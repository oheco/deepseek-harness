#include "supervisor.h"

#include "launcher_config.h"
#include "launcher_util.h"
#include "probe.h"

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <limits.h>
#include <memory>
#include <poll.h>
#include <signal.h>
#include <stdexcept>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <vector>
#if defined(__linux__)
#include <sys/prctl.h>
#include <sys/syscall.h>
#endif

namespace dsh::launcher {
namespace {
using Clock = std::chrono::steady_clock;
constexpr std::size_t kLogBytes = 16 * 1024;
constexpr std::size_t kLineBytes = 8 * 1024;
constexpr auto kTerminateGrace = std::chrono::milliseconds(750);
constexpr auto kReapWarning = std::chrono::seconds(2);

void privateDirectory(const std::string& path) {
#if defined(__linux__)
    // App sandbox ancestors such as /data are searchable (0711), not readable.
    // O_PATH permits safe openat traversal without requiring directory listing.
    constexpr int directoryFlags = O_PATH | O_DIRECTORY | O_CLOEXEC;
#else
    constexpr int directoryFlags = O_RDONLY | O_DIRECTORY | O_CLOEXEC;
#endif
    Fd dir(open("/", directoryFlags));
    if (dir.value < 0) throw std::runtime_error(failure("open directory", "/", errno));
    std::size_t pos = 1;
    bool componentSeen = false;
    while (pos < path.size()) {
        const auto end = path.find('/', pos);
        const auto part = path.substr(pos, end == std::string::npos ? end : end - pos);
        pos = end == std::string::npos ? path.size() : end + 1;
        if (part.empty()) continue;
        if (part == "." || part == "..") throw std::runtime_error("private directory cannot contain dot components: " + path);
        componentSeen = true;
        int next = openat(dir.value, part.c_str(), directoryFlags | O_NOFOLLOW);
        if (next < 0 && errno == ENOENT) {
            if (mkdirat(dir.value, part.c_str(), 0700) != 0 && errno != EEXIST) {
                throw std::runtime_error(failure("mkdir0700", path, errno));
            }
            next = openat(dir.value, part.c_str(), directoryFlags | O_NOFOLLOW);
        }
        if (next < 0) throw std::runtime_error(failure("open private directory (no symlinks)", path, errno));
        dir.reset(next);
    }
    struct stat st{};
    if (fstat(dir.value, &st) != 0) throw std::runtime_error(failure("fstat directory", path, errno));
    if (!componentSeen || st.st_uid != geteuid() || (st.st_mode & 07777) != 0700) {
        throw std::runtime_error("private directory must be owned by current uid with mode 0700: " + path);
    }
}

void existingDirectory(const std::string& path) {
    // HOME is an environment value, not a request to list that directory. The
    // child chdir below owns the work directory's actual search-permission check.
    // Follow final directory symlinks as chdir does, without rewriting either
    // configured path or applying the private-directory no-symlink policy here.
#if defined(__linux__) || defined(__OHOS__)
    Fd dir(open(path.c_str(), O_PATH | O_DIRECTORY | O_CLOEXEC));
    if (dir.value < 0) throw std::runtime_error(failure("open directory", path, errno));
#else
    struct stat st{};
    if (stat(path.c_str(), &st) != 0) throw std::runtime_error(failure("stat directory", path, errno));
    if (!S_ISDIR(st.st_mode)) throw std::runtime_error(failure("stat directory", path, ENOTDIR));
#endif
}

// Readability is established by the operation the launcher will actually use.
// OHOS access() is unreliable in both directions: access(R_OK) reports success
// for a mode 0000 file, and access(X_OK) reports success for a directory with no
// search permission, while the real open/chdir fails with EACCES. SELinux
// execute permission is not decidable here at all; the child's execve error
// channel owns that verdict.
void readableFile(const std::string& path) {
    struct stat st{};
    if (stat(path.c_str(), &st) != 0) throw std::runtime_error(failure("stat file", path, errno));
    if (!S_ISREG(st.st_mode)) throw std::runtime_error("not a regular file: " + path);
    Fd file(open(path.c_str(), O_RDONLY | O_CLOEXEC));
    if (file.value < 0) throw std::runtime_error(failure("open file", path, errno));
}

// A mode-bit check on the signed Node binary, not a statement that the platform
// will permit the exec: execve in the child is the only authority for that.
void executableFile(const std::string& path) {
    struct stat st{};
    if (stat(path.c_str(), &st) != 0) throw std::runtime_error(failure("stat file", path, errno));
    if (!S_ISREG(st.st_mode)) throw std::runtime_error("not a regular file: " + path);
    if ((st.st_mode & 0111) == 0) throw std::runtime_error(failure("execute bit", path, EACCES));
}

void makePipe(Fd& readEnd, Fd& writeEnd) {
    int pipeFds[2];
#if defined(__linux__)
    if (pipe2(pipeFds, O_CLOEXEC) != 0) throw std::runtime_error(failure("pipe2", "child output", errno));
#else
    if (pipe(pipeFds) != 0) throw std::runtime_error(failure("pipe", "child output", errno));
#endif
    readEnd.reset(pipeFds[0]); writeEnd.reset(pipeFds[1]);
    for (Fd* fd : {&readEnd, &writeEnd}) {
        // All child plumbing stays above stdio even when the parent closed it.
        if (fd->value < 3) {
            const int moved = fcntl(fd->value, F_DUPFD_CLOEXEC, 3);
            if (moved < 0) throw std::runtime_error(failure("duplicate pipe", "child output", errno));
            fd->reset(moved);
        }
        if (fcntl(fd->value, F_SETFD, FD_CLOEXEC) != 0) throw std::runtime_error(failure("fcntl CLOEXEC", "pipe", errno));
    }
    if (fcntl(readEnd.value, F_SETFL, O_NONBLOCK) != 0) throw std::runtime_error(failure("fcntl nonblock", "pipe", errno));
}

bool decimal(const std::string& text, std::size_t& pos, unsigned limit, unsigned& value) {
    const auto begin = pos;
    value = 0;
    while (pos < text.size() && text[pos] >= '0' && text[pos] <= '9') {
        const unsigned digit = static_cast<unsigned>(text[pos++] - '0');
        if (value > (limit - digit) / 10) return false;
        value = value * 10 + digit;
    }
    return pos > begin && !(pos - begin > 1 && text[begin] == '0');
}

bool consume(const std::string& text, std::size_t& pos, const std::string& literal) {
    if (text.compare(pos, literal.size(), literal) != 0) return false;
    pos += literal.size(); return true;
}

bool tokenChar(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '_' || c == '-';
}

std::string readiness(const std::string& line, int expectedPort) {
    std::size_t pos = 0;
    if (!consume(line, pos, "dsh web: http://127.0.0.1:")) return {};
    unsigned port;
    if (!decimal(line, pos, 65535, port) || port == 0 ||
        (expectedPort != 0 && port != static_cast<unsigned>(expectedPort)) ||
        !consume(line, pos, "/?token=")) return {};
    const auto tokenStart = pos;
    while (pos < line.size() && tokenChar(line[pos])) ++pos;
    if (pos == tokenStart) return {};
    const auto urlEnd = pos;
    if (pos != line.size()) {
        if (!consume(line, pos, " (LAN: http://")) return {};
        // The DSH announcement currently uses an IPv4 LAN address. It never
        // becomes the WebView URL; still validate every suffix byte strictly.
        for (int i = 0; i < 4; ++i) {
            unsigned octet;
            if (!decimal(line, pos, 255, octet)) return {};
            if (!consume(line, pos, i == 3 ? ":" : ".")) return {};
        }
        unsigned lanPort;
        if (!decimal(line, pos, 65535, lanPort) || lanPort != port ||
            !consume(line, pos, "/?token=") ||
            !consume(line, pos, line.substr(tokenStart, urlEnd - tokenStart)) ||
            !consume(line, pos, ")") || pos != line.size()) return {};
    }
    return line.substr(9, urlEnd - 9);
}

// Raw child text never enters the public log. Unknown tokens can be printed
// before the URL, on stderr, or across lines; keyword filtering cannot protect
// those cases. Only fixed classifications and a token-free ready event leave
// this parser. Partial and oversized lines are never readiness candidates.
class Lines {
public:
    Lines(std::string source, int port, std::function<void(const std::string&)> log,
        std::function<void(std::string)> ready)
        : source_(std::move(source)), port_(port), log_(std::move(log)), ready_(std::move(ready)) {}
    void feed(const char* bytes, std::size_t size) {
        for (std::size_t i = 0; i < size; ++i) {
            const unsigned char c = static_cast<unsigned char>(bytes[i]);
            if (c == '\n') { end(true); continue; }
            if (++bytes_ > kLineBytes) { oversized_ = true; line_.clear(); continue; }
            switch (escape_) {
                case 0:
                    if (c == 27) escape_ = 1;
                    else if ((c >= 32 && c <= 126) || c == '\r') line_ += static_cast<char>(c);
                    else invalid_ = true;
                    break;
                case 1:
                    if (c == '[') escape_ = 2;
                    else if (c == ']') escape_ = 3;
                    else { invalid_ = true; escape_ = 0; }
                    break;
                case 2:
                    if (c >= 0x40 && c <= 0x7e) escape_ = 0;
                    else if (c < 0x20 || c > 0x3f) invalid_ = true;
                    break;
                case 3:
                    if (c == 7) escape_ = 0;
                    else if (c == 27) escape_ = 4;
                    break;
                case 4:
                    if (c == '\\') escape_ = 0;
                    else escape_ = 3;
                    break;
            }
        }
    }
    void eof() { if (bytes_ != 0) end(false); }
private:
    void end(bool newline) {
        if (!line_.empty() && line_.back() == '\r') line_.pop_back();
        std::string url;
        if (newline && !oversized_ && !invalid_ && escape_ == 0 && source_ == "stdout") {
            url = readiness(line_, port_);
        }
        if (!url.empty()) {
            ready_(std::move(url));
            log_("[stdout] dsh web ready; authenticated URL withheld");
        } else {
            log_("[" + source_ + "] " + (oversized_ ? "oversized line discarded" :
                !newline ? "unterminated line discarded" : "child output withheld (may contain credentials)"));
        }
        line_.clear(); bytes_ = 0; oversized_ = false; invalid_ = false; escape_ = 0;
    }
    std::string source_;
    int port_;
    std::function<void(const std::string&)> log_;
    std::function<void(std::string)> ready_;
    std::string line_;
    std::size_t bytes_ = 0;
    int escape_ = 0;
    bool oversized_ = false;
    bool invalid_ = false;
};

// The probe reads only these fields; port and startupTimeoutMs stay with the
// supervisor because no probe check uses them.
LaunchPaths launchPaths(const LaunchConfig& c) {
    return {c.nodePath, c.dshEntry, c.homeDir, c.workDir, c.filesDir, c.cacheDir, c.tempDir};
}

std::string childFailureMessage(const ChildFailure& error, const LaunchConfig& c) {
    switch (error.stage) {
        case Group: return failure("setpgid", c.nodePath, error.error);
        case Signals: return failure("reset signals", c.nodePath, error.error);
        case Stdio: return failure("dup2 stdio", c.nodePath, error.error);
        case ChangeDirectory: return failure("chdir", c.workDir, error.error);
        case Execute: return failure("execve signed Node", c.nodePath, error.error);
        default: return "invalid child failure record";
    }
}
} // namespace

Supervisor::Supervisor() : worker_([this] { workerLoop(); }) {}

Supervisor::~Supervisor() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        shutdown_ = true; stop_ = true;
        if (active_) { snapshot_.state = "stopping"; snapshot_.url.clear(); }
    }
    wake_.notify_one();
    worker_.join();
    // The probe owns an independent worker that may be mid-check. Its destructor
    // requests nothing from this supervisor and reaps only its own children, so
    // no run state crosses between the two. It is released after the join so a
    // slow check never holds the snapshot mutex or delays child reaping.
    probe_.reset();
}

