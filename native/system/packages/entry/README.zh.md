---
description: "预编译 Landlock 启动器与异步 POSIX flock 的 JavaScript 入口。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 入口导出 `tryLockExclusive(fd): Promise<void>`，`./exclusive-file` 导出仅支持鸿蒙的 `openExclusive(path, mode): number`。导入任何入口都不会加载 `system.node`。包不提供根导出。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

可选操作系统/CPU 平台包携带二进制。它们的 `~x.y.z` 依赖范围允许同一次版本内的后续补丁版本。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 和鸿蒙 ARM64 包含 `bin/system.node`。flock 绑定缺失或无法加载时，锁获取请求会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

`openExclusive(path, mode)` 以 `O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC` 同步创建普通文件，返回由调用方拥有的可写描述符。路径为不含 NUL 字符的 UTF-8 字符串，父目录必须存在。mode 为 `0` 至 `0o777` 的整数，并受 umask 限制。调用方负责写入和关闭描述符。已有文件、符号链接及特殊文件会被拒绝，不会被打开或更改。操作不重试、不重新打开、不截断、不删除路径。open 错误携带 `code`、值为正数的 `errno`、`syscall: 'open'` 和 `path`；不支持的平台或缺失的绑定在调用时失败。

鸿蒙上仅在当前线程的一次 libc open 期间屏蔽 SIGCHLD，随后在返回 JavaScript 前恢复完整的原始信号掩码。掩码错误为 `ExclusiveFileSignalMaskError`，携带 `syscall: 'pthread_sigmask'`、`phase: 'block' | 'restore'` 及保留 open 失败值的 `openErrno`。掩码设置失败时不执行 open。恢复失败时线程掩码状态不确定：已得到的原生描述符会被关闭，文件可能已创建，调用方必须停止后续依赖操作。结果构造失败时也关闭新创建的描述符；任何失败都不会删除其路径。该能力不替换 Node 文件系统方法，也不改变进程全局的信号处理方式。

C 源文件和 exclusive-file 头文件随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。
