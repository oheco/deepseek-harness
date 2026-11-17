---
description: "Signed HarmonyOS arm64 system primitives through stable Node-API."
kind: "package-library"
---
# @deepseek-ai/node-addon-system-openharmony-arm64

English | [中文](README.zh.md)

This platform package contains signed `bin/system.node` for HarmonyOS arm64. It provides POSIX flock and synchronous exclusive-file creation to the [`@deepseek-ai/node-addon-system` entry](../entry/README.md); import the entry's capability subpaths. It contains no Landlock launcher and performs no installation-time compilation.

Native builds require clang, llvm-objcopy, binary-sign-tool, and headers from the running Node installation. Build intermediates use `$TMPDIR` and the complete signed payload replaces the addon by a same-directory rename. Private files require an application-private filesystem; shared HOME ignores requested permission bits.
