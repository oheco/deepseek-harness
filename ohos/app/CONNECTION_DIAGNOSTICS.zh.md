# App 连接诊断日志

[English](CONNECTION_DIAGNOSTICS.md) | 中文

本参考说明 App 内的连接日志及其采集方式。日志用于区分本地打开停在哪一步、网页 WebSocket 关闭和原生 broker 恢复状态。

## 查看与复制

复现问题后，返回连接列表，点击标题栏右侧的**诊断日志**。电脑可用 **Ctrl+Shift+L** 返回列表。点击**刷新**读取最新记录，点击**复制日志**复制全部保留记录；页面只显示最近 96 KiB。查看日志及从该页返回继续保留正在进行的连接操作。App 重启后仍能读取此前日志。

App 将记录写入 `context.filesDir/connection-diagnostics/connection.log`，轮转文件为 `connection.previous.log`；目录为 0700、文件为 0600。每份最多 1 MiB，合计最多 2 MiB，达到上限时替换较旧的记录。界面读取失败会显示固定错误；文件写入失败不改变连接结果。

记录包含时间、进程、固定事件名、数字与布尔标志。账号、密码、token、Cookie 名称和值、连接名称、broker/session 标识、地址、会话内容、异常原文和 WebSocket 原始 reason 均不写入这份日志。复制只在用户点击时进行。

## 记录含义

`source=app` 与 `source=native` 共享同一文件；`wallMs` 为时间戳，`monoMs` 为原生单调时间，`pid` 区分重启。`generation` 是对应 App 所有者的代次，`app_gen` 是原生取消代次，`sdk_gen` 是 SDK 恢复代次；这些计数分别解释，不能直接互相比较。`current=0` 表示来自已退役页面的回调。

| 记录 | 关键字段 |
| --- | --- |
| `home.phase` / `home.phase_pending` | `operation` 区分选择与断开；`phase`：1 等待页面准备、2 broker 映射、3 DSH 探测、4 WebView 接管、5 断开；`elapsedMs` 为等待时长 |
| `index.phase` / `index.phase_pending` | `phase`：0 就绪或结束、1 等待控制器绑定或初始空白页结束、2 Cookie 准备、3 等待导航结束、4 页面错误、5 渲染器退出；`attached` 为 Web 控制器是否绑定 |
| `cookies.read_begin` / `cookies.read_complete` / `cookies.prepared` | 元数据读取、完成及认证 Cookie 过期数量；没有完成事件时可与等待阶段对照 |
| `index.back_history` / `index.back_to_connections` | 返回前的历史项数 `count`、当前位置 `status` 与上一项分类 `phase`：0 初始化空白页、1 当前连接 origin、2 其他；不记录地址 |
| `index.http_error` / `index.network_error` / `index.renderer_exited` | HTTP 状态、ArkWeb 错误码或渲染器退出枚举；`phase=1` 在请求错误中表示主文档 |
| `web.ws_created` / `web.ws_open` / `web.ws_error` / `web.ws_closed` | 只观察当前 origin 的 `/api/remote.mux`；`socket`、`code`、`clean`、`ageMs`、`lastMessageMs`、接收与发送次数 |
| `web.ws_close_requested` | 网页请求关闭的代码，可与随后实际关闭事件区分 |
| `web.ws_large_message` / `web.ws_summary` | `chars`、`totalChars`、`maxChars` 为文本 UTF-16 长度；二进制消息使用 `bytes`；普通消息汇总最多每 5 秒一次 |
| `web.visibility` / `web.online` / `web.offline` | 浏览器报告的可见性与 online 状态；online 读取原始 getter，仍属于 ArkWeb 报告而不是蜂窝网络诊断 |
| `native_sdk_state` / `native_sdk_recovery_stopped` | SDK 原始错误 `code`、`http`、`attempts`、`sdk_gen`、`retry_ms`；`flags` bit0 为映射存在、bit1 为取消代次已变、bit2 为状态查询失败 |
| `native_probe_stage_begin` / `native_probe_stage_end` | `stage=1` 为 token 交换、2 为首页；curl 数值错误、HTTP、耗时及保留的响应体字节数；不记录响应体 |
| `native_operation_begin` / `native_operation_end` | `method`：0 登录、1 列表、2 映射、3 手动重连、4 状态、5 关闭、6 DSH 探测；`queue_ms` 与 `duration_ms` 区分排队及执行 |
| `native_napi_forced_close` / `native_release_begin` / `native_release_end` | 提交失败是否触发取消和关闭，以及映射、peer、API 各自释放时长 |

`native_sdk_state.state` 使用 SDK 枚举：0 connecting、1 connected、2 reconnecting、3 retry_wait、4 paused、5 failed、6 closed。`connection.state.state` 使用 App 枚举：0 connected、1 disconnected、2 recovering、3 authentication-required。`web.ws_closed.reason` 仅为固定分类：0 空、1 reconnect requested、2 invalid Remote stream frame、3 Remote stream failure could not be delivered、4 peer disposed、5 其他非空值；未匹配的文本被丢弃。

阶段观察每 5 秒记录尚未完成的等待；普通 SDK 状态轮询只记录变化。观察定时器只写日志，连接动作由原有逻辑负责。WebSocket `1006` 表示浏览器未收到正常关闭帧；判断服务端心跳或主动终止仍需对应时间的服务端日志。SDK 公共状态没有暴露其内部在线探测的 curl 阶段，App 的 HTTP Probe 记录与该状态分别保留。

## 验证

App 行为检查为 `node --test ohos/app/tests/*.test.mjs`。原生文件边界测试 [connection_log_test.cpp](entry/src/main/cpp/connection_log_test.cpp) 覆盖并发、轮转、文件权限、软链接/FIFO 拒绝及写入失败，状态日志测试 [native_diagnostics_test.cpp](entry/src/main/cpp/native_diagnostics_test.cpp) 覆盖静默与去重；两者由原生 CMake 的 `DSH_BUILD_BROKER_TESTS` 注册。鸿蒙测试二进制须在执行前完成签名。诊断安装包及实际设备证据与既有修订分开记录，见 [VALIDATION.md](VALIDATION.md)。
