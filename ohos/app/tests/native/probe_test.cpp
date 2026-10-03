#include "probe.h"
#include "supervisor.h"

#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <signal.h>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <unistd.h>

using dsh::launcher::LaunchConfig;
using dsh::launcher::LaunchSnapshot;
using dsh::launcher::ProbeSnapshot;
using dsh::launcher::Supervisor;
using Clock = std::chrono::steady_clock;
namespace {
void require(bool condition, const std::string& message) { if (!condition) throw std::runtime_error(message); }
void pauseMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
void copyFile(const std::string& from, const std::string& to) {
    std::ifstream source(from, std::ios::binary);
    std::ofstream target(to, std::ios::binary);
    require(source.good() && target.good(), "fixture copy failed: " + from);
    target << source.rdbuf();
}
void rejects(const std::function<void()>& fn, const std::string& message) {
    bool rejected = false;
    try { fn(); } catch (const std::exception&) { rejected = true; }
    require(rejected, message);
}

LaunchSnapshot await(Supervisor& supervisor, const std::function<bool(const LaunchSnapshot&)>& predicate,
    int timeoutMs = 5000) {
    const auto end = Clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        const auto before = Clock::now();
        const auto current = supervisor.snapshot();
        require(Clock::now() - before < std::chrono::milliseconds(100), "supervisor snapshot blocked");
        if (predicate(current)) return current;
        if (Clock::now() > end) {
            throw std::runtime_error("supervisor wait timed out in " + current.state + ": " + current.message);
        }
        pauseMs(5);
    }
}

ProbeSnapshot awaitProbe(Supervisor& supervisor, int timeoutMs = 20000) {
    const auto end = Clock::now() + std::chrono::milliseconds(timeoutMs);
    for (;;) {
        const auto before = Clock::now();
        const auto probe = supervisor.probe();
        require(probe != nullptr, "supervisor owns no probe");
        const auto current = probe->snapshot();
        // The probe worker must never hold its mutex across a check.
        require(Clock::now() - before < std::chrono::milliseconds(100), "probe snapshot blocked");
        require(current.report.size() <= 8192, "probe report exceeds 8 KiB");
        if (!current.running) return current;
        if (Clock::now() > end) throw std::runtime_error("probe wait timed out");
        pauseMs(20);
    }
}

LaunchConfig config(const std::string& fixture, const std::string& root, const std::string& scenario) {
    require(mkdir(root.c_str(), 0700) == 0, "test root mkdir failed");
    // The fixture derives its root from HOME and requires this exact cwd, so the
    // two directories keep the spaced names the supervisor fixture uses.
    require(mkdir((root + "/home with spaces").c_str(), 0700) == 0, "home mkdir failed");
    require(mkdir((root + "/work with spaces").c_str(), 0700) == 0, "work mkdir failed");
    // The executable ignores its entry argument, so a readable plain file proves
    // the probe checks readability without requiring a built DSH entry.
    std::ofstream(root + "/entry.js") << "// native probe fixture entry\n";
    std::ofstream(root + "/scenario") << scenario << '\n';
    LaunchConfig c;
    c.nodePath = fixture;
    c.dshEntry = root + "/entry.js";
    c.homeDir = root + "/home with spaces";
    c.workDir = root + "/work with spaces";
    c.filesDir = root + "/files";
    c.cacheDir = root + "/cache";
    c.tempDir = root + "/temp";
    c.port = 34002;
    c.startupTimeoutMs = 1500;
    return c;
}

pid_t unrelatedProcess() {
    const pid_t pid = fork();
    require(pid >= 0, "unrelated fixture fork failed");
    if (pid == 0) { for (;;) pauseMs(100); }
    return pid;
}

