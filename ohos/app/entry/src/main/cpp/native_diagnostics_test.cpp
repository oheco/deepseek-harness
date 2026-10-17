// Standalone offline diagnostics test: no SDK, network, NAPI or hilog link.
#ifndef DSH_NATIVE_DIAGNOSTICS_NO_HILOG
#define DSH_NATIVE_DIAGNOSTICS_NO_HILOG 1
#endif
#include "native_diagnostics.h"

#include <cassert>
#include <cerrno>
#include <cstring>

namespace {
using namespace dsh::broker::diag;
unsigned calls = 0;
Event receivedEvent = Event::Cancel;
Fields receivedFields;
void receive(Event event, const Fields& fields) noexcept {
    ++calls; receivedEvent = event; receivedFields = fields;
    errno = EIO;
}
void fallback() {
    setTestSink(nullptr);
    emit(Event::ProbeStageEnd);
    assert(calls == 0);
    setTestSink(receive);
    Fields fields; fields.method = 6; fields.stage = static_cast<int>(Stage::Home);
    fields.curl = 28; fields.http = 503; fields.bodyBytes = 2048; fields.durationMs = 15000;
    errno = ENOENT;
    emit(Event::ProbeStageEnd, fields);
    assert(errno == ENOENT && calls == 1 && receivedEvent == Event::ProbeStageEnd);
    assert(receivedFields.method == 6 && receivedFields.stage == 2 && receivedFields.curl == 28 &&
        receivedFields.http == 503 && receivedFields.bodyBytes == 2048 && receivedFields.durationMs == 15000);
    assert(std::strcmp(eventName(receivedEvent), "native_probe_stage_end") == 0);
    setTestSink(nullptr);
    emit(Event::Cancel);
    assert(calls == 1);
}
void observations() {
    ChangeGate<SdkObservation> sdk;
    SdkObservation state; state.state = 3; state.error = -7; state.attempts = 1;
    assert(sdk.changed(state));
    // Repeated 250ms polling of an unchanged failure stays silent.
    for (unsigned poll = 0; poll < 1000; ++poll) assert(!sdk.changed(state));
    ++state.attempts; assert(sdk.changed(state));
    ++state.generation; assert(sdk.changed(state));
    state.state = 4; assert(sdk.changed(state));
    state.http = 401; assert(sdk.changed(state));
    state.queryCode = -1; assert(sdk.changed(state));
    state.mapped = true; assert(sdk.changed(state));
    ++state.appGeneration; assert(sdk.changed(state));
    sdk.reset(); assert(sdk.changed(state));

    ChangeGate<StatusObservation> status;
    StatusObservation current; current.state = 2; current.mapped = true;
    assert(status.changed(current));
    for (unsigned poll = 0; poll < 1000; ++poll) assert(!status.changed(current));
    current.error = true; assert(status.changed(current));
    assert(!status.changed(current));
    current.authError = true; assert(status.changed(current));
    current.state = 5; assert(status.changed(current));
    current.mapped = false; assert(status.changed(current));
    ++current.generation; assert(status.changed(current));
}
} // namespace
int main() {
    fallback(); observations();
    return 0;
}
