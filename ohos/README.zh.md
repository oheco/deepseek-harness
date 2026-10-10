# 鸿蒙 CLI/Web 与 App — 0.2.0-rc.2-ohos.1

[English](README.md) | 中文

## 范围

oheco 发行版本为 `0.2.0-rc.2-ohos.1`，基于上游 `dsh-v0.2.0-rc.2`，源码工作区包保留 rc.2 版本；[release.json](release.json)记录准确的上游源码与适配依赖。[app-release.json](app-release.json)单独记录 App 修订，适配分支是上游 fork 中的 `ohos/0.2.0-rc.2`。CLI/Web 不包含 Electron；独立鸿蒙 App 管理本地与 broker 连接，不嵌入 Node 或 npm 运行包。

## 安装与运行

通过正式软件目录安装 Node.js 24 和运行包：

```sh
oo install nodejs
oo install deepseek-harness
dsh --version
DSH_HOME="${XDG_CONFIG_HOME:?}/deepseek-harness" dsh web --host 127.0.0.1 --port 0 --no-open
```

目录通过 npm 安装 `release.json` 中四个固定鸿蒙依赖。归档包含生产 CLI/Web 依赖闭包、Web 资源及已签名 system 扩展。oo 0.10 默认让 npm 全局安装；`--` 后的显式 npm 参数可选择其他作用域或安装前缀。打开 `dsh web` 打印的认证 URL。`DSH_HOME` 使用应用私有文件系统，共享 HOME 无法落实私有权限。验证目录不复制现有凭据或会话。Session 升级兼容性由上游负责，本适配不承诺降级支持。

使用 `oo export deepseek-harness@0.2.0-rc.2-ohos.1 app-0.2.0-rc.2-ohos.2 --output <新目录>` 导出 App `0.2.0-rc.2-ohos.2`；包版本选择原 CLI/Web 发行版，命名工程选择本次 App 修订。bundle 为 `org.oheco.deepseekharness`，安装升级同名 App。请在 DevEco 中为目标设备配置个人签名。新连接默认启动已安装的 `dsh`，自动选择回环端口并写入 `~/Documents/dsh-0.2.0-run.log`；已保存的用户命令保持原值。[App 参考](app/README.zh.md)说明连接行为，[broker 接入](app/entry/src/main/cpp/broker/README.zh.md)说明原样正式 0.5.0 SDK、系统信任及恢复条件。工程导出包含离线 SDK 与原生依赖，不含个人签名配置。

## 重现构建

需要鸿蒙 PC ARM64、Node.js 24 及开发头文件、Python 3、SDK Clang、oheco Go `1.27.1-ohos.1`、PATH 中的 `binary-sign-tool`。固定工具、归档、摘要及许可在 `tpr/ohos-build-tools`，含 pnpm。VitePress 锁定的 0.21.5 编译器在本地依赖副本中接入原样 esbuild-wasm 0.21.5；其他构建工具保留固定的鸿蒙/WASM 包。工具准备阶段从完整固定的 Go 源码及依赖归档原生构建锁定的 oxlint-tsgolint 7.0.2001 后端，再签名私有副本；输入清单记录其文件系统大小写适配。通过配置的代理预取锁定依赖后离线构建，不复用其他版本的 node_modules。

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store <private-prepared-store> --output <fresh-build>
python3 ohos/package.py --deployment <fresh-build>/deployment --output <fresh-package>
python3 ohos/package-app-project.py --output <fresh-app-output>
```

`prepare-runtime.py` 计算当前 CLI/Web 部署闭包；`update-workspace-lock.py` 添加鸿蒙工作区链接，复用上游固定 Koffi，不解析新的注册中心版本。审核锁文件及 `release.json` 中的摘要。`build.py` 要求全新源码目录无 node_modules，使用 copy 模式离线冻结安装，编译 Host/Client/Web 与已签名 flock 扩展，保留官方品牌并部署生产依赖。App 导出器校验每个 SDK/原生输入，默认使用已安装运行包；`--web-launcher` 显式选择本地试用启动器。

临时文件与目录使用 `$TMPDIR` 并清理；路径保持短，满足 tsx Unix 套接字限制。构建缓存使用 `$XDG_CACHE_HOME`，长期配置、凭据及会话使用 `$XDG_CONFIG_HOME`。`install-local.py` 使用固定鸿蒙依赖准备隔离归档安装，拒绝已有输出目录。`acceptance.py` 使用私有状态验收安装后的产物。[LOCAL-VALIDATION.md](LOCAL-VALIDATION.md)保存本地试用历史证据；[App 验证记录](app/VALIDATION.md)区分源码检查、构建与签名验证、仅安装的设备结果。

## 平台限制

LibreOffice Kit 0.1.1 没有 OpenHarmony 引擎，其能力查询返回 `Unsupported LibreOfficeKit host: openharmony-arm64`。Web 组合禁用 Office 转 PDF 提供者，保留通用文档预览与独立 Excel/CSV 字节查看器。依赖引擎的 Office 转换、重算及渲染仍不支持，其他 JS/Python Office 编辑工具未验证。适配不使用 Linux 二进制，也不伪装全局平台。

Shell 工具使用 `/usr/bin/zsh`。持久终端需要具备 termios 的 Python 3，不能精确判断子进程是否等待输入。鸿蒙没有受支持的进程沙箱后端；默认完整访问与关闭审批保持，显式请求沙箱会失败。文件发布处理共享 HOME 缺少硬链接和私有 chmod 的差异。设置文件无法外部打开时返回路径。App 保留 Documents 权限及两步终端启动流程。源码 fixture 与原生产物检查不代表已验收人工 ArkWeb 交互或所有断网情况下的旧 TCP 透明续传；设备检查遵守用户仅安装的范围。
