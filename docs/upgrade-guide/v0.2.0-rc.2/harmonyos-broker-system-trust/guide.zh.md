---
kind: upgrade-guide
description: "鸿蒙连接管理 App 移除日志导入和自定义 broker CA 信任。"
---

# 鸿蒙 broker 连接要求系统信任

[English](guide.md) | 中文

## 变更

鸿蒙 App 移除**从日志导入本地连接**和**导入 CA 证书**。管理 HTTPS 和信令 WSS 要求证书受系统信任，证书链有效且域名匹配。新建服务地址为空，由用户填写。

已保存的 version-one 连接保留名称、端口和凭据。读取时丢弃停用的 `caPath` 字段，后续保存也不包含它。先前依赖导入私有 CA 的服务会因证书验证失败而无法连接。公开原生 broker 方法拒绝传入 `caPath` 属性；App 调用方使用更新后的 [原生声明](../../../../ohos/app/entry/src/main/cpp/types/libdsh_launcher/index.d.ts)。

## 迁移

1. 本地连接使用 `dsh web --port 3080 --token '<your token>'` 启动 DSH，选择**本地模式**，直接填写端口和 token，再用标题栏的**保存**保存。
2. 远程连接填写自己的管理服务地址，HTTPS 证书必须受系统信任且域名匹配。连接前替换仅由私有 CA 签发的服务端证书。
3. 测试连接。按钮保持**测试连接**文字，旋转图标表示正在测试，绿色对勾表示成功，红色叉表示失败。确认输入的 token 仍然保留。已有连接名称和凭据无需手工重写。

当前流程见 [App 说明](../../../../ohos/app/README.zh.md)。这次 App 偏好变更不修改 DSH Session 日志或 SQLite 数据。
