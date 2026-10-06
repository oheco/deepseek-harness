# DSH App 正式 broker 0.4.0 SDK 接入验证

本轮将 App 切换到已安装的正式 broker 0.4.0 C SDK，保持 SDK 源码不变，接入异步首连、持久 peer/map、自动恢复状态与同句柄手动重连。原有系统主题、透明系统栏、旋转锁与设置页滚动布局保留。仅运行与此次恢复接入相关的检查、SDK 构建内置探针和生成可安装 HAP 所需步骤，不运行仓库全量测试或额外 VM/SDK 编译夹具。

## 正式 SDK 与离线构建

[SDK 导入记录](validation/broker-sdk-0.4.0/sdk-intake.json)确认版本 `0.4.0`，完整归档 13885 个 SDK 文件及软件包版本/许可文件，原样复制 24 个 remote 文件及原始 CMake。安装目录前后全文件摘要均为 `1dc40f50e8d6138591910c1be310d4e68d4a7a857b39e9dcbb7679a7b068826f`，`installed_sdk_unchanged = true`、`local_sdk_changes = NONE`。

[最终原样复核](validation/broker-sdk-0.4.0/final-sdk-immutability.json)逐文件核对安装包中的 13887 个输入（其中 SDK 文件 13885 个）及 App 的 24 个 SDK 副本，摘要均与原导入一致。

完整源码归档 SHA-256 为 `3b309480074c59ba5dd446721d2bd49bc2a1cb1a74054924cf2a38bb9dba0931`。原始 SDK 离线 `build.sh` 在新的私有目录退出 0，构建六个依赖静态库和包含 coordinator/recovery 的 11 个 SDK C 源文件；只执行构建器内置的签名目标探针。见 [SDK 构建日志](validation/broker-sdk-0.4.0/sdk-build.log)。App 依赖载荷只含六个依赖库、头文件与许可证，HAP 构建独立编译原样 SDK 源码，不复用预编译 remote SDK 库。

## App 恢复与清理

[原生客户端](entry/src/main/cpp/broker/README.zh.md)使用 `ob_remote_connect_async`，首次创建 SDK 监听端后持续持有 API、peer 与 map。可恢复故障、自动退避和暂停均保留本地端口；前台仅对已暂停 peer 请求 `ob_remote_peer_reconnect`。App 不再关闭后按旧端口重新绑定，也不增加自有 TCP 转发器。

[WebConnection.ets](entry/src/main/ets/launcher/WebConnection.ets)区分请求接受与连接完成。自动恢复通过状态轮询确认并检查 DSH 端点，然后通知原 WebView；正常恢复保留控制器、DOM、历史、搜索与 origin，仅已退出的渲染器在恢复后重建。[Index.ets](entry/src/main/ets/pages/Index.ets)在明确返回时立即退出页面并恢复纵向显示，继续持有未完成清理的 Promise，清理结束前不接入新 WebView。后台与临时组件脱离保留 SDK 映射；窗口/Ability 销毁及原生环境释放执行最终清理。

App 为 `org.oheco.deepseekharness`、`0.2.0-rc.2-ohos.1`、versionCode `1000003`。App 私有偏好、DSH Session 日志和 SQLite 类型不变；原始输入见[迁移记录](../app-migration.json)。

## 相关检查

一次[聚焦执行](validation/broker-sdk-0.4.0/app-focused-tests.log)通过 52/52：恢复与 Index 生命周期 19 项、页面/Ability 接线 8 项、系统栏 15 项、方向 10 项。核对正式 SDK 的手动请求实现后，补充“接受请求时快照仍为 paused”的异步状态分支，仅[重跑恢复检查](validation/broker-sdk-0.4.0/web-connection-final.log)，19/19 通过、退出 0；其余三个已通过文件未变化。这些使用 SDK 状态替身检查实际 App 源码行为，不能代替普通 HAP 的网络和物理 WebView 验收。

## 构建与设备范围

[发行验证回执](https://github.com/oheco/deepseek-harness/releases/download/v0.2.0-rc.2-ohos.1/deepseek-harness-0.2.0-rc.2-ohos.1-validation.json)的 `app` 项记录正式 Hvigor 构建退出 0，34 项全部执行、0 项缓存，耗时约 60 秒。11 个正式 SDK C 编译单元与 App 接入均在本次构建生成；HAP 原生库为 ELF64/aarch64，包含 `brokerReconnect` 绑定。前期环境、库搜索路径和签名配套文件问题与最终成功分开记录；库路径修正在 App 自有构建包装中完成，正式 SDK CMake 保持原样。

签名使用用户指定的 fix2 原签名配置及配套文件。发行回执记录签名验证退出 0，HAP 证书链公钥摘要与 fix2 一致，原配置、三个签名文件与五个配套解密文件未修改，临时副本已删除。个人设备签名 HAP 保留在本地，大小为 5232374 字节，SHA-256 为 `6598643b1026b7e521e8692e52134026d6432eab09b0eebf0ad6ffd9402630f0`。

发行回执的 `app.installation` 确认电脑 `192.168.1.160:34835` 与手机 `192.168.1.191:41339` 的 HDC `install -r` 均成功，安装版本与代码正确；首次手机连接离线与恢复后的成功安装分别记录。便携工程保持 SDK `6.1.0(23)`、phone/tablet/2in1；实际设备构建使用已安装 SDK26/compatible23 与有效的 default/2in1 配置，不修改 SDK 字典。交付工程不包含个人签名配置，编译输入与 HAP 的一致性另按文件摘要记录。

沿用用户“只需完成安装，无需启动验证”的要求，不解锁、启动或操作电脑和手机 App。0.3.0 控制服务或 peer 仍兼容映射服务恢复；已有 TCP/WebSocket 连续恢复需要两端 peer、目标 socket 与新版控制恢复关系在保留期限内存活。本轮不将 SDK 原生探针或 App 状态替身检查扩大为真实网络中断、设备挂起或旧 TCP 续传的真机证明。之前 fix5 的导出、HAP 与安装记录保留。
