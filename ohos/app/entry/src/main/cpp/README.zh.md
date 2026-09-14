# 原生启动器参考

[English](README.md) | 中文

此库仅供本地使用，通过 `import launcher from 'libdsh_launcher.so'` 提供约定的 `start(config): void`、`snapshot(): LaunchSnapshot` 和 `stop(): void` 方法，以及 `probe(config): void` 和 `probeSnapshot(): ProbeSnapshot`。完整字段列表以[类型声明](types/libdsh_launcher/index.d.ts)为准。应用入口包必须声明对 `file:./src/main/cpp/types/libdsh_launcher` 的依赖，并将外部原生构建指向本目录的 [CMakeLists.txt](CMakeLists.txt)。

源码分为 `launcher_util.*`（描述符所有权、配置字段边界、fork 子进程失败记录、继承描述符关闭）、`launcher_config.h`（`LaunchConfig`）、`supervisor.*`、`probe.*` 和 `napi_bridge.cpp`。静态库目标 `dsh_supervisor` 包含监管器和能力检测，并链接 `dsh_launcher_core`；`dsh_launcher.so` 链接该目标以及 `libace_napi.z.so`；未新增任何第三方依赖。

## 输入和环境

所有路径必须为绝对路径、非空、长度小于 `PATH_MAX`，且不含 NUL 或换行符。`nodePath` 和 `homeDir` 不能包含 `PATH` 分隔符 `:`。Node 必须是已针对设备签名的普通可执行文件；启动器不会下载、签名或修改它。`dshEntry` 是已经构建、存在且可读的 DSH 入口。`homeDir` 和 `workDir` 必须已经存在，启动器不会创建它们，也不会修改其权限。端口为 0 至 65535 的整数，启动超时必须显式设置为 1 至 86400000 毫秒的整数。

文件预检使用启动器自身真正执行的操作，因为 OHOS 的 `access()` 在两个方向上都不足为凭：对 0000 权限的文件 `access(R_OK)` 返回成功，对没有搜索权限的目录 `access(X_OK)` 也返回成功，而实际的 `open` 或 `chdir` 会以 `EACCES` 失败。`dshEntry` 必须 `stat` 为普通文件，并通过 `open(O_RDONLY | O_CLOEXEC)`，随即关闭该描述符。`nodePath` 必须 `stat` 为普通文件、至少具备一个执行模式位（`st_mode & 0111`），并通过同样的真实 `open`。缺少执行位时报告 `execute bit [path]: errno=13 (Permission denied)`；真实 `open` 被拒绝时报告 `open file [path]: errno=N (strerror)`。启动器不修改任何权限，也不授予任何权限。执行模式位只是模式位检查：它不代表 SELinux 已允许执行，真正的判定由子进程的 `execve` 错误通道负责，并报告为 `execve signed Node [path]: errno=N (strerror)`。

HOME/work 预检只确认路径能解析为目录，不要求读取目录列表：Linux/OHOS 使用 `O_PATH | O_DIRECTORY`，其他平台使用 `stat`。它与私有存储路径的规则不同，会跟随末级目录符号链接；不会规范化或改写 `HOME`、`PATH` 以及子进程 `chdir` 参数中的配置字符串。最终 HOME 目录仅用于提供环境值时，不要求具备搜索权限。工作目录的搜索权限由子进程实际执行的 `chdir(workDir)` 检查；失败会保留 `chdir` 阶段、配置路径、errno 和回收后的退出状态。缺失路径、非目录、软链循环以及不可访问的祖先目录仍然报错；启动器不授予权限，也不回退到其他工作目录。

请传入 `context.filesDir + '/dsh-launcher'`、`context.cacheDir + '/dsh-launcher'` 和 `context.tempDir + '/dsh-launcher'`，而不是系统创建的 0770 根目录。工作线程通过 `openat(O_NOFOLLOW)` 逐级遍历各私有路径，以 0700 权限创建缺失的路径组件，并检查最终目录的所有者和精确的 0700 权限。同样的规则也适用于 `filesDir + '/dsh'`。已有但权限不安全的目录以及符号链接会被拒绝，不会被修改权限或替换。启动器绝不修改共享的 `~/.dsh` 链接。其他相同 UID 的执行主体不得并发重命名这些可信的应用私有祖先目录。

