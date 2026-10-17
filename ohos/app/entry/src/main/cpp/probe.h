#ifndef DSH_OHOS_PROBE_H
#define DSH_OHOS_PROBE_H

#include "launcher_config.h"
#include "launcher_util.h"

#include <condition_variable>
#include <mutex>
#include <string>
#include <thread>

namespace dsh::launcher {

struct ProbeSnapshot {
    bool running = false;
    std::string report;
};

// One persistent worker runs read-only device capability checks over one set of
// launch paths. It never starts the DSH service, never signals or reaps a
// supervisor's child, and never signals a process it did not fork. Each check
// reports independently, so one failure cannot hide the checks after it.
class Probe final {
public:
    Probe();
    ~Probe();
    Probe(const Probe&) = delete;
    Probe& operator=(const Probe&) = delete;

    // Queues every check and returns without waiting. Throws logic_error while
    // running; callers validate the LaunchConfig before reaching this call.
    void start(const LaunchPaths& paths);
    // Copies the bounded ASCII report and the running flag under the mutex; the
    // report survives completion and is replaced by the next start.
    ProbeSnapshot snapshot() const;

private:
    void workerLoop();
    void run(const LaunchPaths& config);
    void publish(const std::string& line);
    void finish(const std::string& summary);

    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::string report_;
    LaunchPaths pending_{};
    bool running_ = false;
    bool queued_ = false;
    bool shutdown_ = false;
    std::thread worker_;
};

} // namespace dsh::launcher
#endif
