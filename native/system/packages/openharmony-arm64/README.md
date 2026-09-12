# HarmonyOS ARM64 system binding

English | [中文](README.zh.md)

Signed Node-API v8 `flock` binding for HarmonyOS PC ARM64. The caller owns the file descriptor; closing it releases the lock. This package contains no Landlock launcher. Build it on HarmonyOS with `node native/system/scripts/build.ts --host-addon-only` from the repository root and `binary-sign-tool` in PATH.
