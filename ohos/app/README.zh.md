# DSH 鸿蒙 App · 连接管理

[English](README.md) | 中文

管理已保存的本地和远程 DSH 连接，并用全窗口 WebView 打开所选工作空间。这是用于本地验证的社区 App 工程，构建与设备验收证据见 [VALIDATION.md](VALIDATION.md)。

## 在 DevEco 中打开

1. 打开包含 [build-profile.json5](build-profile.json5) 的工程根目录。
2. 使用支持工程声明的 `6.1.0(23)` 编译、目标和兼容 API 的 ARM64 鸿蒙 SDK。模块支持手机、平板和 2in1；表单可滚动，并随窗口宽度调整布局。
3. 配置自己的 App 签名，然后 Build/Run `entry`。导出不包含个人签名身份或 profile。

显示名为 `Deepseek Harness`，bundle 名为 `org.oheco.deepseekharness`。安装同 bundle 会升级已有 App。模块需要联网权限。工程包含 broker C SDK、完整固定版本的依赖源码和 ARM64 静态库；依赖与重建细节由 [原生说明](entry/src/main/cpp/README.zh.md)维护。

## 添加与编辑连接

首页显示已保存连接的名称与模式。点击底部中央 `+`，再选择**本地模式**或**远程模式**。所选模式在设置页中保持固定。通过**编辑**修改名称、配置或删除连接。**保存**位于导航标题栏右侧；**测试连接**与编辑时才显示的**删除连接**并排固定在页面底部。

App 在自己的私有偏好中保存最多 100 条连接，包含 DSH token，远程连接还保存服务 bearer 与 peer 密码。账号密码登录后清除，不写入持久化存储。保存成功后，列表显示及编辑、打开使用的配置立即更新，包括仅修改 token 的情况。保存失败时保留原列表；偏好无法读取或版本不支持时，需重试后再编辑，应用不会用空列表覆盖原数据。

### 本地模式

在同一设备上启动 DSH，指定固定端口和 token。独立本地启动器接受 Web 参数：

```sh
zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-connections-local/run-web.zsh --port 3080 --token '<your token>'
```

在 App 中填写名称、本地端口（默认 `3080`）和同一 token（初始为空）。**测试连接**使用新的 token 鉴权，再读取已认证的 DSH 首页，按钮文字保持居中，图标独立位于文字左侧，测试时旋转，成功显示绿色对勾，失败显示红色叉；测试与删除按钮的文字均为 14 字号；已输入内容保持不变。修改连接配置会清除上一次测试状态。失败详情区分 token 被拒绝、访问被拒绝、服务不可达及端口上的其他服务。标题栏的**保存**保存配置，不要求先测试成功。

App 连接 `127.0.0.1`，不负责启动 Node 或 DSH；终端或其他有权限的环境需要先运行服务。

### 远程模式

1. 填写自己的 broker 服务 HTTPS 地址、账号和账号密码。新建时服务地址为空。所有管理与信令连接均要求 HTTPS/WSS，证书必须受系统信任且域名匹配。
2. 登录后从该账号的列表中选择在线 broker。离线 broker 仍可见，但不能选择。
3. 填写连接名称、该 broker 的**连接密码**、远端 DSH 端口（默认 `3080`）和 DSH token；这些凭据与管理服务账号密码分开。
4. 测试连接或点击标题栏的**保存**。远端 broker 必须正在运行，并允许 TCP 访问其 `127.0.0.1:<DSH 端口>` 目标。

设置页在连接名称下显示已登录服务的地址与账号，再显示所选 broker，两项均有**修改**按钮。修改服务后登录并按需重新选择 broker，返回原设置页；取消时恢复原身份，选择其他 broker 时清除原连接密码。

App 不提供自定义 CA 导入或信任覆盖。旧连接保留其配置，已停用的 CA 引用会被丢弃。

原生 SDK 负责 WSS 信令、peer 认证、穿透与中继。它的本地 TCP 映射在恢复期间始终保持为 WebView 回环地址；HTTP、API 和 WebSocket 保留浏览器一侧的 Host、Origin 与 Cookie。明确关闭并重新打开连接时，App 建立新映射并重新进行 token 鉴权。

测试结束会关闭临时映射。成功打开后由 WebView 接管映射，返回列表或 App 销毁时关闭。传输断线保留当前页面与 SDK 监听端，由 SDK 自动尝试恢复。App 观察恢复状态，控制器、页面状态与 origin 保持不变。回到前台时检查端点并唤醒已暂停的连接，重复事件共享未完成操作；恢复失败仍保留页面。渲染器已退出时，在恢复后重新加载其最后一个应用内地址。返回立即退出页面并取消未完成操作，清理完成前不接入新的 WebView。首次打开失败保留连接流程；已保存的管理 bearer 失效时进入该连接的登录页，DSH token 错误不会清除 broker 登录状态。

[原生接入](entry/src/main/cpp/broker/README.zh.md)使用未经修改的 broker 0.4.0 SDK。0.3.0 服务端仍兼容，App 本地监听端保持不变；已有 TCP/WebSocket socket 的连续恢复要求两端 peer 与控制服务支持新版恢复协议。

## WebView 与外观

WebView 占据整个内容区域，在系统旋转锁关闭时允许自动纵向与横向旋转；连接列表和所有设置页固定纵向，从 WebView 返回时恢复纵向。系统返回先关闭原生菜单或搜索，再处理网页历史，最后返回连接列表。电脑用户可用 **Ctrl+Shift+L** 直接返回。Ctrl+F、匹配跳转、菜单操作、外链和本地路径操作继续可用；原生文件管理器操作不会从远端电脑下载 DSH 页面中显示的路径。

连接列表和表单使用鸿蒙原生 Navigation 与 NavDestination 页面、默认切换动画和系统返回按钮，跟随系统浅深色主题。系统栏保持透明，App 背景（浅色 `#FFFFFF`、深色 `#151517`）扩展到状态栏和底部手势区域，系统栏文字与图标保持清晰；操作控件仍留在安全区内。设置页 Scroll 铺满页面宽度，滚动条位于屏幕边缘；左右留白和最大宽度只用于滚动内容，底部按钮与表单对齐。加载遮罩保留到首次绘制，原生浮层读取当前网页的主题颜色。

## 本地验证与导出

从源码 checkout 执行：

```sh
node --test ohos/app/tests/*.test.mjs
python3 -B ohos/test-app-project.py
node ohos/check-app-arkts.cjs --sdk <installed-ets-sdk> --output <new-private-directory>
python3 -B ohos/package-app-project.py --output <new-archive-directory> --export-project <new-project-directory>
```

打包器包含离线原生依赖，并拒绝已有导出目录。ArkTS 检查属于语义检查，不是 DevEco 完整 HAP 构建。已签名的原生传输测试及运行包检查与 ArkWeb 人工交互验收分别记录，见 [VALIDATION.md](VALIDATION.md)。已有导出、个人签名配置和正在运行的服务会保留。
