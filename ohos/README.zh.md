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
oo npm install --global --prefix "$HOME/.local" @deepseek-ai/dsh@0.1.5-rc.2-ohos.1
export PATH="$HOME/.local/bin:$PATH"
dsh --help
```

将 `DSH_HOME` 设置为可写的应用私有目录。调用远程提供方前配置 `DEEPSEEK_API_KEY`。`dsh --profile headless "your task"` 运行命令行任务；`dsh web --host 127.0.0.1 --port 0 --no-open` 启动浏览器界面。按 Web 配置输出的地址和认证说明操作。

鸿蒙默认允许完整的文件系统和进程访问，并禁用审批。显式权限配置仍然有效；请求沙箱时，如果没有受支持的后端，则运行失败。Shell 工具使用 zsh 语法。可选的持久终端工具需要带 `termios` 的 Python 3。Sharp 使用上游 WASM 实现；其支持的图片格式与原生 libvips 构建有所不同。

## 可复现构建

源码位于 [oheco/deepseek-harness](https://github.com/oheco/deepseek-harness) 的 `ohos/0.1.5-rc.2` 分支。`ohos/release.json` 记录上游提交和适配依赖的精确版本。源码锁文件固定 JavaScript 依赖，包括 pnpm 完整性摘要和仓库补丁。构建前通过已配置的代理准备锁文件所需的 pnpm 存储；发行构建使用离线模式，缺少输入时失败。构建机需要仓库固定的 pnpm、Node.js 24、Python 3 和 Git。

```sh
python3 ohos/build.py --output /absolute/path/to/fresh-build
```

在鸿蒙上构建系统扩展，要求具备 Node 开发头文件，且 `PATH` 中可找到 Clang 和 `binary-sign-tool`：

```sh
node --experimental-strip-types native/system/scripts/build.ts --host-addon-only
```

使用已签名的鸿蒙扩展打包生产部署目录。若在另一台机器上打包，通过 `--system-addon` 指定对应的共享文件路径。

```sh
python3 ohos/package.py --deployment /absolute/path/to/fresh-build/deployment --output /absolute/path/to/fresh-release
```

归档保留已签名扩展的原始内容，并在 `build-info.json` 中记录源码提交、锁文件摘要、扩展摘要和内置包版本。仅发布从已验收的干净提交构建的归档。oo 安装时，npm 不运行依赖构建脚本。

## 验证与限制

原生验收环境为鸿蒙 PC ARM64、Node.js 24.21.0、Python 3.14.7 和 SDK 26.0.0.35-Beta。本地确定性的 DeepSeek 兼容提供方驱动真实配置启动、zsh 数组及文件效果、持久终端状态及重置、搜索、JavaScript PTC、会话持久化，以及 Web 认证和静态资源。验收包含安装后的启动入口及含空格的安装路径。

真实远程模型行为需要提供方凭据，本地提供方测试无法证明该行为。此发行版不包含 Electron。Python SDK 未包含在内：测试宿主缺少其 pydantic/pydantic-core 依赖。JavaScript PTC 通过 Node 运行时执行，不需要 Python SDK。持久终端在此平台上无法识别进程是否专门等待 stdin。