子进程恰好接收以下六项环境变量，不继承终端变量、API 凭据、`NODE_OPTIONS`、代理设置或动态库搜索路径覆盖：

| 变量 | 值 |
| --- | --- |
| `HOME` | `homeDir` |
| `DSH_HOME` | `filesDir + '/dsh'` |
| `XDG_CONFIG_HOME` | `filesDir` |
| `XDG_CACHE_HOME` | `cacheDir` |
| `TMPDIR` | `tempDir` |
| `PATH` | Node 所在目录 + `:` + `homeDir + '/.oheco/bin:/usr/bin:/system/bin'` |

可执行文件的参数严格为 `nodePath, '--expose-internals', dshEntry, 'web', '--host', '127.0.0.1', '--port', String(port), '--no-open'`，不经过 shell 拆分。工作目录为 `workDir`，标准输入为 `/dev/null`，标准输出和标准错误使用独立管道。继承的非标准输入输出描述符会被关闭。OHOS 使用预先计算的描述符上限，逐个调用异步信号安全的 `close`：即使 SDK 声明了 `close_range`，应用的系统调用策略仍可能为它触发 SIGSYS。Linux/OHOS 下的私有目录遍历使用 `O_PATH`，因此只需祖先目录的 0711 搜索权限，无需读取目录列表。环境隔离不会阻止 DSH 自行读取工作目录或所配置存储中明确存在的 `.env` 或凭据；需要无凭据验证时，应使用空的隔离工作目录。

## 生命周期和就绪判定

常驻原生工作线程负责全部文件系统调用、fork、管道轮询、超时处理和进程回收。`start` 校验有界字段并将工作入队；前一次运行结束之前再次启动会抛出异常，停止期间也不例外。`snapshot` 复制受互斥锁保护的内存记录和至多 16 KiB 日志；工作线程不会在持有该锁时执行 I/O。`stop` 立即发布 `stopping` 状态、清空 URL 并请求终止，不等待线程结束。空闲或终态下调用 stop 会立即进入 stopped，同时保留上一次诊断；这也支持 UI 先停止再重试的流程。

只有以换行符结束、整行匹配 `dsh web: http://127.0.0.1:<port>/?token=<base64url>` 公告的标准输出行，才能使运行进入就绪状态。端口必须为使用规范十进制表示的 1..65535；如果请求端口非零，则必须与之精确相等。可选后缀必须严格符合 ` (LAN: http://<IPv4>:<same-port>/?token=<same-token>)`；它会被校验，但绝不会用作 WebView URL。ANSI CSI/OSC 转义序列可以跨分片，在解析前会被移除；非法控制字符、超长行、未完成的转义、标准错误中的公告以及无换行的 EOF 都不会触发就绪。每个流的行缓冲分别限制为 8 KiB。

带认证信息的 URL 仅保留在内存中，并在停止、超时或观察到退出时清空。不要持久化或完整记录快照：其中的 `url` 是凭据。日志有意屏蔽子进程的全部任意文本，包括看似无害的片段，因为未知 token 可能在就绪之前出现，也可能跨流或跨行分布。日志保留固定的标准输出/标准错误分类、丢弃行的原因、就绪摘要，以及进程管理器生成的阶段、路径、errno、超时和退出诊断。这种无法确认安全就不输出的选择意味着不会原样显示 loader 堆栈；仅凭关键词无法确认一行中不含凭据。

每个子进程都有专属进程组。停止或超时时发送 TERM；750 毫秒后，工作线程向自己管理的进程组发送 KILL，再回收组长进程。`waitid(WNOWAIT)` 将组长 PID 保留到最后一次组信号发送之后，避免 PID 被回收并分配给无关进程组。非预期退出会进入 error，包括就绪后以退出码 0 退出；用户请求的停止进入 stopped。`exitCode` 在回收前为 -1，正常退出时为普通退出状态，被信号终止时为 128 加终止信号值。回收后 `pid` 变为零。工作线程绝不接管已有服务，也不向占用端口的进程发送信号。

