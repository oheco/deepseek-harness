---
kind: upgrade-guide
description: "鸿蒙启动使用 zsh，旧移植版的固定 token 参数和私有 UI 钩子改由插件提供。"
---

# 鸿蒙运行配置

[English](guide.md) | 中文

## 变更

鸿蒙 CLI/Web 发行版基于上游 `0.2.2-rc.3`，增加系统兼容。普通命令使用 `/usr/bin/zsh -f -c`，持久终端也使用 zsh。旧鸿蒙移植版的 `--token` 参数、私有对话标题栏工厂、设置路径弹窗和自定义 WebSocket 分片不再包含。上游已有的 profile 名称仍可使用。

鸿蒙除原有仅所有者权限外，额外接受精确权限为 `0660` 的凭据文件。其他平台保留上游权限检查。创建文件仍请求 `0600`。共享 HOME 无法落实私有 chmod 权限；需要仅所有者访问时，应使用应用私有存储。

## 迁移

1. 启动新版本之前先停止旧 Web 服务。将现有 `DSH_HOME` 备份到应用私有存储。保留已有 Session 代文件；保留旧代不代表支持降级读取。
2. 使用 Node.js `>=24.9.0`、系统 zsh 和带 termios 的 Python 3。通过 `oo install deepseek-harness` 安装发行版，或参照[鸿蒙安装说明](https://github.com/oheco/deepseek-harness/blob/v0.2.2-rc.3-ohos.1/ohos/README.md)。试用安装应使用独立的 `DSH_HOME`。
3. 从保存的启动命令中移除 `--token`。需要保留固定登录地址时，从 [oheco/dsh-fixed-token](https://github.com/oheco/dsh-fixed-token) 仓库目录执行 `dsh plugin --profile web add link:/absolute/path/dsh-fixed-token`。将 profile 覆盖文件中的 `connection.config.token` 原值移到下面的插件行，再仅删除旧 token 字段。插件接受 16–256 位 URL 安全字符；旧值超出此范围时应生成新 token。不要发布 token 或 profile 覆盖文件。

```yaml
- id: oheco-fixed-token
  name: '@oheco/dsh-fixed-token'
  config:
    token: <existing-private-token>
```

4. 将外部插件升级到上游 API。可选的[已打开会话列表](https://github.com/oheco/dsh-open-sessions)替代旧私有标题栏方案。使用 [oheco/dsh-image-guard](https://github.com/oheco/dsh-image-guard) 时，应将其放在重试插件之后。这些插件单独安装，不随运行包捆绑。
5. 重启 Web 并刷新浏览器。确认 `dsh --version` 输出 `0.2.2-rc.3`，核对启用的插件行，并测试登录地址。外层包元数据记录适配修订 `0.2.2-rc.3-ohos.1`。

需要保留持久状态时应直接执行命令：在此鸿蒙系统上，交互式 `exec` 会结束 shell 并重置状态。显式进程隔离仍不受支持；部署默认值与其他限制见安装说明。
