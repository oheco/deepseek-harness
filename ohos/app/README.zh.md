# DSH 鸿蒙 App · 本地验证工程

[English](README.md) | 中文

这是 oheco 的社区封装测试工程，不是官方客户端，也不是已发布版本。它是一个很薄的包装：服务在终端里运行，应用只负责读取服务输出的地址并用内置 WebView 打开。验收状态见 [VALIDATION.md](VALIDATION.md)。

应用显示名为 `Deepseek Harness`，bundle 名为 `org.oheco.deepseekharness`，第三级由软件包名 `deepseek-harness` 去掉横杠得到。图标按鸿蒙的**分层图标**规范生成（脚本见 `ohos/sync-app-logo.py`）：`AppScope/resources/base/media/` 下的 `background.png`（1024×1024 纯白背景层）、`foreground.png`（1024×1024 透明前景，只含标记）和 `layered_image.json`（`layered-image` 引用两层）。`app.json5` 与 `abilities[].icon` 都引用 `$media:layered_image`，**圆角方块由系统绘制**——规范明确要求在 PNG 里自行切圆角属于审核不通过项，所以图层里不带圆角。启动图另用透明的 `ability_icon.png`（模块资源），并在 `resources/dark/media/` 提供深色主题的白色标记版本。`app_icon.png` 保留为平面的圆角兜底图，仅在某个界面无法合成分层图标时改用它。

启动器入口与窗口装饰在这台设备上读的是同一个 ability 图标，因此桌面图标和标题栏图标无法分别设置：显示的都是这个分层图标的合成结果。更换 bundle 名后，需在 DevEco 中重新生成或选择与新包名匹配的签名 profile；旧包名的应用数据不会自动迁移。

本工程复制 `deepseek-harness-0.1.7` 中已完成 App 的 tracked 源码，保留全部搜索、右键、外链、路径、主题和日志交互。本地 App 版本为 `0.2.0-rc.2-ohos.1 / 1000002`，bundle 名不变，因此以后手工安装会升级同名 App，不会与旧 App 并存。独立无签名导出为 `export/DSHApp-0.2.0`；旧工程及其签名配置保持只读。旧检查或已签名 HAP 不能作为本版本证据；实际执行的检查见 [VALIDATION.md](VALIDATION.md)。

## 1. 在 DevEco 中打开

1. 打开本目录（包含 `build-profile.json5`），不要只打开 `entry`。
2. 准备支持工程所声明 SDK 的 DevEco/HarmonyOS SDK 和 ArkTS 工具链。默认目标是 ARM64 鸿蒙 PC / 2in1，compileSdkVersion、targetSdkVersion、compatibleSdkVersion 均为 `6.1.0(23)`。
3. 用你自己的开发账号配置 **App 签名**；工程不包含证书、私钥、profile 或个人 `local.properties`。普通开发签名不等于系统 App 身份。
4. Sync 工程，然后 Build/Run `entry`。

工程只声明 `ohos.permission.INTERNET` 和 normal 级、弹窗授权的 `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY`，不申请任何系统级权限，也不修改设备策略。

工程内仍保留 `entry/src/main/cpp`（早期“应用内直接启动”的进程监管器）。两步模式不使用它，但保留下来供具备共享目录访问权限的设备继续实验，`entry/build-profile.json5` 中的 CMake 引用因此保持不变。

## 2. 为什么是两步模式

真机验证表明普通签名应用**读不到共享目录里的运行时**（`open` 返回 `EPERM`）、**不能执行私有目录中的 ELF**（`errno=13`），系统里也没有 Node（`/system/bin/node` 等均不存在），所以既不能直接运行 oo 安装的 Node，也无法把自包含运行时塞进 HAP 再执行。两步模式把启动交给终端，应用只做展示。

## 3. 使用流程

首页只有两块内容：

1. **一条命令**，复制后在鸿蒙终端执行：

   ```sh
   zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-local/run-web.zsh > /storage/Users/currentUser/Documents/dsh-0.2.0-run.log 2>&1 &
   ```

   命令明确选择独立的 0.2.0 本地运行包，不会启动 PATH 中的旧 `dsh`。默认端口由系统随机选择，状态与现有设置、会话和凭据隔离。日志写入共享用户目录下的 Documents，应用通过 normal 级 Documents 权限读取；如果直接路径被拒绝，等待区会出现**选择日志文件**按钮回退到系统文件选择器。首页命令与日志名来自 `RuntimeDefaults.ets`：`ohos/package-app-project.py` 默认生成同一独立本地入口。运行包移动后，用 `--web-launcher <路径>`，必要时加 `--home <共享用户目录>`，重新生成新导出。启动器支持 `DSH_020_HOME` 与 `DSH_020_PORT` 显式覆盖以便隔离测试；继承的通用 `DSH_HOME` 不会指向旧状态目录。同一实例已经运行时不要重复执行启动命令。

2. **持续等待提示**。应用每秒读取该日志，取出其中的就绪地址；**并且在打开之前先实际连接一次**：只有该地址真的响应，才切到 WebView。这样上一次运行遗留的日志不会直接打开一个已经失效的页面。检测到新端口（服务重启）会重新连接并加载。

打开 WebView 后它占据整个窗口，没有标题栏、返回按钮或设置入口；系统返回键优先处理网页历史。

