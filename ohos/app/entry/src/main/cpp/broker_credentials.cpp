#include "broker_credentials.h"
#include "broker_sdk/ob_json.h"
#include <cjson/cJSON.h>
#include <openssl/mem.h>
#include <openssl/rand.h>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstring>
#include <cstdint>
#include <fcntl.h>
#include <memory>
#include <stdexcept>
#include <sys/file.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

namespace dsh::broker {
namespace {
using dsh::launcher::Fd;
struct JsonDelete { void operator()(cJSON* value) const { cJSON_Delete(value); } };
using Json = std::unique_ptr<cJSON, JsonDelete>;
struct SecretText {
    std::string value;
    ~SecretText() { if (!value.empty()) OPENSSL_cleanse(value.data(), value.size()); }
};
void fail() { throw std::runtime_error("Account credential storage is unavailable"); }
void privateFile(int fd) {
    struct stat st{};
    if (fd < 0 || fstat(fd, &st) || !S_ISREG(st.st_mode) || st.st_uid != geteuid() ||
        (st.st_mode & 07777) != 0600 || st.st_nlink != 1) fail();
}
const char* string(cJSON* object, const char* name) {
    auto* entry = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!cJSON_IsString(entry)) fail();
    return entry->valuestring;
}
std::int64_t number(cJSON* object, const char* name) {
    auto* entry = cJSON_GetObjectItemCaseSensitive(object, name);
    if (!cJSON_IsNumber(entry) || !std::isfinite(entry->valuedouble) || entry->valuedouble < 1 ||
        entry->valuedouble > 9007199254740991.0 || std::floor(entry->valuedouble) != entry->valuedouble) fail();
    return static_cast<std::int64_t>(entry->valuedouble);
}
template<std::size_t N> void copy(char (&target)[N], cJSON* object, const char* name) {
    const auto* value = string(object, name);
    if (std::strlen(value) != N - 1) fail();
    std::memcpy(target, value, N);
}
bool hex(const char* value) {
    return std::strlen(value) == 64 && std::strspn(value, "0123456789abcdef") == 64;
}
void validate(const ob_auth_credentials& value) {
    if (!CredentialStore::validSession(value.auth_session_id) || !hex(value.token) || !hex(value.refresh_token) ||
        !std::strcmp(value.token, value.refresh_token) || !value.generation || value.generation > 9007199254740991ULL ||
        value.token_expires_at_ms <= 0 || value.refresh_expires_at_ms <= 0) fail();
}
void addString(cJSON* object, const char* name, const char* value) {
    if (!cJSON_AddStringToObject(object, name, value)) fail();
}
void addNumber(cJSON* object, const char* name, std::int64_t value) {
    if (!cJSON_AddNumberToObject(object, name, static_cast<double>(value))) fail();
}
void eraseJson(cJSON* value) {
    for (auto* child = value ? value->child : nullptr; child; child = child->next) {
        if (child->valuestring) OPENSSL_cleanse(child->valuestring, std::strlen(child->valuestring));
        eraseJson(child);
    }
}
struct EraseJson {
    cJSON* value;
    ~EraseJson() { eraseJson(value); }
};
} // namespace

void ensurePrivateDirectory(const std::string& path) {
    if (path.empty() || path.front() != '/' || path.size() > 900) fail();
    const auto directoryPath = path.substr(0, path.find_last_not_of('/') + 1);
    if (directoryPath.empty()) fail();
    constexpr int flags = O_PATH | O_DIRECTORY | O_CLOEXEC;
    Fd directory(open("/", flags));
    if (directory.value < 0) fail();
    for (std::size_t pos = 1; pos < directoryPath.size();) {
        const auto end = directoryPath.find('/', pos);
        const auto part = directoryPath.substr(pos, end == std::string::npos ? end : end - pos);
        pos = end == std::string::npos ? directoryPath.size() : end + 1;
        if (part.empty()) continue;
        if (part == "." || part == "..") fail();
        int next = openat(directory.value, part.c_str(), flags | O_NOFOLLOW);
        bool created = false;
        if (next < 0 && errno == ENOENT) {
            if (mkdirat(directory.value, part.c_str(), 0700) && errno != EEXIST) fail();
            created = true;
            next = openat(directory.value, part.c_str(), flags | O_NOFOLLOW);
        }
        if (next < 0) fail();
        Fd child(next);
        if (created || pos == directoryPath.size()) {
            // Publish directory entries durably, including retry after an earlier sync failure.
            Fd parent(openat(directory.value, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC));
            if (parent.value < 0 || fsync(parent.value)) fail();
        }
        next = child.value;
        child.value = -1;
        directory.reset(next);
    }
    struct stat st{};
    if (fstat(directory.value, &st) || st.st_uid != geteuid() || (st.st_mode & 07777) != 0700) fail();
}

