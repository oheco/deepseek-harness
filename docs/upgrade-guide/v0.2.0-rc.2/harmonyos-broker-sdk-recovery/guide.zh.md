---
kind: upgrade-guide
description: "鸿蒙 App 使用正式 broker SDK 恢复机制及更新的原生接入输入。"
---

# 鸿蒙 App 使用 broker SDK 恢复机制

[English](guide.md) | 中文

## 变更

App 原样嵌入正式 broker 0.4.0 C SDK。网络断开保留 peer、TCP 映射、监听端口与 WebView。SDK 自动重试，回到前台时在同一句柄上唤醒已暂停的 peer。正常恢复不重建 WebView。已有 TCP/WebSocket 连续恢复要求两端 peer 和控制服务使用新版恢复协议；0.3.0 仍兼容映射服务恢复。

原生接入新增 `brokerReconnect`。`brokerStatus.state` 包含 `reconnecting`、`retry_wait`、`paused` 和 `closed`，并增加终止性账户授权失败的 `errorCode` 字段。移除并拒绝 `brokerConnect.localPort`：SDK 首次选择端口，恢复时保留原监听端。`brokerLogin` 和 `brokerList` 现在要求传入与连接相同的私有 `tempDir`。

## 迁移

1. 登录、列表和连接均传入 `context.tempDir + '/dsh-broker'`，原生客户端存活期间保持该目录不变。
2. 恢复或暂停期间继续持有 SDK 映射。对已暂停的连接请求 `brokerReconnect` 并观察后续状态；接受请求不代表连接已经建立。
3. 删除固定替换端口输入和关闭再连接的恢复流程。释放所有权时等待最终 `brokerClose`；App 可以先退出页面，再完成清理。

完整恢复与清理行为由[原生客户端说明](../../../../ohos/app/entry/src/main/cpp/broker/README.zh.md)维护。App 偏好版本、DSH Session 日志和 SQLite 数据均保持不变。
