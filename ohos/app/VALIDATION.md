# DSH App broker 0.5.0 刷新与页面保留验证

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
