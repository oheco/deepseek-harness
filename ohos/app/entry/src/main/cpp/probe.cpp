#include "probe.h"

#include "launcher_config.h"
#include "launcher_util.h"

#include <array>
#include <cerrno>
#include <chrono>
#include <csignal>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <poll.h>
#include <stdexcept>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <utility>
#include <vector>

extern "C" char** environ;

namespace dsh::launcher {
namespace {
using Clock = std::chrono::steady_clock;
constexpr std::size_t kReportBytes = 8 * 1024;
constexpr std::size_t kReportLineBytes = 500;
constexpr std::size_t kFirstLineBytes = 120;
constexpr std::size_t kCommandOutputBytes = 64 * 1024;
constexpr auto kExecLimit = std::chrono::seconds(5);
constexpr auto kTerminateGrace = std::chrono::milliseconds(750);
constexpr const char* kShellPath = "/usr/bin/zsh";
constexpr const char* kSystemShellPath = "/system/bin/sh";

std::string octal(unsigned value) {
    char text[16];
    std::snprintf(text, sizeof(text), "0%o", value);
    return text;
}

std::string statText(const struct stat& st) {
    return "mode=" + octal(static_cast<unsigned>(st.st_mode)) +
        " uid=" + std::to_string(static_cast<long long>(st.st_uid)) +
        " gid=" + std::to_string(static_cast<long long>(st.st_gid));
}

// One physical printable-ASCII line: control bytes and non-ASCII bytes become
// '?', and everything after an http(s) scheme up to the next whitespace becomes
// [URL redacted]. A credential-bearing URL therefore cannot reach the caller
// even when a command prints one.
std::string reportLine(const std::string& line) {
    std::string ascii;
    ascii.reserve(line.size());
    for (const unsigned char c : line) {
        const bool printable = (c >= 32 && c <= 126) || c == '\t';
        ascii += printable ? static_cast<char>(c) : '?';
    }
    std::string redacted;
    redacted.reserve(ascii.size());
    std::size_t pos = 0;
    while (pos < ascii.size()) {
        if (ascii.compare(pos, 7, "http://") == 0 || ascii.compare(pos, 8, "https://") == 0) {
            redacted += "[URL redacted]";
            while (pos < ascii.size() && ascii[pos] != ' ' && ascii[pos] != '\t') ++pos;
            continue;
        }
        redacted += ascii[pos++];
    }
    if (redacted.size() > kReportLineBytes) redacted.resize(kReportLineBytes);
    return redacted;
}

std::string readAll(int fd) {
    std::string bytes;
    std::array<char, 4096> buffer{};
    for (;;) {
        const ssize_t count = read(fd, buffer.data(), buffer.size());
        if (count > 0) { bytes.append(buffer.data(), static_cast<std::size_t>(count)); continue; }
        if (count == 0) break;
        if (errno == EINTR) continue;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        break;
    }
    return bytes;
}

// Creates every missing component of `path` at 0700. Existing directories are
// left exactly as they are, including a mode the caller must fix itself.
void createDirectories(const std::string& path) {
    std::string partial;
    std::size_t pos = path.front() == '/' ? 1 : 0;
    while (pos <= path.size()) {
        const auto end = path.find('/', pos);
        partial = path.substr(0, end == std::string::npos ? path.size() : end);
        pos = end == std::string::npos ? path.size() + 1 : end + 1;
        if (partial.empty()) continue;
        if (mkdir(partial.c_str(), 0700) != 0 && errno != EEXIST) {
            throw std::runtime_error(failure("mkdir0700", partial, errno));
        }
    }
}

void writeAll(int fd, const std::string& bytes) {
    std::size_t offset = 0;
    while (offset < bytes.size()) {
        const ssize_t count = write(fd, bytes.data() + offset, bytes.size() - offset);
        if (count > 0) { offset += static_cast<std::size_t>(count); continue; }
        if (count < 0 && errno == EINTR) continue;
        return;
    }
}

struct Result {
    bool executed = false;
    int exitCode = -1;
    int signal = 0;
    std::string output;
    std::string failureStage;
    int error = 0;
    std::string failurePath;
};

// Forks one child for one check. The child uses its own pipes and descriptor
// bound; no supervisor instance, process group, or descriptor is shared with it.
Result runChild(const std::string& executable, const std::vector<std::string>& args) {
    Result result;
    int outFds[2], failFds[2];
    if (pipe(outFds) != 0) throw std::runtime_error(failure("pipe", "probe stdout", errno));
    Fd outRead(outFds[0]), outWrite(outFds[1]);
    if (pipe(failFds) != 0) throw std::runtime_error(failure("pipe", "probe failure channel", errno));
    Fd failRead(failFds[0]), failWrite(failFds[1]);
    for (int fd : {outFds[0], outFds[1], failFds[0], failFds[1]}) {
        const int flags = fcntl(fd, F_GETFD);
        if (flags < 0 || fcntl(fd, F_SETFD, flags | FD_CLOEXEC) != 0) {
            throw std::runtime_error(failure("fcntl CLOEXEC", "probe pipe", errno));
        }
    }
    if (fcntl(outRead.value, F_SETFL, O_NONBLOCK) != 0) {
        throw std::runtime_error(failure("fcntl nonblock", "probe stdout", errno));
    }
    Fd input(open("/dev/null", O_RDONLY | O_CLOEXEC));
    if (input.value < 0) throw std::runtime_error(failure("open stdin", "/dev/null", errno));
    Fd discard(open("/dev/null", O_WRONLY | O_CLOEXEC));
    if (discard.value < 0) throw std::runtime_error(failure("open stderr", "/dev/null", errno));
    std::vector<char*> argv;
    for (const auto& arg : args) argv.push_back(const_cast<char*>(arg.c_str()));
    argv.push_back(nullptr);
    const int maxFd = descriptorBound();
    const char* path = executable.c_str();
    char* const* childArgv = argv.data();
    const int childOut = outWrite.value, childFailure = failWrite.value;
    const int childErr = discard.value, childIn = input.value;
    sigset_t emptySignals;
    sigemptyset(&emptySignals);
    struct sigaction defaultSignal{};
    defaultSignal.sa_handler = SIG_DFL;
    sigemptyset(&defaultSignal.sa_mask);
    const pid_t pid = fork();
    if (pid < 0) throw std::runtime_error(failure("fork", executable, errno));
    if (pid == 0) {
        if (sigprocmask(SIG_SETMASK, &emptySignals, nullptr) != 0) childFail(childFailure, Signals, errno);
        for (int number : {SIGTERM, SIGINT, SIGHUP, SIGPIPE, SIGCHLD}) {
            if (sigaction(number, &defaultSignal, nullptr) != 0) childFail(childFailure, Signals, errno);
        }
        if (dup2(childIn, STDIN_FILENO) < 0 || dup2(childOut, STDOUT_FILENO) < 0 || dup2(childErr, STDERR_FILENO) < 0) {
            childFail(childFailure, Stdio, errno);
        }
        closeInherited(childFailure, maxFd);
        execve(path, childArgv, environ);
        childFail(childFailure, Execute, errno);
    }
    outWrite.reset(); failWrite.reset(); input.reset(); discard.reset();
    std::array<char, sizeof(ChildFailure)> failureBytes{};
    std::size_t failureLength = 0;
    const auto deadline = Clock::now() + kExecLimit;
    Clock::time_point killDeadline{};
    bool killed = false, killSent = false, reaped = false;
    int status = 0;
    while (!reaped) {
        const auto now = Clock::now();
        if (!killed && now >= deadline) {
            kill(pid, SIGTERM);
            killDeadline = now + kTerminateGrace;
            killed = true;
        } else if (killed && !killSent && now >= killDeadline) {
            kill(pid, SIGKILL);
            killSent = true;
        }
        struct pollfd polls[]{{outRead.value, POLLIN, 0}, {failRead.value, POLLIN, 0}};
        const int ready = poll(polls, 2, 20);
        if (ready < 0 && errno != EINTR) throw std::runtime_error(failure("poll", "probe pipes", errno));
        result.output += readAll(outRead.value);
        // A check reads only the first output line, so a flooding process is cut
        // off at a bound instead of growing this buffer without limit.
        if (result.output.size() > kCommandOutputBytes) {
            result.output.resize(kCommandOutputBytes);
            outRead.reset();
        }
        if (failureLength < failureBytes.size()) {
            const ssize_t count = read(failRead.value, failureBytes.data() + failureLength,
                failureBytes.size() - failureLength);
            if (count > 0) failureLength += static_cast<std::size_t>(count);
        }
        pid_t done;
        do { done = waitpid(pid, &status, WNOHANG); } while (done < 0 && errno == EINTR);
        if (done == pid) reaped = true;
        else if (done < 0) throw std::runtime_error(failure("waitpid", executable, errno));
    }
    if (WIFEXITED(status)) result.exitCode = WEXITSTATUS(status);
    if (WIFSIGNALED(status)) result.signal = WTERMSIG(status);
    if (failureLength == failureBytes.size()) {
        ChildFailure record{};
        std::memcpy(&record, failureBytes.data(), sizeof(record));
        result.executed = false;
        switch (record.stage) {
            case Signals: result.failureStage = "reset signals"; break;
            case Stdio: result.failureStage = "dup2 stdio"; break;
            case Execute: result.failureStage = "execve"; break;
            default: result.failureStage = "stage " + std::to_string(record.stage); break;
        }
        result.error = record.error;
        result.failurePath = executable;
        return result;
    }
    if (failureLength != 0) {
        result.executed = false; result.failureStage = "incomplete failure record"; result.failurePath = executable;
        return result;
    }
    result.executed = true;
    return result;
}

// The first line of command output, cleaned to printable ASCII and bounded.
std::string firstLine(const std::string& output) {
    const auto end = output.find('\n');
    std::string line = output.substr(0, end == std::string::npos ? output.size() : end);
    if (!line.empty() && line.back() == '\r') line.pop_back();
    std::string cleaned;
    cleaned.reserve(line.size());
    for (const unsigned char c : line) {
        if (c >= 32 && c <= 126) cleaned += static_cast<char>(c);
        else if (c == '\t') cleaned += ' ';
    }
    if (cleaned.size() > kFirstLineBytes) cleaned.resize(kFirstLineBytes);
    return cleaned;
}

std::string outcome(const Result& result) {
    if (!result.executed) {
        return "exec failure stage=" + result.failureStage + " errno=" + std::to_string(result.error) +
            " path=" + result.failurePath;
    }
    std::string text = "exit code=" + std::to_string(result.exitCode);
    if (result.signal != 0) text += " signal=" + std::to_string(result.signal);
    const auto line = firstLine(result.output);
    return text + " first line=" + (line.empty() ? "<empty>" : line);
}

// One exec check's outcome: exit status and first output line, or the failing
// stage, errno, and path from the child's failure channel.
std::string resultText(const Result& result, const std::string& extra = {}) {
    return outcome(result) + (extra.empty() ? "" : " " + extra);
}

// Copies `source` into an app-private file under tempDir at mode 0700, runs it
// with `arguments`, and removes the copy. The source binary is never modified and
// no signature is applied to the copy, so the result reports whether this device
// permits executing an app-private image. Returns the run result and a cleanup
// note; throws only for a failed copy/setup, which the caller reports as FAIL.
std::pair<Result, std::string> privateCopyCheck(const std::string& tempDir, const char* source,
    const std::vector<std::string>& arguments) {
    createDirectories(tempDir);
    const std::string copy = tempDir + "/dsh-probe-" + std::to_string(getpid()) + "-copy";
    Fd input(open(source, O_RDONLY | O_CLOEXEC));
    if (input.value < 0) throw std::runtime_error(failure("open source", source, errno));
    Fd output(open(copy.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0700));
    if (output.value < 0) throw std::runtime_error(failure("create copy", copy, errno));
    std::array<char, 4096> bytes{};
    for (;;) {
        const ssize_t count = read(input.value, bytes.data(), bytes.size());
        if (count > 0) { writeAll(output.value, std::string(bytes.data(), static_cast<std::size_t>(count))); continue; }
        if (count == 0) break;
        if (errno == EINTR) continue;
        throw std::runtime_error(failure("read source", source, errno));
    }
    input.reset(); output.reset();
    if (chmod(copy.c_str(), 0700) != 0) throw std::runtime_error(failure("chmod 0700 copy", copy, errno));
    std::vector<std::string> argv{copy};
    argv.insert(argv.end(), arguments.begin(), arguments.end());
    const auto result = runChild(copy, argv);
    const int removed = unlink(copy.c_str());
    return {result, "(copy unlink rc=" + std::to_string(removed) + ")"};
}
} // namespace

Probe::Probe() : worker_([this] { workerLoop(); }) {}

Probe::~Probe() {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        shutdown_ = true;
    }
    wake_.notify_one();
    // Joining also waits for the checks in flight; run() reaps its own child on
    // every path, including the timeout path, so destruction leaves no orphan.
    worker_.join();
}

