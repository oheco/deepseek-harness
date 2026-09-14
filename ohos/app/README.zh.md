# DSH 鸿蒙 App · 本地验证工程

[English](README.md) | 中文

这是 oheco 的社区封装测试工程，不是官方客户端，也不是已发布版本。它是一个很薄的包装：服务在终端里运行，应用只负责读取服务输出的地址并用内置 WebView 打开。验收状态见 [VALIDATION.md](VALIDATION.md)。

应用显示名为 `Deepseek Harness`，bundle 名为 `org.oheco.deepseekharness`，第三级由软件包名 `deepseek-harness` 去掉横杠得到。图标按鸿蒙的**分层图标**规范生成（脚本见 `ohos/sync-app-logo.py`）：`AppScope/resources/base/media/` 下的 `background.png`（1024×1024 纯白背景层）、`foreground.png`（1024×1024 透明前景，只含标记）和 `layered_image.json`（`layered-image` 引用两层）。`app.json5` 与 `abilities[].icon` 都引用 `$media:layered_image`，**圆角方块由系统绘制**——规范明确要求在 PNG 里自行切圆角属于审核不通过项，所以图层里不带圆角。启动图另用透明的 `ability_icon.png`（模块资源），并在 `resources/dark/media/` 提供深色主题的白色标记版本。`app_icon.png` 保留为平面的圆角兜底图，仅在某个界面无法合成分层图标时改用它。

启动器入口与窗口装饰在这台设备上读的是同一个 ability 图标，因此桌面图标和标题栏图标无法分别设置：显示的都是这个分层图标的合成结果。更换 bundle 名后，需在 DevEco 中重新生成或选择与新包名匹配的签名 profile；旧包名的应用数据不会自动迁移。

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
   dsh web --host 127.0.0.1 --port 9000 --no-open > ~/Documents/dsh-run.log 2>&1 &
   ```

   服务使用你终端里的真实 `dsh`，保留你已有的设置、会话和凭据。端口固定为 `9000`；如果该端口已被占用（例如你已有服务在跑），命令会报地址占用而退出，日志里不会出现地址，应用会一直停在等待界面——先停掉占用端口的进程再执行。

2. **持续等待提示**。应用每秒读取该日志，取出其中的就绪地址；**并且在打开之前先实际连接一次**：只有该地址真的响应，才切到 WebView。这样上一次运行遗留的日志不会直接打开一个已经失效的页面。检测到新端口（服务重启）会重新连接并加载。

打开 WebView 后它占据整个窗口，没有标题栏、返回按钮或设置入口；系统返回键优先处理网页历史。

深浅色跟随系统，但需要一点额外处理：ArkUI 在系统切换深浅色时**不会自动重渲染页面**，所以标题栏（系统绘制）立刻变色而页面仍停留在旧配色。`EntryAbility` 因此在 `onConfigurationUpdate` 里把当前 colorMode 写入 AppStorage，页面用 `@StorageProp` 绑定它，系统切换时页面随之重新渲染并重新解析 `$r()` 颜色；启动时也会显式声明一次跟随系统。浅色与深色两套颜色见 `entry/src/main/resources/{base,dark}/element/color.json`。

打开 WebView 的瞬间还有一次白屏：ArkWeb 在页面内容绘制前会先画一层默认的空白表面，这一层与深浅色主题无关。因此 Web 组件本身设为主题背景色，并在 `onFirstScreenPaint`（首次内容绘制）之前用一层同主题的加载遮罩盖住它，绘制完成后立即撤掉；`onPageEnd` 也会撤掉，避免个别情况下遮罩滞留。

页面只与本机 `127.0.0.1` 通信，但 ArkWeb 在刚创建时会先把 `navigator.onLine` 报成 `false`，而 DSH 客户端在启动时读取该标记，一旦为假就停在“等待网络恢复”的断开状态，只能靠它自己的重连控件恢复。因此应用在文档开始前注入一小段脚本，让页面看到真实使用的本地连接可用，并阻止一次瞬时的系统 offline 事件把这条本地连接置为断开。

日志放在 `~/Documents/dsh-run.log` 而不是 `~/.dsh/`：`~/.dsh` 是终端应用的私有目录，本应用属于另一个沙箱，读不到。即使换到 Documents，其中文件的权限是 `-rw-rw----`（属主 + `file_manager` 组），应用不在该组，所以应用会申请 normal 级的 `ohos.permission.READ_WRITE_DOCUMENTS_DIRECTORY`；如果直接路径仍被拒绝，等待区会出现**选择日志文件**按钮，通过系统文件选择器取得读取授权——这条路径不需要任何特殊权限。

地址解析规则：必须是**已换行结束**的完整一行、显式 `http://127.0.0.1:<port>` 或 `http://[::1]:<port>`、非零端口、非空 token；带上游 LAN 后缀的行可以接受，但只打开回环地址。地址只在内存中交给 WebView，不写入偏好或日志文件。

## 4. 已知限制

- 需要用户手动在终端执行一次命令；应用无法自己启动服务，这是平台权限决定的。
- 页面地址带有本地会话令牌；日志留在你自己的设备上，应用不会把它复制到别处，用过之后可以自行删除该日志。
- Web 界面的品牌由你安装的 `dsh` 决定。要让界面显示上游原版的 “DeepSeek Harness” 品牌，需要用已改为 `official` profile 的发行配方重新构建并安装 `dsh`（见 `ohos/README.zh.md`）。
- 应用不常驻后台，也不监控终端里的服务；服务停了就回到等待界面。

## 本地源码检查

从 Harness 源码仓库根目录运行（不是在仅导出的工程里）：

```sh
python3 ohos/test-app-project.py
node --test ohos/app/tests/two-step-flow.test.mjs
python3 ohos/app/tests/native/run.py
```

前两项使用源码已有的锁定 Node 依赖，覆盖工程打包、身份与图标、地址解析、日志轮询和授权回退；第三项在应用私有临时目录构建、签名并测试早期监管器。完整工程的 DevEco 构建及签名由你自己的 SDK 和签名环境完成。
