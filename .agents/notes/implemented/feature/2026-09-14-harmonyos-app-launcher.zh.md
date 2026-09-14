# Agent Note: HarmonyOS App launcher for the terminal service

Status: implemented

[English](2026-09-14-harmonyos-app-launcher.md) | 中文

## Problem

鸿蒙发行版从终端提供 CLI 与 Web 配置，oheco 目录以 npm 包形式安装它。用户希望改成一个 App：点图标、看到进度、进入 Web 界面。最直接的封装——让 App 运行共享目录里已安装的 Node 与 DSH——预设了普通签名 HAP 并不具备的权限，而这个假设只能在真机上验证。

## Decision

[ohos/app](../../../../ohos/app/README.zh.md) 中的 App 是对“终端启动的服务”的一层薄封装。首页给出一行终端命令；服务把就绪公告写入 `~/Documents/dsh-run.log`；应用每秒轮询该文件，先连接一次公告的回环来源，成功后才在整个窗口的 ArkWeb 中打开它。App 内没有任何代码启动服务，Web 界面就是已安装 `dsh` 所提供的那个。

应用内启动、设置页、诊断页、能力检测，以及只为它们存在的 HAP 外运行时副本都已移除。原生监管器仍留在 `entry/src/main/cpp`——仍在编译、测试仍会运行——但已没有 ArkTS 代码引入它。

## Device capability boundary

本机普通开发签名（DevEco 自动签名）得到的应用进程为 `uid=20020187`、附加组 `1097,3099`，以下数据由 App 自己的能力检测在这些界面撤下之前测得：

| 能力 | 结果 |
| --- | --- |
| 写应用私有目录 | 正常 |
| 执行 `/system/bin/sh -c …` | 正常，退出码 0 |
| `open` 共享目录中的 Node 或 DSH 入口 | `EPERM` |
| 执行私有目录中的 ELF 副本 | `EACCES` |
| `/usr/bin/zsh` | 应用沙箱内不存在 |
| 系统 Node（`/system/bin/node`、`/usr/bin/node`） | 不存在 |

共享文件属主为 `uid 20001006 gid 1006`、模式 `-rw-rw----`，目录为 `drwxrws--x`。终端进程加入了 1006 组，普通应用不会加入；本机上唯一为该组放行的沙箱规则属于 `ohos.permission.FILE_ACCESS_MANAGER`，其 `availableType` 为 `SYSTEM`。`ohos.permission.READ_WRITE_USER_FILE` 虽为 `NORMAL`，但本机没有对应的沙箱规则；三个目录权限是 `NORMAL` 且为 `user_grant`。因此 App 既不读取共享运行时，也不启动 Node；也因此在整棵代码树中不再使用 `access()`：本机它对 mode 0000 的文件仍报成功，预检改为执行真实的 `open`。

## Log location and access

`~/.dsh` 是终端应用的私有目录，另一个沙箱读不到它，所以公告写入 `~/Documents/dsh-run.log`。Documents 中的文件同样只对属主与组开放，因此 App 申请 normal 级的 `READ_WRITE_DOCUMENTS_DIRECTORY`，并在直接路径仍被拒时通过系统文件选择器的授权读取——那条路径不需要任何权限。

应用只接受**以换行结束**、带有显式 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`、非零端口与非空 token 的行；上游的 LAN 后缀可以接受，但永不打开。地址只在内存中交给 ArkWeb。

## Opening gate, theming and first paint

上一次运行遗留的日志仍然含有格式正确的地址，因此 App 会先连接一次公告来源，只有真的响应才打开视图；服务在新端口重启时会重新连接并加载。

有两个平台行为需要显式处理。ArkUI 在系统深浅色变化时不会重渲染页面，因此 `EntryAbility` 把 colorMode 发布到 AppStorage，页面用 `@StorageProp` 绑定以重新解析 `$r()` 颜色；启动时也会显式声明一次跟随系统。ArkWeb 会在页面内容之前绘制一层空白表面，因此 Web 组件本身带主题背景，并用一层同主题遮罩盖到 `onFirstScreenPaint` 或 `onPageEnd`。

ArkWeb 在新建视图解析系统网络状态期间会把 `navigator.onLine` 报成 false，而 Harness 客户端会因此停在断开状态、只能靠它自己的重连控件恢复。文档开始前注入的脚本让页面看到实际使用的本地连接，并阻止一次瞬时的系统 offline 事件把它置为断开。

## Icons

App 遵循鸿蒙的分层图标规范：`layered_image.json` 引用 `background.png` 与 `foreground.png`，两者均为 1024×1024，圆角方块由系统绘制。规范明确把“在 PNG 里自行切圆角”列为审核不通过项，因此任何图层都不带圆角。`app_icon.png` 保留为已经切好圆角的平面兜底图。本机上启动器入口与窗口装饰读取同一个 ability 资源，所以桌面图标与标题栏图标无法分别设置；`startWindowIcon` 使用透明标记，并提供深色主题变体。

## Alternatives considered

**由 App 启动服务。** 首个构建正是如此，带原生监管器与外置运行时副本。它在本机不可行：共享读取失败于 `EPERM`，私有目录执行失败于 `EACCES`。

**把 Node 与运行时打进 HAP。** 本机没有系统 Node，而解压到应用私有目录的 ELF 无法执行，因此只携带 JavaScript 运行时等于没有东西可以运行它。

**申请特权文件权限。** `FILE_ACCESS_MANAGER` 需要系统身份签名的 profile；`READ_WRITE_USER_FILE` 在本机没有沙箱规则；而且即使读到共享 Node 也仍然无法执行它。

**关键词脱敏后展示子进程原文。** 凭据可能在就绪之前出现或跨记录分片，因此监管器完全屏蔽任意子进程文本。这一点作为那段代码的性质保留，而不是作为 App 的界面。

**把 WebView 的断开状态留给用户。** 客户端自己的重连控件一次点击即可修复，但一打开就显示断开的页面会被读成 App 有故障；文档开始前的脚本去掉的是原因，而不是症状。

**接受图标冲突。** 由于两个界面读同一个 ability 资源，另一种选择是全局使用透明标记，而用户已否决桌面图标无白底。

## Consequences

用户每个会话需要执行一次命令；App 无法自行启动服务，这是平台结论而非延期功能。Web 界面的品牌取决于已安装 `dsh` 的构建方式，因此发行配方现在选择 `DSH_CLIENT_BUILD_PROFILE=official` 客户端配置——没有重新构建并安装的包，侧栏会保留本地构建标签。App 不监控终端里的服务，也不常驻。原生监管器与能力检测仍在编译但无人使用，保留给确实拥有共享运行时权限的设备。

## Testing

`python3 ohos/test-app-project.py` 覆盖工程打包、身份与 SDK 字段、分层图标描述与清单引用、归档权限，以及拒绝私钥、越界软链和大小写冲突。`node --test ohos/app/tests/two-step-flow.test.mjs` 覆盖地址解析（换行结束、LAN 后缀、畸形与非回环形式）、回环来源、日志轮询、重启后地址替换，以及经文件选择器恢复。`python3 ohos/app/tests/native/run.py` 仍在鸿蒙上构建、签名并测试监管器与检测。全部检查无需密钥；真机提供任何 fixture 都无法替代的验收。
