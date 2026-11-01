#include "broker_napi.h"
#include "broker_client.h"
#include "broker_credentials.h"
#include "connection_log.h"
#include <cmath>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>

namespace {
using dsh::broker::Client;
using dsh::broker::Inputs;
using dsh::broker::Method;
using dsh::broker::Result;
using dsh::broker::Status;
namespace diag = dsh::broker::diag;
using Channel = std::int64_t;
using ClientMap = std::map<Channel, std::shared_ptr<Client>>;
// Live and still-releasing Clients together; each owns one worker thread.
constexpr std::size_t kMaximumClients = 64;
constexpr double kMaximumChannel = 2147483647;
constexpr int kNoMethod = -1;
struct NapiError final : std::runtime_error {
    napi_status code;
    explicit NapiError(napi_status value) : std::runtime_error("Broker NAPI operation failed"), code(value) {}
};
int diagnosticCode(const std::exception& error) noexcept {
    const auto* napi = dynamic_cast<const NapiError*>(&error);
    return napi ? static_cast<int>(napi->code) : -1;
}
void failure(int method, Channel channel, diag::Stage stage, int code, std::uint64_t flags = 0) noexcept {
    diag::Fields fields; fields.method = method; fields.channel = channel; fields.stage = static_cast<int>(stage);
    fields.code = code; fields.flags = flags; fields.outcome = static_cast<int>(diag::Outcome::Exception);
    diag::emit(diag::Event::NapiFailure, fields);
}
void failure(Method method, Channel channel, diag::Stage stage, int code, std::uint64_t flags = 0) noexcept {
    failure(static_cast<int>(method), channel, stage, code, flags);
}
/** Module broker state shared by every ArkTS window. `clients` is used only on
 * the ArkTS thread; the mutex guards counters shared with worker threads. A
 * Client reference is dropped on the ArkTS thread only after dispose, or while
 * the map, a release work item or a disposal thread still holds the Client. */
struct Holder {
    ClientMap clients;
    std::mutex mutex;
    std::size_t pending = 0, releasing = 0;
    bool closing = false, disposed = false;
    napi_async_cleanup_hook_handle hook = nullptr;
    void addWork(bool release = false) {
        std::lock_guard<std::mutex> lock(mutex); ++pending;
        if (release) ++releasing;
    }
    void finished(bool workerDisposed = false, bool released = false) {
        napi_async_cleanup_hook_handle finishedHook = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (released) --releasing;
            if (workerDisposed) disposed = true;
            else --pending;
            if (disposed && pending == 0) finishedHook = hook;
        }
        if (finishedHook) { delete this; napi_remove_async_cleanup_hook(finishedHook); }
    }
    std::shared_ptr<Client> find(Channel channel) const {
        const auto found = clients.find(channel);
        return found == clients.end() ? nullptr : found->second;
    }
    std::shared_ptr<Client> obtain(Channel channel) {
        if (auto existing = find(channel)) return existing;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (closing) throw std::runtime_error("Broker native module is shutting down");
            if (clients.size() + releasing >= kMaximumClients)
                throw std::runtime_error("Broker channel limit of 64 reached; release an unused channel first");
        }
        // The slot exists before the worker starts, so a failed insertion cannot drop a running Client here.
        const auto slot = clients.try_emplace(channel).first;
        try { slot->second = std::make_shared<Client>(channel); }
        catch (...) { clients.erase(slot); throw; }
        return slot->second;
    }
};
struct Work {
    Holder* owner = nullptr;
    bool counted = false;
    std::shared_ptr<Client> client;
    std::future<Result> future;
    Result result;
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    Method method = Method::Close;
    Channel channel = -1;
    std::uint64_t invokedMs = 0, scheduledMs = 0, dispatchMs = 0;
};
struct ReleaseWork {
    Holder* owner = nullptr;
    std::shared_ptr<Client> client;
    napi_async_work work = nullptr;
    napi_deferred deferred = nullptr;
    Channel channel = -1;
    bool disposed = false;
    std::uint64_t invokedMs = 0, scheduledMs = 0, dispatchMs = 0;
};
void check(napi_status status) { if (status != napi_ok) throw NapiError(status); }
napi_value field(napi_env env, napi_value object, const char* name, bool optional = false) {
    bool exists = false; check(napi_has_named_property(env, object, name, &exists));
    if (!exists) {
        if (!optional) throw std::invalid_argument(std::string("Missing broker field: ") + name);
        napi_value value; check(napi_get_undefined(env, &value)); return value;
    }
    napi_value value; check(napi_get_named_property(env, object, name, &value)); return value;
}
napi_value optionsObject(napi_env env, napi_value value) {
    napi_valuetype type; check(napi_typeof(env, value, &type));
    if (type != napi_object) throw std::invalid_argument("Broker options must be an object");
    return value;
}
Channel channelNumber(napi_env env, napi_value value) {
    napi_valuetype type; check(napi_typeof(env, value, &type));
    double number = -1;
    if (type == napi_number) check(napi_get_value_double(env, value, &number));
    if (!std::isfinite(number) || number != std::floor(number) || number < 0 || number > kMaximumChannel)
        throw std::invalid_argument("channel must be an integer from 0 through 2147483647");
    return static_cast<Channel>(number);
}
std::string string(napi_env env, napi_value object, const char* name, std::size_t maximum, bool optional = false) {
    napi_value value = field(env, object, name, optional);
    napi_valuetype type; check(napi_typeof(env, value, &type));
    if (optional && type == napi_undefined) return {};
    if (type != napi_string) throw std::invalid_argument(std::string(name) + " must be a string");
    std::size_t length = 0; check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
    if ((!optional && !length) || length > maximum) throw std::invalid_argument(std::string(name) + " exceeds its length range");
    std::string text(length + 1, '\0');
    check(napi_get_value_string_utf8(env, value, text.data(), text.size(), &length)); text.resize(length);
    if (text.find('\0') != std::string::npos) throw std::invalid_argument(std::string(name) + " contains NUL");
    return text;
}
Inputs inputs(napi_env env, napi_value object, Method method) {
    optionsObject(env, object);
    Inputs input;
    if (method == Method::Probe) {
        input.origin = string(env, object, "origin", 128);
        input.token = string(env, object, "token", 8192);
        return input;
    }
    bool customTrust = false;
    check(napi_has_named_property(env, object, "caPath", &customTrust));
    if (customTrust) throw std::invalid_argument("Broker HTTPS requires system trust; caPath is not supported");
    input.serviceUrl = string(env, object, "serviceUrl", 2048);
    input.tempDir = string(env, object, "tempDir", 900);
    if (input.tempDir[0] != '/') throw std::invalid_argument("tempDir must be absolute");
    input.credentialDir = string(env, object, "credentialDir", 900, true);
    if (!input.credentialDir.empty() && input.credentialDir[0] != '/')
        throw std::invalid_argument("credentialDir must be absolute");
    if (method == Method::Login) {
        if (input.credentialDir.empty()) throw std::invalid_argument("credentialDir is required for account login");
        input.account = string(env, object, "account", 256);
        input.password = string(env, object, "password", 1024);
    } else {
        input.authSessionId = string(env, object, "authSessionId", 36, true);
        input.accessToken = string(env, object, "accessToken", 8192, true);
        if (input.authSessionId.empty() && input.accessToken.empty())
            throw std::invalid_argument("Account credentials are required");
        if (!input.authSessionId.empty() && (input.credentialDir.empty() || !dsh::broker::CredentialStore::validSession(input.authSessionId)))
            throw std::invalid_argument("Invalid account login session");
        if (method == Method::Connect) {
            input.brokerId = string(env, object, "brokerId", 128);
            input.peerPassword = string(env, object, "peerPassword", 1024);
            const std::string relay = string(env, object, "relayMode", 8);
            if (relay == "auto") input.relayMode = dsh::broker::RelayMode::Auto;
            else if (relay == "never") input.relayMode = dsh::broker::RelayMode::Never;
            else if (relay == "force") input.relayMode = dsh::broker::RelayMode::Force;
            else throw std::invalid_argument("relayMode must be auto, never or force");
            double port; check(napi_get_value_double(env, field(env, object, "remotePort"), &port));
            if (!std::isfinite(port) || port != std::floor(port) || port < 1 || port > 65535)
                throw std::invalid_argument("remotePort must be an integer from 1 through 65535");
            input.remotePort = static_cast<int>(port);
            bool requestedPort = false;
            check(napi_has_named_property(env, object, "localPort", &requestedPort));
            if (requestedPort) {
                double localPort; check(napi_get_value_double(env, field(env, object, "localPort"), &localPort));
                if (!std::isfinite(localPort) || localPort != std::floor(localPort) || localPort < 0 || localPort > 65535)
                    throw std::invalid_argument("localPort must be an integer from 0 through 65535");
                input.localPort = static_cast<int>(localPort);
            }
        }
    }
    return input;
}
void setString(napi_env env, napi_value object, const char* name, const std::string& text) {
    napi_value value; check(napi_create_string_utf8(env, text.data(), text.size(), &value));
    check(napi_set_named_property(env, object, name, value));
}
void setNumber(napi_env env, napi_value object, const char* name, int number) {
    napi_value value; check(napi_create_int32(env, number, &value)); check(napi_set_named_property(env, object, name, value));
}
napi_value statusValue(napi_env env, const Status& status) {
    napi_value value; check(napi_create_object(env, &value));
    setString(env, value, "state", status.state); setString(env, value, "localUrl", status.localUrl);
    setString(env, value, "brokerId", status.brokerId); setString(env, value, "error", status.error);
    setString(env, value, "errorCode", status.errorCode);
    setNumber(env, value, "localPort", status.localPort); setNumber(env, value, "remotePort", status.remotePort);
    return value;
}
napi_value output(napi_env env, const Work& work) {
    if (work.method == Method::Status || work.method == Method::Connect || work.method == Method::Reconnect)
        return statusValue(env, work.result.status);
    napi_value value;
    if (work.method == Method::Close) { check(napi_get_undefined(env, &value)); return value; }
    if (work.method == Method::List) {
        check(napi_create_array_with_length(env, work.result.brokers.size(), &value));
        for (std::size_t i = 0; i < work.result.brokers.size(); ++i) {
            const auto& broker = work.result.brokers[i];
            napi_value entry; check(napi_create_object(env, &entry));
            setString(env, entry, "id", broker.id); setString(env, entry, "name", broker.name);
            napi_value online; check(napi_get_boolean(env, broker.online, &online)); check(napi_set_named_property(env, entry, "online", online));
            check(napi_set_element(env, value, static_cast<uint32_t>(i), entry));
        }
        return value;
    }
    check(napi_create_object(env, &value));
    if (work.method == Method::Login) {
        setString(env, value, "accessToken", work.result.accessToken);
        setString(env, value, "authSessionId", work.result.authSessionId);
        setString(env, value, "tokenType", "Bearer");
    } else {
        setString(env, value, "state", work.result.probeState); setNumber(env, value, "httpStatus", work.result.httpStatus);
    }
    return value;
}
void execute(napi_env, void* data) {
    auto* work = static_cast<Work*>(data);
    work->dispatchMs = diag::nowMs() - work->scheduledMs;
    if (work->method != Method::Status) {
        diag::Fields fields; fields.method = static_cast<int>(work->method); fields.channel = work->channel;
        fields.queueMs = work->dispatchMs;
        diag::emit(diag::Event::NapiExecute, fields);
    }
    try { work->result = work->future.get(); }
    catch (const std::exception& error) {
        failure(work->method, work->channel, diag::Stage::NapiFuture, diagnosticCode(error));
        work->result.error = "Broker worker failed";
    }
}
void reject(napi_env env, napi_deferred deferred, const std::string& message, const std::string& code = "DSH_BROKER") {
    napi_value text, error;
    check(napi_create_string_utf8(env, message.c_str(), message.size(), &text));
    check(napi_create_error(env, nullptr, text, &error));
    setString(env, error, "code", code);
    check(napi_reject_deferred(env, deferred, error));
}
// Settles without a worker. The deferred is consumed even when resolution fails.
void resolveNow(napi_env env, napi_deferred& deferred, napi_value value) {
    const auto settled = deferred; deferred = nullptr;
    check(napi_resolve_deferred(env, settled, value));
}
void complete(napi_env env, napi_status status, void* data) {
    std::unique_ptr<Work> work(static_cast<Work*>(data));
    bool settlementFailed = false;
    try {
        if (status != napi_ok) reject(env, work->deferred, "Broker operation cancelled");
        else if (!work->result.error.empty()) reject(env, work->deferred, work->result.error, work->result.errorCode);
        else check(napi_resolve_deferred(env, work->deferred, output(env, *work)));
    } catch (const std::exception& error) {
        settlementFailed = true;
        failure(work->method, work->channel, diag::Stage::NapiSettle, diagnosticCode(error));
        // Environment teardown can refuse JS operations; native ownership still ends.
    }
    if (work->method != Method::Status || status != napi_ok || !work->result.error.empty() || settlementFailed) {
        diag::Fields fields; fields.method = static_cast<int>(work->method); fields.channel = work->channel;
        fields.code = static_cast<int>(status);
        fields.startMs = work->invokedMs; fields.queueMs = work->dispatchMs; fields.durationMs = diag::nowMs() - work->invokedMs;
        const bool failed = !work->result.error.empty() || (work->method == Method::Probe && work->result.probeState != "ok");
        fields.outcome = static_cast<int>(settlementFailed ? diag::Outcome::Exception : status != napi_ok ? diag::Outcome::Cancelled :
            failed ? diag::Outcome::Failed : diag::Outcome::Ok);
        diag::emit(diag::Event::NapiComplete, fields);
    }
    auto deleted = napi_delete_async_work(env, work->work);
    if (deleted != napi_ok) failure(work->method, work->channel, diag::Stage::NapiDeleteWork, static_cast<int>(deleted));
    auto* owner = work->owner;
    // Another reference remains in the map, a release work item or a disposal thread until dispose.
    work.reset();
    owner->finished();
}
napi_value invoke(napi_env env, napi_callback_info info, Method method) {
    napi_deferred deferred = nullptr; napi_value promise = nullptr;
    const auto invokedMs = diag::nowMs();
    diag::Stage stage = diag::Stage::NapiPromise;
    Channel channel = -1;
    bool begun = false;
    auto begin = [&] {
        if (begun) return;
        begun = true;
        if (method == Method::Status) return;
        diag::Fields fields; fields.method = static_cast<int>(method); fields.channel = channel; fields.startMs = invokedMs;
        diag::emit(diag::Event::NapiBegin, fields);
    };
    try {
        check(napi_create_promise(env, &deferred, &promise));
        stage = diag::Stage::NapiArguments;
        std::size_t argc = 2; napi_value argv[2]; void* data = nullptr;
        check(napi_get_cb_info(env, info, &argc, argv, nullptr, &data));
        if (argc != 1 || !data) throw std::invalid_argument("Invalid broker method arguments");
        auto* holder = static_cast<Holder*>(data);
        const bool options = method != Method::Close && method != Method::Status && method != Method::Reconnect;
        channel = channelNumber(env, options ? field(env, optionsObject(env, argv[0]), "channel") : argv[0]);
        begin();
        Inputs input; stage = diag::Stage::NapiInputs;
        if (options) input = inputs(env, argv[0], method);
        stage = diag::Stage::NapiChannel;
        auto client = options ? holder->obtain(channel) : holder->find(channel);
        if (!client) {
            // Close, status and reconnect of an unused channel report idle without creating a worker.
            napi_value value;
            if (method == Method::Close) check(napi_get_undefined(env, &value));
            else value = statusValue(env, Status{});
            stage = diag::Stage::NapiSettle;
            resolveNow(env, deferred, value);
            if (method != Method::Status) {
                diag::Fields fields; fields.method = static_cast<int>(method); fields.channel = channel;
                fields.startMs = invokedMs; fields.durationMs = diag::nowMs() - invokedMs;
                // flags: bit 0 settled without a channel client.
                fields.flags = 1; fields.outcome = static_cast<int>(diag::Outcome::Ok);
                diag::emit(diag::Event::NapiComplete, fields);
            }
            return promise;
        }
        auto work = std::make_unique<Work>(); work->owner = holder; work->client = std::move(client);
        work->method = method; work->channel = channel; work->deferred = deferred; work->invokedMs = invokedMs;
        stage = diag::Stage::NapiCreateWork;
        napi_value name; check(napi_create_string_utf8(env, "dsh.broker", NAPI_AUTO_LENGTH, &name));
        check(napi_create_async_work(env, nullptr, name, execute, complete, work.get(), &work->work));
        try {
            stage = diag::Stage::NapiSubmit;
            work->future = work->client->submit(method, std::move(input));
            work->owner->addWork(); work->counted = true;
            stage = diag::Stage::NapiQueue; work->scheduledMs = diag::nowMs();
            check(napi_queue_async_work(env, work->work));
        } catch (...) {
            diag::Fields fields; fields.method = static_cast<int>(method); fields.channel = channel;
            fields.stage = static_cast<int>(stage);
            fields.outcome = static_cast<int>(diag::Outcome::Exception);
            // flags: bit 0 cancel requested, bit 1 Close submitted, bit 2 work counted.
            fields.flags = work->counted ? 4u : 0u;
            if (method != Method::Status && method != Method::Reconnect) {
                work->client->cancel(); fields.flags |= 1u;
                try { work->client->submit(Method::Close, {}); fields.flags |= 2u; }
                catch (const std::exception& error) {
                    failure(method, channel, diag::Stage::NapiCloseSubmit, diagnosticCode(error));
                    // Disposed/full close queue already cancels.
                }
            }
            diag::emit(diag::Event::NapiForcedClose, fields);
            auto deleted = napi_delete_async_work(env, work->work);
            if (deleted != napi_ok) failure(method, channel, diag::Stage::NapiDeleteWork, static_cast<int>(deleted));
            if (work->counted) work->owner->finished();
            throw;
        }
        work.release();
        return promise;
    } catch (const std::exception& error) {
        begin();
        failure(method, channel, stage, diagnosticCode(error));
        if (deferred) {
            try { reject(env, deferred, error.what()); }
            catch (const std::exception&) { /* Teardown can refuse rejection; the failure record remains. */ }
        }
        if (promise) return promise;
        napi_throw_error(env, "DSH_BROKER", "Cannot create broker operation"); return nullptr;
    }
}
napi_value login(napi_env env, napi_callback_info info) { return invoke(env, info, Method::Login); }
napi_value list(napi_env env, napi_callback_info info) { return invoke(env, info, Method::List); }
napi_value connect(napi_env env, napi_callback_info info) { return invoke(env, info, Method::Connect); }
napi_value reconnect(napi_env env, napi_callback_info info) { return invoke(env, info, Method::Reconnect); }
napi_value close(napi_env env, napi_callback_info info) { return invoke(env, info, Method::Close); }
napi_value status(napi_env env, napi_callback_info info) { return invoke(env, info, Method::Status); }
napi_value probe(napi_env env, napi_callback_info info) { return invoke(env, info, Method::Probe); }
void disposeClient(Channel channel, Client& client) noexcept {
    try { client.dispose(); }
    catch (const std::exception& error) { failure(kNoMethod, channel, diag::Stage::NapiDispose, diagnosticCode(error)); }
}
void disposeAll(ClientMap& clients) noexcept {
    for (auto& entry : clients) disposeClient(entry.first, *entry.second);
    clients.clear();
}
/** Disposes on a new thread that finishes the release count. Returns false
 * after the synchronous fallback; the caller then finishes the count. */
