#include "supervisor.h"

#include <arpa/inet.h>
#include <algorithm>
#include <cctype>
#include <cerrno>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iostream>
#include <stdexcept>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <thread>
#include <unistd.h>

using dsh::launcher::LaunchConfig;
using dsh::launcher::Supervisor;
using Clock = std::chrono::steady_clock;
namespace {
void require(bool result, const char* message) { if (!result) throw std::runtime_error(message); }
void sleepTick() { std::this_thread::sleep_for(std::chrono::milliseconds(20)); }
std::string getHeaders(int port, const std::string& path, const std::string& cookie) {
    const int fd = socket(AF_INET, SOCK_STREAM, 0);
    require(fd >= 0, "HTTP socket failed");
    try {
        timeval timeout{3, 0};
        require(setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0 &&
            setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout)) == 0, "HTTP socket timeout setup failed");
        sockaddr_in address{};
        address.sin_family = AF_INET; address.sin_port = htons(static_cast<unsigned short>(port));
        address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        require(connect(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) == 0, "loopback HTTP connect failed");
        const std::string request = "GET " + path + " HTTP/1.1\r\nHost: 127.0.0.1:" + std::to_string(port) +
            "\r\nConnection: close\r\n" + (cookie.empty() ? "" : "Cookie: " + cookie + "\r\n") + "\r\n";
        std::size_t sent = 0;
        while (sent < request.size()) {
            const auto count = send(fd, request.data() + sent, request.size() - sent, MSG_NOSIGNAL);
            if (count < 0 && errno == EINTR) continue;
            require(count > 0, "HTTP send failed"); sent += static_cast<std::size_t>(count);
        }
        std::string headers;
        while (headers.find("\r\n\r\n") == std::string::npos && headers.size() < 16384) {
            char bytes[512]; const auto count = recv(fd, bytes, sizeof(bytes), 0);
            if (count < 0 && errno == EINTR) continue;
            require(count > 0, "HTTP header read failed"); headers.append(bytes, static_cast<std::size_t>(count));
        }
        require(headers.find("\r\n\r\n") != std::string::npos, "HTTP headers incomplete or oversized");
        close(fd);
        return headers.substr(0, headers.find("\r\n\r\n") + 2);
    } catch (...) { close(fd); throw; }
}

std::string headerValue(const std::string& headers, const std::string& name) {
    std::size_t pos = headers.find("\r\n") + 2;
    while (pos < headers.size()) {
        const auto end = headers.find("\r\n", pos);
        if (end == std::string::npos) break;
        const auto colon = headers.find(':', pos);
        if (colon != std::string::npos && colon < end) {
            std::string key = headers.substr(pos, colon - pos);
            std::transform(key.begin(), key.end(), key.begin(), [](unsigned char c) { return std::tolower(c); });
            if (key == name) {
                auto start = colon + 1;
                while (start < end && headers[start] == ' ') ++start;
                return headers.substr(start, end - start);
            }
        }
        pos = end + 2;
    }
    return {};
}

void http200(const std::string& url) {
    constexpr std::size_t prefixLength = sizeof("http://127.0.0.1:") - 1;
    const auto path = url.find('/', prefixLength);
    require(path != std::string::npos, "validated URL path missing");
    const int port = std::stoi(url.substr(prefixLength, path - prefixLength));
    const auto login = getHeaders(port, url.substr(path), "");
    require(login.rfind("HTTP/1.1 303 ", 0) == 0, "launch token did not produce the expected HTTP 303 login");
    require(headerValue(login, "location") == "/", "login redirect was not the same-origin root");
    const auto setCookie = headerValue(login, "set-cookie");
    require(!setCookie.empty() && setCookie.find("HttpOnly") != std::string::npos,
        "login did not issue an HttpOnly browser cookie");
    const auto cookie = setCookie.substr(0, setCookie.find(';'));
    require(cookie.find_first_of("\r\n") == std::string::npos, "invalid cookie header");
    const auto index = getHeaders(port, "/", cookie);
    require(index.rfind("HTTP/1.1 200 ", 0) == 0, "authenticated loopback GET did not return HTTP 200");
}
}

// This opt-in executable is not run by the native fixture recipe. The parent
// owns invocation as a managed job; neither authenticated URL nor body is logged.
int main(int argc, char** argv) {
    try {
        require(argc == 6 || argc == 7, "usage: dsh_launcher_smoke NODE DSH_ENTRY HOME WORK PRIVATE_ROOT [PORT]");
        const std::string root = argv[5];
        require(mkdir(root.c_str(), 0700) == 0, "PRIVATE_ROOT must be a new directory under an existing private parent");
        int port = 0;
        if (argc == 7) {
            char* end = nullptr; const long parsed = std::strtol(argv[6], &end, 10);
            require(end != argv[6] && *end == '\0' && parsed >= 0 && parsed <= 65535 && parsed != 9000, "invalid/forbidden smoke port");
            port = static_cast<int>(parsed);
        }
        LaunchConfig config{argv[1], argv[2], argv[3], argv[4], root + "/files", root + "/cache", root + "/temp", port, 90000};
        Supervisor supervisor; supervisor.start(config);
        std::cout << "starting isolated owned child" << std::endl;
        const auto deadline = Clock::now() + std::chrono::seconds(100);
        bool ready = false;
        while (Clock::now() < deadline) {
            const auto snapshot = supervisor.snapshot();
            if (snapshot.state == "ready") { http200(snapshot.url); ready = true; break; }
            if (snapshot.state == "error" || snapshot.state == "stopped") {
                std::cerr << snapshot.message << '\n' << snapshot.logs;
                throw std::runtime_error("child terminated before HTTP verification");
            }
            sleepTick();
        }
        require(ready, "smoke startup deadline expired");
        std::cout << "PASS authenticated loopback HTTP 200 (URL/token withheld)" << std::endl;
        supervisor.stop();
        const auto stopDeadline = Clock::now() + std::chrono::seconds(5);
        while (Clock::now() < stopDeadline) {
            const auto snapshot = supervisor.snapshot();
            if (snapshot.state == "stopped") {
                require(snapshot.url.empty() && snapshot.pid == 0 && snapshot.exitCode != -1, "child was not fully reaped");
                std::cout << "PASS stopped/reaped; no server retained" << std::endl; return 0;
            }
            require(snapshot.state != "error", "owned child shutdown failed"); sleepTick();
        }
        throw std::runtime_error("smoke reap deadline expired");
    } catch (const std::exception& error) {
        std::cerr << "FAIL " << error.what() << '\n'; return 1;
    }
}
