---
description: "为 Linux 进程隔离与 POSIX 会话写锁提供预编译系统原语。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

## Summary

使用 Linux `landlock-run` 可执行文件限制子进程，或通过 `./flock` 入口获取 POSIX 写锁。平台包包含预编译二进制；消费方安装时不会构建原生代码。Landlock 策略与会话生命周期仍由调用方负责。

## Table of Contents

- [使用](#use)
- [支持范围](#support)
- [开发](#development)

## Use

`@deepseek-ai/node-addon-system/landlock-run` 为 Landlock 导出 `launcherPath`、`probe` 和 `grantArgs`。其可执行文件名、参数和失败语义由 [CLI 约定](docs/cli-contract.md) 定义。

[flock 行为约定](docs/flock-contract.md) 将描述符、进程和咨询式锁语义对应到独立原生测试。

`@deepseek-ai/node-addon-system/flock` 导出 `tryLockExclusive(fd): Promise<void>`。在调用完成前保持描述符打开。获取操作使用非阻塞独占 flock；发生竞争时，返回的 Promise 会以 `EAGAIN` 或 `EWOULDBLOCK` 拒绝，关闭该打开文件描述的最后一个描述符即释放锁。参见[入口 README](packages/entry/README.zh.md)。

鸿蒙 ARM64 还提供 `@deepseek-ai/node-addon-system/exclusive-file`，用于同步排他创建普通文件。描述符所有权、临时信号掩码及失败语义由[入口 README](packages/entry/README.zh.md)定义。

导入任何能力入口都不会加载 addon。Landlock 可执行文件缺失时探测为不可用；原生绑定缺失时在调用处失败。所有路径都不会进行编译，也不会静默允许不受支持的行为。

## Support

Linux x64/arm64 包包含静态 Landlock 可执行文件，以及分别用于 glibc/musl 的 `system.node` 文件。macOS x64/arm64 和鸿蒙 ARM64 包仅包含 `system.node`。鸿蒙通过 `process.platform === "openharmony"` 选择已签名的 Node-API v8 addon，不提供 Landlock 启动器。Landlock 还需要支持强制执行的 Linux 内核；Windows 使用 Harness 既有锁实现。[支持矩阵](docs/support-matrix.md) 指定构建者与验证负责人。

## Development

在本目录运行 `pnpm build:ts` 构建入口、`pnpm build:native` 构建当前宿主声明的原生产物、`pnpm build:test-oracle` 构建独立的 flock 系统调用 fixture（测试前置数据）。随后用 `pnpm test` 验证入口、锁、打包及可用的内核行为。Linux 完整构建需要 musl-gcc；macOS 使用 cc。根目录 `pnpm run build:native-system` 只构建源码测试所需的当前宿主 addon。

鸿蒙上使用 Node 24 及其开发头文件，在仓库根目录运行 `node native/system/scripts/build.ts --host-addon-only`。将 `clang`、`llvm-objcopy` 和 `binary-sign-tool` 加入 PATH（缺失时检查 LLVM 工具目录的 PATH），并将 `TMPDIR` 指向应用私有临时存储。准备阶段先在临时副本中移除 SDK 链接器的初始 codesign 段，再完成最终签名。编译与签名目录在成功或失败后均清理；产物先复制到目标旁的唯一 pending 文件再重命名，因此 TMPDIR 与源码位于不同文件系统时也可安全替换。

鸿蒙锁测试覆盖原生回调、worker、进程以及独立 C oracle。oracle 使用 SDK Clang 构建并由 `binary-sign-tool` 签名，从 `$XDG_CACHE_HOME` 执行，因为共享 HOME 的可执行 chmod 无效。测试临时目录使用 `$TMPDIR`。

[架构](docs/architecture.md)、[打包](docs/packaging.md)和[发布流程](docs/release.md)分别负责实现与发布细节。

### Dev Note

无。
