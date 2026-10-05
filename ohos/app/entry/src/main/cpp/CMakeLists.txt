cmake_minimum_required(VERSION 3.16)
project(dsh_launcher LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# Shared portability primitives: descriptor ownership, config field bounds, the
# fork-child failure record, and inherited-descriptor closure.
add_library(dsh_launcher_core STATIC launcher_util.cpp)
# Portable supervisor core: filesystem preflight, fork/exec, readiness parsing,
# timeouts, and reaping. The capability probe shares its failure protocol and
# path bounds, and the supervisor owns a probe, so both live in this target.
add_library(dsh_supervisor STATIC supervisor.cpp probe.cpp)
foreach(target dsh_launcher_core dsh_supervisor)
    set_target_properties(${target} PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_include_directories(${target} PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}")
    target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_definitions(${target} PRIVATE _GNU_SOURCE)
    # SDK libc has pthread_create but intentionally no pthread_cancel; CMake's
    # FindThreads libc probe requires the latter. Use the Clang/GCC driver flag.
    target_compile_options(${target} PUBLIC -pthread)
    target_link_options(${target} PUBLIC -pthread)
endforeach()
target_link_libraries(dsh_supervisor PUBLIC dsh_launcher_core)

# Supervisor-only fixtures can omit broker dependencies explicitly.
option(DSH_BUILD_BROKER "Build native broker SDK integration" ON)
if(DSH_BUILD_BROKER)
    include(broker_dependencies.cmake)
    add_subdirectory(broker_sdk)
    add_library(dsh_broker STATIC broker_client.cpp broker_trust.cpp)
    set_target_properties(dsh_broker PROPERTIES POSITION_INDEPENDENT_CODE ON)
    target_include_directories(dsh_broker PRIVATE "${DSH_BROKER_DEPENDENCY_ROOT}/include")
    target_compile_options(dsh_broker PRIVATE -Wall -Wextra -Wpedantic)
    target_link_libraries(dsh_broker PUBLIC ob_remote dsh_launcher_core)
endif()

# Native fixture builds explicitly disable the ArkTS-only bridge.
option(DSH_BUILD_NAPI "Build the HarmonyOS ArkTS NAPI bridge" ON)
if(DSH_BUILD_NAPI)
    if(NOT DSH_BUILD_BROKER)
        message(FATAL_ERROR "The App NAPI bridge requires DSH_BUILD_BROKER")
    endif()
    add_library(dsh_launcher SHARED napi_bridge.cpp broker_napi.cpp)
    target_compile_options(dsh_launcher PRIVATE -Wall -Wextra -Wpedantic)
    # Keep this pinned BoringSSL/curl implementation private to the module;
    # ArkWeb and platform libraries may load different TLS implementations.
    target_link_options(dsh_launcher PRIVATE "-Wl,--exclude-libs,ALL")
    target_link_libraries(dsh_launcher PRIVATE dsh_supervisor dsh_broker libace_napi.z.so)
endif()

option(DSH_BUILD_BROKER_TESTS "Build standalone native broker probes" OFF)
if(DSH_BUILD_BROKER_TESTS)
    enable_testing()
    # Fixture CA input is absent from the production library and App bridge.
    add_library(dsh_broker_fixture STATIC broker_client.cpp broker_trust.cpp)
    target_include_directories(dsh_broker_fixture PRIVATE "${DSH_BROKER_DEPENDENCY_ROOT}/include")
    target_compile_options(dsh_broker_fixture PRIVATE -Wall -Wextra -Wpedantic)
    target_compile_definitions(dsh_broker_fixture PUBLIC DSH_BROKER_FIXTURE_TRUST=1)
    target_link_libraries(dsh_broker_fixture PUBLIC ob_remote dsh_launcher_core)
    add_executable(dsh_broker_test broker_test.cpp)
    target_link_libraries(dsh_broker_test PRIVATE dsh_broker_fixture)
    add_test(NAME broker-client COMMAND dsh_broker_test)
endif()
