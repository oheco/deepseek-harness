#pragma once

#include "native_diagnostics.h"
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <future>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

struct ob_api_client;
struct ob_remote_peer;
struct ob_remote_map;

namespace dsh::broker { class CredentialStore; }

namespace dsh::broker {

// Remote network path; numbers equal ob_remote_relay_mode and the diagnostic flags.
enum class RelayMode { Auto = 0, Never = 1, Force = 2 };

struct Inputs {
    std::string serviceUrl, account, password, accessToken, authSessionId, credentialDir;
    std::string brokerId, peerPassword, tempDir, origin, token;
#ifdef DSH_BROKER_FIXTURE_TRUST
    // Compiled only in the standalone fixture library, never the App module.
    std::string testCaPath;
#endif
    int remotePort = 0, localPort = 0;
    RelayMode relayMode = RelayMode::Auto;
    Inputs() = default;
    Inputs(const Inputs&) = default;
    Inputs& operator=(const Inputs&) = default;
    Inputs(Inputs&&) = default;
    Inputs& operator=(Inputs&&) = default;
    ~Inputs();
};
struct Broker { std::string id, name; bool online = false; };
struct Status {
    std::string state = "idle", localUrl, brokerId, error, errorCode;
    int localPort = 0, remotePort = 0;
};
struct Result {
    std::string error, accessToken, authSessionId, probeState, errorCode = "DSH_BROKER";
    std::vector<Broker> brokers;
    Status status;
    int httpStatus = 0;
    Result() = default;
    Result(const Result&) = delete;
    Result& operator=(const Result&) = delete;
    Result(Result&&) = default;
    Result& operator=(Result&&) = default;
    ~Result();
};
// Values are stable numeric operation codes in system diagnostics.
enum class Method { Login = 0, List = 1, Connect = 2, Reconnect = 3, Status = 4, Close = 5, Probe = 6 };

/** One FIFO worker owns the persistent SDK peer/map/API and serializes state,
 * reconnect and close operations. Recoverable outages retain every handle and
 * listener port. Close invalidates queued work, interrupts the initial async
 * connection wait, and settles after SDK quiescence. Management REST operations
 * finish on their configured deadlines. Dispose joins after map/peer/API closure;
 * repeated dispose returns at once. `channel` only labels diagnostic records:
 * -1 is unassigned, otherwise the App channel 0..2147483647 owning this client. */
class Client final {
public:
    explicit Client(std::int64_t channel = -1);
    ~Client();
    Client(const Client&) = delete;
    Client& operator=(const Client&) = delete;
    std::future<Result> submit(Method method, Inputs inputs);
    Status status() const;
    void cancel();
    void dispose();
private:
    struct Task {
        Method method;
        Inputs inputs;
        std::uint64_t generation, enqueuedMs = 0, queueDepth = 0;
        std::promise<Result> promise;
    };
    struct Cancellation { Client* owner; std::uint64_t generation; };
    static int cancelled(void* data);
    void run();
    Result perform(Task& task);
    void release();
    void publish(Status status);
    bool publishCurrent(Status status, const Cancellation& cancellation);
    const char* prepareApi(const Inputs& input);
    void checkPeer();
    Result login(const Inputs& input, Cancellation& cancellation);
    Result list(const Inputs& input, Cancellation& cancellation);
    // Forced relay preflight: the account and service must both offer TURN; false fills result's error.
    bool relayAvailable(Result& result, Cancellation& cancellation);
    Result connect(const Inputs& input, Cancellation& cancellation);
    Result reconnect(Cancellation& cancellation);
    Result probe(const Inputs& input, Cancellation& cancellation);
    diag::Fields diagnosticFields() const noexcept;
    const std::int64_t channel_;
    std::atomic<bool> disposed_{false};
    mutable std::mutex stateMutex_;
    Status status_;
    std::mutex queueMutex_;
    std::condition_variable wake_;
    std::deque<std::unique_ptr<Task>> queue_;
    std::atomic<std::uint64_t> generation_{0};
    std::atomic<bool> stopping_{false};
    std::shared_ptr<CredentialStore> credentials_;
    ob_api_client* api_ = nullptr;
    ob_remote_peer* peer_ = nullptr;
    ob_remote_map* map_ = nullptr;
    std::uint64_t peerGeneration_ = 0;
    // Only the FIFO worker accesses these diagnostic snapshots.
    diag::ChangeGate<diag::SdkObservation> sdkLog_;
    diag::ChangeGate<diag::StatusObservation> statusLog_;
    std::string privateRoot_, caBundle_;
    // Construct last so the worker cannot observe uninitialized owned handles.
    std::thread worker_;
};

} // namespace dsh::broker
