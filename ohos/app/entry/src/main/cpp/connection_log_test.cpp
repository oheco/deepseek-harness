#include "connection_log.h"
#include <cassert>
#include <algorithm>
#include <cstdlib>
#include <filesystem>
#include <fcntl.h>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>
#include <vector>

namespace {
using namespace dsh::diagnostics;
template<class Function> void refused(Function function) {
    bool failed = false;
    try { function(); } catch (const std::exception&) { failed = true; }
    assert(failed);
}
void privacyAndBounds(const std::string& root) {
    refused([] { read(); });
    const auto directory = root + "/journal";
    configure(directory);
    appendApp("app.open", "generation=1 remote=0");
    write("native", "native_sdk_state", "state=2 http=503");
    auto text = read();
    assert(text.find("event=app.open generation=1 remote=0") != std::string::npos);
    assert(text.find("source=native event=native_sdk_state state=2 http=503") != std::string::npos);
    assert(text.find("wallMs=") != std::string::npos && text.find("monoMs=") != std::string::npos);
    for (const auto* fields : {"token=private-secret", "url=https://private.invalid", "body=private-secret", "value=1\nprivate-secret", "count=1.5", "count=NaN"})
        refused([&] { appendApp("app.input", fields); });
    refused([] { appendApp("secret\nprivate-secret", "count=1"); });
    assert(read().find("private-secret") == std::string::npos);
    struct stat info{};
    assert(stat(directory.c_str(), &info) == 0 && (info.st_mode & 0777) == 0700);
    assert(stat((directory + "/connection.log").c_str(), &info) == 0 && (info.st_mode & 0777) == 0600);
    std::vector<std::thread> workers;
    for (int worker = 0; worker < 4; ++worker) workers.emplace_back([worker] {
        for (int sequence = 0; sequence < 100; ++sequence)
            appendApp("app.concurrent", "worker=" + std::to_string(worker) + " sequence=" + std::to_string(sequence));
    });
    for (auto& worker : workers) worker.join();
    text = read();
    assert(std::count(text.begin(), text.end(), '\n') == 402);
}
void rotate(const std::string& root) {
    const auto directory = root + "/rotation";
    configure(directory);
    appendApp("app.retired", "count=0");
    for (int count = 1; count <= 25000; ++count)
        appendApp("app.rotation", "count=" + std::to_string(count) + " generation=1 elapsedMs=12345 state=2");
    const auto text = read();
    assert(text.size() <= 2 * 1024 * 1024 && text.find("app.retired") == std::string::npos);
    assert(text.find("count=25000 ") != std::string::npos);
    assert(text.back() == '\n');
    struct stat info{};
    for (const auto* name : {"connection.log", "connection.previous.log"}) {
        assert(stat((directory + "/" + name).c_str(), &info) == 0);
        assert(info.st_size <= 1024 * 1024 && (info.st_mode & 0777) == 0600);
    }
    assert(chmod((directory + "/connection.log").c_str(), 0644) == 0);
    appendApp("app.write_must_not_throw", "count=1");
    refused([] { read(); });
    assert(chmod((directory + "/connection.log").c_str(), 0600) == 0);
    assert(read().find("diagnostics.write_failed") != std::string::npos);
}
void unsafeFiles(const std::string& root) {
    const auto publicDirectory = root + "/public";
    assert(mkdir(publicDirectory.c_str(), 0755) == 0);
    refused([&] { configure(publicDirectory); });
    const auto linkedDirectory = root + "/directory-link";
    assert(symlink((root + "/journal").c_str(), linkedDirectory.c_str()) == 0);
    refused([&] { configure(linkedDirectory); });
    const auto directory = root + "/unsafe";
    assert(mkdir(directory.c_str(), 0700) == 0);
    assert(symlink((root + "/journal/connection.log").c_str(), (directory + "/connection.log").c_str()) == 0);
    refused([&] { configure(directory); });
    assert(unlink((directory + "/connection.log").c_str()) == 0);
    assert(mkfifo((directory + "/connection.log").c_str(), 0600) == 0);
    refused([&] { configure(directory); });
}
} // namespace
int main(int argc, char** argv) {
    assert(argc == 1 || (argc == 2 && argv[1][0] == '/'));
    std::string root;
    std::string pattern;
    if (argc == 1) {
        const char* temporary = std::getenv("TMPDIR");
        assert(temporary && temporary[0] == '/');
        pattern = std::string(temporary) + "/dsh-connection-log-XXXXXX";
        char* created = mkdtemp(pattern.data());
        assert(created);
        root = created;
    } else { root = argv[1]; }
    privacyAndBounds(root); rotate(root); unsafeFiles(root);
    if (argc == 1) {
        assert(root == pattern && root.find("/dsh-connection-log-") != std::string::npos);
        std::filesystem::remove_all(root);
    }
    return 0;
}
