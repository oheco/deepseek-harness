# 原生进程管理器验证

[English](README.md) | 中文

这些隔离的原生进程 fixture（测试前置数据）用于验证[可移植核心](../../entry/src/main/cpp/README.zh.md)，绝不执行真实 DSH 入口，也不监听端口 9000。模拟 Node 的已签名可执行文件会先校验精确参数列表、仅含六项的显式环境、工作目录、私有目录权限、继承描述符的关闭情况和专属进程组，然后才输出任何就绪文本。两个测试程序分别覆盖监管器和能力检测，二者都不会启动真实服务。

## 在鸿蒙上构建和签名

需要 Python 3、CMake、Ninja、SDK `clang++` 和 `PATH` 中的 `binary-sign-tool`，以及可写的应用私有 `XDG_CACHE_HOME`。从仓库根目录执行：

```sh
python3 ohos/app/tests/native/run.py
```

该流程在 `XDG_CACHE_HOME` 下创建新的 0700 `dsh-launcher-native-*` 构建目录，配置原生 C++17 构建，为四个可执行文件签名，运行 CTest，并单独将 `libdsh_launcher.so` 链接到已安装 SDK 的 NAPI 库。编译器探针只构建静态归档，不会执行。构建路径和保留的 CTest 日志位置会显示在命令输出中。SDK 的 libc 缺少 `pthread_cancel`，因此核心使用编译器的 `-pthread` 选项，而不是 CMake 中不兼容的 FindThreads libc 探针。

CMake 编译后，等效的签名和 fixture 命令如下：

```sh
binary-sign-tool sign -inFile "$BUILD/fixture with spaces" -outFile "$BUILD/fixture with spaces.signed" -selfSign 1
binary-sign-tool sign -inFile "$BUILD/dsh_supervisor_test" -outFile "$BUILD/dsh_supervisor_test.signed" -selfSign 1
binary-sign-tool sign -inFile "$BUILD/dsh_probe_test" -outFile "$BUILD/dsh_probe_test.signed" -selfSign 1
binary-sign-tool sign -inFile "$BUILD/dsh_launcher_smoke" -outFile "$BUILD/dsh_launcher_smoke.signed" -selfSign 1
```

执行前，将每个原始可执行文件替换为其已签名的同目录文件，并设置 0700 权限。`run.py` 会原子地完成这些替换。每次重新构建或裁剪二进制后都必须重新签名。通过 `ctest --test-dir "$BUILD" --output-on-failure` 可再次运行已签名的 fixture 测试集；每次调用都会创建新的私有测试状态子目录。测试依赖仅所有者可访问的权限时，绝不能使用共享 HOME 下的构建目录。

## 已覆盖行为

测试集覆盖分片 ANSI 和就绪行、仅完整行可触发就绪、CRLF、固定端口精确匹配和真实临时端口校验、严格的 IPv4 LAN 后缀校验、无换行 EOF、超长标准输出/标准错误行、畸形 URL 和 token、标准输出与标准错误分离、缺失路径和 exec errno 报告、启动超时、忽略 TERM 的子进程、就绪前后退出、拒绝重复启动、立即异步停止、从 idle/error 先停止再重试，以及回收后重试。测试会检查每次观察到的快照是否泄漏凭据，以及日志是否遵守 16 KiB 上限，也包括子进程持续大量输出的情况。环境 fixture 会向测试父进程注入假的终端/API 凭据，证明子进程不会接收到它们。

目录 fixture 使用 chmod 确实生效的私有存储。它们先证明 0100 权限的 HOME 和工作目录允许子进程实际 `chdir`，同时拒绝 `open(O_RDONLY | O_DIRECTORY)`，然后要求进程管理器成功就绪和重启。覆盖项还包括仅用于环境值的 HOME 元数据、末级 HOME/work 目录别名不改写环境字符串、通过 0600 目录别名实际触发的子进程 `chdir` 拒绝及其阶段/路径/errno/退出码 127、祖先搜索权限拒绝、缺失路径、普通文件、悬空链接和软链循环。独立短命子进程探针检查实际 `chdir`，不改变测试父进程的工作目录，也不依赖 OHOS 上可能对不可搜索目录错误返回成功的 `access(X_OK)`。权限修改仅作用于新建 fixture 目录，并在断言后恢复。

检测程序覆盖基于真实操作的文件检查和能力报告。它先记录 `access(R_OK)` 对 0000 权限入口返回成功、而 `open(O_RDONLY)` 以 `EACCES` 失败，然后要求进程管理器在任何 fork 之前以 `open file [path]: errno=13` 拒绝该入口，并证明该诊断不可能来自 `access()`。另一个用例复制已签名 fixture 并将执行位改为 0400，要求得到单独的 `execute bit [path]: errno=13` 拒绝且不发生 fork，随后在改回 0700 后重试成功。报告检查要求每一行都带 `OK`/`FAIL`/`INFO` 前缀、内容为可打印 ASCII、遵守 8 KiB 总长和每行 500 字节的上限，并包含 `INFO identity`/`INFO mode`/`INFO summary` 行、两个文件的真实 open、私有目录写入、fixture 记录的退出状态、系统 shell 检测以及应用私有副本结果；任何一行都不得包含未脱敏的 `http://` 或 `https://` 片段。抵抗 TERM 的检测项仍必须在检测的时限内结束：fixture 运行一个忽略 TERM 的脚本，报告必须记录终止信号，且整个检测项要在 12 秒的断言窗口内完成。其余用例证明 `start` 启动的检测不会影响受管子进程和无关进程，二者仍存活且只由各自的所有者回收；检测运行期间再次调用 `probe` 会被拒绝；完成后报告保持稳定且 `running` 变回 false；后续调用会以空报告替换实例；非法配置在任何检测实例存在之前就被拒绝。当某个已存在的私有目录缺失时，写入检测只会独立报告该失败，其余检测项仍会继续执行。