void Supervisor::start(LaunchConfig config) {
    validate(config);
    auto replacement = std::make_shared<Probe>();
    std::shared_ptr<Probe> previous;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        // The active-run check precedes every path check so a rejected start
        // reports the run conflict, not a stale path from the pending config.
        if (active_ || shutdown_) throw std::logic_error("launcher already active; wait for stopped/error after reap");
        // The probe observes the same paths through its own worker, pipes, and
        // children, never through this supervisor's child. It is replaced, not
        // reused, so a finished report can never be mistaken for this launch's.
        // The run worker keeps ownership of the private-directory preflight, so
        // its established error surface and ordering are unchanged.
        replacement->start(launchPaths(config));
        previous = std::move(probe_);
        probe_ = replacement;
        pending_ = std::move(config);
        snapshot_ = LaunchSnapshot{};
        snapshot_.state = "starting"; snapshot_.message = "Preparing isolated child environment";
        active_ = true; queued_ = true; stop_ = false;
    }
    // Destruction joins the replaced probe's worker, so it happens outside the
    // lock; the bridge may still hold the shared reference it used to poll.
    previous.reset();
    wake_.notify_one();
}

void Supervisor::probe(const LaunchConfig& config) {
    validate(config);
    std::shared_ptr<Probe> previous;
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (shutdown_) throw std::logic_error("launcher is shutting down");
        // The probe instance itself refuses a restart while its worker is busy,
        // and replacing it here would silently discard the running checks'
        // report, so an in-flight probe is a conflict rather than a replacement.
        if (probe_ != nullptr && probe_->snapshot().running) throw std::logic_error("probe already running");
        // The new probe is started after that check, because a started probe is
        // running by definition. The supervisor lock serializes probe calls, so
        // the check can only ever observe a probe from an earlier call.
        previous = std::move(probe_);
        probe_ = std::make_shared<Probe>();
        probe_->start(launchPaths(config));
    }
    previous.reset();
}