void Probe::start(const LaunchPaths& paths) {
    {
        std::lock_guard<std::mutex> lock(mutex_);
        if (shutdown_) throw std::logic_error("probe already destroyed");
        if (running_ || queued_) throw std::logic_error("probe already running");
        pending_ = paths;
        running_ = true; queued_ = true;
    }
    wake_.notify_one();
}

ProbeSnapshot Probe::snapshot() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return ProbeSnapshot{running_, report_};
}

void Probe::workerLoop() {
    for (;;) {
        LaunchPaths config;
        {
            std::unique_lock<std::mutex> lock(mutex_);
            wake_.wait(lock, [this] { return queued_ || shutdown_; });
            if (!queued_ && shutdown_) return;
            config = std::move(pending_);
            queued_ = false;
        }
        // run owns and reaps the child of every check even when it throws.
        try {
            run(config);
        } catch (const std::exception& error) {
            finish(std::string("FAIL internal: ") + error.what());
        }
    }
}

void Probe::publish(const std::string& line) {
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string bounded = reportLine(line);
    if (report_.size() + bounded.size() + 1 > kReportBytes) return;
    report_ += bounded;
    report_ += '\n';
}

void Probe::finish(const std::string& summary) {
    std::lock_guard<std::mutex> lock(mutex_);
    const std::string bounded = reportLine(summary);
    if (report_.size() + bounded.size() + 1 <= kReportBytes) {
        report_ += bounded;
        report_ += '\n';
    } else if (report_.size() + 1 + sizeof("FAIL report truncated\n") <= kReportBytes) {
        report_ += "FAIL report truncated\n";
    }
    running_ = false;
}

