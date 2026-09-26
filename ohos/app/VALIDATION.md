# 0.1.7 鸿蒙 App 移植验证

本工程仅在本地迁移和导出，没有发布、推送、安装 HAP，未修改旧 App 工作区、`export/DSHApp`、现有 dsh 安装或 9000 服务。

## 迁移基线

用户确认 0.1.5 App 已完成后，取 `deepseek-harness-eval/ohos/app` **当前工作树**，而不是仅取 `79bc906508` 提交。搜索、右键菜单、路径打开、主题浮层和日志读取优化包含未提交及未跟踪文件；原始 68 个 App/脚本输入的摘要记录在上级 `app-migration.json`。

与旧 `export/DSHApp` 比对后，60 个共同文件内容一致。差异仅为导出器生成的 RuntimeDefaults 和用户受保护的构建/签名配置，未发现漏回源的业务修复。没有复制用户的证书、私钥、签名 profile 或个人 `local.properties`。

## 保留与调整

- 保留 Ctrl+F、匹配计数、前后跳转、Esc、可拖动搜索条、右键复制和鼠标落点取词。
- 保留外部 HTTP(S) 链接转浏览器、文件/目录在文件管理器中查看、路径边界与符号链接拒绝、三秒 toast。
- 保留禁止缩放、深浅色及页面主题同步、首屏遮罩、全窗口 WebView 和本地网络状态适配。
- 保留大日志头部就绪地址读取、日志截断与重启处理、Documents 权限和 Picker 回退。
- 首页启动命令改为指定 `harness-ohos-0.1.7-local/run-web.zsh`，避免启动 PATH 中的旧 dsh；独立日志为 `~/Documents/dsh-0.1.7-run.log`。
- 新版 Web 默认随机端口，状态为 `$XDG_CONFIG_HOME/dsh-0.1.7-local`，不复用原来的配置、凭据或会话。
- App 版本改为 `0.1.7-rc.2 / 1000001`，SDK 三项仍为 `6.1.0(23)`，bundle 仍为 `org.oheco.deepseekharness`。因此手工安装新版会升级同名 App，并非并存安装。
- 上游 favicon 只移除了主题 style，生成 App 图标所用 SVG path 投影一致；沿用用户已确认的图标，不做无关重绘。

## 本轮实际检查

| 检查 | 结果及边界 |
| --- | --- |
| App 逻辑 | `node --test ohos/app/tests/*.test.mjs`，18 项通过：上下文识别、路径菜单及拒绝规则、就绪解析、日志轮询与大日志/截断恢复。 |
| 工程与连接生成 | `python3 ohos/test-app-project.py`，11 项通过：身份、SDK、版本、分层图标、归档保护、拒绝私钥/越界链接、路径引用及新旧启动入口隔离。 |
| ArkTS 语义 | 本机 `ohos-sdk-ets/26.0.0.35-Beta` 的 checker 按工程 `6.1.0(23)` 字段检查，0 errors；保留 INTERNET 提示、部分文件 API 异常处理提示、getContext 废弃提示。不等同于 DevEco 完整 HAP 构建。 |
| 实际 Web 衔接 | `python3 ohos/test-app-web.py` 使用应用生成的命令，真实启动 0.1.7 运行包，写入隔离日志，用实际 `RunLogUrl.ets` 解析就绪地址，验证鉴权 Cookie、原版页面标题及非 9000 端口。临时路径含空格和引号，状态与日志均在 `$TMPDIR`，结束时关闭进程并清理。 |
| 主题兼容 | 新版 Web 保留浮层脚本使用的全部 `--dsw-*` 语义颜色变量；没有修改用户已确认的浮层逻辑。 |
| 双语说明 | App README 的中英文启动说明和配对记录已同步检查。 |

检查日志保存在相邻 `harness-ohos-0.1.7-local/app-checks/`。导出通过临时、回环、项目专用的 oo 索引进行，不修改正式目录；归档和导出逐文件一致性记录在 App 归档目录的 `export-verification.json`。

## 仍需用户在 DevEco 验证

本轮不构建、签名或安装 HAP，也不把旧版 App 已完成的真机验收当作新版已验收。早期原生监管器未改动、两步页面不使用它，因此没有重跑其 CMake 测试；没有重建已验收的 Web 后端或运行全仓回归。

打开独立的 `export/DSHApp-0.1.7`，自行配置签名并 Run。复制首页命令到终端执行后，应连接新版 Web；需要选择日志时请选择 `dsh-0.1.7-run.log`，不要选旧 `dsh-run.log`。确认 Ctrl+F、右键操作、拖动搜索条、外链、深浅色和禁止缩放仍与旧版一致。日志含认证 token，不要分享；同一后台实例已运行时不要重复启动。
