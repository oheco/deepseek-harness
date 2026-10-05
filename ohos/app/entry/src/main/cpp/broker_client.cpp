#include "broker_client.h"
#include "broker_trust.h"
#include "broker_sdk/ob_api.h"
#include "broker_sdk/ob_remote.h"
#include "broker_sdk/ob_json.h"
#include "launcher_util.h"

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>
#include <cjson/cJSON.h>
#include <curl/curl.h>
#include <openssl/mem.h>

namespace dsh::broker {
namespace {
void wipe(std::string& text) {
    if (!text.empty()) OPENSSL_cleanse(text.data(), text.size());
}
struct JsonDelete { void operator()(cJSON* value) const { cJSON_Delete(value); } };
struct Response {
    char* text = nullptr;
    ~Response() { ob_api_response_free(text); }
};
using Json = std::unique_ptr<cJSON, JsonDelete>;
using Api = std::unique_ptr<ob_api_client, decltype(&ob_api_client_destroy)>;
const char* text(cJSON* value, const char* field) {
    cJSON* entry = cJSON_GetObjectItemCaseSensitive(value, field);
    return cJSON_IsString(entry) ? entry->valuestring : nullptr;
}
Json parse(const Response& response) {
    return Json(response.text ? ob_json_parse_complete(response.text, std::strlen(response.text)) : nullptr);
}
std::string apiError(const ob_api_error& error) {
    if (error.http_status == 401) return "Account login is required or has expired";
    if (error.http_status == 403) return "Account access is forbidden";
    if (error.http_status == 404) return "Broker service endpoint was not found";
    if (error.code == OB_API_TRANSPORT) return "Broker HTTPS connection or certificate verification failed";
    if (error.code == OB_API_INVALID) return "Invalid broker service options";
    return "Broker service request failed";
}
std::string peerError(int code, int http) {
    if (http == 401 || http == 403) return "Broker account access was denied";
    if (code == OB_REMOTE_EAUTH) return "Peer password authentication failed";
    if (code == OB_REMOTE_ETIMEOUT) return "Broker peer setup timed out";
    if (code == OB_REMOTE_EACL) return "Broker target port is not allowed";
    if (code == OB_REMOTE_ECLOSED) return "Broker connection closed";
    if (code == OB_REMOTE_EICE) return "Broker network traversal failed";
    if (code == OB_REMOTE_EQUIC) return "Broker encrypted transport failed";
    return "Broker connection failed";
}
Api newApi(const Inputs& input, const char* roots, ob_api_error& error) {
    if (input.serviceUrl.rfind("https://", 0) != 0) {
        error.code = OB_API_INVALID;
        return Api(nullptr, ob_api_client_destroy);
    }
    ob_api_options options{};
    options.base_url = input.serviceUrl.c_str();
    options.tenant_token = input.accessToken.empty() ? nullptr : input.accessToken.c_str();
    options.ca_file = roots;
    options.timeout_ms = 15000;
    return Api(ob_api_client_create(&options, &error), ob_api_client_destroy);
}
void privateDirectory(const std::string& path) {
    using dsh::launcher::Fd;
    if (path.empty() || path[0] != '/' || path.size() > 900) throw std::runtime_error("Invalid broker temporary directory");
    constexpr int flags = O_PATH | O_DIRECTORY | O_CLOEXEC;
    Fd dir(open("/", flags));
    if (dir.value < 0) throw std::runtime_error("Broker temporary directory is unavailable");
    for (std::size_t pos = 1; pos < path.size();) {
        auto end = path.find('/', pos);
        auto part = path.substr(pos, end == std::string::npos ? end : end - pos);
        pos = end == std::string::npos ? path.size() : end + 1;
        if (part.empty()) continue;
        if (part == "." || part == "..") throw std::runtime_error("Invalid broker temporary directory");
        int next = openat(dir.value, part.c_str(), flags | O_NOFOLLOW);
        if (next < 0 && errno == ENOENT) {
            if (mkdirat(dir.value, part.c_str(), 0700) != 0 && errno != EEXIST)
                throw std::runtime_error("Cannot create broker temporary directory");
            next = openat(dir.value, part.c_str(), flags | O_NOFOLLOW);
        }
        if (next < 0) throw std::runtime_error("Broker temporary directory must contain no symlinks");
        dir.reset(next);
    }
    struct stat st{};
    if (fstat(dir.value, &st) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0700)
        throw std::runtime_error("Broker temporary directory must be private mode 0700");
}
void initializeTemporaryRoot(const std::string& path) {
    static std::mutex mutex;
    static std::string retainedRoot;
    std::lock_guard<std::mutex> lock(mutex);
    if (!retainedRoot.empty()) {
        if (retainedRoot != path) throw std::runtime_error("Broker temporary directory cannot change during this process");
        return;
    }
    retainedRoot = path;
    // The source SDK reads TMPDIR for its private peer certificates. Set one
    // validated App directory before creating any SDK API or peer workers.
    if (setenv("TMPDIR", retainedRoot.c_str(), 1) != 0) {
        retainedRoot.clear();
        throw std::runtime_error("Cannot initialize broker temporary directory");
    }
}
struct CurlDelete { void operator()(CURL* easy) const { curl_easy_cleanup(easy); } };
struct HeadersDelete {
    void operator()(curl_slist* headers) const {
        for (auto* item = headers; item; item = item->next) if (item->data) OPENSSL_cleanse(item->data, std::strlen(item->data));
        curl_slist_free_all(headers);
    }
};
struct ProbeResponse { std::string body, location, cookie; std::size_t headerBytes = 0; bool limit = false; };
std::size_t probeBody(char* bytes, std::size_t size, std::size_t count, void* data) {
    auto* response = static_cast<ProbeResponse*>(data);
    if (count && size > SIZE_MAX / count) return 0;
    auto length = size * count;
    if (length > 2 * 1024 * 1024 - response->body.size()) { response->limit = true; return 0; }
    try { response->body.append(bytes, length); } catch (...) { return 0; }
    return length;
}
std::size_t probeHeader(char* bytes, std::size_t size, std::size_t count, void* data) {
    auto* response = static_cast<ProbeResponse*>(data);
    if (count && size > SIZE_MAX / count) return 0;
    auto length = size * count;
    if (length > 8192 || length > 65536 - response->headerBytes) return 0;
    response->headerBytes += length;
    try {
        if (length >= 11 && strncasecmp(bytes, "Set-Cookie:", 11) == 0) {
            std::string value(bytes + 11, length - 11);
            auto end = value.find(';');
            value.resize(end == std::string::npos ? value.size() : end);
            auto first = value.find_first_not_of(" \t");
            auto last = value.find_last_not_of(" \t\r\n");
            if (first == std::string::npos || last == std::string::npos) return 0;
            value = value.substr(first, last - first + 1);
            if (value.find('=') == std::string::npos || value.find_first_of("\r\n") != std::string::npos ||
                value.size() > 8192 - response->cookie.size()) return 0;
            if (!response->cookie.empty()) response->cookie += "; ";
            response->cookie += value;
        }
        if (length >= 9 && strncasecmp(bytes, "Location:", 9) == 0) {
            std::string value(bytes + 9, length - 9);
            auto first = value.find_first_not_of(" \t");
            auto last = value.find_last_not_of(" \t\r\n");
            response->location = first == std::string::npos ? "" : value.substr(first, last - first + 1);
        }
    } catch (...) { return 0; }
    return length;
}
} // namespace

Inputs::~Inputs() { wipe(password); wipe(peerPassword); wipe(accessToken); wipe(token); }
Result::~Result() { wipe(accessToken); }
Client::Client() : worker_(&Client::run, this) {}
Client::~Client() { dispose(); }
int Client::cancelled(void* data) {
    auto* c = static_cast<Cancellation*>(data);
    return c->owner->stopping_.load() || c->owner->generation_.load() != c->generation;
}
void Client::cancel() {
    { std::lock_guard<std::mutex> lock(stateMutex_); generation_.fetch_add(1); }
    wake_.notify_all();
}
std::future<Result> Client::submit(Method method, Inputs inputs) {
    auto task = std::make_unique<Task>();
    task->method = method;
    task->inputs = std::move(inputs);
    std::lock_guard<std::mutex> lock(queueMutex_);
    if (stopping_.load()) throw std::runtime_error("Broker client is disposed");
    if (method == Method::Close) {
        cancel();
        // A full queue cannot prevent cancellation. Unstarted ordinary work
        // settles now; prior closes remain queued until handles are quiescent.
        for (auto it = queue_.begin(); it != queue_.end();) {
            if ((*it)->method == Method::Close) { ++it; continue; }
            Result cancelledResult; cancelledResult.error = "Broker operation cancelled";
            (*it)->promise.set_value(std::move(cancelledResult)); it = queue_.erase(it);
        }
    }
    if (queue_.size() >= 32) throw std::runtime_error("Broker operation queue is full");
    task->generation = generation_.load();
    auto future = task->promise.get_future();
    queue_.push_back(std::move(task));
    wake_.notify_one();
    return future;
}
Status Client::status() const { std::lock_guard<std::mutex> lock(stateMutex_); return status_; }
void Client::publish(Status status) { std::lock_guard<std::mutex> lock(stateMutex_); status_ = std::move(status); }
bool Client::publishCurrent(Status status, const Cancellation& cancellation) {
    std::lock_guard<std::mutex> lock(stateMutex_);
    if (stopping_.load() || generation_.load() != cancellation.generation) return false;
    status_ = std::move(status);
    return true;
}
const char* Client::prepareApi(const Inputs& input) {
    privateDirectory(input.tempDir);
    initializeTemporaryRoot(input.tempDir);
    if (privateRoot_.empty()) privateRoot_ = input.tempDir;
    else if (privateRoot_ != input.tempDir) throw std::runtime_error("Broker temporary directory cannot change during this client");
#ifdef DSH_BROKER_FIXTURE_TRUST
    if (!input.testCaPath.empty()) return input.testCaPath.c_str();
#endif
    if (caBundle_.empty()) caBundle_ = createSystemTrustBundle(privateRoot_);
    return caBundle_.c_str();
}
void Client::dispose() {
    // Called by module cleanup on its own thread, never by an ArkTS callback.
    { std::lock_guard<std::mutex> lock(queueMutex_); stopping_.store(true); cancel(); }
    if (worker_.joinable()) worker_.join();
}
void Client::release() {
    if (map_) { ob_remote_map_close(map_); map_ = nullptr; }
    if (peer_) { ob_remote_peer_close(peer_); peer_ = nullptr; }
    if (api_) { ob_api_client_destroy(api_); api_ = nullptr; }
}
void Client::checkPeer() {
    if (!peer_) return;
    ob_remote_connection_info info{};
    Status next = status();
    if (ob_remote_peer_get_state(peer_, &info) != OB_REMOTE_OK) {
        next.state = "failed"; next.error = "Cannot read broker connection state";
        next.errorCode.clear();
    } else {
        switch (info.state) {
            case OB_REMOTE_STATE_CONNECTING: next.state = "connecting"; break;
            case OB_REMOTE_STATE_CONNECTED: next.state = "connected"; break;
            case OB_REMOTE_STATE_RECONNECTING: next.state = "reconnecting"; break;
            case OB_REMOTE_STATE_RETRY_WAIT: next.state = "retry_wait"; break;
            case OB_REMOTE_STATE_PAUSED: next.state = "paused"; break;
            case OB_REMOTE_STATE_FAILED: next.state = "failed"; break;
            case OB_REMOTE_STATE_CLOSED: next.state = "closed"; break;
        }
        next.error = info.last_error.code ? peerError(info.last_error.code, info.last_error.http_status) : "";
        next.errorCode = info.last_error.http_status == 401 || info.last_error.http_status == 403 ? "DSH_BROKER_AUTH" : "";
        if (!map_ && next.state == "connected") {
            next.state = "failed"; next.error = "Broker loopback mapping is unavailable";
        }
    }
    // The logical peer and listener survive outages, exhausted automatic retries,
    // and terminal errors until the App explicitly closes this owned connection.
    publishCurrent(std::move(next), Cancellation{this, peerGeneration_});
}
void Client::run() {
    for (;;) {
        std::unique_ptr<Task> task;
        {
            std::unique_lock<std::mutex> lock(queueMutex_);
            wake_.wait_for(lock, std::chrono::milliseconds(250), [this] { return stopping_.load() || !queue_.empty(); });
            if (!queue_.empty()) { task = std::move(queue_.front()); queue_.pop_front(); }
            else if (stopping_.load()) break;
        }
        if (task) {
            Result result;
            try { result = perform(*task); }
            catch (const std::exception&) {
                // SDK diagnostics and input fields are never copied to an error.
                result.error = "Broker operation failed";
                if (task->method == Method::Connect) {
                    release(); Status failed; failed.state = "failed"; failed.error = result.error;
                    publishCurrent(std::move(failed), Cancellation{this, task->generation});
                }
            }
            catch (...) {
                result.error = "Broker operation failed";
                if (task->method == Method::Connect) {
                    release(); Status failed; failed.state = "failed"; failed.error = result.error;
                    publishCurrent(std::move(failed), Cancellation{this, task->generation});
                }
            }
            task->promise.set_value(std::move(result));
        }
        checkPeer();
    }
    release(); publish(Status{});
    if (!caBundle_.empty()) { unlink(caBundle_.c_str()); caBundle_.clear(); }
}
Result Client::perform(Task& task) {
    Cancellation cancellation{this, task.generation};
    Result result;
    if (task.method == Method::Close) { release(); publish(Status{}); return result; }
    if (cancelled(&cancellation)) { result.error = "Broker operation cancelled"; return result; }
    switch (task.method) {
        case Method::Login: result = login(task.inputs, cancellation); break;
        case Method::List: result = list(task.inputs, cancellation); break;
        case Method::Connect: result = connect(task.inputs, cancellation); break;
        case Method::Reconnect: result = reconnect(cancellation); break;
        case Method::Status: checkPeer(); result.status = status(); break;
        case Method::Probe: result = probe(task.inputs, cancellation); break;
        case Method::Close: break;
    }
    if (cancelled(&cancellation)) {
        if (task.method == Method::Connect) { release(); publish(Status{}); }
        wipe(result.accessToken); result = Result{}; result.error = "Broker operation cancelled";
    }
    return result;
}
Result Client::login(const Inputs& input, Cancellation& cancellation) {
    Result result; ob_api_error error{};
    const char* roots = prepareApi(input);
    if (cancelled(&cancellation)) { result.error = "Broker operation cancelled"; return result; }
    auto api = newApi(input, roots, error);
    if (!api) { result.error = apiError(error); return result; }
    Response response;
    if (ob_api_tenant_login(api.get(), input.account.c_str(), input.password.c_str(), &response.text, &error)) {
        result.error = apiError(error);
        if (error.http_status == 401) result.errorCode = "DSH_BROKER_AUTH";
        return result;
    }
    auto json = parse(response);
    const char* token = text(json.get(), "token");
    if (!token || !*token || std::strlen(token) > 8192) { result.error = "Invalid broker login response"; return result; }
    result.accessToken = token;
    OPENSSL_cleanse(const_cast<char*>(token), std::strlen(token));
    return result;
}
Result Client::list(const Inputs& input, Cancellation& cancellation) {
    Result result; ob_api_error error{};
    const char* roots = prepareApi(input);
    if (cancelled(&cancellation)) { result.error = "Broker operation cancelled"; return result; }
    auto api = newApi(input, roots, error);
    if (!api) { result.error = apiError(error); return result; }
    Response response;
    if (ob_api_broker_list(api.get(), &response.text, &error)) {
        result.error = apiError(error);
        if (error.http_status == 401) result.errorCode = "DSH_BROKER_AUTH";
        return result;
    }
    auto json = parse(response);
    auto* brokers = cJSON_GetObjectItemCaseSensitive(json.get(), "brokers");
    if (!cJSON_IsArray(brokers) || cJSON_GetArraySize(brokers) > 4096) {
        result.error = "Invalid broker list response"; return result;
    }
    for (auto* entry = brokers->child; entry; entry = entry->next) {
        const char* id = text(entry, "id"), *name = text(entry, "name");
        auto* online = cJSON_GetObjectItemCaseSensitive(entry, "online");
        if (!id || !*id || std::strlen(id) > 128 || !name || std::strlen(name) > 256 || !cJSON_IsBool(online)) {
            result.error = "Invalid broker list response"; result.brokers.clear(); return result;
        }
        result.brokers.push_back({id, name, cJSON_IsTrue(online) != 0});
    }
    return result;
}
Result Client::connect(const Inputs& input, Cancellation& cancellation) {
    Result result;
    if (peer_ || api_) { result.error = "Close the current broker connection first"; return result; }
    Status connecting; connecting.state = "connecting"; connecting.brokerId = input.brokerId; connecting.remotePort = input.remotePort;
    if (!publishCurrent(connecting, cancellation)) { result.error = "Broker operation cancelled"; return result; }
    const char* roots = prepareApi(input);
    if (cancelled(&cancellation)) { result.error = "Broker operation cancelled"; return result; }
    ob_api_error apiErrorValue{};
    auto api = newApi(input, roots, apiErrorValue);
    if (!api) {
        result.error = apiError(apiErrorValue);
        connecting.state = "failed"; connecting.error = result.error;
        publishCurrent(std::move(connecting), cancellation);
        return result;
    }
    api_ = api.release();
    peerGeneration_ = cancellation.generation;
    ob_remote_connect_options options{};
    options.relay_mode = OB_REMOTE_RELAY_AUTO; options.timeout_ms = 30000;
    options.max_maps = 1; options.max_flows = 128;
    ob_remote_error error{};
    int code = ob_remote_connect_async(api_, input.brokerId.c_str(), input.peerPassword.c_str(), &options, &peer_, &error);
    if (!code && !cancelled(&cancellation))
        code = ob_remote_portmap_tcp(peer_, "127.0.0.1", 0, "127.0.0.1", static_cast<std::uint16_t>(input.remotePort), &map_, &error);
    if (code) {
        if (peer_) {
            ob_remote_connection_info info{};
            if (ob_remote_peer_get_state(peer_, &info) == OB_REMOTE_OK &&
                (info.state == OB_REMOTE_STATE_FAILED || info.state == OB_REMOTE_STATE_CLOSED) && info.last_error.code) {
                error = info.last_error; code = error.code;
            }
        }
        result.error = peerError(code, error.http_status);
        if (error.http_status == 401 || error.http_status == 403) result.errorCode = "DSH_BROKER_AUTH";
        connecting.state = "failed"; connecting.error = result.error;
        connecting.errorCode = result.errorCode == "DSH_BROKER_AUTH" ? result.errorCode : "";
        publishCurrent(std::move(connecting), cancellation);
        return result;
    }
    if (cancelled(&cancellation)) { result.error = "Broker operation cancelled"; return result; }
    connecting.localPort = ob_remote_map_local_port(map_);
    connecting.localUrl = "http://127.0.0.1:" + std::to_string(connecting.localPort) + "/";
    publishCurrent(std::move(connecting), cancellation);
    // The persistent async handle allows Close to interrupt this wait. SDK
    // workers own retry scheduling and retain the single map through recovery.
    while (!cancelled(&cancellation)) {
        checkPeer();
        Status current = status();
        if (current.state == "connected") { result.status = std::move(current); return result; }
        if (current.state == "paused" || current.state == "failed" || current.state == "closed") {
            result.error = current.error.empty() ? "Broker connection is not available" : current.error;
            if (!current.errorCode.empty()) result.errorCode = current.errorCode;
            return result;
        }
        std::unique_lock<std::mutex> lock(queueMutex_);
        wake_.wait_for(lock, std::chrono::milliseconds(100), [&] { return cancelled(&cancellation); });
    }
    result.error = "Broker operation cancelled";
    return result;
}
Result Client::reconnect(Cancellation& cancellation) {
    Result result;
    if (!peer_ || !map_) { result.error = "No broker connection is available to reconnect"; return result; }
    checkPeer();
    Status current = status();
    if (current.state == "failed" || current.state == "closed") {
        result.error = current.error.empty() ? "Broker connection cannot be resumed" : current.error;
        if (!current.errorCode.empty()) result.errorCode = current.errorCode;
        return result;
    }
    if (current.state == "paused" && !cancelled(&cancellation)) {
        ob_remote_error error{};
        const int code = ob_remote_peer_reconnect(peer_, &error);
        if (code) {
            result.error = peerError(code, error.http_status);
            if (error.http_status == 401 || error.http_status == 403) result.errorCode = "DSH_BROKER_AUTH";
            return result;
        }
        checkPeer();
    }
    // Acceptance is asynchronous. A still-paused or reconnecting snapshot is
    // returned unchanged; readiness belongs to later SDK state observations.
    result.status = status();
    return result;
}
Result Client::probe(const Inputs& input, Cancellation& cancellation) {
    Result result; result.probeState = "unreachable";
    constexpr char prefix[] = "http://127.0.0.1:";
    if (input.origin.rfind(prefix, 0) != 0) { result.error = "DSH probe requires a numeric loopback origin"; return result; }
    auto port = input.origin.substr(sizeof(prefix) - 1);
    if (!port.empty() && port.back() == '/') port.pop_back();
    if (port.empty() || port.size() > 5 || port.find_first_not_of("0123456789") != std::string::npos ||
        std::stoi(port) < 1 || std::stoi(port) > 65535) {
        result.error = "Invalid DSH probe loopback port"; return result;
    }
    std::string origin = std::string(prefix) + port;
    static std::once_flag once;
    static CURLcode initialized = CURLE_FAILED_INIT;
    std::call_once(once, [] { initialized = curl_global_init(CURL_GLOBAL_DEFAULT); });
    if (initialized != CURLE_OK) return result;
    std::unique_ptr<curl_slist, HeadersDelete> headers;
    std::unique_ptr<CURL, CurlDelete> easy(curl_easy_init());
    if (!easy) return result;
    char* encoded = curl_easy_escape(easy.get(), input.token.data(), static_cast<int>(input.token.size()));
    if (!encoded) return result;
    std::string url = origin + "/?token=" + encoded;
    OPENSSL_cleanse(encoded, std::strlen(encoded)); curl_free(encoded);
    ProbeResponse response;
    auto set = [&](CURLoption option, auto value) { return curl_easy_setopt(easy.get(), option, value) == CURLE_OK; };
    if (!set(CURLOPT_URL, url.c_str()) || !set(CURLOPT_PROXY, "") || !set(CURLOPT_NOSIGNAL, 1L) ||
        !set(CURLOPT_TIMEOUT_MS, 15000L) || !set(CURLOPT_CONNECTTIMEOUT_MS, 5000L) ||
        !set(CURLOPT_FOLLOWLOCATION, 0L) || !set(CURLOPT_PROTOCOLS_STR, "http") ||
        !set(CURLOPT_WRITEFUNCTION, probeBody) ||
        !set(CURLOPT_WRITEDATA, &response) || !set(CURLOPT_HEADERFUNCTION, probeHeader) ||
        !set(CURLOPT_HEADERDATA, &response) || !set(CURLOPT_NOPROGRESS, 0L) ||
        !set(CURLOPT_XFERINFOFUNCTION, +[](void* data, curl_off_t, curl_off_t, curl_off_t, curl_off_t) { return cancelled(data); }) ||
        !set(CURLOPT_XFERINFODATA, &cancellation)) { wipe(url); return result; }
    auto code = curl_easy_perform(easy.get()); wipe(url);
    long status = 0; curl_easy_getinfo(easy.get(), CURLINFO_RESPONSE_CODE, &status); result.httpStatus = static_cast<int>(status);
    if (code != CURLE_OK) return result;
    if (status == 401) { result.probeState = "unauthorized"; return result; }
    if (status == 403) { result.probeState = "forbidden"; return result; }
    if (status != 303 || response.cookie.empty() || (response.location != "/" && response.location != "./" && response.location != origin + "/")) {
        result.probeState = "not-dsh"; return result;
    }
    // The SDK's curl profile disables ambient cookie persistence. Keep only
    // cookies from this single verified token exchange for the same-origin GET.
    std::string cookie = "Cookie: " + response.cookie;
    headers.reset(curl_slist_append(nullptr, cookie.c_str()));
    wipe(cookie); wipe(response.cookie);
    if (!headers) return result;
    response = ProbeResponse{};
    std::string home = origin + "/";
    if (!set(CURLOPT_HTTPHEADER, headers.get()) || !set(CURLOPT_URL, home.c_str())) return result;
    code = curl_easy_perform(easy.get());
    curl_easy_getinfo(easy.get(), CURLINFO_RESPONSE_CODE, &status); result.httpStatus = static_cast<int>(status);
    if (code != CURLE_OK) return result;
    result.probeState = status == 200 && response.body.find("__DSH_BOOT__") != std::string::npos ? "ok" :
        status == 401 ? "unauthorized" : status == 403 ? "forbidden" : "not-dsh";
    return result;
}
} // namespace dsh::broker
