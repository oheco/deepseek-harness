#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <signal.h>
#include <string>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <netinet/in.h>

extern char** environ;
namespace {
void emit(int fd, const std::string& text) {
    std::size_t offset = 0;
    while (offset < text.size()) {
        const auto n = write(fd, text.data() + offset, text.size() - offset);
        if (n > 0) offset += static_cast<std::size_t>(n);
        else if (n < 0 && errno == EINTR) continue;
        else _exit(90);
    }
}
void pauseMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
[[noreturn]] void waitForever() { for (;;) pauseMs(50); }
std::string env(const char* name) { const auto* value = std::getenv(name); return value == nullptr ? "" : value; }
}

int main(int argc, char** argv) {
    if (argc != 9 || std::string(argv[1]) != "--expose-internals" || std::string(argv[3]) != "web" ||
        std::string(argv[4]) != "--host" || std::string(argv[5]) != "127.0.0.1" ||
        std::string(argv[6]) != "--port" || std::string(argv[8]) != "--no-open") return 91;
    std::string mode;
    std::ifstream scenario(argv[2]); std::getline(scenario, mode);
    const auto home = env("HOME");
    const auto root = home.substr(0, home.rfind('/'));
    if (env("DSH_HOME") != root + "/files/dsh" || env("XDG_CONFIG_HOME") != root + "/files" ||
        env("XDG_CACHE_HOME") != root + "/cache" || env("TMPDIR") != root + "/temp" ||
        env("PATH") != std::string(argv[0]).substr(0, std::string(argv[0]).rfind('/')) + ":" + home + "/.oheco/bin:/usr/bin:/system/bin") return 92;
    int envCount = 0;
    for (char** entry = environ; *entry != nullptr; ++entry) ++envCount;
    if (envCount != 6 || std::getenv("DSH_TEST_SECRET") || std::getenv("NODE_OPTIONS") || std::getenv("DEEPSEEK_API_KEY")) return 93;
    char cwd[4096];
    if (!getcwd(cwd, sizeof(cwd)) || std::string(cwd) != root + "/work with spaces") return 94;
    struct stat st{};
    for (const auto& dir : {"files", "files/dsh", "cache", "temp"}) {
        if (stat((root + "/" + dir).c_str(), &st) != 0 || (st.st_mode & 0777) != 0700 || st.st_uid != geteuid()) return 95;
    }
    // The parent deliberately leaves descriptor 200 open without CLOEXEC.
    if (fcntl(200, F_GETFD) >= 0 || errno != EBADF) return 96;
    if (getpgrp() != getpid()) return 97;
    unsigned port = static_cast<unsigned>(std::strtoul(argv[7], nullptr, 10));
    int socketFd = -1;
    if (port == 0) {
        socketFd = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in address{}; address.sin_family = AF_INET; address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        if (socketFd < 0 || bind(socketFd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0) return 98;
        socklen_t length = sizeof(address);
        if (getsockname(socketFd, reinterpret_cast<sockaddr*>(&address), &length) != 0) return 99;
        port = ntohs(address.sin_port);
    }
    const std::string token = "secret_Aa-123";
    const std::string url = "http://127.0.0.1:" + std::to_string(port) + "/?token=" + token;
    const std::string line = "dsh web: " + url;
    if (mode == "exit-before") { emit(2, "loader failed secret_Aa-123\n"); return 23; }
    if (mode == "hang") { signal(SIGTERM, SIG_IGN); waitForever(); }
    if (mode == "no-newline") { emit(1, line); emit(2, "token=secret_Aa-123"); waitForever(); }
    if (mode == "oversized") {
        emit(1, std::string(9000, 's') + line + std::string(40000, 'x') + "\n");
        emit(2, "secret_Aa-123" + std::string(50000, 't') + "\n"); waitForever();
    }
    if (mode == "malformed") {
        emit(1, "prefix " + line + "\n" + line + "&evil=yes\n" + line + "#fragment\n" +
            "dsh web: http://127.0.0.1:0/?token=secret_Aa-123\n" +
            "dsh web: http://127.0.0.1:65536/?token=secret_Aa-123\n" +
            "dsh web: http://127.0.0.1:01/?token=secret_Aa-123\n" +
            "dsh web: http://127.0.0.1:34002/?token=\n" +
            "dsh web: http://127.0.0.1:34002/?token=secret%2F123\n" +
            "dsh web: http://127.0.0.1:34002/?token=secret+123\n" +
            "dsh web: http://127.0.0.1:34002/?token=secret=\n" +
            "dsh web: http://127.0.0.1.evil:34002/?token=secret_Aa-123\n" +
            "dsh web: http://127.0.0.1@evil:34002/?token=secret_Aa-123\n" +
            "dsh web: https://127.0.0.1:34002/?token=secret_Aa-123\n" +
            "dsh web: http://[::1]:34002/?token=secret_Aa-123\n" +
            "dsh web: http://localhost:34002/?token=secret_Aa-123\n" +
            "dsh web: http://127.0.0.1:34002?token=secret_Aa-123\n" +
            "dsh web: http://127.0.0.1:999999999999999999999/?token=secret_Aa-123\n" +
            line + " (LAN: javascript:secret_Aa-123)\n" +
            line + " (LAN: http://192.168.1.4:34002/?token=other)\n" +
            line + " (LAN: http://192.168.1.999:34002/?token=secret_Aa-123)\n" +
            "dsh web: http://127.0.0.1:34003/?token=secret_Aa-123\n");
        emit(2, line + "\n"); waitForever();
    }
    if (mode == "split-streams") {
        emit(1, line.substr(0, 20)); emit(2, line.substr(20) + "\n"); waitForever();
    }
    if (mode == "chunked" || mode == "lan") {
        emit(2, "raw secret_\nAa-123\nto"); pauseMs(20); emit(2, "ken=secret_Aa-123\n");
        emit(1, "\x1b[3"); pauseMs(20); emit(1, "2mdsh web: http://127."); pauseMs(20);
        emit(1, "0.0.1:" + std::to_string(port) + "/?to"); pauseMs(20);
        emit(1, "ken=secret_"); pauseMs(20); emit(1, "Aa-123\x1b[0m"); pauseMs(120);
        if (mode == "lan") emit(1, " (LAN: http://192.168.1.4:" + std::to_string(port) + "/?token=secret_Aa-123)");
        emit(1, "\r\n"); waitForever();
    }
    if (mode == "group") {
        const pid_t descendant = fork();
        if (descendant < 0) return 101;
        if (descendant == 0) {
            signal(SIGTERM, SIG_IGN);
            const int marker = open((root + "/descendant heartbeat").c_str(), O_WRONLY | O_CREAT | O_APPEND, 0600);
            if (marker < 0) return 102;
            for (;;) { emit(marker, "."); pauseMs(10); }
        }
        std::ofstream(root + "/descendant pid") << descendant;
        signal(SIGTERM, SIG_IGN);
    }
    emit(1, line + "\n");
    if (mode == "ready-exit") { pauseMs(140); return 7; }
    if (mode == "flood") {
        signal(SIGTERM, SIG_IGN);
        for (;;) { emit(1, "output secret_Aa-123\n"); emit(2, "token=secret_Aa-123\n"); }
    }
    waitForever();
}
