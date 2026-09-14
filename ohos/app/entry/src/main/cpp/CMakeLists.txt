cmake_minimum_required(VERSION 3.16)
project(dsh_launcher LANGUAGES CXX)

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

# Native fixture builds explicitly disable the ArkTS-only bridge.
option(DSH_BUILD_NAPI "Build the HarmonyOS ArkTS NAPI bridge" ON)
if(DSH_BUILD_NAPI)
    add_library(dsh_launcher SHARED napi_bridge.cpp)
    target_compile_options(dsh_launcher PRIVATE -Wall -Wextra -Wpedantic)
    target_link_libraries(dsh_launcher PRIVATE dsh_supervisor libace_napi.z.so)
endif()
