#include "supervisor.h"

#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <fcntl.h>
#include <fstream>
#include <functional>
#include <iostream>
#include <signal.h>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <utility>
#include <unistd.h>
#if defined(__linux__)
#include <sys/prctl.h>
#endif

using dsh::launcher::LaunchConfig;
using dsh::launcher::LaunchSnapshot;
using dsh::launcher::Supervisor;
using Clock = std::chrono::steady_clock;
namespace {
void require(bool condition, const std::string& message) { if (!condition) throw std::runtime_error(message); }
void pauseMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
void noSecrets(const LaunchSnapshot& s) {
    require(s.logs.size() <= 16384, "logs exceed 16KiB");
    for (const auto& secret : {"secret", "Aa-123", "API_CREDENTIAL_FIXTURE", "token=", "\x1b"}) {
        require(s.logs.find(secret) == std::string::npos, "sensitive/ANSI bytes leaked into logs");
        require(s.message.find(secret) == std::string::npos, "sensitive bytes leaked into message");
    }
    if (s.state != "ready") require(s.url.empty(), "URL retained outside ready");
}
LaunchSnapshot await(Supervisor& supervisor, const std::function<bool(const LaunchSnapshot&)>& predicate, int timeoutMs = 5000) {
    const auto end = Clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        const auto before = Clock::now();
        auto s = supervisor.snapshot();
        require(Clock::now() - before < std::chrono::milliseconds(100), "snapshot blocked");
        noSecrets(s);
        if (predicate(s)) return s;
        if (Clock::now() > end) throw std::runtime_error("wait timed out in " + s.state + ": " + s.message);
        pauseMs(5);
    }
}
LaunchSnapshot terminal(Supervisor& s) {
    return await(s, [](const auto& snapshot) { return snapshot.state == "stopped" || snapshot.state == "error"; });
}
void rejects(const std::function<void()>& fn) {
    bool rejected = false;
    try { fn(); } catch (const std::exception&) { rejected = true; }
    require(rejected, "operation did not reject");
}
LaunchConfig config(const std::string& fixture, const std::string& root, const std::string& scenario, int port = 34002, int timeout = 500) {
    require(mkdir(root.c_str(), 0700) == 0, "test root mkdir failed");
    require(mkdir((root + "/home with spaces").c_str(), 0700) == 0, "home mkdir failed");
    require(mkdir((root + "/work with spaces").c_str(), 0700) == 0, "work mkdir failed");
    std::ofstream(root + "/scenario with spaces") << scenario << '\n';
    return {fixture, root + "/scenario with spaces", root + "/home with spaces", root + "/work with spaces",
        root + "/files", root + "/cache", root + "/temp", port, timeout};
}
struct RestoreMode {
    std::string path;
    ~RestoreMode() {
        // Only newly created fixture directories are changed; restore search/read
        // access even after an assertion so retained test state remains removable.
        if (chmod(path.c_str(), 0700) != 0) std::cerr << "fixture mode restore failed: " << path << '\n';
    }
};
int actualChdirError(const std::string& path) {
    // OHOS access(X_OK) can succeed even when an actual directory search fails.
    // Use a separate owned child so this probe never changes the process-wide cwd.
    int pipeFds[2];
    require(pipe(pipeFds) == 0, "chdir probe pipe failed");
    const char* directory = path.c_str();
    const pid_t child = fork();
    if (child < 0) { close(pipeFds[0]); close(pipeFds[1]); throw std::runtime_error("chdir probe fork failed"); }
    if (child == 0) {
        close(pipeFds[0]);
        const int error = chdir(directory) == 0 ? 0 : errno;
        ssize_t written;
        do { written = write(pipeFds[1], &error, sizeof(error)); } while (written < 0 && errno == EINTR);
        _exit(written == static_cast<ssize_t>(sizeof(error)) ? 0 : 1);
    }
    close(pipeFds[1]);
    int error = -1;
    ssize_t count;
    do { count = read(pipeFds[0], &error, sizeof(error)); } while (count < 0 && errno == EINTR);
    close(pipeFds[0]);
    int status = 0;
    pid_t reaped;
    do { reaped = waitpid(child, &status, 0); } while (reaped < 0 && errno == EINTR);
    require(count == static_cast<ssize_t>(sizeof(error)) && reaped == child && WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "chdir probe result/reap failed");
    return error;
}
void unreadableButSearchable(const std::string& path) {
    require(chmod(path.c_str(), 0100) == 0, "search-only fixture chmod failed");
    struct stat st{};
    require(stat(path.c_str(), &st) == 0 && (st.st_mode & 0777) == 0100, "search-only mode not enforced by filesystem");
    require(actualChdirError(path) == 0, "fixture directory is not searchable by actual chdir");
    const int fd = open(path.c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    const int error = errno;
    if (fd >= 0) close(fd);
    require(fd < 0 && (error == EACCES || error == EPERM), "fixture did not actually deny directory listing");
}
void checkReadyAndStop(const LaunchConfig& c, bool partial = false) {
    Supervisor supervisor;
    require(supervisor.snapshot().state == "idle", "initial state not idle");
    supervisor.stop();
    require(supervisor.snapshot().state == "stopped", "idle stop did not settle stopped");
    const auto started = Clock::now(); supervisor.start(c);
    require(Clock::now() - started < std::chrono::milliseconds(100), "start blocked");
    rejects([&] { supervisor.start(c); });
    if (partial) {
        pauseMs(140);
        auto partialState = supervisor.snapshot();
        if (partialState.state == "stopping") partialState = terminal(supervisor);
        require(partialState.state == "starting", "expected starting before newline, got " + partialState.state + ": " + partialState.message);
    }
    const auto ready = await(supervisor, [](const auto& s) { return s.state == "ready"; });
    require(ready.pid > 0 && ready.exitCode == -1, "invalid ready pid/exit");
    require(ready.url.find("http://127.0.0.1:") == 0 && ready.url.find("/?token=secret_Aa-123") != std::string::npos, "ready URL invalid");
    if (c.port != 0) require(ready.url == "http://127.0.0.1:" + std::to_string(c.port) + "/?token=secret_Aa-123", "port mismatch");
    const auto stopping = Clock::now(); supervisor.stop(); supervisor.stop();
    require(Clock::now() - stopping < std::chrono::milliseconds(100), "stop blocked");
    require(supervisor.snapshot().state == "stopping", "stop did not immediately publish stopping");
    rejects([&] { supervisor.start(c); });
    const auto done = terminal(supervisor);
    require(done.state == "stopped" && done.pid == 0 && done.exitCode != -1, "stop did not reap");
    int status = 0;
    require(waitpid(ready.pid, &status, WNOHANG) == -1 && errno == ECHILD, "supervisor left zombie");
    require(Clock::now() - stopping < std::chrono::seconds(3), "termination exceeded bound");
    supervisor.stop();
    supervisor.start(c); await(supervisor, [](const auto& s) { return s.state == "ready"; });
    supervisor.stop(); require(terminal(supervisor).state == "stopped", "retry failed");
}
}