void Probe::run(const LaunchPaths& config) {
    std::size_t failures = 0;
    auto emit = [&](bool ok, const std::string& text) {
        if (!ok) ++failures;
        publish(std::string(ok ? "OK " : "FAIL ") + text);
    };

    {
        const gid_t primary = getgid();
        std::vector<gid_t> groups;
        gid_t probe[32];
        const int count = getgroups(static_cast<int>(sizeof(probe) / sizeof(probe[0])), probe);
        std::string groupText;
        if (count < 0) {
            groupText = std::string("getgroups ") + std::strerror(errno);
        } else {
            groups.assign(probe, probe + count);
            for (std::size_t i = 0; i < groups.size(); ++i) {
                if (i != 0) groupText += ",";
                groupText += std::to_string(static_cast<long long>(groups[i]));
            }
            if (groups.empty()) groupText = "<none>";
        }
        publish("INFO identity: uid=" + std::to_string(static_cast<long long>(getuid())) +
            " euid=" + std::to_string(static_cast<long long>(geteuid())) +
            " gid=" + std::to_string(static_cast<long long>(primary)) + " groups=" + groupText);
    }

    struct Entry {
        const char* label;
        const std::string* path;
    };
    const Entry modes[] = {
        {"homeDir", &config.homeDir}, {"workDir", &config.workDir},
        {"nodePath", &config.nodePath}, {"dshEntry", &config.dshEntry},
    };
    for (const auto& entry : modes) {
        struct stat st{};
        if (stat(entry.path->c_str(), &st) != 0) {
            // A stat failure here may be a directory search denial on an
            // ancestor, so the path is named but the errno is the whole report.
            publish(std::string("INFO mode ") + entry.label + "=" + *entry.path +
                " stat " + std::strerror(errno) + " errno=" + std::to_string(errno));
            continue;
        }
        publish(std::string("INFO mode ") + entry.label + "=" + *entry.path + " " + statText(st));
    }

    for (const auto& entry : modes) {
        if (entry.path != &config.nodePath && entry.path != &config.dshEntry) continue;
        const int fd = open(entry.path->c_str(), O_RDONLY | O_CLOEXEC);
        const int error = errno;
        if (fd < 0) {
            emit(false, std::string("open ") + entry.label + " " + *entry.path + " errno=" +
                std::to_string(error) + " (" + std::strerror(error) + ")");
            continue;
        }
        close(fd);
        emit(true, std::string("open ") + entry.label + " " + *entry.path);
    }

    {
        // Writing into the private tree is the operation the launcher depends on
        // for DSH_HOME state; a merely stat-able directory is not enough.
        const std::string file = config.filesDir + "/probe-write-" + std::to_string(getpid());
        Fd created(open(file.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600));
        if (created.value < 0) {
            emit(false, "private write " + file + " errno=" + std::to_string(errno) +
                " (" + std::strerror(errno) + ")");
        } else {
            const std::string payload = "probe\n";
            const ssize_t written = write(created.value, payload.data(), payload.size());
            const int writeError = errno;
            created.reset();
            const int removed = unlink(file.c_str());
            const int unlinkError = errno;
            if (written != static_cast<ssize_t>(payload.size())) {
                emit(false, "private write " + file + " write errno=" + std::to_string(writeError));
            } else if (removed != 0) {
                emit(false, "private write " + file + " unlink errno=" + std::to_string(unlinkError));
            } else {
                emit(true, "private write " + config.filesDir);
            }
        }
    }

    {
        const auto version = runChild(config.nodePath, {config.nodePath, "--version"});
        emit(version.executed, "exec nodePath --version: " + resultText(version));
    }

    {
        struct stat st{};
        if (stat(kShellPath, &st) != 0) {
            emit(false, std::string("exec /usr/bin/zsh -c printf probe-ok: path does not exist or is not statable: ") +
                kShellPath + " errno=" + std::to_string(errno) + " (" + std::strerror(errno) + ")");
        } else {
            const auto shell = runChild(kShellPath, {kShellPath, "-c", "printf probe-ok"});
            emit(shell.executed && shell.exitCode == 0 && shell.signal == 0,
                std::string("exec /usr/bin/zsh -c printf probe-ok: ") + resultText(shell));
        }
    }

    {
        const auto shell = runChild(kSystemShellPath, {kSystemShellPath, "-c", "printf probe-ok"});
        emit(shell.executed && shell.exitCode == 0 && shell.signal == 0,
            std::string("exec system shell ") + kSystemShellPath + " -c printf probe-ok: " + resultText(shell));
    }

    // The copy check is the deciding fact for a self-contained bundle: it runs an
    // app-private copy of the system shell, with no signature applied here. A
    // missing system shell or an absent private directory is reported, not fatal.
    try {
        const auto copied = privateCopyCheck(config.tempDir, kSystemShellPath, {"-c", "printf probe-ok"});
        emit(copied.first.executed && copied.first.exitCode == 0 && copied.first.signal == 0,
            std::string("exec private copy of ") + kSystemShellPath + " -c printf probe-ok: " +
            resultText(copied.first, copied.second));
    } catch (const std::exception& error) {
        emit(false, std::string("exec private copy of ") + kSystemShellPath + " -c printf probe-ok: " + error.what());
    }

    publish("INFO summary: " + std::to_string(failures) + " FAIL line(s); " +
        (failures == 0 ? "every check reported OK" : "see the FAIL lines above"));
    finish(std::string("INFO probe complete: ") + std::to_string(failures) + " failure(s)");
}
} // namespace dsh::launcher
