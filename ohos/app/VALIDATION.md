# DSH App 验证记录

## 2026-10-17 · 0.2.1-rc.2 源码迁移

当前 App 为 `org.oheco.deepseekharness`、`0.2.1-rc.2-ohos.1`、versionCode `1000010`，高于基础修订 `1000006` 及旧诊断版 `1000009`。目标 CLI/Web 运行包为 `0.2.1-rc.2-ohos.1`，默认启动日志为 `Documents/dsh-0.2.1-run.log`。父级 App 修订元数据和导出生成器已同步。

已将审查快照中的 30 个文件（19 个已有文件、11 个新增文件）完整迁入，迁入时逐文件 SHA-256 一致；随后仅更新 App 版本、默认日志、双语说明、验证记录和回归测试。原生诊断 10 文件、ETS 8 文件、资源 2 文件、测试 5 文件及文档 5 文件均保留；broker 0.5.0 SDK 与原生依赖库未变。入口保留控制器/代次/origin/地址所有权、初始空白与 Cookie 双条件、每代仅一次导航及完整附着/空白结束回调。

在 HarmonyOS aarch64、Node `24.21.0` 上执行 `NODE_PATH=/storage/Users/currentUser/dev/ohos/deepseek-harness-0.2.0/node_modules node --test ohos/app/tests/*.test.mjs`，退出 0，`185/185` 通过，无失败或跳过。旧目录的 TypeScript `6.0.3` 仅作为只读测试依赖；该回归执行时尚未安装新仓库主依赖。新增 8 项回归覆盖初始空白历史返回后恢复同一 local/remote 工作空间、等待初始空白期间返回、同 origin 真正后退、其他 origin 及空白历史过滤、历史 API 异常与空历史、菜单/搜索优先级，以及 ArrayBuffer/Blob 二进制诊断帧阈值。私有进程内绕过 origin 过滤后，两项返回回归按预期失败；生产源码未做突变。

独立原生检查在 `$TMPDIR` 私有目录中使用 `clang++ -std=c++17 -Wall -Wextra -Wpedantic -pthread` 编译 `native_diagnostics_test.cpp` 及 `connection_log.cpp + connection_log_test.cpp`，随后用 `binary-sign-tool sign -selfSign 1` 签名并执行，两个测试均退出 0。工具链产物已有 `.codesign` 导致首次显式签名拒绝；最终对这些私有测试副本执行 `llvm-objcopy --remove-section=.codesign` 后重新签名成功，签名工具报告段对齐警告但签名和运行均退出 0。临时目录按任务完成清理，没有重编 broker SDK 或操作网络。

`node --check` 对 11 个 App 测试模块均退出 0，双语资源键相同且无重复，`git diff --check -- ohos/app` 退出 0。集成检查随后确认工程导出 `22/22`、当前安装 SDK 的独立 ArkTS 检查 0 错误；SDK/NAPI、过时 API 及权限提示保留为警告。

[本版构建与检查回执](validation/port-0.2.1-rc.2/app-build-checks.json)记录全新离线 Hvigor `7.26.8`、SDK `26.0.0.105 Release` 构建、签名和独立验签均退出 0，兼容 API23，签名公钥与原系列一致。HAP 为 5,402,074 字节，SHA-256 `277e801e05d547f2da97a1c2fcb21dce27c30845883a14f4de6f9d379d5c32b2`；构建时 252 项输入与缓存快照一致，临时签名材料和缓存签名配置已清理。个人签名 HAP 保留本地，无签名工程用于公开交付。

本轮未安装或启动设备上的 App，也未操作现有服务。返回修复的真实 WebView、锁屏解除后的重入和蜂窝网络恢复仍需单独验收；`185/185` 属于源码替身回归。

下列诊断与 broker 段落保留旧版本的验证结果。10 月 11–12 日的 8 份诊断附件未随本次源码快照迁入，文件名仅标识原回执。旧 `diag.3 / 1000009` 只有构建、签名与覆盖安装证据，启动被锁屏错误 `10106102` 阻止；`177/177` 属于 `diag.2`，不能用作返回修复或本版本真机通过的证据。

## 2026-10-12 返回空白页修复版

