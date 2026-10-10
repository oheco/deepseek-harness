#include "broker_client.h"
#include "broker_trust.h"
#include "broker_credentials.h"
#include <cjson/cJSON.h>
#include <ctime>
#include <cerrno>
#include <sys/stat.h>
#include <curl/curl.h>
#include "broker_sdk/ob_api.h"
#include "broker_sdk/ob_remote.h"
#include <openssl/evp.h>
#include <openssl/pem.h>
#include <openssl/ssl.h>
#include <openssl/x509v3.h>
#include <arpa/inet.h>
#include <poll.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <cerrno>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
// Linker fault injection is confined to the standalone test binary, never the HAP.
static std::atomic<bool> failNextDirectorySync{false}, failNextListener{false};
extern "C" int __real_fsync(int fd);
extern "C" int __real_listen(int fd, int backlog);
extern "C" int __wrap_fsync(int fd) {
    struct stat info{};
    if (!fstat(fd, &info) && S_ISDIR(info.st_mode) && failNextDirectorySync.exchange(false)) {
        errno = EIO; return -1;
    }
    return __real_fsync(fd);
}
extern "C" int __wrap_listen(int fd, int backlog) {
    if (failNextListener.exchange(false)) { errno = EIO; return -1; }
    return __real_listen(fd, backlog);
}
using namespace dsh::broker;
using Clock = std::chrono::steady_clock;
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
std::string timestamp(std::time_t value) {
    std::tm result{}; gmtime_r(&value, &result);
    char text[32]; require(std::strftime(text, sizeof(text), "%Y-%m-%dT%H:%M:%SZ", &result) != 0, "fixture timestamp");
    return text;
}
SSL_CTX* certificate(const std::string& ca) {
    auto* keyContext = EVP_PKEY_CTX_new_id(EVP_PKEY_EC, nullptr);
    require(keyContext && EVP_PKEY_keygen_init(keyContext) == 1 &&
        EVP_PKEY_CTX_set_ec_paramgen_curve_nid(keyContext, NID_X9_62_prime256v1) == 1, "fixture key init");
    EVP_PKEY* key = nullptr; require(EVP_PKEY_keygen(keyContext, &key) == 1, "fixture keygen"); EVP_PKEY_CTX_free(keyContext);
    auto* cert = X509_new(); require(cert && X509_set_version(cert, 2) == 1, "fixture cert");
    require(ASN1_INTEGER_set(X509_get_serialNumber(cert), 1) == 1 &&
        X509_gmtime_adj(X509_get_notBefore(cert), -60) && X509_gmtime_adj(X509_get_notAfter(cert), 3600) &&
        X509_set_pubkey(cert, key) == 1, "fixture cert fields");
    auto* name = X509_get_subject_name(cert);
    require(X509_NAME_add_entry_by_txt(name, "CN", MBSTRING_ASC, reinterpret_cast<const unsigned char*>("local-fixture"), -1, -1, 0) == 1 &&
        X509_set_issuer_name(cert, name) == 1, "fixture cert name");
    X509V3_CTX v3; X509V3_set_ctx(&v3, cert, cert, nullptr, nullptr, 0);
    auto* extension = X509V3_EXT_nconf_nid(nullptr, &v3, NID_subject_alt_name, "IP:127.0.0.1");
    require(extension && X509_add_ext(cert, extension, -1) == 1 && X509_sign(cert, key, EVP_sha256()) > 0, "fixture cert sign");
    X509_EXTENSION_free(extension);
    auto* file = fopen(ca.c_str(), "w"); require(file && PEM_write_X509(file, cert) == 1, "fixture CA write"); fclose(file); chmod(ca.c_str(), 0600);
    auto* context = SSL_CTX_new(TLS_server_method()); require(context && SSL_CTX_use_certificate(context, cert) == 1 && SSL_CTX_use_PrivateKey(context, key) == 1, "fixture TLS context");
    X509_free(cert); EVP_PKEY_free(key); return context;
}
struct Fixture {
    int listener = -1, port = 0, upstreamPort = 0;
    SSL_CTX* tls = nullptr;
    std::atomic<bool> stop{false};
    std::atomic<int> requests{0};
    std::atomic<bool> dropRefreshReply{false};
    std::mutex authMutex;
    std::string accountToken = std::string(64, 'a'), refreshToken = std::string(64, 'b'), predecessorRequest;
    int authGeneration = 1;
    std::string accessDeadline, refreshDeadline;
    std::thread acceptor;
    std::mutex mutex;
    std::vector<int> clients;
    std::vector<std::thread> workers;
    Fixture(SSL_CTX* context = nullptr, int upstream = 0) : upstreamPort(upstream), tls(context) {
        listener = socket(AF_INET, SOCK_STREAM, 0); require(listener >= 0, "fixture socket");
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        require(bind(listener, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0 && listen(listener, 32) == 0, "fixture bind");
        socklen_t length = sizeof(address); require(getsockname(listener, reinterpret_cast<sockaddr*>(&address), &length) == 0, "fixture getsockname"); port = ntohs(address.sin_port);
        acceptor = std::thread([this] {
            while (!stop.load()) {
                int fd = accept(listener, nullptr, nullptr); if (fd < 0) break;
                std::lock_guard<std::mutex> lock(mutex); clients.push_back(fd);
                workers.emplace_back([this, fd] { serve(fd); std::lock_guard<std::mutex> done(mutex);
                    close(fd); clients.erase(std::remove(clients.begin(), clients.end(), fd), clients.end()); });
            }
        });
    }
    ~Fixture() {
        stop.store(true); shutdown(listener, SHUT_RDWR); acceptor.join(); close(listener);
        { std::lock_guard<std::mutex> lock(mutex); for (int fd : clients) shutdown(fd, SHUT_RDWR); }
        for (auto& worker : workers) worker.join();
    }
    static bool write(int fd, SSL* ssl, const char* data, std::size_t length) {
        while (length) {
            int n = ssl ? SSL_write(ssl, data, static_cast<int>(length)) : send(fd, data, length, MSG_NOSIGNAL);
            if (n <= 0) return false;
            length -= n; data += n;
        }
        return true;
    }
    void serve(int fd) {
        timeval timeout{3, 0}; setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
        SSL* ssl = tls ? SSL_new(tls) : nullptr;
        if (ssl) { SSL_set_fd(ssl, fd); if (SSL_accept(ssl) != 1) { SSL_free(ssl); return; } }
        if (upstreamPort) {
            int upstream = socket(AF_INET, SOCK_STREAM, 0);
            sockaddr_in target{}; target.sin_family = AF_INET; target.sin_addr.s_addr = htonl(INADDR_LOOPBACK); target.sin_port = htons(upstreamPort);
            if (upstream < 0 || ::connect(upstream, reinterpret_cast<sockaddr*>(&target), sizeof(target))) { if (upstream >= 0) close(upstream); SSL_free(ssl); return; }
            while (!stop.load()) {
                pollfd fds[] = {{fd, POLLIN, 0}, {upstream, POLLIN, 0}};
                int ready = poll(fds, 2, ssl && SSL_pending(ssl) ? 0 : 100);
                if (ready < 0) break;
                char bytes[32768];
                if ((fds[0].revents & POLLIN) || (ssl && SSL_pending(ssl))) {
                    int n = ssl ? SSL_read(ssl, bytes, sizeof(bytes)) : recv(fd, bytes, sizeof(bytes), 0);
                    if (n <= 0 || !write(upstream, nullptr, bytes, n)) break;
                }
                if (fds[1].revents & POLLIN) { int n = recv(upstream, bytes, sizeof(bytes), 0); if (n <= 0 || !write(fd, ssl, bytes, n)) break; }
                if (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL) || fds[1].revents & (POLLERR | POLLHUP | POLLNVAL)) break;
            }
            close(upstream); SSL_free(ssl); return;
        }
        std::string request;
        while (request.size() < 16384) {
            char bytes[8192]; int n = ssl ? SSL_read(ssl, bytes, sizeof(bytes)) : recv(fd, bytes, sizeof(bytes), 0);
            if (n <= 0) { SSL_free(ssl); return; } request.append(bytes, n);
            auto end = request.find("\r\n\r\n");
            if (end != std::string::npos) {
                std::size_t size = 0; auto cl = request.find("Content-Length:");
                if (cl < end) size = std::strtoul(request.c_str() + cl + 15, nullptr, 10);
                if (request.size() >= end + 4 + size) break;
            }
        }
        requests.fetch_add(1);
        if (request.find("GET /keep-open ") != std::string::npos) {
            const char upgrade[] = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n";
            if (write(fd, ssl, upgrade, sizeof(upgrade) - 1)) {
                char bytes[64];
                while (!stop.load()) {
                    int n = ssl ? SSL_read(ssl, bytes, sizeof(bytes)) : recv(fd, bytes, sizeof(bytes), 0);
                    if (n == 0 || (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) break;
                }
            }
            SSL_free(ssl); return;
        }
        int status = 200; std::string body, headers;
        if (request.find("/v1/auth/login ") != std::string::npos || request.find("/v1/tenants/login ") != std::string::npos) {
            require(request.find("Authorization:") == std::string::npos, "login sent bearer");
            if (request.find("\"slow\"") != std::string::npos) std::this_thread::sleep_for(std::chrono::seconds(2));
            if (request.find("\"bad\"") != std::string::npos) { status = 401; body = "{}"; }
            else {
                std::lock_guard<std::mutex> auth(authMutex);
                accessDeadline = timestamp(std::time(nullptr) + 3600);
                refreshDeadline = timestamp(std::time(nullptr) + 86400);
                body = "{\"tenant\":{},\"auth_session_id\":\"11111111-1111-4111-8111-111111111111\",\"generation\":" +
                    std::to_string(authGeneration) + ",\"token\":\"" + accountToken + "\",\"refresh_token\":\"" + refreshToken +
                    "\",\"token_expires_at\":\"" + accessDeadline + "\",\"refresh_expires_at\":\"" + refreshDeadline + "\"}";
            }
        } else if (request.find("/v1/auth/refresh ") != std::string::npos) {
            std::lock_guard<std::mutex> auth(authMutex);
            auto* json = cJSON_Parse(request.c_str() + request.find("\r\n\r\n") + 4);
            auto field = [&](const char* name) { auto* item = cJSON_GetObjectItemCaseSensitive(json, name); return cJSON_IsString(item) ? std::string(item->valuestring) : std::string(); };
            const auto requestId = field("request_id");
            if (requestId == predecessorRequest && !requestId.empty()) {
                // Replaying the exact pending request acknowledges the existing commit.
            } else if (request.find("Authorization: Bearer " + refreshToken) != std::string::npos) {
                accountToken = field("next_token"); refreshToken = field("next_refresh_token");
                predecessorRequest = requestId; ++authGeneration;
                accessDeadline = timestamp(std::time(nullptr) + 3600);
                refreshDeadline = timestamp(std::time(nullptr) + 86400);
            } else { status = 401; }
            cJSON_Delete(json);
            body = status == 200 ? "{\"auth_session_id\":\"11111111-1111-4111-8111-111111111111\",\"generation\":" +
                std::to_string(authGeneration) + ",\"token_expires_at\":\"" + accessDeadline +
                "\",\"refresh_expires_at\":\"" + refreshDeadline + "\"}" : "{}";
            if (dropRefreshReply.exchange(false)) { SSL_free(ssl); return; }
        } else if (request.find("/v1/brokers ") != std::string::npos) {
            std::lock_guard<std::mutex> auth(authMutex);
            if (request.find("Authorization: Bearer " + accountToken) == std::string::npos) { status = 401; body = "{}"; }
            else body = "{\"brokers\":[{\"id\":\"11111111-1111-4111-8111-111111111111\",\"name\":\"device\",\"online\":true}]}";
        } else if (request.find("/?token=valid ") != std::string::npos) { status = 303; headers = "Location: ./\r\nSet-Cookie: fixture-session=yes; Path=/; HttpOnly\r\n"; }
        else if (request.find("/?token=foreign ") != std::string::npos) { status = 303; headers = "Location: https://example.invalid/\r\nSet-Cookie: fixture-session=yes\r\n"; }
        else if (request.find("/?token=elsewhere ") != std::string::npos) { status = 303; headers = "Location: /other\r\nSet-Cookie: fixture-session=yes\r\n"; }
        else if (request.find("/?token=") != std::string::npos) { status = 403; body = "denied"; }
        else if (request.find("Cookie: fixture-session=yes") != std::string::npos) body = "<script>window.__DSH_BOOT__={}</script>";
        else { status = 401; body = "denied"; }
        std::string reply = "HTTP/1.1 " + std::to_string(status) + " Test\r\n" + headers + "Content-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
        write(fd, ssl, reply.data(), reply.size()); SSL_free(ssl);
    }
};
Inputs service(int port, const std::string& ca) { Inputs input; input.serviceUrl = "https://127.0.0.1:" + std::to_string(port); input.testCaPath = ca; return input; }
void basic(const std::string& root) {
    auto ca = root + "/fixture-ca.pem"; auto* context = certificate(ca);
    {
        Fixture fixture(context), web;
        Client client; auto input = service(fixture.port, ca); input.account = "account"; input.password = "password";
        input.tempDir = root + "/peer"; input.credentialDir = root + "/credentials";
        failNextDirectorySync.store(true);
        auto unsynced = client.submit(Method::Login, input).get();
        require(!unsynced.error.empty() && unsynced.authSessionId.empty() && !failNextDirectorySync.load(),
            "first login acknowledged an unsynced credential directory");
        auto start = Clock::now(); auto future = client.submit(Method::Login, input);
        require(Clock::now() - start < std::chrono::milliseconds(100), "submit blocked");
        auto login = future.get(); require(login.error.empty() && CredentialStore::validSession(login.authSessionId) && login.accessToken.empty(), "TLS managed login failed");
        input.authSessionId = login.authSessionId;
        auto list = client.submit(Method::List, input).get(); require(list.error.empty() && list.brokers.size() == 1 && list.brokers[0].online && list.brokers[0].name == "device", "typed list failed");
        auto expired = input; expired.authSessionId.clear(); expired.accessToken = "expired-token";
        require(client.submit(Method::List, expired).get().errorCode == "DSH_BROKER_AUTH", "expired account bearer classification");
        {
            CredentialStore store(input.credentialDir, input.serviceUrl, input.authSessionId);
            auto options = store.options();
            options.credentials.token_expires_at_ms = static_cast<std::int64_t>(std::time(nullptr)) * 1000 - 1000;
            store.saveLogin(options.credentials); ob_auth_credentials_clear(&options.credentials);
            fixture.dropRefreshReply.store(true);
            auto interrupted = client.submit(Method::List, input).get();
            require(!interrupted.error.empty(), "lost refresh response unexpectedly acknowledged");
            options = store.options();
            ob_auth_credentials current{}; ob_auth_pending pending{}; int hasPending = 0;
            require(options.begin(options.user, &current, &pending, &hasPending) == 0 && hasPending == 1,
                "interrupted refresh discarded durable pending request");
            options.end(options.user); ob_auth_credentials_clear(&current); ob_auth_pending_clear(&pending);
            ob_auth_credentials_clear(&options.credentials);
            Client restarted;
            auto recovered = restarted.submit(Method::List, input).get();
            require(recovered.error.empty() && recovered.brokers.size() == 1, "restart did not replay pending refresh");
            options = store.options();
            require(options.credentials.generation == 2, "refresh rotation was not durably committed");
            require(options.begin(options.user, &current, &pending, &hasPending) == 0 && hasPending == 0,
                "committed refresh retained pending journal");
            options.end(options.user); ob_auth_credentials_clear(&current); ob_auth_pending_clear(&pending);
            ob_auth_credentials_clear(&options.credentials); restarted.dispose();
            std::cout << "PASS expired access refresh, lost response journal and restarted client exact replay\n";
        }
        auto* trust = SSL_CTX_new(TLS_client_method()); require(trust, "system trust context");
        auto* certificateFile = fopen(ca.c_str(), "r");
        auto* privateCertificate = certificateFile ? PEM_read_X509(certificateFile, nullptr, nullptr, nullptr) : nullptr;
        if (certificateFile) fclose(certificateFile);
        require(privateCertificate && X509_STORE_add_cert(SSL_CTX_get_cert_store(trust), privateCertificate) == 1, "fixture preexisting trust");
        auto rootCount = loadSystemTrust(trust); require(rootCount > 0, "HarmonyOS system root loading failed");
        auto* verification = X509_STORE_CTX_new();
        require(verification && X509_STORE_CTX_init(verification, SSL_CTX_get_cert_store(trust), privateCertificate, nullptr) == 1
            && X509_verify_cert(verification) != 1, "system trust retained custom fixture root");
        X509_STORE_CTX_free(verification); X509_free(privateCertificate); SSL_CTX_free(trust);
        std::cout << "PASS HarmonyOS system roots loaded=" << rootCount << ", preexisting custom trust replaced\n";
        int beforeTlsFailure = fixture.requests.load();
        auto untrusted = input; untrusted.testCaPath.clear();
        require(client.submit(Method::Login, untrusted).get().error == "Broker HTTPS connection or certificate verification failed", "untrusted TLS accepted");
        auto trustBundle = createSystemTrustBundle(input.tempDir);
        ob_api_options defaultTrust{}; defaultTrust.base_url = untrusted.serviceUrl.c_str(); defaultTrust.ca_file = trustBundle.c_str();
        ob_api_error tlsError{}; auto* tlsApi = ob_api_client_create(&defaultTrust, &tlsError); require(tlsApi, "system trust API");
        char* tlsReceipt = nullptr;
        require(ob_api_tenant_login(tlsApi, "account", "password", &tlsReceipt, &tlsError) == OB_API_TRANSPORT
            && tlsError.transport_code == CURLE_PEER_FAILED_VERIFICATION, "self-signed server did not fail certificate verification");
        ob_api_response_free(tlsReceipt); ob_api_client_destroy(tlsApi); unlink(trustBundle.c_str());
        auto wrongHost = input; wrongHost.serviceUrl = "https://localhost:" + std::to_string(fixture.port);
        ob_api_options wrongHostOptions{}; wrongHostOptions.base_url = wrongHost.serviceUrl.c_str(); wrongHostOptions.ca_file = ca.c_str();
        tlsApi = ob_api_client_create(&wrongHostOptions, &tlsError); require(tlsApi, "wrong-host API");
        tlsReceipt = nullptr;
        require(ob_api_tenant_login(tlsApi, "account", "password", &tlsReceipt, &tlsError) == OB_API_TRANSPORT
            && tlsError.transport_code == CURLE_PEER_FAILED_VERIFICATION, "trusted certificate with wrong hostname accepted");
        ob_api_response_free(tlsReceipt); ob_api_client_destroy(tlsApi);
        require(fixture.requests.load() == beforeTlsFailure, "credentials reached a server with an invalid TLS certificate");
        std::cout << "PASS self-signed and wrong-host HTTPS rejected before account credentials\n";
        input.authSessionId.clear(); input.password = "bad"; require(client.submit(Method::Login, input).get().error == "Account login is required or has expired", "wrong password diagnostic");
        Inputs probe; probe.origin = "http://127.0.0.1:" + std::to_string(web.port); probe.token = "valid";
        auto good = client.submit(Method::Probe, probe).get(); require(good.error.empty() && good.probeState == "ok" && good.httpStatus == 200, "DSH fresh cookie exchange failed");
        probe.token = "wrong"; auto bad = client.submit(Method::Probe, probe).get(); require(bad.probeState == "forbidden" && bad.httpStatus == 403 && bad.errorCode == "DSH_BROKER", "wrong DSH token reused cookie or was treated as management expiry");
        probe.token = "foreign"; require(client.submit(Method::Probe, probe).get().probeState == "not-dsh", "cross-origin DSH redirect followed");
        probe.token = "elsewhere"; require(client.submit(Method::Probe, probe).get().probeState == "not-dsh", "non-root DSH redirect followed");
        probe.origin = "http://localhost:1"; require(!client.submit(Method::Probe, probe).get().error.empty(), "non-numeric loopback accepted");
        input.password = "password"; input.account = "slow";
        int before = fixture.requests.load(); auto slow = client.submit(Method::Login, input);
        for (int n = 0; n < 200 && fixture.requests.load() == before; ++n) std::this_thread::sleep_for(std::chrono::milliseconds(5));
        require(fixture.requests.load() > before, "slow operation not started");
        auto queued = client.submit(Method::List, input); start = Clock::now();
        auto close = client.submit(Method::Close, {});
        require(slow.get().error == "Broker operation cancelled" && queued.get().error == "Broker operation cancelled", "close did not cancel inflight and queued work");
        require(close.get().error.empty() && client.status().state == "idle" && Clock::now() - start < std::chrono::seconds(4), "close did not settle quiescent");
        client.dispose();
        bool rejected = false; try { client.submit(Method::List, input); } catch (const std::exception&) { rejected = true; }
        require(rejected, "dispose accepted new work");
        std::cout << "PASS HTTPS verified login/list, TLS rejection, async FIFO cancellation, close/dispose, fresh DSH cookie probe\n";
    }
    SSL_CTX_free(context); unlink(ca.c_str());
}
void publicHttps() {
    auto* easy = curl_easy_init(); require(easy, "public HTTPS probe handle");
    auto option = [&](CURLoption name, auto value) { require(curl_easy_setopt(easy, name, value) == CURLE_OK, "public HTTPS probe options"); };
    option(CURLOPT_URL, "https://broker.oheco.org/");
    option(CURLOPT_PROXY, "socks5h://127.0.0.1:10808");
    option(CURLOPT_NOBODY, 1L); option(CURLOPT_NOSIGNAL, 1L);
    option(CURLOPT_TIMEOUT_MS, 15000L); option(CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    option(CURLOPT_FOLLOWLOCATION, 0L); option(CURLOPT_PROTOCOLS_STR, "https");
    option(CURLOPT_CAINFO, static_cast<const char*>(nullptr)); option(CURLOPT_CAPATH, static_cast<const char*>(nullptr));
    option(CURLOPT_SSL_VERIFYPEER, 1L); option(CURLOPT_SSL_VERIFYHOST, 2L);
    option(CURLOPT_SSLVERSION, static_cast<long>(CURL_SSLVERSION_TLSv1_2));
    option(CURLOPT_SSL_CTX_FUNCTION, +[](CURL*, void* context, void*) {
        SSL_CTX_set_keylog_callback(static_cast<SSL_CTX*>(context), nullptr);
        return configureSystemTrust(context) ? CURLE_SSL_CACERT_BADFILE : CURLE_OK;
    });
    auto code = curl_easy_perform(easy); long status = 0;
    curl_easy_getinfo(easy, CURLINFO_RESPONSE_CODE, &status); curl_easy_cleanup(easy);
    if (code != CURLE_OK) std::cout << "INFO public HTTPS probe transport code=" << static_cast<int>(code) << ", HTTP status=" << status << '\n';
    require(code == CURLE_OK && status >= 100 && status <= 599, "read-only public broker HTTPS system verification failed");
    std::cout << "PASS read-only public broker HTTPS with system roots, HTTP status=" << status << '\n';
}
void integration(const std::string& root, int upstreamPort) {
    auto ca = root + "/integration-ca.pem"; auto* context = certificate(ca);
    {
        Fixture proxy(context, upstreamPort), web;
        const char* realPort = std::getenv("DSH_BROKER_REAL_DSH_PORT");
        const char* realToken = std::getenv("DSH_BROKER_REAL_DSH_TOKEN");
        int targetPort = realPort ? std::atoi(realPort) : web.port;
        require(targetPort > 0 && targetPort <= 65535 && (!realPort || (realToken && *realToken)), "real DSH driver inputs");
        auto input = service(proxy.port, ca); input.tempDir = root + "/peer"; input.credentialDir = root + "/credentials";
        ob_api_options apiOptions{}; apiOptions.base_url = input.serviceUrl.c_str(); apiOptions.ca_file = ca.c_str();
        ob_api_error error{}; auto* api = ob_api_client_create(&apiOptions, &error); require(api, "integration api");
        ob_api_credentials credentials{}; char* receipt = nullptr;
        require(ob_api_tenant_register(api, &credentials, &receipt, &error) == 0, "integration account registration");
        ob_api_response_free(receipt); ob_api_client_destroy(api);
        Client client; input.account = credentials.name; input.password = credentials.password;
        auto login = client.submit(Method::Login, input).get(); require(login.error.empty(), "integration account login"); input.authSessionId = login.authSessionId;
        CredentialStore store(input.credentialDir, input.serviceUrl, input.authSessionId);
        auto auth = store.options();
        api = ob_api_client_create_with_auth(&apiOptions, &auth, &error);
        ob_auth_credentials_clear(&auth.credentials); require(api, "integration managed api");
        ob_remote_allow_rule rule{"127.0.0.1", static_cast<uint16_t>(targetPort), static_cast<uint16_t>(targetPort), OB_REMOTE_TCP};
        ob_remote_serve_options serveOptions{}; serveOptions.allow_rules = &rule; serveOptions.allow_rule_count = 1;
        serveOptions.stun_server = "127.0.0.1"; serveOptions.stun_port = 9;
        ob_remote_server* server = nullptr; ob_remote_error remoteError{};
        int serveCode = ob_remote_serve(api, "app-integration", "peer-test-password", &serveOptions, &server, &remoteError);
        if (serveCode) std::cerr << "serve code=" << serveCode << " http=" << remoteError.http_status << " diagnostic=" << remoteError.message << '\n';
        require(serveCode == 0, "integration native serve");
        auto list = client.submit(Method::List, input).get(); require(list.error.empty() && list.brokers.size() == 1 && list.brokers[0].online, "integration list live broker");
        input.brokerId = list.brokers[0].id; input.remotePort = targetPort; input.peerPassword = "wrong-peer-password"; input.tempDir = root + "/peer";
        auto expired = input; expired.authSessionId.clear(); expired.accessToken = "expired-management-token";
        require(client.submit(Method::Connect, expired).get().errorCode == "DSH_BROKER_AUTH", "connect management bearer classification");
        client.submit(Method::Close, {}).get();
        auto wrong = client.submit(Method::Connect, input).get(); require(!wrong.error.empty() && wrong.errorCode == "DSH_BROKER", "wrong peer password accepted or classified as management expiry");
        client.submit(Method::Close, {}).get(); input.peerPassword = "peer-test-password";
        auto unused = client.submit(Method::Connect, input).get();
        require(unused.error.empty(), "unused mapping setup");
        client.submit(Method::Close, {}).get();
        input.localPort = unused.status.localPort;
        auto reused = client.submit(Method::Connect, input).get();
        require(reused.error.empty() && reused.status.localPort == input.localPort, "available preferred listener was not reused");
        client.submit(Method::Close, {}).get();
        failNextListener.store(true);
        auto listenerFailure = client.submit(Method::Connect, input).get();
        require(!listenerFailure.error.empty() && !failNextListener.load(),
            "listen failure changed an available preferred port instead of reporting failure");
        client.submit(Method::Close, {}).get();
        std::cout << "PASS available preferred port reuse and non-bind listener failure does not fall back\n";
        Fixture occupied;
        input.localPort = occupied.port;
        for (int n = 0; n < 2; ++n) {
            auto connected = client.submit(Method::Connect, input).get();
            if (!connected.error.empty()) std::cerr << "integration connect iteration=" << n << ": " << connected.error << '\n';
            require(connected.error.empty() && connected.status.state == "connected" && connected.status.localPort > 0 && connected.status.remotePort == targetPort, "integration mapped connection failed");
            if (n == 0) require(connected.status.localPort != occupied.port, "occupied preferred port did not fall back");
            input.localPort = connected.status.localPort;
            auto snapshot = client.submit(Method::Status, {}).get();
            auto wake = client.submit(Method::Reconnect, {}).get();
            require(snapshot.error.empty() && wake.error.empty() && snapshot.status.state == "connected" &&
                wake.status.state == "connected" && snapshot.status.localUrl == connected.status.localUrl &&
                wake.status.localPort == connected.status.localPort, "healthy wake replaced the owned SDK listener");
            Inputs probe; probe.origin = connected.status.localUrl; probe.token = realToken ? realToken : "valid";
            auto result = client.submit(Method::Probe, probe).get(); require(result.probeState == "ok", "mapped HTTP token/cookie content failed");
            probe.token = "wrong"; auto badProbe = client.submit(Method::Probe, probe).get();
            require(badProbe.probeState == "forbidden" || badProbe.probeState == "unauthorized", "mapped wrong DSH token accepted");
            if (n == 0 && realPort && std::getenv("DSH_BROKER_HOLD")) {
                std::cout << "MAP_READY=" << connected.status.localPort << std::endl;
                std::string command; std::getline(std::cin, command);
            }
            int held = -1;
            if (!realPort) {
                held = socket(AF_INET, SOCK_STREAM, 0); require(held >= 0, "held WebSocket socket");
                timeval deadline{5, 0}; setsockopt(held, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline));
                sockaddr_in mapping{}; mapping.sin_family = AF_INET; mapping.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
                mapping.sin_port = htons(connected.status.localPort);
                require(::connect(held, reinterpret_cast<sockaddr*>(&mapping), sizeof(mapping)) == 0, "held WebSocket connect");
                const char request[] = "GET /keep-open HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n";
                require(Fixture::write(held, nullptr, request, sizeof(request) - 1), "held WebSocket upgrade send");
                char bytes[1024]; int received = recv(held, bytes, sizeof(bytes), 0);
                require(received > 0 && std::string(bytes, received).find("101 Switching Protocols") != std::string::npos, "held WebSocket upgrade acknowledgement");
            }
            client.submit(Method::Close, {}).get(); require(client.status().state == "idle" && client.status().localPort == 0, "mapping close status");
            if (held >= 0) { char byte; require(recv(held, &byte, 1, 0) == 0, "mapping close retained an accepted WebSocket"); close(held); }
            int fd = socket(AF_INET, SOCK_STREAM, 0); sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK); address.sin_port = htons(connected.status.localPort);
            require(::connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0, "closed map still listening"); close(fd);
        }
        auto pendingConnect = client.submit(Method::Connect, input);
        auto cancelDeadline = Clock::now() + std::chrono::seconds(2);
        while (client.status().state != "connecting" && Clock::now() < cancelDeadline)
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
        require(client.status().state == "connecting", "native setup did not start before cancellation");
        auto cancelledClose = client.submit(Method::Close, {});
        require(pendingConnect.get().error == "Broker operation cancelled" && cancelledClose.get().error.empty() && client.status().state == "idle", "in-flight native peer cancellation/quiescence failed");
        client.dispose(); ob_remote_server_close(server); ob_api_client_destroy(api); ob_api_credentials_clear(&credentials);
        std::cout << "PASS real control HTTPS/WSS, account login/list, peer-password rejection, PAKE ICE QUIC, dynamic TCP DSH cookie probe, healthy SDK wake keeps port, accepted WebSocket close, repeated connect/close and cancellation\n";
    }
    SSL_CTX_free(context); unlink(ca.c_str());
}
} // namespace
int main() {
    // The TLS fixture owns this standalone test process; application code never
    // changes signal dispositions.
    signal(SIGPIPE, SIG_IGN);
    std::string pattern = std::string(std::getenv("TMPDIR") ? std::getenv("TMPDIR") : "") + "/dsh-broker-test.XXXXXX";
    char* directory = mkdtemp(pattern.data()); if (!directory) return 2;
    try {
        basic(directory);
        if (const char* enabled = std::getenv("DSH_BROKER_READONLY_HTTPS")) {
            if (std::strcmp(enabled, "1") == 0) publicHttps();
        }
        if (const char* port = std::getenv("DSH_BROKER_FIXTURE_PORT")) integration(directory, std::atoi(port));
        // The owning Python TemporaryDirectory removes journals and peer certificate directories.
        return 0;
    } catch (const std::exception& error) { std::cerr << "FAIL " << error.what() << '\n'; return 1; }
}