bool disposeOnThread(Holder* owner, const std::shared_ptr<Client>& client, Channel channel) noexcept {
    try {
        std::thread([owner, held = client, channel]() mutable {
            disposeClient(channel, *held); held.reset();
            owner->finished(false, true);
        }).detach();
        return true;
    } catch (const std::exception& error) {
        failure(kNoMethod, channel, diag::Stage::NapiCleanupThread, diagnosticCode(error));
    }
    // Joining reaches handle quiescence before the ArkTS thread can drop the Client.
    disposeClient(channel, *client);
    return false;
}
void releaseExecute(napi_env, void* data) {
    auto* work = static_cast<ReleaseWork*>(data);
    work->dispatchMs = diag::nowMs() - work->scheduledMs;
    try { work->client->dispose(); work->disposed = true; }
    catch (const std::exception& error) { failure(kNoMethod, work->channel, diag::Stage::NapiDispose, diagnosticCode(error)); }
}
void releaseComplete(napi_env env, napi_status status, void* data) {
    std::unique_ptr<ReleaseWork> work(static_cast<ReleaseWork*>(data));
    bool settlementFailed = false;
    try {
        if (work->disposed) {
            napi_value value; check(napi_get_undefined(env, &value));
            check(napi_resolve_deferred(env, work->deferred, value));
        } else reject(env, work->deferred, "Broker channel release was interrupted before quiescence");
    } catch (const std::exception& error) {
        settlementFailed = true;
        failure(kNoMethod, work->channel, diag::Stage::NapiSettle, diagnosticCode(error));
        // Environment teardown can refuse JS operations; native ownership still ends.
    }
    auto deleted = napi_delete_async_work(env, work->work);
    if (deleted != napi_ok) failure(kNoMethod, work->channel, diag::Stage::NapiDeleteWork, static_cast<int>(deleted));
    auto* owner = work->owner;
    const bool handedOff = !work->disposed && disposeOnThread(owner, work->client, work->channel);
    diag::Fields fields; fields.channel = work->channel; fields.code = static_cast<int>(status);
    fields.startMs = work->invokedMs; fields.queueMs = work->dispatchMs; fields.durationMs = diag::nowMs() - work->invokedMs;
    // flags: bit 0 unknown channel, bit 1 disposal continues on a separate thread.
    fields.flags = handedOff ? 2u : 0u;
    fields.outcome = static_cast<int>(settlementFailed ? diag::Outcome::Exception : status != napi_ok ? diag::Outcome::Cancelled :
        work->disposed ? diag::Outcome::Ok : diag::Outcome::Failed);
    diag::emit(diag::Event::NapiChannelReleaseEnd, fields);
    // The Client is disposed here, or the disposal thread holds another reference.
    work.reset();
    if (!handedOff) owner->finished(false, true);
}
napi_value release(napi_env env, napi_callback_info info) {
    napi_deferred deferred = nullptr; napi_value promise = nullptr;
    const auto invokedMs = diag::nowMs();
    diag::Stage stage = diag::Stage::NapiPromise;
    Channel channel = -1;
    bool begun = false;
    auto begin = [&] {
        if (begun) return;
        begun = true;
        diag::Fields fields; fields.channel = channel; fields.startMs = invokedMs;
        diag::emit(diag::Event::NapiChannelReleaseBegin, fields);
    };
    try {
        check(napi_create_promise(env, &deferred, &promise));
        stage = diag::Stage::NapiArguments;
        std::size_t argc = 2; napi_value argv[2]; void* data = nullptr;
        check(napi_get_cb_info(env, info, &argc, argv, nullptr, &data));
        if (argc != 1 || !data) throw std::invalid_argument("Invalid broker method arguments");
        auto* holder = static_cast<Holder*>(data);
        channel = channelNumber(env, argv[0]);
        begin();
        stage = diag::Stage::NapiChannel;
        const auto found = holder->clients.find(channel);
        if (found == holder->clients.end()) {
            napi_value value; check(napi_get_undefined(env, &value));
            stage = diag::Stage::NapiSettle;
            resolveNow(env, deferred, value);
            diag::Fields fields; fields.channel = channel; fields.startMs = invokedMs;
            fields.durationMs = diag::nowMs() - invokedMs; fields.flags = 1; fields.outcome = static_cast<int>(diag::Outcome::Ok);
            diag::emit(diag::Event::NapiChannelReleaseEnd, fields);
            return promise;
        }
        auto work = std::make_unique<ReleaseWork>();
        work->owner = holder; work->channel = channel; work->deferred = deferred; work->invokedMs = invokedMs;
        stage = diag::Stage::NapiCreateWork;
        napi_value name; check(napi_create_string_utf8(env, "dsh.broker.release", NAPI_AUTO_LENGTH, &name));
        check(napi_create_async_work(env, nullptr, name, releaseExecute, releaseComplete, work.get(), &work->work));
        // Node extraction and reinsertion allocate nothing, so a failed queue restores the channel.
        ClientMap::node_type node;
        bool counted = false;
        try {
            holder->addWork(true); counted = true;
            node = holder->clients.extract(found);
            work->client = node.mapped();
            try { work->client->cancel(); }
            catch (const std::exception&) { /* Dispose cancels again on the execute thread. */ }
            stage = diag::Stage::NapiQueue; work->scheduledMs = diag::nowMs();
            check(napi_queue_async_work(env, work->work));
        } catch (...) {
            if (node) holder->clients.insert(std::move(node));
            work->client.reset();
            auto deleted = napi_delete_async_work(env, work->work);
            if (deleted != napi_ok) failure(kNoMethod, channel, diag::Stage::NapiDeleteWork, static_cast<int>(deleted));
            if (counted) holder->finished(false, true);
            throw;
        }
        work.release();
        // The extracted map node drops here; the queued work item keeps the Client.
        return promise;
    } catch (const std::exception& error) {
        begin();
        failure(kNoMethod, channel, stage, diagnosticCode(error));
        if (deferred) {
            try { reject(env, deferred, error.what()); }
            catch (const std::exception&) { /* Teardown can refuse rejection; the failure record remains. */ }
        }
        if (promise) return promise;
        napi_throw_error(env, "DSH_BROKER", "Cannot create broker operation"); return nullptr;
    }
}
std::string diagnosticArgument(napi_env env, napi_value value, std::size_t maximum) {
    napi_valuetype type; check(napi_typeof(env, value, &type));
    if (type != napi_string) throw std::invalid_argument("Diagnostic argument must be a string");
    std::size_t length = 0; check(napi_get_value_string_utf8(env, value, nullptr, 0, &length));
    if (length > maximum) throw std::invalid_argument("Diagnostic argument is too long");
    std::string text(length + 1, '\0');
    check(napi_get_value_string_utf8(env, value, text.data(), text.size(), &length)); text.resize(length);
    if (text.find('\0') != std::string::npos) throw std::invalid_argument("Diagnostic argument contains NUL");
    return text;
}
napi_value diagnosticInvoke(napi_env env, napi_callback_info info, int method) {
    try {
        std::size_t count = 3; napi_value args[3];
        check(napi_get_cb_info(env, info, &count, args, nullptr, nullptr));
        const auto expected = method == 0 ? 1u : method == 1 ? 2u : 0u;
        if (count != expected) throw std::invalid_argument("Invalid diagnostic argument count");
        napi_value result;
        if (method == 0) dsh::diagnostics::configure(diagnosticArgument(env, args[0], 4096));
        else if (method == 1) dsh::diagnostics::appendApp(diagnosticArgument(env, args[0], 80), diagnosticArgument(env, args[1], 1024));
        else {
            const auto text = dsh::diagnostics::read();
            check(napi_create_string_utf8(env, text.data(), text.size(), &result));
            return result;
        }
        check(napi_get_undefined(env, &result)); return result;
    } catch (const std::exception&) {
        // Neither a private pathname nor caller text is copied into the exception.
        napi_throw_error(env, "DSH_DIAGNOSTICS", "Connection diagnostic journal operation failed"); return nullptr;
    }
}
napi_value configureDiagnostics(napi_env env, napi_callback_info info) { return diagnosticInvoke(env, info, 0); }
napi_value writeDiagnostic(napi_env env, napi_callback_info info) { return diagnosticInvoke(env, info, 1); }
napi_value readDiagnostics(napi_env env, napi_callback_info info) { return diagnosticInvoke(env, info, 2); }
void cleanup(napi_async_cleanup_hook_handle hook, void* data) {
    auto* holder = static_cast<Holder*>(data);
    auto started = diag::nowMs(); diag::Fields fields;
    { std::lock_guard<std::mutex> lock(holder->mutex); holder->hook = hook; holder->closing = true; fields.depth = holder->pending; }
    diag::emit(diag::Event::NapiCleanupBegin, fields);
    // Every channel is cancelled before any join; in-flight releases stay counted in pending.
    for (auto& entry : holder->clients) {
        try { entry.second->cancel(); }
        catch (const std::exception& error) { failure(kNoMethod, entry.first, diag::Stage::NapiDispose, diagnosticCode(error)); }
    }
    std::shared_ptr<ClientMap> clients;
    try {
        clients = std::make_shared<ClientMap>(std::move(holder->clients));
        holder->clients.clear();
        std::thread([holder, clients, started] {
            disposeAll(*clients);
            diag::Fields fields; fields.durationMs = diag::nowMs() - started;
            diag::emit(diag::Event::NapiCleanupEnd, fields); holder->finished(true);
        }).detach();
        return;
    } catch (const std::exception& error) {
        failure(Method::Close, -1, diag::Stage::NapiCleanupThread, diagnosticCode(error));
    }
    // Joining reaches handle quiescence. Outstanding NAPI completions keep
    // the cleanup hook alive and release it without blocking the UI loop.
    disposeAll(clients ? *clients : holder->clients);
    fields.durationMs = diag::nowMs() - started; fields.flags = 1;
    diag::emit(diag::Event::NapiCleanupEnd, fields); holder->finished(true);
}
} // namespace
void installBrokerBindings(napi_env env, napi_value exports) {
    auto holder = std::make_unique<Holder>();
    napi_property_descriptor properties[] = {
        {"configureConnectionDiagnostics", nullptr, configureDiagnostics, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"writeConnectionDiagnostic", nullptr, writeDiagnostic, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"readConnectionDiagnostics", nullptr, readDiagnostics, nullptr, nullptr, nullptr, napi_default, nullptr},
        {"brokerLogin", nullptr, login, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerList", nullptr, list, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerConnect", nullptr, connect, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerReconnect", nullptr, reconnect, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerClose", nullptr, close, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerStatus", nullptr, status, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerRelease", nullptr, release, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"dshProbe", nullptr, probe, nullptr, nullptr, nullptr, napi_default, holder.get()},
    };
    check(napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
    check(napi_add_async_cleanup_hook(env, cleanup, holder.get(), nullptr));
    holder.release();
}
