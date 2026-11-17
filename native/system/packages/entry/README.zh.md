---
description: "预编译 Landlock 启动器与异步 POSIX flock 的 JavaScript 入口。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 入口导出 `tryLockExclusive(fd): Promise<void>`；导入任一入口都不会加载 `system.node`。包不提供根导出。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

可选操作系统/CPU 平台包携带二进制。它们的 `~x.y.z` 依赖范围允许同一次版本内的后续补丁版本。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 包含 `bin/system.node`。flock 绑定缺失或无法加载时，锁获取请求会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

鸿蒙 arm64 提供已签名的 `bin/system.node`，包含 flock 及独立的 `./exclusive-file` 能力。`openExclusive(path, mode)` 同步使用 `O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC`，仅在调用线程执行一次 libc open 期间屏蔽 SIGCHLD，然后恢复完整的原有掩码。它不重试、不打开已有路径、不截断，也不删除路径。调用方拥有返回的描述符并负责关闭。打开失败保留 code、值为正数的 errno、`syscall: 'open'` 及路径。`ExclusiveFileSignalMaskError` 标明屏蔽或恢复失败，并保留原始 open errno；屏蔽失败时不执行 open。恢复失败时关闭已返回的 fd，保留可能创建的路径，但线程掩码状态不明：应停止依赖操作并重启宿主。导入入口不会加载扩展；不支持的平台、缺失二进制或缺失能力均在调用时失败。私有文件需要鸿蒙 `$TMPDIR` 这类保留权限的文件系统；共享 HOME 不强制执行请求的权限。

C 源文件随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。