用户报告 `diag.2` 首次连接可进入工作空间，但首次系统返回进入空白页，第二次返回才到连接列表；再次选择保留连接时仍显示白屏。入口返回逻辑原先仅检查 `accessBackward()`，会退到用于绑定控制器的初始 `about:blank`，而原生连接及已就绪标记仍被保留。修复读取实际后退历史，仅回退到当前连接 origin 内的页面；上一项为初始化空白页时直接隐藏当前工作空间并返回连接列表。`index.back_history` 仅记录历史项数、索引和地址分类，不记录 URL。

修复包为 `0.2.0-rc.2-ohos.2-diag.3`、versionCode `1000009`、5402033 字节，SHA-256 `bc5180decb68cd71606e2a57b5786ee47ecc5d8460356ae0a7aead2ef5f6002c`。构建回执 `validation/connection-diagnostics-20261012/back-fix-build.json`确认离线 HAP 构建及验签退出 0，沿用原签名系列；252 项生产输入与当前源码一致，已核对包内返回历史 API 与诊断事件。按用户要求，本轮未运行测试或独立静态检查，只执行必要构建、签名和包摘要核对。

安装回执 `validation/connection-diagnostics-20261012/back-fix-installation.json`确认电脑经代理覆盖安装成功，未卸载或清除数据，安装版本为 `1000009`。随后启动被设备锁屏阻止，系统返回 `10106102`；用户暂不能解锁，修复后返回和再进入的实际界面确认保留。此包不包含远程服务端修复。

限速数值记录 `validation/connection-diagnostics-20261012/remote-speed.json` 及帧时序 `validation/connection-diagnostics-20261012/remote-speed-wire.jsonl`记录现有 DSH 服务的独立只读 `session/follow` 采集：4541266 字节单帧在 256/512 KiB/s 各连续 3 次均异常关闭 `1006`，每次完整数据帧后有两枚 Ping，随后服务端 EOF，没有 WebSocket 关闭帧；同速率 256 KiB/s 的 251375 字节快照持续 20 秒，10 次 Ping 均收到 Pong，观察结束后主动正常关闭。仅限制采集连接，未改现有服务配置或 GUI，也未经过 broker/蜂窝网络。EOF 时间含通道缓冲排空，不能当作服务端终止时点。结果与服务端将 Ping 排队时间计入 missed Pong 的路径吻合；服务端具体终止原因仍缺直接记录，不扩大为所有手机断连的唯一原因。

## 2026-10-12 本地断开重开修复版

在诊断版 `1000007` 上，同进程、同一 local 连接明确断开后重开连续 3/3 失败：HTTP 探测均为 200，控制器绑定和 Cookie 准备均完成，目标 `loadUrl` 已接受，随后才出现初始 `about:blank` 的 begin/end；没有目标 `page_ready` 或 `web.ws_open`，前台导航阶段持续等待至少 55–60 秒。修复在 [Index.ets](entry/src/main/ets/pages/Index.ets) 中分别跟踪本代初始空白页、Cookie 就绪和已发导航，两个条件均完成后仅加载目标一次；旧代、关闭、渲染器退出和目标错误取消仍沿用原所有权检查。

新增 8 项行为回归模拟默认空白导航覆盖已接受目标的竞争、Cookie 与空白页完成的两种顺序、重复/旧代回调、关闭和渲染器退出。连接测试 52/52、完整 App 测试 177/177 均退出 0；修复前源码运行新重连用例按预期失败，已接受目标随后被空白页覆盖。独立 ArkTS 检查为 0 错误；全新离线 Hvigor 构建、签名和独立验签均退出 0。

本地修复 HAP 为 `0.2.0-rc.2-ohos.2-diag.2`、versionCode `1000008`、5398774 字节，SHA-256 `894ba267b4daa44897645324c1825a6ea6b55b2738ccf1094704ea4698cba9ab`。252 项生产输入匹配当前源文件，较 `diag.1` 唯一生产源码变化为入口页面；207 项原生输入未变。沿用原签名系列，可覆盖安装保留数据。设备转发任务被停止，HDC 别名离线；此修复包尚未安装或真机复测。此前 3 轮失败用于定位，不能表述为修复后通过；远程 256/512 KiB/s 限速测试保留为后续验证。

