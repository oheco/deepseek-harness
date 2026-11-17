#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cerrno>
#include <cstdio>
#ifdef DSH_NATIVE_DIAGNOSTICS_FILE
#include "connection_log.h"
#endif

#if !defined(DSH_NATIVE_DIAGNOSTICS_NO_HILOG) && defined(__OHOS__) && __has_include(<hilog/log.h>)
#include <hilog/log.h>
#define DSH_NATIVE_DIAGNOSTICS_HILOG 1
#endif

namespace dsh::broker::diag {

// Only fixed event names and numeric fields can reach the logging sink.
enum class Event {
    QueueEnqueued, QueueError, QueueDropped, OperationBegin, OperationEnd,
    Cancel, DisposeBegin, DisposeEnd, ReleaseBegin, ReleaseEnd,
    SdkState, SdkRecoveryStopped, SdkCallEnd, ApiCallEnd,
    ProbeStageBegin, ProbeStageEnd, ProbeSetupFailed,
    NapiBegin, NapiExecute, NapiComplete, NapiFailure, NapiForcedClose,
    NapiCleanupBegin, NapiCleanupEnd, NapiChannelReleaseBegin, NapiChannelReleaseEnd
};
enum class Outcome { Ok = 0, Failed = 1, Cancelled = 2, Exception = 3 };
enum class Stage {
    None = 0, TokenExchange = 1, Home = 2, CurlInit = 3, CurlHandle = 4,
    TokenEncode = 5, CurlOptions = 6, CookieHeader = 7, HomeOptions = 8,
    ApiCreate = 9, ApiRequest = 10, PeerConnect = 11, PortMap = 12,
    PortMapFallback = 13, PeerReconnect = 14,
    MapClose = 15, PeerClose = 16, ApiDestroy = 17,
    NapiPromise = 18, NapiArguments = 19, NapiInputs = 20,
    NapiCreateWork = 21, NapiSubmit = 22, NapiQueue = 23,
    NapiSettle = 24, NapiDeleteWork = 25, NapiFuture = 26,
    NapiCloseSubmit = 27, NapiCleanupThread = 28, NapiChannel = 29, NapiDispose = 30,
    RelayCheck = 31
};
struct Fields {
    int method = -1, stage = 0, outcome = 0, code = 0, http = 0, curl = 0, state = -1;
    // App broker channel 0..2147483647; -1 marks module-wide or unassigned records.
    std::int64_t channel = -1;
    std::uint64_t appGeneration = 0, sdkGeneration = 0, attempts = 0, retryMs = 0;
    std::uint64_t startMs = 0, durationMs = 0, queueMs = 0, bodyBytes = 0, depth = 0, flags = 0;
};
inline std::uint64_t nowMs() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}
inline const char* eventName(Event event) noexcept {
    switch (event) {
        case Event::QueueEnqueued: return "native_queue_enqueued";
        case Event::QueueError: return "native_queue_error";
        case Event::QueueDropped: return "native_queue_dropped";
        case Event::OperationBegin: return "native_operation_begin";
        case Event::OperationEnd: return "native_operation_end";
        case Event::Cancel: return "native_cancel";
        case Event::DisposeBegin: return "native_dispose_begin";
        case Event::DisposeEnd: return "native_dispose_end";
        case Event::ReleaseBegin: return "native_release_begin";
        case Event::ReleaseEnd: return "native_release_end";
        case Event::SdkState: return "native_sdk_state";
        case Event::SdkRecoveryStopped: return "native_sdk_recovery_stopped";
        case Event::SdkCallEnd: return "native_sdk_call_end";
        case Event::ApiCallEnd: return "native_api_call_end";
        case Event::ProbeStageBegin: return "native_probe_stage_begin";
        case Event::ProbeStageEnd: return "native_probe_stage_end";
        case Event::ProbeSetupFailed: return "native_probe_setup_failed";
        case Event::NapiBegin: return "native_napi_begin";
        case Event::NapiExecute: return "native_napi_execute";
        case Event::NapiComplete: return "native_napi_complete";
        case Event::NapiFailure: return "native_napi_failure";
        case Event::NapiForcedClose: return "native_napi_forced_close";
        case Event::NapiCleanupBegin: return "native_napi_cleanup_begin";
        case Event::NapiCleanupEnd: return "native_napi_cleanup_end";
        case Event::NapiChannelReleaseBegin: return "native_napi_channel_release_begin";
        case Event::NapiChannelReleaseEnd: return "native_napi_channel_release_end";
    }
    return "native_unknown";
}
// Journal field text; the hilog format below lists the same fields in the same order.
inline int format(char* buffer, std::size_t size, const Fields& fields) noexcept {
    return std::snprintf(buffer, size,
        "method=%d channel=%lld stage=%d outcome=%d code=%d http=%d curl=%d state=%d app_gen=%llu sdk_gen=%llu "
        "attempts=%llu retry_ms=%llu start_ms=%llu duration_ms=%llu queue_ms=%llu body_bytes=%llu depth=%llu flags=%llu",
        fields.method, static_cast<long long>(fields.channel), fields.stage, fields.outcome, fields.code, fields.http,
        fields.curl, fields.state,
        static_cast<unsigned long long>(fields.appGeneration), static_cast<unsigned long long>(fields.sdkGeneration),
        static_cast<unsigned long long>(fields.attempts), static_cast<unsigned long long>(fields.retryMs),
        static_cast<unsigned long long>(fields.startMs), static_cast<unsigned long long>(fields.durationMs),
        static_cast<unsigned long long>(fields.queueMs), static_cast<unsigned long long>(fields.bodyBytes),
        static_cast<unsigned long long>(fields.depth), static_cast<unsigned long long>(fields.flags));
}

