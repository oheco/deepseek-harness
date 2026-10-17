#include "launcher_util.h"

#include "launcher_config.h"

#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <stdexcept>
#include <sys/resource.h>
#include <unistd.h>
#if defined(__linux__) && !defined(__OHOS__) && defined(SYS_close_range)
#include <sys/syscall.h>
#endif

namespace dsh::launcher {
namespace {
void checkPath(const std::string& path, const char* field) {
    if (path.empty() || path.front() != '/' || path.size() >= PATH_MAX ||
        path.find('\0') != std::string::npos || path.find('\n') != std::string::npos ||
        path.find('\r') != std::string::npos) {
        throw std::invalid_argument(std::string(field) + " must be an absolute, nonempty path without NUL/newlines");
    }
}
} // namespace

std::string failure(const char* operation, const std::string& path, int error) {
    return std::string(operation) + " [" + path + "]: errno=" + std::to_string(error) +
        " (" + std::strerror(error) + ")";
}

std::string failure(const char* operation, int error) {
    return std::string(operation) + ": errno=" + std::to_string(error) +
        " (" + std::strerror(error) + ")";
}

void validate(const LaunchConfig& c) {
    checkPath(c.nodePath, "nodePath"); checkPath(c.dshEntry, "dshEntry");
    checkPath(c.homeDir, "homeDir"); checkPath(c.workDir, "workDir");
    checkPath(c.filesDir, "filesDir"); checkPath(c.cacheDir, "cacheDir");
    checkPath(c.tempDir, "tempDir");
    if (c.nodePath.find(':') != std::string::npos || c.homeDir.find(':') != std::string::npos) {
        throw std::invalid_argument("nodePath/homeDir cannot contain PATH separator ':'");
    }
    if (c.port < 0 || c.port > 65535) throw std::invalid_argument("port must be an integer in 0..65535");
    // Keep steady_clock deadline arithmetic bounded; a whole day is already well
    // beyond an interactive startup. No implicit timeout default crosses the API.
    if (c.startupTimeoutMs < 1 || c.startupTimeoutMs > 86400000) {
        throw std::invalid_argument("startupTimeoutMs must be an integer in 1..86400000");
    }
}

int descriptorBound() {
    struct rlimit limits{};
    if (getrlimit(RLIMIT_NOFILE, &limits) != 0 || limits.rlim_max == RLIM_INFINITY || limits.rlim_max > INT_MAX) {
        throw std::runtime_error("cannot establish inherited descriptor close bound");
    }
    return static_cast<int>(limits.rlim_max);
}

[[noreturn]] void childFail(int fd, int stage, int error) {
    ChildFailure result{stage, error};
    const char* data = reinterpret_cast<const char*>(&result);
    std::size_t left = sizeof(result);
    while (left > 0) {
        const ssize_t n = write(fd, data, left);
        if (n > 0) { data += n; left -= static_cast<std::size_t>(n); }
        else if (n < 0 && errno == EINTR) continue;
        else break;
    }
    _exit(127);
}

void closeInherited(int errorFd, int maxFd) {
#if defined(__linux__) && !defined(__OHOS__) && defined(SYS_close_range)
    // OHOS application seccomp can raise SIGSYS for close_range despite SDK
    // declarations; a return-code fallback cannot handle that policy.
    const bool first = errorFd == 3 || syscall(SYS_close_range, 3U, static_cast<unsigned>(errorFd - 1), 0U) == 0;
    const bool second = syscall(SYS_close_range, static_cast<unsigned>(errorFd + 1), ~0U, 0U) == 0;
    if (first && second) return;
#endif
    for (int fd = 3; fd < maxFd; ++fd) if (fd != errorFd) close(fd);
}
} // namespace dsh::launcher
