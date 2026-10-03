# 0.2.0 鸿蒙 App 本地迁移验证

本记录仅覆盖当前 App 源码与独立本地连接，不沿用 0.1.7 的通过结果。本 App 迁移操作没有构建、签名或安装 HAP，没有发布或推送，也不修改旧 App 工程、旧导出、个人签名文件、现有 dsh 安装或服务。

## 迁移输入与只读比对

新 checkout 基线为 `dsh-v0.2.0-rc.2`，分支 `ohos/0.2.0-rc.2`。复制旧 `deepseek-harness-0.1.7` 干净工作树的 tracked App 文件 62 个与相关脚本 7 个；原始输入摘要及基线记录在 [app-migration.json](../app-migration.json)。不带 build、.hvigor、依赖、签名和 local 配置。

仅以安全白名单比较旧导出，不读取其根 build-profile、App 身份及生成的 RuntimeDefaults，更不读取或复制个人证书、私钥、签名 profile、local.properties 与构建产物。`export/DSHApp` 的 59 个可比文件全部与旧源码一致；`export/DSHApp-0.1.7` 为 55 个一致，只有 README 中英文、配对元数据及 VALIDATION 四个文档不同。两份导出的业务 ArkTS 源码均无缺失或差异，未发现业务修复未回源。

## 适配与保留

- App 身份仍为 `org.oheco.deepseekharness`；本地版本 `0.2.0-rc.2-ohos.1`，versionCode 从 1000001 递增至 1000002。SDK 三项保持 `6.1.0(23)`。
- 首页与打包默认入口明确使用 `zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-local/run-web.zsh`，不使用 PATH 里的旧 dsh；日志为独立 `~/Documents/dsh-0.2.0-run.log`，默认端口由系统选择。
- 保留 Ctrl+F、匹配计数、前后跳转、Esc、可拖动搜索条、右键复制和鼠标落点取词、外链转系统浏览器、路径在文件管理器中查看、边界与符号链接拒绝及三秒 toast。
- 保留深浅色与页面颜色同步、首屏遮罩、禁止缩放、全窗口 WebView、Back 历史处理及本地网络状态适配；9 个业务 ArkTS 文件和 Documents 权限清单原样复制，新增测试检查其摘要。
- 保留大日志头部就绪读取、日志截断／重启、normal 级 Documents 权限及系统 Picker 回退。不实施撤销的 UserFile 权限、broker 按钮、编辑器、逐文件授权或副本功能。
- 打包器新增直接生成新无签名 DevEco 目录的 `--export-project`；拒绝已有目录，不运行 oo 验证。更新导出脚本也不再为“保护签名”而读取签名配置摘要，保护路径在任何内容读取前排除。

## 本轮实际执行

以下命令从新 checkout 根目录执行；结果只属于新 App。所有临时目录位于 `$TMPDIR`，由 trap 或 TemporaryDirectory 清理。原始检查日志位于被 Git 忽略的 [validation](validation/) 目录。

| 检查 | 命令与当前结果 | 边界 |
| --- | --- | --- |
| App 逻辑 | `NODE_PATH=/storage/Users/currentUser/dev/ohos/deepseek-harness-0.1.7/node_modules node --test ohos/app/tests/*.test.mjs`：23/23 通过、exit 0 | 旧 TypeScript 仅为只读检查工具输入；测试读取新源码，含新增外链、主题与业务保留回归，不是 ArkWeb 人工验收。 |
| 工程与生成 | `python3 -B ohos/test-app-project.py`：16/16 通过、exit 0，含签名配置不读取回归 | 覆盖身份版本、SDK、图标、路径引号、独立入口、Documents 权限、新无签名导出与拒绝已有工程。 |
| ArkTS 语义 | `node ohos/check-app-arkts.cjs --sdk /storage/Users/currentUser/.oheco/packages/ohos-sdk-ets/26.0.0.35-Beta --output "$priv/check"`：errors 0、exit 0 | 按工程 SDK 字段检查新源码；10 个提示为 INTERNET、文件 API 异常处理、getContext 废弃。不是 assembleHap 或完整 DevEco 构建。 |
| 图标 | `python3 -B ohos/sync-app-logo.py --check`：5 个 PNG 与分层描述通过、exit 0 | 不做无关图标重绘。 |
| 主题兼容只读核对 | 新版 ui-theme 的 design-platform.css 仍定义浮层脚本读取的 7 个 `--dsw-*` 变量，并有深浅色定义 | 只是源码核对，不是新 ArkWeb 实际颜色验收，也不修改或测试该软件包。 |
| Web 衔接 | `python3 -B ohos/test-app-web.py`：真实启动本次 fresh candidate 的独立运行包，实际新 `RunLogUrl.ets` 解析就绪日志，鉴权 Cookie、原版页面标题及随机非 9000 端口均通过、exit 0 | 首页同一本地启动器与日志文件名；shared home/日志及 `DSH_020_HOME` 隔离在含空格／引号的 `$TMPDIR`，设 `DSH_020_PORT=0`，结束时关闭自己的进程组并清理。不是 HAP、ArkWeb 或真机交互测试。 |
| 无签名导出 | `python3 -B ohos/package-app-project.py --output "$priv/archive" --export-project /storage/Users/currentUser/dev/ohos/export/DSHApp-0.2.0`：创建时 71 文件逐文件与归档 stage 一致、exit 0；其后同步当前检查说明，并加入本轮 Web 衔接日志与输入摘要记录（现为 73 文件） | 只创建新的无签名 DevEco 目录；临时 ZIP 与 stage 已清理，不覆盖任何旧工程。 |
| 双语说明 | `node scripts/verify-translation-pairing.ts ohos/app/README.md ohos/app/tests/native/README.md`：2 个指定文档对一致、exit 0 | 只检查 App 文档，不运行全仓 doc-sync。 |
| 导出复核 | 60 个安全 tracked 文件（说明链接按导出路径投影）、6 个本轮日志及输入摘要记录与新源码逐字节一致；总计 73 文件、exit 0 | 复核不读取受保护的身份、默认器或 build-profile，不访问任何旧导出。打包回归也验证迁移记录随包及相对链接可打开。 |

## 使用与未验证部分

独立运行包已通过上述本地连接测试。打开新的 `export/DSHApp-0.2.0`（根目录而非 entry）。该工程没有个人签名配置；如以后自行在 DevEco 配置签名并运行，同 bundle 身份会升级原 App，而非并存安装。复制首页命令到终端；需选择日志时只选 `dsh-0.2.0-run.log`。日志含认证 token，不要分享；服务已运行时不要重复启动。

本轮不做 HAP 构建、签名、安装或真机人工操作；普通 HAP 权限、ArkWeb 搜索／右键／外链／路径／深浅色交互仍需用户验收。早期原生监管器源码未改动、两步模式不使用它，因此不重跑其编译或签名测试。不运行其他软件包验证或全仓回归；任何旧检查、旧 HAP 或旧真机验收都不能替代本版本证据。