进程组 fixture 会保留一个独立管理的无关进程，观察受管后代进程的心跳停止，并验证直接子进程已经回收。如果隔离测试可执行文件中非特权的 Linux/OHOS `PR_SET_CHILD_SUBREAPER` 调用成功，测试还会回收自己收养的孙进程，并验证杀死管理进程后，Node 子进程会收到父死 SIGKILL。生产库不会请求子进程收养者身份，也不需要鸿蒙系统权限 API。

## 按需运行的真实服务验证程序

fixture 流程会构建并签名 `dsh_launcher_smoke`，但有意不执行它。父 agent（智能体）或用户在单独授权启动真实 DSH 服务后，可将其作为受管后台任务运行：

```sh
"$BUILD/dsh_launcher_smoke" "$SIGNED_NODE" "$BUILT_DSH_ENTRY" "$HOME_DIR" "$EMPTY_WORK_DIR" "$XDG_CACHE_HOME/dsh-app-real-smoke-UNIQUE" 0
```

私有根目录必须尚不存在；其父目录、HOME 和工作目录必须已经存在。该程序使用生产进程管理器，等待就绪的时间最长为 90 秒，请求带认证信息的回环页面，在需要时完成 DSH 的同源 HTTP 303/cookie 交接，要求随后得到的首页请求返回 HTTP 200，再请求停止并验证进程回收。它输出阶段、PASS 或失败诊断，不输出 URL、token、cookie、响应体或子进程的任意文本。它拒绝显式配置端口 9000；零表示选择空闲端口。调用方负责管理后台任务、收集输出，并且只保留或移除该次测试的专属状态。该程序运行成功仍然只是终端上下文中的验证，不是普通 HAP 授权的证据。

## 已记录的原生结果

2026-09-14，完整流程在鸿蒙 aarch64 上直接通过，使用 SDK `26.0.0.35-Beta` 和 Clang `15.0.4`；同日的能力检测运行重新执行了整个流程：`dsh_supervisor_native` 在 24.97 秒内通过，新增的 `dsh_probe_native` 在 9.23 秒内通过，覆盖真实 open 回归、能力报告的格式与长度检查，以及共存/替换用例；NAPI 共享库也成功链接。fixture、测试程序和按需运行的冒烟测试程序均使用 `binary-sign-tool sign ... -selfSign 1` 完成签名。保留的证据位于 `$XDG_CACHE_HOME/dsh-launcher-native-*/Testing/Temporary/LastTest.log`，已签名的冒烟测试程序位于同一构建根目录。这两次记录的运行都没有调用冒烟测试程序。CMake 输出了未知 `HarmonyOS` 平台提示，但使用的是已安装的原生编译器目标，没有以 Linux 平台身份或其他平台的结果替代。

目录回归使用旧的 `O_RDONLY` HOME/work 预检时，在实际 0100 HOME fixture 上以 errno 13 失败；改为仅检查元数据后通过。本机对 0600 和 000 目录执行 `access(X_OK)` 返回成功，但实际 `chdir` 返回 errno 13，因此 fixture 通过实际操作探测搜索权限。读取方向存在同样的不可靠性：对 0000 权限文件执行 `access(R_OK)` 返回成功，而实际 `open(O_RDONLY)` 返回 errno 13；fixture 会先记录这两个结果，再要求得到真实 open 的诊断。本机的能力报告还显示，执行应用私有目录中未签名的 `/system/bin/sh` 副本时 `execve` 返回 errno 13，而已签名的 fixture 和系统 shell 均能正常执行。核心还使用 `O_PATH` 遍历可搜索的 0711 `/data` 祖先目录，并使用逐个 `close` 调用，因为 OHOS 的 `close_range` 会触发 SIGSYS 而不是返回 ENOSYS。签名工具报告的程序头对齐警告没有妨碍已签名二进制执行。

## 这些测试尚未证明的事项

SDK 编译与链接不会验证 ArkTS NAPI 导入、虚拟机关闭时的异步环境清理、HAP 代码签名和打包、WebView 导航、普通 HAP 对共享 Node/运行时路径的访问、SELinux fork/exec 策略、后台挂起或应用卸载。能力报告读取的是终端进程自身的 uid、gid 和附加组，而终端域拥有组 1006，这正是它能读取普通应用被拒绝的共享运行时文件的原因；因此该报告演示的是检测过程，而不是普通应用的结论。本域中的降权操作会被拒绝，无法构造“非属主不可读”的文件：0000 权限 fixture 通过真实 open 复现了相同的 `EACCES`，普通 HAP 的共享路径拒绝仍有待验证。原生库和可执行文件在终端执行与 HAP 打包时可能有不同的签名要求。父死清理在被测内核上保护直接子进程，但不覆盖已脱离的后代进程，也不代表所有设备版本。处于内核不可中断状态的子进程可能在 KILL 截止时间之后仍保持 stopping；真正回收之前会一直禁止重启。