深浅色跟随系统，但需要一点额外处理：ArkUI 在系统切换深浅色时**不会自动重渲染页面**，所以标题栏（系统绘制）立刻变色而页面仍停留在旧配色。`EntryAbility` 因此在 `onConfigurationUpdate` 里把当前 colorMode 写入 AppStorage，页面用 `@StorageProp` 绑定它，系统切换时页面随之重新渲染并重新解析 `$r()` 颜色；启动时也会显式声明一次跟随系统。浅色与深色两套颜色见 `entry/src/main/resources/{base,dark}/element/color.json`。

打开 WebView 的瞬间还有一次白屏：ArkWeb 在页面内容绘制前会先画一层默认的空白表面，这一层与深浅色主题无关。因此 Web 组件本身设为主题背景色，并在 `onFirstScreenPaint`（首次内容绘制）之前用一层同主题的加载遮罩盖住它，绘制完成后立即撤掉；`onPageEnd` 也会撤掉，避免个别情况下遮罩滞留。

页面只与本机 `127.0.0.1` 通信，但 ArkWeb 在刚创建时会先把 `navigator.onLine` 报成 `false`，而 DSH 客户端在启动时读取该标记，一旦为假就停在“等待网络恢复”的断开状态，只能靠它自己的重连控件恢复。因此应用在文档开始前注入一小段脚本，让页面看到真实使用的本地连接可用，并阻止一次瞬时的系统 offline 事件把这条本地连接置为断开。

日志放在 `~/Documents/dsh-0.2.0-run.log` 而不是 dsh 状态目录下：本应用属于独立沙箱，不能假定能读终端进程的 dsh 数据，而且该位置还取决于终端进程自己的环境。即使换到 Documents，其中文件的权限是 `-rw-rw----`（属主 + `file_manager` 组），应用不在该组，所以应用会申请 normal 级的 `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY`；如果直接路径仍被拒绝，等待区会出现**选择日志文件**按钮，通过系统文件选择器取得读取授权——这条路径不需要任何特殊权限。

地址解析规则：必须是**已换行结束**的完整一行、显式 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`、非零端口、非空 token；带上游 LAN 后缀的行可以接受，但只打开回环地址。地址只在内存中交给 WebView，不写入偏好或日志文件。

### 桌面交互

Ctrl+F 打开带匹配计数的页内搜索条；Enter / Shift+Enter 切换匹配，Esc 关闭。搜索覆盖已加载的页面内容，不包括尚未加载的会话历史。手势缩放已禁用，外部跳转交给系统处理。

右键提供复制，以及 HTTP(S) 链接、`~/` 和 `/storage/Users/currentUser/` 路径的打开操作。优先使用选中文字；无选区时检查真实链接或鼠标落点附近的有限 DOM 文本，支持跨代码高亮节点及带引号的空格路径。空白位置、密码框、Canvas 和 iframe 中的文字不做推断。没有识别结果时不显示菜单或提示；带连续三个以上小数点或省略号的路径不提供打开操作。原生浮层采用页面的浅／深色 DSH 配色，菜单文字居左。搜索条默认位于右上角，拖拽背景可在窗口内移动。

路径菜单仅提供复制和**在文件管理中查看**。目录直接打开；文件通过华为文件管理器的拉起接口打开其父目录，不保证选中文件。封装层不启动编辑器、不读取文件内容、不请求逐文件授权，也不创建副本。符号链接及用户目录之外的路径会被拒绝。错误使用三秒后自动消失的底部短提示，不显示常驻横幅。

## 4. 已知限制

- 需要用户手动在终端执行一次命令；应用无法自己启动服务，这是平台权限决定的。
- 页面地址带有本地会话令牌；日志留在你自己的设备上，应用不会把它复制到别处，用过之后可以自行删除该日志。
- Web 界面由独立本地运行包提供，不打进 HAP；使用首页命令或执行 Web 衔接测试前，必须先准备好该运行包。
- 应用不常驻，也不负责停止终端服务。服务停止后，已加载页面可能显示网页自己的断开状态；新就绪地址加载前仍会实际检查。

## 本地源码检查

从 Harness 源码仓库根目录运行（不是在仅导出的工程里）：

```sh
python3 -B ohos/test-app-project.py
node --test ohos/app/tests/*.test.mjs
python3 -B ohos/sync-app-logo.py --check
# 仅在独立运行包准备好后执行：
python3 -B ohos/test-app-web.py
```

逻辑测试需要 checkout 锁定 Node 依赖中的 TypeScript；新依赖尚未准备好时，可用 `NODE_PATH` 明确选择旧的只读编译器安装。Web 测试在 `$TMPDIR` 下创建新的 shared home/日志和 `DSH_020_HOME`，结束时停止自己的进程组并清理这些目录。`check-app-arkts.cjs --sdk <已安装的ets-sdk> --output <TMPDIR下的新目录>` 执行可用的独立语义检查，不是 DevEco 完整构建。保留的早期原生监管器未修改、两步页面不使用它；它以前的结果不是本版本证据。

需要另一个无签名导出时，执行 `python3 -B ohos/package-app-project.py --output <TMPDIR下的新归档目录> --export-project <新导出目录>`，不会运行包管理器检查。脚本拒绝已有导出目录，也不会读取旧个人签名文件。收集结果后必须清理临时归档／检查目录。这些命令不会构建、签名或安装 HAP。