int main(int argc, char** argv) {
    try {
        require(argc == 3, "usage: supervisor_test SIGNED_FIXTURE PRIVATE_TEST_ROOT");
        std::cout.setf(std::ios::unitbuf);
        const std::string fixture = argv[1], parent = argv[2];
        require(mkdir(parent.c_str(), 0700) == 0 || errno == EEXIST, "test parent mkdir failed");
        std::string root = parent + "/run-XXXXXX";
        require(mkdtemp(root.data()) != nullptr, "private test root creation failed");
        setenv("DSH_TEST_SECRET", "API_CREDENTIAL_FIXTURE", 1);
        setenv("DEEPSEEK_API_KEY", "API_CREDENTIAL_FIXTURE", 1);
        setenv("NODE_OPTIONS", "--not-inherited", 1);
        const int sourceFd = open("/dev/null", O_RDONLY);
        require(sourceFd >= 0 && dup2(sourceFd, 200) == 200, "leaked descriptor setup failed");
        close(sourceFd);
#if defined(__linux__)
        const bool subreaper = prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) == 0;
#else
        const bool subreaper = false;
#endif
        {
            auto c = config(fixture, root + "/search-only", "ready", 34002, 1500);
            RestoreMode homeMode{c.homeDir}, workMode{c.workDir};
            unreadableButSearchable(c.homeDir); unreadableButSearchable(c.workDir);
            checkReadyAndStop(c);
            std::cout << "PASS search-only HOME/cwd without directory-list permission\n";
        }
        {
            auto c = config(fixture, root + "/home-environment", "ready", 34002, 1500);
            RestoreMode homeMode{c.homeDir};
            require(chmod(c.homeDir.c_str(), 0600) == 0, "metadata-only HOME chmod failed");
            const int homeError = actualChdirError(c.homeDir);
            require(homeError == EACCES || homeError == EPERM, "metadata-only HOME unexpectedly searchable");
            checkReadyAndStop(c);
            std::cout << "PASS HOME supplies environment without requiring final-directory search\n";
        }
        {
            auto c = config(fixture, root + "/directory-aliases", "ready", 34002, 1500);
            const auto homeTarget = c.homeDir, workTarget = c.workDir;
            c.homeDir = root + "/directory-aliases/home alias";
            c.workDir = root + "/directory-aliases/work alias";
            require(symlink(homeTarget.c_str(), c.homeDir.c_str()) == 0 &&
                symlink(workTarget.c_str(), c.workDir.c_str()) == 0, "directory alias creation failed");
            checkReadyAndStop(c);
            std::cout << "PASS HOME/cwd final directory symlinks preserve lexical environment and actual cwd\n";
        }
        {
            Supervisor supervisor;
            auto c = config(fixture, root + "/chdir-denied", "ready", 34002, 1500);
            const auto workTarget = c.workDir;
            RestoreMode workMode{workTarget};
            c.workDir = root + "/chdir-denied/work alias";
            require(symlink(workTarget.c_str(), c.workDir.c_str()) == 0, "denied cwd alias creation failed");
            require(chmod(workTarget.c_str(), 0600) == 0, "unsearchable cwd chmod failed");
            const int workError = actualChdirError(c.workDir);
            require(workError == EACCES || workError == EPERM, "cwd fixture unexpectedly searchable");
            supervisor.start(c);
            const auto denied = terminal(supervisor);
            require(denied.state == "error" && denied.exitCode == 127 && denied.pid == 0 &&
                denied.message.find("chdir [" + c.workDir + "]") != std::string::npos &&
                (denied.message.find("errno=" + std::to_string(EACCES)) != std::string::npos ||
                 denied.message.find("errno=" + std::to_string(EPERM)) != std::string::npos),
                "real child chdir permission denial was not reported: " + denied.message);
            require(denied.logs.find("Started owned process pid=") != std::string::npos,
                "cwd search check did not reach the child chdir operation");
            require(chmod(workTarget.c_str(), 0700) == 0, "cwd recovery chmod failed");
            checkReadyAndStop(c);
            std::cout << "PASS real child chdir denial through symlink retains errno/path/reap and retry\n";
        }
        {
            Supervisor supervisor;
            auto c = config(fixture, root + "/ancestor-denied", "ready");
            const auto blocked = root + "/ancestor-denied/blocked";
            require(mkdir(blocked.c_str(), 0700) == 0 && mkdir((blocked + "/child").c_str(), 0700) == 0,
                "unsearchable ancestor fixture creation failed");
            RestoreMode ancestorMode{blocked};
            require(chmod(blocked.c_str(), 0600) == 0, "unsearchable ancestor chmod failed");
            const auto home = c.homeDir, work = c.workDir;
            for (bool checkHome : {true, false}) {
                c.homeDir = home; c.workDir = work;
                (checkHome ? c.homeDir : c.workDir) = blocked + "/child";
                supervisor.start(c);
                const auto denied = terminal(supervisor);
                require(denied.state == "error" && denied.exitCode == -1 && denied.pid == 0 &&
                    denied.message.find(blocked + "/child") != std::string::npos &&
                    (denied.message.find("errno=" + std::to_string(EACCES)) != std::string::npos ||
                     denied.message.find("errno=" + std::to_string(EPERM)) != std::string::npos),
                    "directory resolution swallowed ancestor search denial: " + denied.message);
            }
            std::cout << "PASS HOME/cwd ancestor search denial remains a preflight error\n";
        }
        {
            Supervisor supervisor;
            auto c = config(fixture, root + "/directory-types", "ready");
            const auto home = c.homeDir, work = c.workDir;
            const auto base = root + "/directory-types";
            std::ofstream(base + "/plain-file") << "not a directory\n";
            require(symlink((base + "/absent").c_str(), (base + "/dangling").c_str()) == 0,
                "dangling directory alias creation failed");
            require(symlink((base + "/plain-file").c_str(), (base + "/file-alias").c_str()) == 0,
                "file alias creation failed");
            require(symlink((base + "/cycle").c_str(), (base + "/cycle").c_str()) == 0,
                "directory cycle creation failed");
            const std::pair<const char*, int> invalid[] = {
                {"absent", ENOENT}, {"plain-file", ENOTDIR}, {"dangling", ENOENT},
                {"file-alias", ENOTDIR}, {"cycle", ELOOP}
            };
            for (bool checkHome : {true, false}) {
                for (const auto& entry : invalid) {
                    c.homeDir = home; c.workDir = work;
                    const auto path = base + "/" + entry.first;
                    (checkHome ? c.homeDir : c.workDir) = path;
                    supervisor.start(c);
                    const auto denied = terminal(supervisor);
                    require(denied.state == "error" && denied.exitCode == -1 && denied.pid == 0 &&
                        denied.message.find(path) != std::string::npos &&
                        denied.message.find("errno=" + std::to_string(entry.second)) != std::string::npos,
                        "directory preflight lost type/link error: " + denied.message);
                }
            }
            std::cout << "PASS HOME/cwd missing/non-directory/dangling/cyclic paths retain diagnostics\n";
        }
        checkReadyAndStop(config(fixture, root + "/chunked", "chunked", 34002, 1500), true);
        std::cout << "PASS chunked URL/ANSI/env/cwd/spaced paths/nonblocking/retry\n";
        checkReadyAndStop(config(fixture, root + "/lan", "lan", 0, 1500), true);
        std::cout << "PASS LAN suffix/ephemeral port\n";
        for (const auto& scenario : {"no-newline", "oversized", "malformed", "split-streams", "hang"}) {
            Supervisor supervisor;
            auto c = config(fixture, root + "/" + scenario, scenario, 34002, 250);
            supervisor.start(c);
            auto done = terminal(supervisor);
            require(done.state == "error" && done.message.find("timed out") != std::string::npos, std::string(scenario) + " accepted invalid output");
            require(done.exitCode != -1, "timed out child not reaped");
            if (std::string(scenario) == "hang") require(done.exitCode == 137, "TERM-resistant child not killed");
            std::cout << "PASS " << scenario << " rejection/timeout/redaction\n";
        }
        for (const auto& scenario : {"ready-exit", "exit-before"}) {
            Supervisor supervisor;
            auto c = config(fixture, root + "/" + scenario, scenario);
            supervisor.start(c);
            if (std::string(scenario) == "ready-exit") await(supervisor, [](const auto& s) { return s.state == "ready"; });
            const auto done = terminal(supervisor);
            require(done.state == "error" && done.exitCode == (std::string(scenario) == "ready-exit" ? 7 : 23), "exit code/state lost");
            require(done.url.empty(), "URL retained after child exit");
            std::cout << "PASS " << scenario << " exit/reap\n";
        }
        {
            Supervisor supervisor;
            auto c = config(fixture, root + "/exec-failure", "ready");
            const auto goodNode = c.nodePath;
            c.nodePath = root + "/exec-failure/not signed node";
            std::ofstream(c.nodePath) << "not an executable format\n";
            require(chmod(c.nodePath.c_str(), 0700) == 0, "invalid executable chmod failed");
            supervisor.start(c);
            const auto done = terminal(supervisor);
            require(done.state == "error" && done.message.find("execve signed Node") != std::string::npos &&
                done.message.find("errno=") != std::string::npos && done.message.find(c.nodePath) != std::string::npos, "exec failure lacks stage/path/errno");
            supervisor.stop();
            require(supervisor.snapshot().state == "stopped" && supervisor.snapshot().message == done.message, "error stop did not settle/preserve diagnostic");
            c.nodePath = goodNode; supervisor.start(c); await(supervisor, [](const auto& s) { return s.state == "ready"; });
            supervisor.stop(); terminal(supervisor);
            c.nodePath += ".missing"; supervisor.start(c);
            require(terminal(supervisor).message.find("errno=2") != std::string::npos, "ENOENT not reported");
            std::cout << "PASS exec failure errno/path and retry\n";
        }
        {
            Supervisor supervisor;
            auto c = config(fixture, root + "/private", "ready");
            const auto originalFiles = c.filesDir;
            require(mkdir(c.filesDir.c_str(), 0770) == 0 && chmod(c.filesDir.c_str(), 0770) == 0, "insecure directory setup failed");
            supervisor.start(c);
            require(terminal(supervisor).message.find("0700") != std::string::npos, "insecure directory accepted");
            struct stat st{}; stat(c.filesDir.c_str(), &st); require((st.st_mode & 0777) == 0770, "existing directory mode changed");
            c.filesDir = root + "/private/files-link";
            require(symlink(originalFiles.c_str(), c.filesDir.c_str()) == 0, "symlink setup failed");
            supervisor.start(c); require(terminal(supervisor).state == "error", "private symlink accepted");
            c.filesDir = originalFiles;
            require(chmod(c.filesDir.c_str(), 0700) == 0, "directory correction failed");
            require(symlink(c.homeDir.c_str(), (c.filesDir + "/dsh").c_str()) == 0, "DSH_HOME symlink setup failed");
            supervisor.start(c); require(terminal(supervisor).state == "error", "DSH_HOME symlink accepted");
            c.port = -1; rejects([&] { supervisor.start(c); });
            c.port = 65536; rejects([&] { supervisor.start(c); });
            c.port = 0; c.startupTimeoutMs = 0; rejects([&] { supervisor.start(c); });
            c.startupTimeoutMs = 1000; c.nodePath = "relative"; rejects([&] { supervisor.start(c); });
            std::cout << "PASS private modes/symlink/field validation\n";
        }
        {
            Supervisor supervisor;
            auto c = config(fixture, root + "/flood", "flood"); supervisor.start(c);
            await(supervisor, [](const auto& s) { return s.state == "ready" && s.logs.size() == 16384; });
            for (int i = 0; i < 50; ++i) { noSecrets(supervisor.snapshot()); pauseMs(1); }
            supervisor.stop(); require(terminal(supervisor).exitCode == 137, "flood starvation or lost KILL");
            std::cout << "PASS bounded logs/snapshot and TERM-resistant flood\n";
        }
        {
            auto c = config(fixture, root + "/group", "group");
            const pid_t unrelated = fork();
            require(unrelated >= 0, "unrelated fixture fork failed");
            if (unrelated == 0) { for (;;) pauseMs(100); }
            try {
                Supervisor supervisor; supervisor.start(c);
                await(supervisor, [](const auto& s) { return s.state == "ready"; });
                int descendant = 0; std::ifstream(root + "/group/descendant pid") >> descendant;
                require(descendant > 0, "descendant pid not written");
                pauseMs(50); supervisor.stop(); terminal(supervisor);
                struct stat before{}, after{};
                require(stat((root + "/group/descendant heartbeat").c_str(), &before) == 0, "descendant did not run");
                pauseMs(100); stat((root + "/group/descendant heartbeat").c_str(), &after);
                require(before.st_size == after.st_size, "owned process group descendant survived");
                require(kill(unrelated, 0) == 0, "unrelated service was killed");
                if (subreaper) {
                    int status = 0; require(waitpid(descendant, &status, 0) == descendant && WIFSIGNALED(status), "descendant not killed");
                }
            } catch (...) { kill(unrelated, SIGKILL); waitpid(unrelated, nullptr, 0); throw; }
            kill(unrelated, SIGKILL); waitpid(unrelated, nullptr, 0);
            std::cout << "PASS owned process group/unrelated process safety\n";
        }
        {
            auto c = config(fixture, root + "/quick-stop", "ready");
            Supervisor supervisor;
            for (int i = 0; i < 10; ++i) {
                supervisor.start(c); supervisor.stop();
                require(terminal(supervisor).state == "stopped", "quick stop/retry failed");
            }
            std::cout << "PASS repeated start/stop before fork\n";
        }
#if defined(__linux__)
        if (subreaper) {
            auto c = config(fixture, root + "/parent-death", "ready");
            int pipeFds[2]; require(pipe(pipeFds) == 0, "parent-death pipe failed");
            const pid_t owner = fork(); require(owner >= 0, "parent-death fork failed");
            if (owner == 0) {
                close(pipeFds[0]);
                Supervisor supervisor; supervisor.start(c);
                const auto s = await(supervisor, [](const auto& item) { return item.state == "ready"; });
                const int child = s.pid; write(pipeFds[1], &child, sizeof(child));
                for (;;) pauseMs(100);
            }
            close(pipeFds[1]); int child = 0;
            require(read(pipeFds[0], &child, sizeof(child)) == sizeof(child) && child > 0, "parent-death child missing");
            close(pipeFds[0]); kill(owner, SIGKILL); waitpid(owner, nullptr, 0);
            int status = 0; pid_t reaped = 0;
            const auto end = Clock::now() + std::chrono::seconds(2);
            while (Clock::now() < end && (reaped = waitpid(child, &status, WNOHANG)) == 0) pauseMs(10);
            if (reaped == 0) { kill(child, SIGKILL); waitpid(child, &status, 0); }
            require(reaped == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL, "PDEATHSIG did not kill Node child");
            std::cout << "PASS parent death signal\n";
        }
#endif
        close(200);
        std::cout << "PASS all native supervisor tests (no real dsh web started)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL " << error.what() << '\n'; return 1;
    }
}