## 2026-10-11 本地连接诊断版

诊断版本为 `0.2.0-rc.2-ohos.2-diag.1`、versionCode `1000007`，bundle 与签名系列沿用原 App。此包用于本地定位连接问题；仓库基础版本及正式修订记录保持 `1000006`。采集操作和字段含义见[连接诊断参考](CONNECTION_DIAGNOSTICS.zh.md)。

诊断构建回执 `validation/connection-diagnostics-20261011/application-build.json`记录离线 Hvigor 7.26.8、HarmonyOS SDK 26.0.0.105 Release 构建和独立验签退出 0；最低 API 为 23，兼容版本 `6.1.0(23)` 的包内编码为 `60100023`。HAP 为 5400646 字节，SHA-256 `19e91af62ee041f8490de1e87b3a62baaa15a4663e2fabb2d9c324882b2d4e7c`。252 个生产输入及原签名材料摘要保持一致。仅缓存构建配置关闭路径大小写枚举，以避免 SDK 遍历不可读的 `/data/storage/el2` 祖先目录；原源码配置保留，并由逐文件摘要校验。

检查回执 `validation/connection-diagnostics-20261011/checks.json`记录 App 回归 169/169、工程检查 22/22、ArkTS 语义检查 0 错误及生产原生语法检查通过。两个新日志测试二进制在鸿蒙编译、签名并成功执行，覆盖静默/去重、脱敏数值格式、并发完整行、文件权限、轮转上限、写入失败和软链接/FIFO 拒绝。

覆盖安装回执 `validation/connection-diagnostics-20261011/installation-computer.json`确认当前电脑安装 `1000007`，未卸载或清除数据。界面回执 `validation/connection-diagnostics-20261011/ui-verification-computer.json`确认实际打开诊断页、读取 66987 个字符、刷新及复制后显示“诊断日志已复制。”；日志含重启前后两个进程以及 App、原生和网页事件。系统剪贴板写入成功反馈已验证，未另行读取系统剪贴板内容。完整刷新后复制的范围另由行为测试确认；本次未验证 2 MiB 日志的系统剪贴板极限。

实测保留的 308 条非空记录均符合固定事件名及数值字段格式；单条网页消息最大为 15420275 个 UTF-16 单位。本次电脑连接仍能收取消息，没有复现 `gateway/internal` 或手机网络恢复失败；大帧是已观测线索，尚不能判定断连原因。手机诊断版安装与运行未验证。以下记录属于此前 `1000006` 修订，不将旧安装或原生网络证据扩展为本次手机验收。

## broker 0.5.0 基础修订

App 为 `org.oheco.deepseekharness`、`0.2.0-rc.2-ohos.2`、versionCode `1000006`。本轮范围为 App、其原生 SDK 接入、工程导出及验证文档；CLI/Web 运行包继续使用 `0.2.0-rc.2-ohos.1`。App 修订由 [app-release.json](../app-release.json) 单独记录。

## 正式 SDK 与离线输入

[SDK 导入记录](validation/broker-sdk-0.5.0/sdk-intake.json)确认正式 broker 0.5.0，完整 SDK 归档 SHA-256 为 `94b563b96f66e5af9d9a99ba728aec0a0ba726685cf7ea878c4759f0ddee073b`。26 个 remote 源文件与安装版逐文件一致，包含新增认证模块和原始 CMake，SDK 无本地修改。[差异记录](validation/broker-sdk-0.5.0/source-comparison.json)确认依赖源码、构建脚本与六个依赖库沿用原样输入；依赖探针仍为历史 0.4.0 证据。

独立 SDK 的[编译回执](validation/broker-sdk-0.5.0/remote-sdk-build.json)和[整库链接回执](validation/broker-sdk-0.5.0/remote-sdk-link.json)均退出 0。此次独立 SDK 编译与链接未执行目标探针，App 原生运行验收另行记录。

## 连接与账号持久化

[原生参考](entry/src/main/cpp/broker/README.zh.md)定义刷新记录、文件权限和所有权。SDK 自动更新 access/refresh 凭据，App 在网络发送前持久化 pending，在确认新凭据持久化后清除 pending；首次创建目录也同步父目录。账号密码不落盘，连接偏好只保存托管会话引用。旧静态 bearer 需重新登录一次才能获得刷新授权。

