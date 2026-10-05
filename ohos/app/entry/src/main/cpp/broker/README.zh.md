# 原生 broker 客户端参考

[English](README.md) | 中文

`libdsh_launcher.so` 模块提供 Promise 方法 `brokerLogin`、`brokerList`、`brokerConnect`、`brokerReconnect`、`brokerClose`、`brokerStatus` 和 `dshProbe`。输入与结果以 [TypeScript 声明](../types/libdsh_launcher/index.d.ts)为准。[broker_client.cpp](../broker_client.cpp) 管理 SDK 句柄，[broker_napi.cpp](../broker_napi.cpp) 转换结果并注册独立的异步清理钩子。

## 认证与映射

broker 方法接收指定服务的 HTTPS origin，并验证 HTTPS/WSS 的证书链及主机名。App 从 HarmonyOS `/etc/security/certificates` 中由 root 拥有、普通用户不可写的证书生成私有 PEM 信任文件，通过 SDK 公开的 `ca_file` 选项传入。系统根证书缺失、不可读、格式错误或为空时操作失败。App 不提供自定义 CA 导入；NAPI 拒绝 `caPath`，包括空值和 undefined。只有单独编译的测试库接受私有测试 CA。QUIC peer 证书继续使用 SDK 独立的 PAKE 和固定证书验证。

登录返回账户 bearer token，由 ArkTS 持久化到应用私有存储。原生代码不将账户凭据写入磁盘，也不记录密码、token、URL 或响应正文。账户密码、peer 密码和 DSH token 是三种独立凭据。管理 HTTP 401 以 `Error.code = 'DSH_BROKER_AUTH'` 拒绝；SDK 终止性的账户授权失败也会分类返回。DSH 检测的认证结果不会使账户 bearer 失效。

连接使用 `ob_remote_connect_async`，在数字地址 `127.0.0.1` 上创建一个由系统分配端口的 SDK TCP 映射，等待认证连接建立后才返回成功。目标为远端 `127.0.0.1` 和输入的 DSH 端口。SDK 监听端就是 WebView 入口；App 不额外创建转发监听端，也不请求固定端口重建。HTTP Host、Origin、重定向、Cookie 和 WebSocket 字节均保持不变。本地监听端没有 broker 层调用方认证，因此 DSH 认证必须保持启用。

登录、列表和连接均传入 `context.tempDir + '/dsh-broker'`。工作线程以 0700 创建缺失的路径组件，拒绝软链接和点路径组件，并验证最终所有者与权限。在 SDK 工作线程启动前，App 将进程 `TMPDIR` 一次性设为这个经过验证的应用私有目录；原生客户端存活期间拒绝不同目录。公开系统根证书文件与临时 SDK peer 证书使用私有文件。SDK 在最终关闭时删除 peer 密钥和证书。不调用 shell，也不修改 TLS 环境变量。

## 恢复与所有权

一个常驻 App 工作线程串行执行 SDK 操作。`brokerStatus` 返回 `idle`、`connecting`、`connected`、`reconnecting`、`retry_wait`、`paused`、`failed` 或 `closed`；只要 peer 和映射仍被持有，本地 URL 与端口就保持记录。可恢复的传输故障保留 API 客户端、peer 和 map。SDK 使用默认自动策略：60 秒预算内最多尝试八次，耗尽后进入 `paused`。App 不另建重试循环，也不在状态轮询时重置预算。

`brokerReconnect` 通过 `ob_remote_peer_reconnect` 唤醒已暂停的 peer。Promise 返回状态快照：接受请求不代表连接已经完成。健康或正在恢复的 peer 保持原状。终止性授权失败不能通过手动重连绕过。App 继续观察状态，并在确认 DSH 端点后报告恢复。明确返回、窗口/Ability 销毁和原生环境释放是最终资源清理路径；进入后台和组件临时脱离保留 SDK 监听端。

双方 peer 上下文及远端目标 socket 在默认 120 秒保留期限内存活时，SDK v2 可以保留已有 TCP/WebSocket socket。控制服务及两端映射 peer 均须支持新版恢复协议，才能保证旧流透明续传。使用 0.3.0 控制服务或 peer 时，兼容模式可以恢复映射服务并保留 App 监听端，但旧 TCP 流可能关闭，由业务客户端重新连接。详见 [SDK 恢复指南](https://github.com/oheco/oheco-broker/blob/main/docs/RECONNECT.md)。

关闭立即使 App 代数失效，丢弃尚未开始的普通工作，并等待所有者关闭 map、回收 peer/control/I/O 工作线程、销毁被借用的 API 客户端后才完成。首次异步 peer 建连可以通过已取得的句柄停止。管理请求仍受 HTTP 超时约束。dispose（资源释放）完成排队 future 并回收 App 工作线程，然后才卸载原生代码；异步清理钩子无法创建清理线程时使用同步回收。

DSH 检测只接收数字回环 HTTP origin。每次检测从无 Cookie 状态开始，通过同 origin 的 303 重定向交换输入的 token，再使用该响应的有界内存 Cookie 请求主页。成功要求 HTTP 200 且包含 `__DSH_BOOT__`。检测之间不持久化 Cookie，错误 token 无法复用之前的成功会话。

## 离线构建输入

App 原样使用正式 broker 0.4.0 C SDK。[broker-sources.json](../tpr/broker-sources.json) 记录软件包身份、完整源码归档与原始文件摘要。[SDK 副本](../broker_sdk/ob_remote.h)及其原始 CMake 文件与已安装正式版一致。App 构建设置位于 [broker_dependencies.cmake](../broker_dependencies.cmake)。[依赖元数据](../tpr/native-dependencies.json)、[原始许可证](../tpr/licenses/)和 SDK MIT 许可证均予以保留。

[PAYLOAD.json](../tpr/broker-native-arm64/PAYLOAD.json) 记录准备好的 arm64 静态库与头文件。CMake 编译 SDK 前检查 [SHA256SUMS](../tpr/broker-native-arm64/SHA256SUMS)。DevEco 使用相对路径输入，不下载依赖，也不解析相邻仓库或缓存路径。在导出工程中运行 `python3 entry/src/main/cpp/prepare_native.py --build-dir "$XDG_CACHE_HOME/<new-directory>"`，或在仓库中运行 `python3 ohos/prepare-broker-native.py --build-dir "$XDG_CACHE_HOME/<new-directory>"`，即可在 HarmonyOS 离线重建。原始 SDK 构建器需要 Clang/Clang++、CMake、Ninja、Python、用于 BoringSSL 生成器的 Go，以及为必需目标探针签名的 `binary-sign-tool`。临时文件使用私有 TMPDIR；归档只包含公开上游测试向量，不包含生成的 peer 密钥或个人签名材料。

## 验证范围

[App 验证记录](../../../../../VALIDATION.md) 区分 SDK 构建探针、App 接入检查、签名 HAP 构建和设备安装。终端原生检查不能证明普通 HAP 的沙箱访问、挂起行为或实际 WebView 连续性，这些仍属于设备应用检查。
