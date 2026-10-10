#include "broker_napi.h"
#include "broker_client.h"
#include "broker_credentials.h"
#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>

namespace {
using dsh::broker::Client;
using dsh::broker::Inputs;
using dsh::broker::Method;
using dsh::broker::Result;
using dsh::broker::Status;
struct Holder {
    std::shared_ptr<Client> client = std::make_shared<Client>();
    std::mutex mutex;
    std::size_t pending = 0;
    bool disposed = false;
    napi_async_cleanup_hook_handle hook = nullptr;
    void addWork() { std::lock_guard<std::mutex> lock(mutex); ++pending; }
    void finished(bool workerDisposed = false) {
        napi_async_cleanup_hook_handle finishedHook = nullptr;
        {
            std::lock_guard<std::mutex> lock(mutex);
            if (workerDisposed) disposed = true;
            else --pending;
            if (disposed && pending == 0) finishedHook = hook;
        }
        if (finishedHook) { delete this; napi_remove_async_cleanup_hook(finishedHook); }
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
};
void check(napi_status status) { if (status != napi_ok) throw std::runtime_error("Broker NAPI operation failed"); }
napi_value field(napi_env env, napi_value object, const char* name, bool optional = false) {
    bool exists = false; check(napi_has_named_property(env, object, name, &exists));
    if (!exists) {
        if (!optional) throw std::invalid_argument(std::string("Missing broker field: ") + name);
        napi_value value; check(napi_get_undefined(env, &value)); return value;
    }
    napi_value value; check(napi_get_named_property(env, object, name, &value)); return value;
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
    napi_valuetype type; check(napi_typeof(env, object, &type));
    if (type != napi_object) throw std::invalid_argument("Broker options must be an object");
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
    try { work->result = work->future.get(); }
    catch (const std::exception&) { work->result.error = "Broker worker failed"; }
}
void reject(napi_env env, napi_deferred deferred, const std::string& message, const std::string& code = "DSH_BROKER") {
    napi_value text, error;
    check(napi_create_string_utf8(env, message.c_str(), message.size(), &text));
    check(napi_create_error(env, nullptr, text, &error));
    setString(env, error, "code", code);
    check(napi_reject_deferred(env, deferred, error));
}
void complete(napi_env env, napi_status status, void* data) {
    std::unique_ptr<Work> work(static_cast<Work*>(data));
    try {
        if (status != napi_ok) reject(env, work->deferred, "Broker operation cancelled");
        else if (!work->result.error.empty()) reject(env, work->deferred, work->result.error, work->result.errorCode);
        else check(napi_resolve_deferred(env, work->deferred, output(env, *work)));
    } catch (const std::exception&) {
        // Environment teardown can refuse JS operations; native ownership still ends.
    }
    napi_delete_async_work(env, work->work);
    auto* owner = work->owner;
    work.reset();
    owner->finished();
}
napi_value invoke(napi_env env, napi_callback_info info, Method method) {
    napi_deferred deferred = nullptr; napi_value promise = nullptr;
    try {
        check(napi_create_promise(env, &deferred, &promise));
        std::size_t argc = 2; napi_value argv[2]; void* data = nullptr;
        check(napi_get_cb_info(env, info, &argc, argv, nullptr, &data));
        const bool options = method != Method::Close && method != Method::Status && method != Method::Reconnect;
        if (argc != (options ? 1u : 0u) || !data) throw std::invalid_argument("Invalid broker method arguments");
        auto work = std::make_unique<Work>(); work->owner = static_cast<Holder*>(data); work->client = work->owner->client;
        work->method = method; work->deferred = deferred;
        Inputs input;
        if (options) input = inputs(env, argv[0], method);
        napi_value name; check(napi_create_string_utf8(env, "dsh.broker", NAPI_AUTO_LENGTH, &name));
        check(napi_create_async_work(env, nullptr, name, execute, complete, work.get(), &work->work));
        try {
            work->future = work->client->submit(method, std::move(input));
            work->owner->addWork(); work->counted = true;
            check(napi_queue_async_work(env, work->work));
        } catch (...) {
            if (method != Method::Status && method != Method::Reconnect) {
                work->client->cancel();
                try { work->client->submit(Method::Close, {}); } catch (const std::exception&) { /* Disposed/full close queue already cancels. */ }
            }
            napi_delete_async_work(env, work->work);
            if (work->counted) work->owner->finished();
            throw;
        }
        work.release();
        return promise;
    } catch (const std::exception& error) {
        if (deferred) { try { reject(env, deferred, error.what()); } catch (...) {} return promise; }
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
void cleanup(napi_async_cleanup_hook_handle hook, void* data) {
    auto* holder = static_cast<Holder*>(data);
    { std::lock_guard<std::mutex> lock(holder->mutex); holder->hook = hook; }
    holder->client->cancel();
    try {
        std::thread([holder] {
            holder->client->dispose(); holder->finished(true);
        }).detach();
    } catch (const std::exception&) {
        // Joining reaches handle quiescence. Outstanding NAPI completions keep
        // the cleanup hook alive and release it without blocking the UI loop.
        holder->client->dispose(); holder->finished(true);
    }
}
} // namespace
void installBrokerBindings(napi_env env, napi_value exports) {
    auto holder = std::make_unique<Holder>();
    napi_property_descriptor properties[] = {
        {"brokerLogin", nullptr, login, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerList", nullptr, list, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerConnect", nullptr, connect, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerReconnect", nullptr, reconnect, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerClose", nullptr, close, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"brokerStatus", nullptr, status, nullptr, nullptr, nullptr, napi_default, holder.get()},
        {"dshProbe", nullptr, probe, nullptr, nullptr, nullptr, napi_default, holder.get()},
    };
    check(napi_define_properties(env, exports, sizeof(properties) / sizeof(properties[0]), properties));
    check(napi_add_async_cleanup_hook(env, cleanup, holder.get(), nullptr));
    holder.release();
}