void requireReport(const ProbeSnapshot& snapshot, const std::string& fixture) {
    require(!snapshot.running, "probe still running after wait");
    require(!snapshot.report.empty(), "probe report is empty");
    std::size_t lines = 0, info = 0, ok = 0, fail = 0;
    std::size_t pos = 0;
    while (pos < snapshot.report.size()) {
        const auto end = snapshot.report.find('\n', pos);
        require(end != std::string::npos, "probe report line is not newline-terminated");
        const std::string line = snapshot.report.substr(pos, end - pos);
        pos = end + 1;
        ++lines;
        require(line.rfind("OK ", 0) == 0 || line.rfind("FAIL ", 0) == 0 || line.rfind("INFO ", 0) == 0,
            "probe line lacks a status prefix: " + line);
        info += line.rfind("INFO ", 0) == 0;
        ok += line.rfind("OK ", 0) == 0;
        fail += line.rfind("FAIL ", 0) == 0;
        for (const char c : line) {
            require(static_cast<unsigned char>(c) >= 32 && static_cast<unsigned char>(c) <= 126,
                "probe line is not printable ASCII: " + line);
        }
        require(line.find("http://") == std::string::npos && line.find("https://") == std::string::npos,
            "probe line leaked an unredacted URL: " + line);
        require(line.size() <= 500, "probe line exceeds its bound");
    }
    require(pos == snapshot.report.size(), "probe report ends outside a line");
    require(lines >= 10 && lines <= 64, "probe report line count is outside its bound");
    require(info >= 4, "probe report lacks INFO detail lines");
    require(ok >= 2, "probe report lacks successful checks");
    // The environment decides which checks fail; the copy check is the one an
    // unsigned app-private process image cannot pass on this device.
    require(fail >= 1, "probe report lacks an independently reported failure");
    require(snapshot.report.find("FAIL exec private copy of /system/bin/sh") != std::string::npos,
        "probe did not report the app-private copy result");
    require(snapshot.report.find("INFO identity: uid=") != std::string::npos, "probe report lacks identity");
    require(snapshot.report.find("INFO mode nodePath=" + fixture) != std::string::npos, "probe report lacks nodePath mode");
    require(snapshot.report.find("OK open nodePath") != std::string::npos, "probe did not open nodePath");
    require(snapshot.report.find("OK open dshEntry") != std::string::npos, "probe did not open dshEntry");
    require(snapshot.report.find("exec nodePath --version: exit code=91") != std::string::npos,
        "probe did not report the fixture's exit status");
    require(snapshot.report.find("OK exec /usr/bin/zsh -c printf probe-ok") != std::string::npos,
        "probe did not report the system shell check");
    require(snapshot.report.find("exec private copy of /system/bin/sh") != std::string::npos,
        "probe did not run the app-private copy check");
    require(snapshot.report.find("INFO summary:") != std::string::npos, "probe report lacks a summary");
}
} // namespace

