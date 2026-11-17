#include "connection_log.h"

#include <cerrno>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <mutex>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

#ifdef DSH_CONNECTION_DIAGNOSTICS_HILOG
#include <hilog/log.h>
#endif

namespace dsh::diagnostics {
namespace {
constexpr std::size_t kFileBytes = 1024 * 1024;
constexpr std::size_t kReadBytes = 2 * kFileBytes;
constexpr const char* kCurrent = "connection.log";
constexpr const char* kPrevious = "connection.previous.log";
std::mutex journalMutex;
int directoryFd = -1;
unsigned long writeFailures = 0;

bool asciiLetter(char c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
bool digit(char c) { return c >= '0' && c <= '9'; }
bool eventName(const std::string& event) {
    if (event.empty() || event.size() > 80) return false;
    for (const char c : event) if (!asciiLetter(c) && !digit(c) && c != '_' && c != '.' && c != '-') return false;
    return true;
}
bool numericFields(const std::string& fields) {
    if (fields.size() > 1024) return false;
    std::size_t pos = 0;
    while (pos < fields.size()) {
        std::size_t start = pos;
        if (!asciiLetter(fields[pos])) return false;
        while (pos < fields.size() && (asciiLetter(fields[pos]) || digit(fields[pos]) || fields[pos] == '_')) ++pos;
        if (pos - start > 32 || pos == fields.size() || fields[pos++] != '=') return false;
        if (pos < fields.size() && fields[pos] == '-') ++pos;
        start = pos;
        while (pos < fields.size() && digit(fields[pos])) ++pos;
        if (start == pos || pos - start > 20) return false;
        if (pos == fields.size()) break;
        if (fields[pos++] != ' ' || pos == fields.size()) return false;
    }
    return true;
}
bool privateDirectory(int fd) {
    struct stat info{};
    return fstat(fd, &info) == 0 && S_ISDIR(info.st_mode) && info.st_uid == geteuid() && (info.st_mode & 0777) == 0700;
}
bool privateFile(int fd, std::size_t limit) {
    struct stat info{};
    return fstat(fd, &info) == 0 && S_ISREG(info.st_mode) && info.st_uid == geteuid() &&
        info.st_nlink == 1 && (info.st_mode & 0777) == 0600 && info.st_size >= 0 &&
        static_cast<unsigned long long>(info.st_size) <= limit;
}
int openLog(const char* name, bool create) {
    int flags = O_CLOEXEC | O_NOFOLLOW | O_NONBLOCK | (create ? O_WRONLY | O_APPEND | O_CREAT : O_RDONLY);
    const int fd = openat(directoryFd, name, flags, 0600);
    if (fd < 0) return -1;
    if (!privateFile(fd, kFileBytes)) { close(fd); errno = EPERM; return -1; }
    return fd;
}
bool writeAll(int fd, const std::string& text) {
    std::size_t pos = 0;
    while (pos < text.size()) {
        const auto count = ::write(fd, text.data() + pos, text.size() - pos);
        if (count > 0) pos += static_cast<std::size_t>(count);
        else if (count < 0 && errno == EINTR) continue;
        else return false;
    }
    return true;
}
std::string line(const char* source, const char* event, const std::string& fields) {
    const auto wall = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();
    const auto mono = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    const std::time_t seconds = static_cast<std::time_t>(wall / 1000);
    std::tm local{};
    localtime_r(&seconds, &local);
    char stamp[48];
    std::strftime(stamp, sizeof(stamp), "%Y-%m-%dT%H:%M:%S%z", &local);
    return std::string(stamp) + " wallMs=" + std::to_string(wall) + " monoMs=" + std::to_string(mono) +
        " pid=" + std::to_string(getpid()) + " source=" + source + " event=" + event +
        (fields.empty() ? "" : " " + fields) + "\n";
}
void appendLocked(const std::string& record) {
    if (directoryFd < 0) return;
    int fd = openLog(kCurrent, true);
    if (fd < 0) { ++writeFailures; return; }
    struct stat info{};
    if (fstat(fd, &info) != 0) { close(fd); ++writeFailures; return; }
    if (static_cast<std::size_t>(info.st_size) + record.size() > kFileBytes) {
        close(fd);
        const int previous = openLog(kPrevious, false);
        if (previous >= 0) close(previous);
        else if (errno != ENOENT) { ++writeFailures; return; }
        // Both names are fixed and validated inside the owner-only directory.
        if (renameat(directoryFd, kCurrent, directoryFd, kPrevious) != 0) { ++writeFailures; return; }
        fd = openLog(kCurrent, true);
        if (fd < 0) { ++writeFailures; return; }
    }
    if (!writeAll(fd, record)) ++writeFailures;
    close(fd);
}
void readFile(std::string& output, const char* name) {
    const int fd = openLog(name, false);
    if (fd < 0) {
        if (errno == ENOENT) return;
        throw std::runtime_error("Connection diagnostic journal cannot be read");
    }
    char buffer[8192];
    for (;;) {
        const auto count = ::read(fd, buffer, sizeof(buffer));
        if (count == 0) break;
        if (count < 0 && errno == EINTR) continue;
        if (count < 0 || output.size() + static_cast<std::size_t>(count) > kReadBytes) {
            close(fd); throw std::runtime_error("Connection diagnostic journal exceeds its read budget");
        }
        output.append(buffer, static_cast<std::size_t>(count));
    }
    close(fd);
}
} // namespace

void configure(const std::string& directory) {
    if (directory.empty() || directory.front() != '/' || directory.back() == '/' ||
        directory.find('\0') != std::string::npos || directory.find("/../") != std::string::npos ||
        directory.find("/./") != std::string::npos || directory.find("//") != std::string::npos ||
        directory.size() > 4096) throw std::invalid_argument("Invalid connection diagnostic directory");
    if (mkdir(directory.c_str(), 0700) != 0 && errno != EEXIST)
        throw std::runtime_error("Connection diagnostic directory cannot be created");
    const int fd = open(directory.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0 || !privateDirectory(fd)) {
        if (fd >= 0) close(fd);
        throw std::runtime_error("Connection diagnostic directory must be private");
    }
    std::lock_guard<std::mutex> lock(journalMutex);
    const int old = directoryFd;
    directoryFd = fd;
    const int current = openLog(kCurrent, true);
    if (current < 0) {
        directoryFd = old; close(fd);
        throw std::runtime_error("Connection diagnostic file must be private");
    }
    close(current);
    if (old >= 0) close(old);
}

void write(const char* source, const char* event, const std::string& fields) noexcept {
    try {
        if ((!std::strcmp(source, "app") || !std::strcmp(source, "native")) && eventName(event) && numericFields(fields)) {
            const auto record = line(source, event, fields);
            std::lock_guard<std::mutex> lock(journalMutex);
            appendLocked(record);
#ifdef DSH_CONNECTION_DIAGNOSTICS_HILOG
            if (!std::strcmp(source, "app")) OH_LOG_Print(LOG_APP, LOG_INFO, 0xD530, "DSHConn", "%{public}s", record.c_str());
#endif
        }
    } catch (...) {
        // Diagnostics cannot change SDK ownership, cancellation, or page state.
    }
}

void appendApp(const std::string& event, const std::string& fields) {
    if (!eventName(event) || !numericFields(fields)) throw std::invalid_argument("Connection diagnostics accept only event names and numeric fields");
    write("app", event.c_str(), fields);
}

std::string read() {
    std::lock_guard<std::mutex> lock(journalMutex);
    if (directoryFd < 0) throw std::runtime_error("Connection diagnostics are not initialized");
    std::string output;
    output.reserve(kReadBytes);
    readFile(output, kPrevious);
    readFile(output, kCurrent);
    if (writeFailures) {
        const auto warning = line("native", "diagnostics.write_failed", "count=" + std::to_string(writeFailures));
        if (output.size() + warning.size() <= kReadBytes) output += warning;
    }
    return output;
}

} // namespace dsh::diagnostics