返回列表保留最近一个 WebView、控制器、文档、路由、历史与映射；同配置再次打开恢复保留页面，切换或明确断开等待真实清理。普通重连显示顶部中央旋转指示，不重新加载整页；仅退出的渲染器在恢复后重建。首个远程监听请求随机端口，后续优先上次成功端口，仅独立确认绑定失败后才回退随机端口。

App 连接偏好兼容读取版本一、写入版本二；旧 App 不支持版本二。DSH Session 日志与 SQLite 格式保留。初始 App 输入见[迁移记录](../app-migration.json)，当前升级操作见[App 参考](README.zh.md)。

## 源码与原生检查

[App 回归日志](validation/broker-sdk-0.5.0/app-tests.log)记录 163/163 通过，覆盖配置迁移、托管引用、端口记录、页面保留、暂停/重连、关闭等待、取消登录和清理失败解锁。安装 SDK 的 ArkTS 独立语义检查为 0 错误；最终 Hvigor 编译亦通过。

[原生运行日志](validation/broker-sdk-0.5.0/native-final.log)记录已签名测试退出 0：125 个系统根证书、HTTPS/WSS、无效 TLS、账号与 peer 认证、PAKE/ICE/QUIC、TCP/HTTP/WebSocket、重复关闭和取消。过期 access 的刷新、丢失响应后的 pending 保留及重启精确重放均通过；目录同步失败不会确认登录，非绑定监听失败不会触发随机端口回退，真实端口占用会回退。

[工程检查日志](validation/broker-sdk-0.5.0/project-tests.log)保留原 22 项执行；旧 SDK 断言修正后的[单项复核](validation/broker-sdk-0.5.0/project-export-final.log)及 App 独立版本后的[最终导出复核](validation/broker-sdk-0.5.0/app-release-export-final.log)另行记录，不将中间失败表述为通过。

完整 `npm run doc-sync` 的[执行日志](validation/broker-sdk-0.5.0/doc-sync.log)记录未改动 Web 测试的 `TS2322`、`TS18048` 与文档构建后的 pnpm 无 TTY 依赖清理失败，不表述为全量通过。Markdown 链接、换行和升级指南检查通过；App 与鸿蒙参考的双语配对在最终交付文字更新后重新确认。本轮不修改运行时或 Web 文件来消除这些基线错误。

## HAP 构建、签名与设备范围

[最终构建回执](validation/broker-sdk-0.5.0/application-build-sdk5.json)记录全新目录完整 Hvigor 构建退出 0，随后针对取消与清理补强重新编译 ArkTS 并签名，原生输入保持不变。12 个 SDK C 编译单元及 App 原生接入在新目录构建；HAP 为 ELF64/aarch64，包内业务源码摘要与当前源文件一致。

最终 HAP 为 5340361 字节，SHA-256 `b065286dcc8cc587abb61d684bb326d668534fa4027d49caecbea3b0ace4ca10`。签名验证退出 0，公钥与用户原 fix2 签名系列一致。个人签名 HAP 保留本地；无签名工程使用便携 SDK `6.1.0(23)` 和 phone/tablet/2in1，实际构建使用 SDK26/compatible23 及 default/2in1。签名原文件保持只读，临时副本与含签名凭据的构建缓存单独清理。

[电脑安装回执](validation/broker-sdk-0.5.0/installation-computer.json)与[手机安装回执](validation/broker-sdk-0.5.0/installation-phone.json)均确认最终 HAP 经代理成功覆盖安装，安装版本为 `0.2.0-rc.2-ohos.2`、代码 `1000006`，HAP 摘要与最终构建一致。两台设备均未启动或操作 App。

原生运行与状态替身测试不能证明普通 HAP 沙箱网络、系统挂起或物理 WebView 连续性。用户此前仅要求安装，无需启动验收；本轮保持该范围。历史 0.4.0 构建及安装证据保留在 [历史 SDK 回执](validation/broker-sdk-0.4.0/application-build-install-sdk4.json)及其同目录记录。