bool CredentialStore::validSession(const std::string& session) {
    if (session.size() != 36 || session[14] != '4' || std::string("89ab").find(session[19]) == std::string::npos) return false;
    for (std::size_t i = 0; i < session.size(); ++i) {
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (session[i] != '-') return false; }
        else if (std::string("0123456789abcdef").find(session[i]) == std::string::npos) return false;
    }
    return true;
}
CredentialStore::Record::~Record() {
    ob_auth_credentials_clear(&credentials);
    ob_auth_pending_clear(&pending);
}
CredentialStore::CredentialStore(const std::string& root, const std::string& service, const std::string& session)
    : service_(service), session_(session), filename_(session + ".json") {
    if (!validSession(session)) fail();
    ensurePrivateDirectory(root);
    directory_.reset(open(root.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (directory_.value < 0) fail();
}
CredentialStore::~CredentialStore() { unlock(); }
void CredentialStore::lock() {
    if (lock_.value >= 0) fail();
    lock_.reset(openat(directory_.value, (session_ + ".lock").c_str(), O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0600));
    privateFile(lock_.value);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (flock(lock_.value, LOCK_EX | LOCK_NB)) {
        if ((errno != EWOULDBLOCK && errno != EAGAIN && errno != EINTR) || std::chrono::steady_clock::now() >= deadline) {
            unlock(); fail();
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}
void CredentialStore::unlock() { lock_.reset(); }
CredentialStore::Record CredentialStore::read() {
    Fd file(openat(directory_.value, filename_.c_str(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC));
    privateFile(file.value);
    struct stat st{};
    if (fstat(file.value, &st) || st.st_size < 1 || st.st_size > 8192) fail();
    SecretText raw;
    raw.value.resize(static_cast<std::size_t>(st.st_size));
    std::size_t pos = 0;
    while (pos < raw.value.size()) {
        const auto count = ::read(file.value, raw.value.data() + pos, raw.value.size() - pos);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) fail();
        pos += static_cast<std::size_t>(count);
    }
    Json json(ob_json_parse_complete(raw.value.data(), raw.value.size()));
    EraseJson erase{json.get()};
    if (!json || number(json.get(), "version") != 1 || service_ != string(json.get(), "serviceUrl")) fail();
    Record result;
    copy(result.credentials.auth_session_id, json.get(), "authSessionId");
    copy(result.credentials.token, json.get(), "accessToken");
    copy(result.credentials.refresh_token, json.get(), "refreshToken");
    result.credentials.generation = static_cast<std::uint64_t>(number(json.get(), "generation"));
    result.credentials.token_expires_at_ms = number(json.get(), "tokenExpiresAtMs");
    result.credentials.refresh_expires_at_ms = number(json.get(), "refreshExpiresAtMs");
    if (session_ != result.credentials.auth_session_id) fail();
    validate(result.credentials);
    auto* pending = cJSON_GetObjectItemCaseSensitive(json.get(), "pending");
    if (pending && !cJSON_IsNull(pending)) {
        if (!cJSON_IsObject(pending)) fail();
        copy(result.pending.auth_session_id, pending, "authSessionId");
        copy(result.pending.request_id, pending, "requestId");
        copy(result.pending.next_token, pending, "nextToken");
        copy(result.pending.next_refresh_token, pending, "nextRefreshToken");
        result.pending.expected_generation = static_cast<std::uint64_t>(number(pending, "expectedGeneration"));
        if (session_ != result.pending.auth_session_id || !validSession(result.pending.request_id) ||
            !hex(result.pending.next_token) || !hex(result.pending.next_refresh_token)) fail();
        result.hasPending = result.pending.expected_generation >= result.credentials.generation;
    }
    return result;
}
void CredentialStore::write(const Record& record) {
    validate(record.credentials);
    if (session_ != record.credentials.auth_session_id || lock_.value < 0) fail();
    Json json(cJSON_CreateObject());
    EraseJson erase{json.get()};
    if (!json) fail();
    addNumber(json.get(), "version", 1);
    addString(json.get(), "serviceUrl", service_.c_str());
    addString(json.get(), "authSessionId", record.credentials.auth_session_id);
    addString(json.get(), "accessToken", record.credentials.token);
    addString(json.get(), "refreshToken", record.credentials.refresh_token);
    addNumber(json.get(), "generation", static_cast<std::int64_t>(record.credentials.generation));
    addNumber(json.get(), "tokenExpiresAtMs", record.credentials.token_expires_at_ms);
    addNumber(json.get(), "refreshExpiresAtMs", record.credentials.refresh_expires_at_ms);
    if (record.hasPending) {
        auto* pending = cJSON_AddObjectToObject(json.get(), "pending");
        if (!pending) fail();
        addString(pending, "authSessionId", record.pending.auth_session_id);
        addString(pending, "requestId", record.pending.request_id);
        addString(pending, "nextToken", record.pending.next_token);
        addString(pending, "nextRefreshToken", record.pending.next_refresh_token);
        addNumber(pending, "expectedGeneration", static_cast<std::int64_t>(record.pending.expected_generation));
    }
    char* printed = cJSON_PrintUnformatted(json.get());
    if (!printed) fail();
    SecretText bytes;
    try { bytes.value = printed; } catch (...) { OPENSSL_cleanse(printed, std::strlen(printed)); cJSON_free(printed); throw; }
    OPENSSL_cleanse(printed, std::strlen(printed)); cJSON_free(printed);
    unsigned char random[16];
    if (RAND_bytes(random, sizeof(random)) != 1) fail();
    std::string temporary = session_ + ".write-";
    constexpr char digits[] = "0123456789abcdef";
    for (auto byte : random) { temporary += digits[byte >> 4]; temporary += digits[byte & 15]; }
    Fd file(openat(directory_.value, temporary.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (file.value < 0) fail();
    try {
        privateFile(file.value);
        std::size_t pos = 0;
        while (pos < bytes.value.size()) {
            const auto count = ::write(file.value, bytes.value.data() + pos, bytes.value.size() - pos);
            if (count < 0 && errno == EINTR) continue;
            if (count <= 0) fail();
            pos += static_cast<std::size_t>(count);
        }
        if (fsync(file.value) || renameat(directory_.value, temporary.c_str(), directory_.value, filename_.c_str()) || fsync(directory_.value)) fail();
    } catch (...) { unlinkat(directory_.value, temporary.c_str(), 0); throw; }
}
void CredentialStore::saveLogin(const ob_auth_credentials& credentials) {
    lock();
    try { Record record; record.credentials = credentials; write(record); }
    catch (...) { unlock(); throw; }
    unlock();
}
ob_auth_options CredentialStore::options() {
    lock();
    ob_auth_options options{};
    try { auto record = read(); options.credentials = record.credentials; }
    catch (...) { unlock(); throw; }
    unlock();
    options.struct_size = sizeof(options); options.version = 1; options.user = this;
    options.begin = begin; options.prepare = prepare; options.commit = commit; options.end = end;
    return options;
}
int CredentialStore::begin(void* user, ob_auth_credentials* credentials, ob_auth_pending* pending, int* hasPending) {
    auto* store = static_cast<CredentialStore*>(user);
    try {
        store->lock(); auto record = store->read();
        *credentials = record.credentials; *pending = record.pending; *hasPending = record.hasPending ? 1 : 0;
        return 0;
    } catch (...) { return -1; }
}
int CredentialStore::prepare(void* user, const ob_auth_credentials* credentials, const ob_auth_pending* pending) {
    try {
        Record record; record.credentials = *credentials; record.pending = *pending; record.hasPending = true;
        static_cast<CredentialStore*>(user)->write(record); return 0;
    } catch (...) { return -1; }
}
int CredentialStore::commit(void* user, const ob_auth_credentials* credentials, const ob_auth_pending*) {
    try {
        Record record; record.credentials = *credentials;
        static_cast<CredentialStore*>(user)->write(record); return 0;
    } catch (...) { return -1; }
}
void CredentialStore::end(void* user) { static_cast<CredentialStore*>(user)->unlock(); }
} // namespace dsh::broker
