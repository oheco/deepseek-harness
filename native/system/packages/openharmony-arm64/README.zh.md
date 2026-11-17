---
description: "通过稳定 Node-API 提供已签名的鸿蒙 arm64 系统原语。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system-openharmony-arm64

[English](README.md) | 中文

本平台包包含鸿蒙 arm64 已签名的 `bin/system.node`，向 [`@deepseek-ai/node-addon-system` 入口](../entry/README.zh.md)提供 POSIX flock 及同步排他文件创建；请导入入口的能力子路径。本包不包含 Landlock 启动器，也不在安装时编译。

原生构建需要 clang、llvm-objcopy、binary-sign-tool 及当前 Node 安装的头文件。构建中间文件使用 `$TMPDIR`，完整的已签名产物通过同目录重命名替换扩展。私有文件需要应用私有文件系统；共享 HOME 忽略请求的权限位。