std::shared_ptr<Probe> Supervisor::probe() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return probe_;
}

LaunchSnapshot Supervisor::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return snapshot_;
}

void Supervisor::stop() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (!active_) {
            snapshot_.state = "stopped"; snapshot_.url.clear(); snapshot_.pid = 0;
            if (snapshot_.message.empty()) snapshot_.message = "Stopped; no owned child";
            return;
        }
        stop_ = true; snapshot_.state = "stopping"; snapshot_.url.clear();
        snapshot_.message = "Termination requested; waiting for owned child to be reaped";
    }
    wake_.notify_one();
}

bool Supervisor::stopRequested() const {
    std::lock_guard<std::mutex> lock(mutex_); return stop_;
}

void Supervisor::appendLog(const std::string& line) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.logs += line + '\n';
    if (snapshot_.logs.size() > kLogBytes) snapshot_.logs.erase(0, snapshot_.logs.size() - kLogBytes);
}

void Supervisor::acceptUrl(std::string url) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!stop_ && snapshot_.state == "starting") {
        snapshot_.url = std::move(url); snapshot_.state = "ready";
        snapshot_.message = "Owned child announced authenticated loopback URL";
    }
}

void Supervisor::beginStopping(const std::string& message) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.state = "stopping"; snapshot_.url.clear(); snapshot_.message = message;
}