#ifndef DSH_NATIVE_DIAGNOSTICS_HILOG
// Fixture/host fallback is silent until a test installs a nonthrowing sink.
using Sink = void (*)(Event, const Fields&) noexcept;
inline std::atomic<Sink> testSink{nullptr};
inline void setTestSink(Sink sink) noexcept { testSink.store(sink); }
#endif
inline void emit(Event event, const Fields& fields = {}) noexcept {
    const int savedErrno = errno;
#ifdef DSH_NATIVE_DIAGNOSTICS_FILE
    char values[1024];
    const int length = format(values, sizeof(values), fields);
    if (length > 0 && static_cast<std::size_t>(length) < sizeof(values)) {
        try { dsh::diagnostics::write("native", eventName(event), values); }
        catch (...) { /* Allocation failure cannot alter broker behavior. */ }
    }
#endif
#ifdef DSH_NATIVE_DIAGNOSTICS_HILOG
    OH_LOG_Print(LOG_APP, fields.outcome || fields.code ? LOG_WARN : LOG_INFO, 0xD530, "DSHConnNative",
        "%{public}s method=%{public}d channel=%{public}lld stage=%{public}d outcome=%{public}d code=%{public}d "
        "http=%{public}d curl=%{public}d state=%{public}d app_gen=%{public}llu sdk_gen=%{public}llu "
        "attempts=%{public}llu retry_ms=%{public}llu start_ms=%{public}llu duration_ms=%{public}llu queue_ms=%{public}llu "
        "body_bytes=%{public}llu depth=%{public}llu flags=%{public}llu mono_ms=%{public}llu",
        eventName(event), fields.method, static_cast<long long>(fields.channel), fields.stage, fields.outcome,
        fields.code, fields.http, fields.curl, fields.state,
        static_cast<unsigned long long>(fields.appGeneration), static_cast<unsigned long long>(fields.sdkGeneration),
        static_cast<unsigned long long>(fields.attempts), static_cast<unsigned long long>(fields.retryMs),
        static_cast<unsigned long long>(fields.startMs), static_cast<unsigned long long>(fields.durationMs),
        static_cast<unsigned long long>(fields.queueMs),
        static_cast<unsigned long long>(fields.bodyBytes), static_cast<unsigned long long>(fields.depth),
        static_cast<unsigned long long>(fields.flags), static_cast<unsigned long long>(nowMs()));
#else
    if (auto sink = testSink.load()) sink(event, fields);
#endif
    errno = savedErrno;
}

struct SdkObservation {
    int queryCode = 0, state = -1, error = 0, http = 0;
    std::uint64_t attempts = 0, generation = 0, appGeneration = 0;
    bool mapped = false;
    bool operator==(const SdkObservation& other) const noexcept {
        return queryCode == other.queryCode && state == other.state && error == other.error && http == other.http &&
            attempts == other.attempts && generation == other.generation && appGeneration == other.appGeneration && mapped == other.mapped;
    }
};
struct StatusObservation {
    int state = -1;
    bool error = false, authError = false, mapped = false;
    std::uint64_t generation = 0;
    bool operator==(const StatusObservation& other) const noexcept {
        return state == other.state && error == other.error && authError == other.authError &&
            mapped == other.mapped && generation == other.generation;
    }
};
// Retry countdown and timing fields deliberately do not affect change detection.
template<class Observation> class ChangeGate {
public:
    bool changed(const Observation& next) noexcept {
        if (valid_ && previous_ == next) return false;
        previous_ = next; valid_ = true; return true;
    }
    void reset() noexcept { valid_ = false; }
private:
    bool valid_ = false;
    Observation previous_{};
};
} // namespace dsh::broker::diag
