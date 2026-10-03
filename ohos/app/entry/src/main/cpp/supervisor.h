#ifndef DSH_OHOS_SUPERVISOR_H
#define DSH_OHOS_SUPERVISOR_H

#include "launcher_config.h"
#include "launcher_util.h"

#include <condition_variable>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace dsh::launcher {

class Probe;

struct LaunchSnapshot {
    std::string state = "idle";
    std::string url;
    std::string message;
    std::string logs;
    int pid = 0;
    int exitCode = -1;
};

// One worker owns each child until reap. Public methods never wait for child I/O,
// directory access, exec, or termination. Destruction requests stop and joins.
class Supervisor final {
public:
    Supervisor();
    ~Supervisor();
    Supervisor(const Supervisor&) = delete;
    Supervisor& operator=(const Supervisor&) = delete;

    // Throws invalid_argument for invalid fields, logic_error while active.
    void start(LaunchConfig config);
    // Starts a capability probe for these paths. A probe neither starts nor
    // touches the supervised child, so a probe may run while a launch is active.
    // Throws invalid_argument for an invalid field, logic_error while one runs.
    void probe(const LaunchConfig& config);
    LaunchSnapshot snapshot() const;
    // The owned probe, or null before the first start/probe call.
    std::shared_ptr<Probe> probe() const;
    void stop();

private:
    void workerLoop();
    void run(const LaunchConfig& config);
    void appendLog(const std::string& line);
    void acceptUrl(std::string url);
    void beginStopping(const std::string& message);
    bool stopRequested() const;
    void finish(bool failed, const std::string& message, int exitCode);

    mutable std::mutex mutex_;
    std::condition_variable wake_;
    LaunchSnapshot snapshot_;
    LaunchConfig pending_{};
    std::shared_ptr<Probe> probe_;
    bool active_ = false;
    bool queued_ = false;
    bool stop_ = false;
    bool shutdown_ = false;
    std::thread worker_;
};

} // namespace dsh::launcher
#endif