void Supervisor::finish(bool failed, const std::string& message, int exitCode) {
    std::lock_guard<std::mutex> lock(mutex_);
    snapshot_.state = failed ? "error" : "stopped";
    snapshot_.url.clear(); snapshot_.message = message;
    snapshot_.pid = 0; snapshot_.exitCode = exitCode; active_ = false;
}

void Supervisor::workerLoop() {
    for (;;) {
        LaunchConfig config;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            wake_.wait(lock, [this] { return queued_ || shutdown_; });
            if (!queued_ && shutdown_) return;
            config = std::move(pending_); queued_ = false;
        }
        // run owns and reaps the child even when allocating a diagnostic fails.
        try { run(config); }
        catch (const std::exception& error) { finish(true, error.what(), -1); }
    }
}

void Supervisor::run(const LaunchConfig& c) {
    const auto deadline = Clock::now() + std::chrono::milliseconds(c.startupTimeoutMs);
    privateDirectory(c.filesDir); privateDirectory(c.cacheDir); privateDirectory(c.tempDir);
    privateDirectory(c.filesDir + "/dsh");
    existingDirectory(c.homeDir); existingDirectory(c.workDir);
    executableFile(c.nodePath); readableFile(c.dshEntry);
    if (stopRequested()) { finish(false, "Stopped before fork", -1); return; }
    if (Clock::now() >= deadline) { finish(true, "Startup timed out during preparation", -1); return; }

    const auto slash = c.nodePath.rfind('/');
    const std::string nodeDir = slash == 0 ? "/" : c.nodePath.substr(0, slash);
    std::vector<std::string> args{c.nodePath, "--expose-internals", c.dshEntry, "web", "--host", "127.0.0.1",
        "--port", std::to_string(c.port), "--no-open"};
    std::vector<std::string> env{"HOME=" + c.homeDir, "DSH_HOME=" + c.filesDir + "/dsh",
        "XDG_CONFIG_HOME=" + c.filesDir, "XDG_CACHE_HOME=" + c.cacheDir, "TMPDIR=" + c.tempDir,
        "PATH=" + nodeDir + ":" + c.homeDir + "/.oheco/bin:/usr/bin:/system/bin"};
    std::vector<char*> argv, envp;
    for (auto& arg : args) argv.push_back(arg.data());
    for (auto& entry : env) envp.push_back(entry.data());
    argv.push_back(nullptr); envp.push_back(nullptr);
    Fd outRead, outWrite, errRead, errWrite, execRead, execWrite;
    makePipe(outRead, outWrite); makePipe(errRead, errWrite); makePipe(execRead, execWrite);
    Fd input(open("/dev/null", O_RDONLY | O_CLOEXEC));
    if (input.value < 0) throw std::runtime_error(failure("open stdin", "/dev/null", errno));
    if (input.value < 3) {
        const int copy = fcntl(input.value, F_DUPFD_CLOEXEC, 3);
        if (copy < 0) throw std::runtime_error(failure("duplicate stdin", "/dev/null", errno));
        input.reset(copy);
    }
    struct rlimit limits{};
    if (getrlimit(RLIMIT_NOFILE, &limits) != 0 || limits.rlim_max == RLIM_INFINITY || limits.rlim_max > INT_MAX) {
        throw std::runtime_error("cannot establish inherited descriptor close bound");
    }
    const int maxFd = static_cast<int>(limits.rlim_max);
    const char* executable = c.nodePath.c_str(); const char* workDir = c.workDir.c_str();
    char* const* childArgv = argv.data(); char* const* childEnv = envp.data();
    const int childOut = outWrite.value, childErr = errWrite.value, childFailure = execWrite.value, childIn = input.value;
    const pid_t parentPid = getpid();
    sigset_t emptySignals;
    sigemptyset(&emptySignals);
    struct sigaction defaultSignal{};
    defaultSignal.sa_handler = SIG_DFL; sigemptyset(&defaultSignal.sa_mask);
    const pid_t pid = fork();
    if (pid < 0) throw std::runtime_error(failure("fork", c.nodePath, errno));
    if (pid == 0) {
        if (setpgid(0, 0) != 0) childFail(childFailure, Group, errno);
#if defined(__linux__) && defined(SYS_prctl)
        // Direct kernel call avoids libc state in the fork child. Unsupported or
        // denied PDEATHSIG is best-effort; the parent race check still applies.
        syscall(SYS_prctl, PR_SET_PDEATHSIG, SIGKILL, 0UL, 0UL, 0UL);
#endif
        if (getppid() != parentPid) _exit(125);
        if (sigprocmask(SIG_SETMASK, &emptySignals, nullptr) != 0) childFail(childFailure, Signals, errno);
        for (int signalNumber : {SIGTERM, SIGINT, SIGHUP, SIGPIPE, SIGCHLD}) {
            if (sigaction(signalNumber, &defaultSignal, nullptr) != 0) childFail(childFailure, Signals, errno);
        }
        if (dup2(childIn, STDIN_FILENO) < 0 || dup2(childOut, STDOUT_FILENO) < 0 || dup2(childErr, STDERR_FILENO) < 0) {
            childFail(childFailure, Stdio, errno);
        }
        closeInherited(childFailure, maxFd);
        if (chdir(workDir) != 0) childFail(childFailure, ChangeDirectory, errno);
        execve(executable, childArgv, childEnv);
        childFail(childFailure, Execute, errno);
    }
    outWrite.reset(); errWrite.reset(); execWrite.reset(); input.reset();
    // Keeping the leader unreaped until the final group signal prevents its pid
    // from being recycled into an unrelated process group while we still signal.
    bool ownership = true;
    auto emergencyReap = [&] {
        if (!ownership) return;
        kill(-pid, SIGKILL); kill(pid, SIGKILL);
        int status;
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
        ownership = false;
    };
    try {
        // Child also calls setpgid before exec. Parent call narrows the early
        // stop race; EACCES means exec won, so the child's own call succeeded.
        if (setpgid(pid, pid) != 0 && errno != EACCES && errno != ESRCH) {
            throw std::runtime_error(failure("parent setpgid", c.nodePath, errno));
        }
        {
            std::lock_guard<std::mutex> lock(mutex_); snapshot_.pid = pid;
        }
        appendLog("Started owned process pid=" + std::to_string(pid) + "; child output is credential-filtered");
        Lines stdoutLines("stdout", c.port, [this](const auto& line) { appendLog(line); },
            [this](auto url) { acceptUrl(std::move(url)); });
        Lines stderrLines("stderr", c.port, [this](const auto& line) { appendLog(line); }, [](auto) {});
        std::array<char, sizeof(ChildFailure)> execBytes{};
        std::size_t execLength = 0;
        bool terminating = false, killed = false, failed = false, readySeen = false, leaderExited = false;
        bool warned = false;
        std::string reason;
        Clock::time_point killDeadline{}, reapDeadline{};
        auto terminate = [&](bool error, std::string message) {
            if (terminating) return;
            failed = error; reason = std::move(message); terminating = true;
            beginStopping(reason); appendLog(reason);
            if (kill(-pid, SIGTERM) != 0 && errno != ESRCH) appendLog(failure("SIGTERM group", std::to_string(pid), errno));
            // Positive pid is owned too, and covers an early group-setup failure.
            if (kill(pid, SIGTERM) != 0 && errno != ESRCH) appendLog(failure("SIGTERM child", std::to_string(pid), errno));
            killDeadline = Clock::now() + kTerminateGrace;
        };
        auto drain = [&](Fd& fd, Lines& lines) {
            std::array<char, 4096> bytes{};
            // A flooding child cannot starve timeout, stop, or the other stream.
            for (int reads = 0; fd.value >= 0 && reads < 4; ++reads) {
                const ssize_t count = read(fd.value, bytes.data(), bytes.size());
                if (count > 0) lines.feed(bytes.data(), static_cast<std::size_t>(count));
                else if (count == 0) { lines.eof(); fd.reset(); break; }
                else if (errno == EINTR) continue;
                else if (errno == EAGAIN || errno == EWOULDBLOCK) break;
                else { terminate(true, failure("read child pipe", "output", errno)); fd.reset(); break; }
            }
        };
        for (;;) {
            const auto now = Clock::now();
            if (stopRequested()) terminate(false, "Termination requested; awaiting reap");
            if (!terminating && !readySeen && now >= deadline) terminate(true, "Startup timed out before complete authenticated URL line");
            if (terminating && !killed && now >= killDeadline) {
                if (kill(-pid, SIGKILL) != 0 && errno != ESRCH) appendLog(failure("SIGKILL group", std::to_string(pid), errno));
                if (!leaderExited && kill(pid, SIGKILL) != 0 && errno != ESRCH) appendLog(failure("SIGKILL child", std::to_string(pid), errno));
                killed = true; reapDeadline = now + kReapWarning;
            }
            struct pollfd polls[]{{outRead.value, POLLIN, 0}, {errRead.value, POLLIN, 0}, {execRead.value, POLLIN, 0}};
            if (poll(polls, 3, 20) < 0 && errno != EINTR) terminate(true, failure("poll", "child pipes", errno));
            drain(outRead, stdoutLines); drain(errRead, stderrLines);
            if (execRead.value >= 0) {
                const ssize_t n = read(execRead.value, execBytes.data() + execLength, execBytes.size() - execLength);
                if (n > 0) {
                    execLength += static_cast<std::size_t>(n);
                    if (execLength == execBytes.size()) {
                        ChildFailure error{}; std::memcpy(&error, execBytes.data(), sizeof(error));
                        // An exec failure remains an error even if stop raced it.
                        failed = true; reason = childFailureMessage(error, c);
                        if (terminating) { beginStopping(reason); appendLog(reason); }
                        else terminate(true, reason);
                        execRead.reset();
                    }
                } else if (n == 0) {
                    execRead.reset();
                    if (execLength != 0) terminate(true, "Incomplete child exec failure record");
                } else if (errno != EINTR && errno != EAGAIN && errno != EWOULDBLOCK) {
                    terminate(true, failure("read", "exec failure pipe", errno)); execRead.reset();
                }
            }
            {
                std::lock_guard<std::mutex> lock(mutex_);
                if (snapshot_.state == "ready") readySeen = true;
            }
            siginfo_t info{};
            if (waitid(P_PID, static_cast<id_t>(pid), &info, WEXITED | WNOHANG | WNOWAIT) != 0) {
                if (errno == EINTR) continue;
                if (errno == ECHILD) {
                    // Another reaper or SIGCHLD=SIG_IGN invalidates ownership.
                    // Never signal a numeric pid again after losing that proof.
                    ownership = false;
                    finish(true, "Owned child waitid returned ECHILD; external reaper/ignored SIGCHLD is unsupported", -1);
                    return;
                }
                throw std::runtime_error(failure("waitid", std::to_string(pid), errno));
            }
            if (info.si_pid == pid) {
                leaderExited = true;
                if (!terminating) terminate(true, readySeen ? "Child exited after readiness" : "Child exited before readiness");
                if (killed) {
                    int status = 0;
                    pid_t result;
                    do { result = waitpid(pid, &status, WNOHANG); } while (result < 0 && errno == EINTR);
                    if (result == pid) {
                        ownership = false;
                        const int code = WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
                        // Flush only bytes already available; escaped descendants
                        // cannot keep this worker waiting for pipe EOF forever.
                        drain(outRead, stdoutLines); drain(errRead, stderrLines);
                        stdoutLines.eof(); stderrLines.eof();
                        reason += "; exitCode=" + std::to_string(code);
                        appendLog(reason); finish(failed, reason, code); return;
                    }
                    if (result < 0) {
                        const int error = errno;
                        if (error == ECHILD) ownership = false;
                        throw std::runtime_error(failure("waitpid", std::to_string(pid), error));
                    }
                }
            }
            if (killed && !warned && Clock::now() >= reapDeadline) {
                warned = true; beginStopping("SIGKILL sent; kernel has not made child reapable; restart remains disabled");
                appendLog("Reap exceeded two seconds; retaining ownership and stopping state");
            }
        }
    } catch (...) {
        emergencyReap();
        throw;
    }
}
} // namespace dsh::launcher