int main(int argc, char** argv) {
    try {
        require(argc == 3, "usage: probe_test SIGNED_FIXTURE PRIVATE_TEST_ROOT");
        std::cout.setf(std::ios::unitbuf);
        const std::string fixture = argv[1], parent = argv[2];
        require(mkdir(parent.c_str(), 0700) == 0 || errno == EEXIST, "test parent mkdir failed");
        std::string root = parent + "/probe-XXXXXX";
        require(mkdtemp(root.data()) != nullptr, "private test root creation failed");

        {
            // A mode 0000 file is the regression fixture: access(R_OK) reports
            // success for it on this device while open(O_RDONLY) fails EACCES.
            Supervisor supervisor;
            auto c = config(fixture, root + "/unreadable", "unused");
            require(open(c.dshEntry.c_str(), O_RDONLY | O_CLOEXEC) >= 0, "entry fixture unreadable before chmod");
            require(chmod(c.dshEntry.c_str(), 0000) == 0, "unreadable entry chmod failed");
            const int accessed = access(c.dshEntry.c_str(), R_OK);
            const int accessError = errno;
            const int opened = open(c.dshEntry.c_str(), O_RDONLY | O_CLOEXEC);
            const int openError = errno;
            if (opened >= 0) close(opened);
            std::cout << "fixture: access(R_OK) rc=" << accessed << " errno=" << accessError
                      << "; open(O_RDONLY) errno=" << openError << '\n';
            require(opened < 0 && openError == EACCES, "fixture did not actually deny reading the mode 0000 file");
            supervisor.start(c);
            const auto denied = await(supervisor, [](const auto& s) { return s.state == "error"; });
            require(denied.exitCode == -1 && denied.pid == 0, "preflight denial created a child");
            require(denied.message.find("open file [" + c.dshEntry + "]") != std::string::npos &&
                denied.message.find("errno=" + std::to_string(EACCES)) != std::string::npos,
                "real open denial was not reported with path and errno: " + denied.message);
            require(denied.message.find("access ") == std::string::npos, "access() still produced the diagnostic");
            require(denied.logs.find("Started owned process pid=") == std::string::npos,
                "unreadable entry reached fork/exec");
            require(chmod(c.dshEntry.c_str(), 0644) == 0, "entry fixture mode restore failed");
            std::cout << "PASS real open read denial reports errno/path before fork"
                      << (accessed == 0 ? " (access(R_OK) had reported success)" : "") << '\n';
        }
        {
            // Node execution needs an execute mode bit. A readable file without
            // one is refused by that check, in its own message form and before
            // any fork; the real open is what proves readability, so the two
            // outcomes stay separately reported.
            Supervisor supervisor;
            auto c = config(fixture, root + "/execute-bit", "ready");
            const std::string copy = root + "/execute-bit/node";
            copyFile(fixture, copy);
            require(chmod(copy.c_str(), 0400) == 0, "read-only chmod failed");
            c.nodePath = copy;
            supervisor.start(c);
            const auto refused = await(supervisor, [](const auto& s) { return s.state == "error"; });
            require(refused.exitCode == -1 && refused.pid == 0, "mode-bit refusal created a child");
            require(refused.message.find("execute bit [" + copy + "]") != std::string::npos &&
                refused.message.find("errno=" + std::to_string(EACCES)) != std::string::npos,
                "missing execute bit was not reported separately: " + refused.message);
            require(refused.message.find("open file [") == std::string::npos,
                "readable nodePath was denied by the readability check: " + refused.message);
            require(refused.logs.find("Started owned process pid=") == std::string::npos,
                "mode-bit refusal reached fork");
            require(chmod(copy.c_str(), 0700) == 0, "execute-bit mode restore failed");
            supervisor.stop();
            require(await(supervisor, [](const auto& s) { return s.state == "stopped"; }).state == "stopped",
                "mode-bit refusal did not settle to stopped");
            supervisor.start(c);
            const auto accepted = await(supervisor, [](const auto& s) { return s.state == "ready"; });
            require(accepted.pid > 0, "readable executable nodePath was rejected: " + accepted.message);
            supervisor.stop();
            require(await(supervisor, [](const auto& s) { return s.state == "stopped"; }).exitCode != -1,
                "execute-bit retry did not reap");
            std::cout << "PASS missing execute bit is refused separately from real readability\n";
        }
        {
            // The launch path runs its own probe. Neither the probe worker nor the
            // supervised child may signal or reap the other, or any unrelated
            // process, and the probe must not disturb the supervised run state.
            Supervisor supervisor;
            auto c = config(fixture, root + "/coexistence", "ready");
            const pid_t unrelated = unrelatedProcess();
            try {
                supervisor.start(c);
                const auto ready = await(supervisor, [](const auto& s) { return s.state == "ready"; });
                require(ready.pid > 0, "supervised fixture child missing");
                require(supervisor.probe() != nullptr, "start supplied no probe");
                const auto report = awaitProbe(supervisor);
                requireReport(report, fixture);
                require(supervisor.snapshot().state == "ready", "probe changed the supervised run state");
                int status = 0;
                require(waitpid(ready.pid, &status, WNOHANG) == 0, "probe reaped the supervised child");
                require(kill(unrelated, 0) == 0, "probe or supervisor killed an unrelated process");
                require(kill(ready.pid, 0) == 0, "probe killed the supervised child");
                supervisor.stop();
                require(await(supervisor, [](const auto& s) { return s.state == "stopped"; }).state == "stopped",
                    "supervised run did not stop after probing");
            } catch (...) { kill(unrelated, SIGKILL); waitpid(unrelated, nullptr, 0); throw; }
            kill(unrelated, SIGKILL); waitpid(unrelated, nullptr, 0);
            std::cout << "PASS start-supplied probe coexists with its child and an unrelated process\n";
        }
        {
            // Repeat start rejection, report stability, and per-probe replacement.
            Supervisor supervisor;
            auto c = config(fixture, root + "/repeat", "unused");
            supervisor.probe(c);
            const auto probe = supervisor.probe();
            const auto start = Clock::now();
            while (!probe->snapshot().running) {
                require(Clock::now() - start < std::chrono::seconds(2), "probe never reported running");
                pauseMs(1);
            }
            rejects([&] { supervisor.probe(c); }, "repeat probe start was accepted");
            const auto report = awaitProbe(supervisor);
            requireReport(report, fixture);
            require(probe->snapshot().running == false, "probe stayed running after completion");
            require(probe->snapshot().report == report.report, "completed report changed after completion");
            supervisor.probe(c);
            require(supervisor.probe() != probe, "probe instance was reused");
            require(supervisor.probe()->snapshot().report.empty(), "replacement probe kept the old report");
            const auto second = awaitProbe(supervisor);
            require(second.report.find("INFO summary:") != std::string::npos, "second probe did not complete");
            std::cout << "PASS probe repeat rejection, completion, and replacement\n";
        }
        {
            // start() supplies the probe the bridge polls; an invalid config must
            // be rejected before any probe exists.
            Supervisor supervisor;
            auto c = config(fixture, root + "/launch-probe", "ready");
            c.port = -1;
            rejects([&] { supervisor.start(c); }, "invalid port accepted with a probe request");
            require(supervisor.probe() == nullptr, "rejected start created a probe");
            c.port = 34002;
            supervisor.start(c);
            require(supervisor.probe() != nullptr, "start did not supply a probe");
            const auto report = awaitProbe(supervisor);
            requireReport(report, fixture);
            await(supervisor, [](const auto& s) { return s.state == "ready"; });
            supervisor.stop();
            require(await(supervisor, [](const auto& s) { return s.state == "stopped"; }).exitCode != -1,
                "stop after probe did not reap");
            std::cout << "PASS start-supplied probe and rejected-start cleanup\n";
        }
        {
            // A TERM-resistant check must still be bounded, killed, and reaped.
            Supervisor supervisor;
            auto c = config(fixture, root + "/timeout", "unused");
            const std::string stubborn = root + "/timeout/stubborn";
            {
                std::ofstream(stubborn) << "#!/system/bin/sh\ntrap '' TERM\nsleep 300\n";
            }
            require(chmod(stubborn.c_str(), 0700) == 0, "stubborn fixture chmod failed");
            c.nodePath = stubborn;
            const auto started = Clock::now();
            supervisor.probe(c);
            const auto report = awaitProbe(supervisor);
            const auto elapsed = Clock::now() - started;
            require(elapsed < std::chrono::seconds(12), "TERM-resistant check was not bounded");
            require(report.report.find("exec nodePath --version: exit code=-1 signal=") != std::string::npos &&
                (report.report.find("signal=15") != std::string::npos ||
                 report.report.find("signal=9") != std::string::npos),
                "TERM-resistant check did not report its terminating signal");
            std::cout << "PASS TERM-resistant probe check terminates and is reaped\n";
        }
        std::cout << "PASS all native capability probe tests (no real dsh web started)\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "FAIL " << error.what() << '\n'; return 1;
    }
}
