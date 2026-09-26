#ifndef DSH_OHOS_LAUNCHER_CONFIG_H
#define DSH_OHOS_LAUNCHER_CONFIG_H

#include <cstdint>
#include <string>

namespace dsh::launcher {

// The subset of a launch request that identifies the paths under inspection.
// Keeping it separate from LaunchConfig lets a probe copy exactly what it reads
// without copying the config's owned probe.
struct LaunchPaths {
    std::string nodePath;
    std::string dshEntry;
    std::string homeDir;
    std::string workDir;
    std::string filesDir;
    std::string cacheDir;
    std::string tempDir;
};

// Explicit launch inputs. Every path must be absolute and nonempty; no terminal
// environment, API credential, or ambient proxy setting is inherited.
struct LaunchConfig {
    std::string nodePath;
    std::string dshEntry;
    std::string homeDir;
    std::string workDir;
    std::string filesDir;
    std::string cacheDir;
    std::string tempDir;
    int port = 0;
    std::int64_t startupTimeoutMs = 0;
};

} // namespace dsh::launcher
#endif