Linux/OHOS 下直接调用 `prctl(PR_SET_PDEATHSIG, SIGKILL)` 系统调用，再检查父 PID 的竞态，可尽力在父进程死亡时清理直接派生的 Node 子进程。孙进程不会继承这一设置；主动脱离进程组的后代进程，在应用突然死亡后无法保证被清理。启动器不会修改应用级信号处理方式或子进程收养者设置。其他代码不得回收此库的子进程，也不得设置 `SIGCHLD=SIG_IGN` 或 `SA_NOCLDWAIT`。

TERM/KILL 的发送有时间界限，但无法承诺内核不可中断进程能在有界时间内被回收。如果 KILL 发送两秒后仍无法回收，记录将保持 stopping，附带明确诊断并禁用重启；它不会谎报完成或放弃进程所有权。异步 NAPI 环境清理会使模块保持加载，直至工作线程结束。若清理期间创建线程失败，则退回同步等待线程结束，而不是卸载仍在运行的原生代码。

## 能力检测

`probe(config)` 在独立的常驻工作线程上启动只读的设备检测并立即返回；`probeSnapshot()` 在检测自身的互斥锁保护下复制 `{ running, report }`，轮询不会等待任何检测项。`start(config)` 会为同一组路径提供自己的检测实例，而被拒绝的启动不会创建任何检测。检测实例绝不复用：新调用会在上一份报告发布后替换实例，而检测仍在运行时再次调用属于 `logic_error`，不会静默重启。检测校验相同的字段，并为自己的写入和复制检测以 0700 创建缺失的私有目录组件；它绝不修改权限、替换或删除任何已存在的文件或目录。

报告最多 8 KiB，由以换行结束的可打印 ASCII 行组成，每行以 `OK `、`FAIL ` 或 `INFO ` 开头。所有 `http(s)://` 直到下一个空白字符的内容都会替换为 `[URL redacted]`，因此即使命令打印了带 token 的 URL，它也无法到达调用方；子进程输出只保留首行，清洗后截断到 120 字符。每一项独立报告，一项失败不会掩盖其后的检测项：身份（uid、euid、gid、附加组）、`homeDir`、`workDir`、`nodePath`、`dshEntry` 的 `stat` 权限位/uid/gid、对 `dshEntry` 和 `nodePath` 的真实 open、在 `filesDir` 中创建-写入-删除一个文件、`nodePath --version`、`/usr/bin/zsh -c "printf probe-ok"`、经 `execve` 执行的系统 shell、把 `/system/bin/sh` 复制到应用私有目录并 chmod 0700 后以 `-c "printf probe-ok"` 执行，以及一行汇总。私有副本检测是判定自包含方案可行性的关键项：它报告本设备能否执行位于应用私有目录的可执行映像，而未签名的副本预期会被平台签名策略拒绝。

每项 exec 检测只 fork 一个子进程，使用独立管道和描述符上限，采用 `fork` + `execve` 且不经 shell 拆分；exec 失败通过专用管道以与 `ChildFailure` 相同风格的结构（`stage`、`errno`、`path`）回传；每项检测上限为 5 秒：先 TERM，750 毫秒后 KILL，并始终回收自己的子进程。检测过程绝不触碰监管器的子进程、进程组或描述符，也绝不向不是自己 fork 的进程发送信号。

## 验证范围限制

[原生 fixture（测试前置数据）命令](../../../../tests/native/README.zh.md)在鸿蒙上编译和签名单独的可执行文件，并针对已安装 SDK 链接桥接层，不需要系统权限 API。这些测试不能证明普通签名 HAP 能够执行单独安装的 Node 二进制、访问共享存储路径、使用相同的进程和信号操作，或在应用挂起期间保持服务运行。HAP 打包与签名、ArkTS 导入和异步清理行为、WebView 集成、SELinux 执行策略以及普通 HAP 生命周期，仍需在设备上的应用中验证。由 fixture 流程运行的检测报告的是终端域自身的结论，因此其身份、组列表和共享路径结果并不等同于普通 HAP 的结果。fixture 流程不会启动真实 DSH 服务。
