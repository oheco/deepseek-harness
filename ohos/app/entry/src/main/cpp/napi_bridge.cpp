#include "probe.h"
#include "supervisor.h"
#include <napi/native_api.h>

#include <cmath>
#include <memory>
#include <stdexcept>
#include <string>

namespace {
using dsh::launcher::LaunchConfig;
using dsh::launcher::Probe;
using dsh::launcher::Supervisor;

void check(napi_status status) {
    if (status != napi_ok) throw std::runtime_error("NAPI operation failed");
}

napi_value property(napi_env env, napi_value config, const char* name) {
    bool present = false;
    check(napi_has_named_property(env, config, name, &present));
    if (!present) throw std::invalid_argument(std::string("Missing required LaunchConfig field: ") + name);
    napi_value value;
    check(napi_get_named_property(env, config, name, &value));
    return value;
}

std::string stringField(napi_env env, napi_value config, const char* name) {
    napi_value value = property(env, config, name);
    napi_valuetype type;
    check(napi_typeof(env, value, &type));
    if (type != napi_string) throw std::invalid_argument(std::string(name) + " must be a string");
    std::size_t size = 0;
    check(napi_get_value_string_utf8(env, value, nullptr, 0, &size));
    if (size == 0 || size >= 4096) throw std::invalid_argument(std::string(name) + " must contain 1..4095 UTF-8 bytes");
    std::string result(size + 1, '\0');
    std::size_t copied = 0;
    check(napi_get_value_string_utf8(env, value, result.data(), result.size(), &copied));
    result.resize(copied);
    return result;
}

double integerField(napi_env env, napi_value config, const char* name, double minimum, double maximum) {
    napi_value value = property(env, config, name);
    napi_valuetype type;
    check(napi_typeof(env, value, &type));
    if (type != napi_number) throw std::invalid_argument(std::string(name) + " must be a number");
    double number;
    check(napi_get_value_double(env, value, &number));
    if (!std::isfinite(number) || std::floor(number) != number || number < minimum || number > maximum) {
        throw std::invalid_argument(std::string(name) + " is outside its integer range");
    }
    return number;
}

napi_value undefined(napi_env env) {
    napi_value value; check(napi_get_undefined(env, &value)); return value;
}

Supervisor* receiver(napi_env env, napi_callback_info info, std::size_t& argc, napi_value* argv) {
    void* data = nullptr;
    check(napi_get_cb_info(env, info, &argc, argv, nullptr, &data));
    if (data == nullptr) throw std::runtime_error("Launcher instance missing");
    return static_cast<Supervisor*>(data);
}

// The module owns exactly one probe, and it exists only after a probe call, so
// probeSnapshot never observes an unstarted instance.
Probe* probeReceiver(napi_env env, napi_callback_info info, std::size_t& argc, napi_value* argv) {
    Supervisor* supervisor = receiver(env, info, argc, argv);
    const auto probe = supervisor->probe();
    if (probe == nullptr) throw std::runtime_error("No capability probe exists; call probe or start first");
    return probe.get();
}

napi_value report(napi_env env, const std::exception& error) {
    bool pending = false;
    if (napi_is_exception_pending(env, &pending) == napi_ok && !pending) {
        napi_throw_error(env, "DSH_LAUNCHER", error.what());
    }
    return nullptr;
}

LaunchConfig launchConfig(napi_env env, napi_value object) {
    napi_valuetype type; check(napi_typeof(env, object, &type));
    if (type != napi_object) throw std::invalid_argument("LaunchConfig must be an object");
    LaunchConfig c;
    c.nodePath = stringField(env, object, "nodePath");
    c.dshEntry = stringField(env, object, "dshEntry");
    c.homeDir = stringField(env, object, "homeDir");
    c.workDir = stringField(env, object, "workDir");
    c.filesDir = stringField(env, object, "filesDir");
    c.cacheDir = stringField(env, object, "cacheDir");
    c.tempDir = stringField(env, object, "tempDir");
    c.port = static_cast<int>(integerField(env, object, "port", 0, 65535));
    c.startupTimeoutMs = static_cast<std::int64_t>(integerField(env, object, "startupTimeoutMs", 1, 86400000));
    return c;
}

napi_value start(napi_env env, napi_callback_info info) {
    try {
        std::size_t argc = 2; napi_value argv[2];
        Supervisor* supervisor = receiver(env, info, argc, argv);
        if (argc != 1) throw std::invalid_argument("start requires exactly one LaunchConfig object");
        supervisor->start(launchConfig(env, argv[0]));
        return undefined(env);
    } catch (const std::exception& error) { return report(env, error); }
}

napi_value probe(napi_env env, napi_callback_info info) {
    try {
        std::size_t argc = 2; napi_value argv[2];
        Supervisor* supervisor = receiver(env, info, argc, argv);
        if (argc != 1) throw std::invalid_argument("probe requires exactly one LaunchConfig object");
        supervisor->probe(launchConfig(env, argv[0]));
        return undefined(env);
    } catch (const std::exception& error) { return report(env, error); }
}

void setString(napi_env env, napi_value object, const char* name, const std::string& value) {
    napi_value result; check(napi_create_string_utf8(env, value.data(), value.size(), &result));
    check(napi_set_named_property(env, object, name, result));
}

void setInteger(napi_env env, napi_value object, const char* name, int value) {
    napi_value result; check(napi_create_int32(env, value, &result));
    check(napi_set_named_property(env, object, name, result));
}

napi_value snapshot(napi_env env, napi_callback_info info) {
    try {
        std::size_t argc = 0;
        const auto current = receiver(env, info, argc, nullptr)->snapshot();
        napi_value result; check(napi_create_object(env, &result));
        setString(env, result, "state", current.state); setString(env, result, "url", current.url);
        setString(env, result, "message", current.message); setString(env, result, "logs", current.logs);
        setInteger(env, result, "pid", current.pid); setInteger(env, result, "exitCode", current.exitCode);
        return result;
    } catch (const std::exception& error) { return report(env, error); }
}

napi_value probeSnapshot(napi_env env, napi_callback_info info) {
    try {
        std::size_t argc = 0;
        const auto current = probeReceiver(env, info, argc, nullptr)->snapshot();
        napi_value result; check(napi_create_object(env, &result));
        napi_value running; check(napi_get_boolean(env, current.running, &running));
        check(napi_set_named_property(env, result, "running", running));
        setString(env, result, "report", current.report);
        return result;
    } catch (const std::exception& error) { return report(env, error); }
}

napi_value stop(napi_env env, napi_callback_info info) {
    try {
        std::size_t argc = 0; receiver(env, info, argc, nullptr)->stop();
        return undefined(env);
    } catch (const std::exception& error) { return report(env, error); }
}

void cleanup(napi_async_cleanup_hook_handle handle, void* data) {
    auto* supervisor = static_cast<Supervisor*>(data);
    supervisor->stop();
    // The registered async hook keeps the environment/module alive until the
    // worker has reaped its child; the UI teardown callback itself does not join.
    try {
        std::thread([supervisor, handle] {
            delete supervisor;
            napi_remove_async_cleanup_hook(handle);
        }).detach();
    } catch (const std::exception&) {
        // If thread creation fails, quiescence takes priority over unloading
        // code still used by a live worker.
        delete supervisor;
        napi_remove_async_cleanup_hook(handle);
    }
}

napi_value initialize(napi_env env, napi_value exports) {
    try {
        auto supervisor = std::make_unique<Supervisor>();
        napi_property_descriptor properties[] = {
            {"start", nullptr, start, nullptr, nullptr, nullptr, napi_default, supervisor.get()},
            {"snapshot", nullptr, snapshot, nullptr, nullptr, nullptr, napi_default, supervisor.get()},
            {"stop", nullptr, stop, nullptr, nullptr, nullptr, napi_default, supervisor.get()},
            {"probe", nullptr, probe, nullptr, nullptr, nullptr, napi_default, supervisor.get()},
            {"probeSnapshot", nullptr, probeSnapshot, nullptr, nullptr, nullptr, napi_default, supervisor.get()}
        };
        check(napi_define_properties(env, exports, 5, properties));
        check(napi_add_async_cleanup_hook(env, cleanup, supervisor.get(), nullptr));
        supervisor.release();
        return exports;
    } catch (const std::exception& error) { return report(env, error); }
}

napi_module module = {1, 0, nullptr, initialize, "dsh_launcher", nullptr, {0}};
} // namespace

extern "C" __attribute__((constructor)) void RegisterDshLauncherModule() {
    napi_module_register(&module);
}
