#ifndef DSH_OHOS_LAUNCHER_UTIL_H
#define DSH_OHOS_LAUNCHER_UTIL_H

#include <cstddef>
#include <limits.h>
#include <stdexcept>
#include <string>
#include <sys/types.h>
#include <unistd.h>

namespace dsh::launcher {

// Defined by launcher_config.h; only a reference is needed here.
struct LaunchConfig;

// Owns one non-negative descriptor and closes it exactly once. No copy, so a
// descriptor cannot be closed twice through two owners.
struct Fd {
    int value = -1;
    Fd() = default;
    explicit Fd(int fd) : value(fd) {}
    ~Fd() { reset(); }
    Fd(const Fd&) = delete;
    Fd& operator=(const Fd&) = delete;
    void reset(int fd = -1) { if (value >= 0) close(value); value = fd; }
};

// `operation [path]: errno=N (strerror)`. The OS error is always preserved.
std::string failure(const char* operation, const std::string& path, int error);
// `operation: errno=N (strerror)` for operations with no single owning path.
std::string failure(const char* operation, int error);

// Bounds every LaunchConfig field. Throws std::invalid_argument for a field
// outside its range; that is an input contract, not a device capability result.
void validate(const LaunchConfig& config);

// Largest descriptor number the current process can have inherited, from the
// hard RLIMIT_NOFILE. Throws std::runtime_error when that bound is unusable.
int descriptorBound();

// Fork-child protocol: how far the child got before it could no longer report
// through the normal stream, and the errno that stopped it.
enum ChildStage {
    Group = 1,
    Signals,
    Stdio,
    ChangeDirectory,
    Execute,
    Read,
    Write,
    Duplicate,
    ChangeMode,
    Fork,
};
struct ChildFailure {
    int stage;
    int error;
};

// Called only in the fork child. No C++ allocation, locks, logging, or libc
// environment mutation. write and _exit also work when exec cannot run at all.
[[noreturn]] void childFail(int fd, int stage, int error);

// Closes every inherited descriptor above stdio except `errorFd`. On OHOS the
// loop is used because the application syscall policy can raise SIGSYS for
// close_range despite the SDK declaring it.
void closeInherited(int errorFd, int maxFd);

} // namespace dsh::launcher
#endif
