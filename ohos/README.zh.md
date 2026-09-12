---
description: "在鸿蒙 PC ARM64 上安装、构建和验证 DeepSeek Harness。"
---

# 鸿蒙上的 DeepSeek Harness

[English](README.md) | 中文

## 摘要

此发行版在鸿蒙 PC ARM64 上使用 Node.js 24 或更高版本及 `/usr/bin/zsh` 运行 CLI/headless 和浏览器 Web 配置。npm 包包含应用及其 JavaScript 运行依赖；oheco 通过 npm 提供适配后的 node-pty、Koffi、sharp 和 ripgrep 包。

## 安装与使用

使用 oo 0.5.0 或更高版本。安装到可写的 npm 前缀目录，并将其 `bin` 目录加入 `PATH`：

```sh
oo update
oo npm install --global --prefix "$HOME/.local" @deepseek-ai/dsh@0.1.5-rc.2-ohos.2
export PATH="$HOME/.local/bin:$PATH"
dsh --help
```

将 `DSH_HOME` 设置为可写的应用私有目录。调用远程提供方前配置 `DEEPSEEK_API_KEY`。`dsh --profile headless "your task"` 运行命令行任务；`dsh web --host 127.0.0.1 --port 0 --no-open` 启动浏览器界面。按 Web 配置输出的地址和认证说明操作。

鸿蒙默认允许完整的文件系统和进程访问，并禁用审批。显式权限配置仍然有效；请求沙箱时，如果没有受支持的后端，则运行失败。Shell 工具使用 zsh 语法。可选的持久终端工具需要带 `termios` 的 Python 3。Sharp 使用上游 WASM 实现；其支持的图片格式与原生 libvips 构建有所不同。

## 可复现构建

源码位于 [oheco/deepseek-harness](https://github.com/oheco/deepseek-harness) 的 `ohos/0.1.5-rc.2` 分支。[release.json](release.json) 记录上游提交和适配运行依赖。发行构建在鸿蒙上执行，需要 Node.js 24、Python 3、Git、Node 开发头文件，且 `PATH` 中具备 SDK Clang 和 `binary-sign-tool`。使用不含 `node_modules` 的干净源码目录，并将输出和 pnpm 存储放在可写的应用私有目录中。

锁文件固定 JavaScript 依赖和补丁。离线构建前，通过已配置的代理准备其 pnpm 11 存储。[构建工具输入](../tpr/ohos-build-tools/SOURCES.json) 固定随源码提供的 pnpm 11.7.0 CLI、鸿蒙可选扩展、WASM 归档、上游 URL、摘要和许可证。Linux 准备的存储可能缺少鸿蒙可选包；构建脚本显式提供这些包，在私有副本上签名 ELF，并使用复制安装及 `/usr/bin/zsh`。

```sh
python3 ohos/build.py --store /absolute/path/to/prepared-pnpm-store --output /absolute/path/to/fresh-build
python3 ohos/package.py --deployment /absolute/path/to/fresh-build/deployment --output /absolute/path/to/fresh-release
```

构建脚本先核对 `release.json` 中已审查源码锁文件的 SHA-256，再使用 pnpm 的 `trust-lockfile` 模式，避免 pnpm 11 在离线安装或部署时发起联网策略验证。锁文件变化后，必须先准备输入并审查策略，才能更新该固定摘要。

构建在鸿蒙上编译系统扩展和 Host/Client/Web 产物，再离线部署生产依赖闭包。Lightning CSS 1.32.0 使用同版本上游 WASM API 构建 CSS Modules 和前端。Esbuild 使用上游 WASM；Rolldown、Rollup 和 Oxc Resolver 使用官方鸿蒙二进制并在本机签名。此构建流程不从源码重建这些构建工具。固定输入缺失或变化时，构建失败。

打包保留已签名系统扩展，并在 `build-info.json` 中记录原生构建来源、源码提交、锁文件摘要、扩展摘要和内置包版本。仅发布从已验收的干净提交构建的归档。oo 安装时，npm 不运行依赖构建脚本。

## 验证与限制

原生验收环境为鸿蒙 PC ARM64、Node.js 24.21.0、Python 3.14.7 和 SDK 26.0.0.35-Beta。本地确定性的 DeepSeek 兼容提供方驱动真实配置启动、zsh 数组及文件效果、持久终端状态及重置、搜索、JavaScript PTC、会话持久化，以及 Web 认证和静态资源。验收包含安装后的启动入口及含空格的安装路径。

真实远程模型行为需要提供方凭据，本地提供方测试无法证明该行为。此发行版不包含 Electron。Python SDK 未包含在内：测试宿主缺少其 pydantic/pydantic-core 依赖。JavaScript PTC 通过 Node 运行时执行，不需要 Python SDK。持久终端在此平台上无法识别进程是否专门等待 stdin。

发行构建中，esbuild WASM API 通过管道正常工作。在测试宿主上，独立 CLI 将 stdout 重定向到普通文件时可能挂起。
