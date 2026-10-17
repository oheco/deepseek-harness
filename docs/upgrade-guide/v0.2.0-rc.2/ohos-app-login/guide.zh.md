---
kind: upgrade-guide
description: "鸿蒙 App 的可刷新登录需要 broker 0.5.0，旧 App 无法读取已保存的版本二连接。"
---

# 鸿蒙 App 登录与已保存连接

[English](guide.md) | 中文

## 变更

App 读取原版本一连接偏好，写入带原生登录会话引用和优先本地端口的版本二，旧 App 无法读取版本二。新的账号登录使用 broker 0.5.0 刷新 API；原静态 bearer 在到期前仍可使用，但需要重新登录才能获得刷新授权。DSH Session 日志和 SQLite 存储格式保留。

## 迁移

1. 在已有 `org.oheco.deepseekharness` App 上覆盖安装新 HAP，保留应用数据，已有连接会自动读取。
2. 远程连接进入**编辑 → 服务旁的修改**，在 broker 0.5.0 服务重新登录一次，再点击**保存**。账号密码会清除，原生私有存储持久化刷新凭据。保存版本二配置后继续使用当前 App。
3. 确认仍可使用独立的 peer 密码和 DSH token 打开连接，返回列表后再次打开同配置会恢复保留页面。恢复与 token 失效行为见 [App 参考](../../../../ohos/app/README.zh.md)。
