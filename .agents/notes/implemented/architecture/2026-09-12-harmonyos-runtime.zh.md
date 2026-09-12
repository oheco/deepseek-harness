# Agent Note: 鸿蒙运行时与独占持久化

Status: implemented

[English](2026-09-12-harmonyos-runtime.md) | 中文

## 问题

鸿蒙 PC ARM64 的 Node.js 平台名为 `openharmony`，Python 平台名为 `ohos`。可用 shell 是 zsh，应用文件系统拒绝硬链接，Linux 沙箱与系统调用等待假设均不成立。未修改的 npm 原生包无法为该平台选择可用二进制。

## 决策

应用入口保留为现有 CLI profile。鸿蒙的单次命令与持久 PTY 都选择 `/usr/bin/zsh`。工具名称仍为 `bash`，面向模型的描述则要求 zsh 语法。持久 zsh 使用零宽 OSC 提示符标记；Python `termios` 在自动化 PTY 内禁用回显。进程清理使用 `/proc` 身份与前台进程组信息，不声称具备 Linux 标准输入等待证据。

基础组合包在鸿蒙上默认使用 `danger-full-access` 与审批 `never`，与用户明确选择的移植范围一致。显式权限配置仍然优先。不受支持的隔离模式会拒绝执行。鸿蒙禁用会话遥测。

JSONL 首次发布与代际发布通过 Koffi 使用 `renameat2(RENAME_NOREPLACE)`，随后同步目录。已有目标永不覆盖。若文件系统缺少所需原子操作则失败，不会回退到可能暴露部分内容的复制。已签名的 Node-API 系统扩展提供现有 flock 所有权协议。已发布会话的迁移规则仍由[原有记录](2026-08-31-released-session-format-migrations.zh.md)负责；此平台扩展保留该决策，并补充文件系统例外。

私有鸿蒙部署 manifest 显式包含必要的工作区 peer 依赖。生产依赖闭包来自仓库锁文件，而适配后的 node-pty、Koffi、sharp 与 ripgrep 仍是单独版本化的 npm 依赖。启动器提供现有 HMR 实现所需的 Node 内部模块参数。包安装与进程执行使用平台实际文件权限。

## 考虑过的替代方案

**将鸿蒙视为 Linux。** 原生模块名称、缺少的沙箱基础设施、缺少的系统调用记录以及硬链接失败，说明 Linux 检测不足以支持鸿蒙。按平台分派可以保留其他宿主实现。

**使用可覆盖重命名或复制暂存日志。** 覆盖会销毁竞争写入者已提交的代际，复制会暴露不完整字节。不替换目标的重命名保留现有发布不变量。

**先移植 Bash 与原生 libvips，再验收 CLI。** 用户选择了 zsh，并接受无沙箱移植。官方 sharp WASM 引擎已提供 Harness 所需的图像操作；原生 libvips 移植属于单独的性能与编解码器决策。

## 影响

鸿蒙使用 zsh 语法，持久终端初始化需要 Python 3。鸿蒙仍无法精确检测标准输入等待。此移植不提供沙箱约束；不受支持的受限模式会明确失败。图像处理受 WASM 的内存、性能与格式限制。

原生 headless 验证使用本地确定性的 DeepSeek 兼容流，执行真实 zsh 工具，核实文件系统效果与返回工具结果，读取持久会话，并等待进程退出。持久工具验证覆盖状态、非零状态码与 shell 退出。依赖库分别验收已签名 PTY、FFI 回调、ripgrep PCRE2 和图像转换。这些结果不代表没有凭据时已验证真实远端 API，不代表支持 Electron，也不代表已验收所有鸿蒙版本。
