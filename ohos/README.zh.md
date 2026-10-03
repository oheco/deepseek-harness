# 鸿蒙 Web 与 App 本地移植 — 0.2.0-rc.2

[English](README.md) | 中文

## 范围

上游标签 `dsh-v0.2.0-rc.2`，提交 `639ed015397290b3745d163aafe02ffee4aa3f84`；独立分支 `ohos/0.2.0-rc.2`。以 0.1.7 已完成的鸿蒙补丁和 App 为参考，保留新版上游实现。CLI/Web 运行包不包含上游 Electron 桌面应用；`ohos/app` 是已有鸿蒙 ArkWeb 封装的迁移版本，不嵌入 npm 运行包。

本轮只进行本地构建和验证，不推送、不打发布标签、不创建 Release、不更新软件目录、不替换当前安装或现有服务。新版使用独立应用私有 `DSH_HOME`，不复制凭据或现有会话；旧格式是否可升级以新版上游文档为准，本地试用不验证旧会话迁移或降级。

## 构建

需要鸿蒙 PC ARM64、Node.js 24 及其开发头文件、Python 3、SDK Clang、PATH 中的 `binary-sign-tool`。固定工具归档、来源、摘要和许可在 `tpr/ohos-build-tools`，含 pnpm，无需全局安装。通过代理预取上游锁文件依赖后离线构建；锁定依赖不能用旧版 node_modules 整体替代。

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store /absolute/private/prepared-store --output /absolute/private/fresh-build
python3 ohos/package.py --deployment /absolute/private/fresh-build/deployment --output /absolute/private/local-package
```

`prepare-runtime.py` 根据当前上游运行预设及依赖计算 CLI/Web 部署闭包；`update-workspace-lock.py` 只添加鸿蒙工作区链接，复用上游固定的 Koffi 3.1.1，不重新解析第三方版本。修改后审核锁文件，在 `release.json` 记录 SHA-256。`build.py` 要求源码目录没有 node_modules，执行离线冻结安装、copy 模式、Host/Client/Web 构建和生产部署，保留 `official` 品牌，不构建 Electron。构建日志应保存在独立本地交付目录。

临时文件和目录均使用 `$TMPDIR` 并清理。路径应保持短，tsx 的 Unix 套接字受鸿蒙 `sun_path` 长度限制。缓存与构建输出使用 `$XDG_CACHE_HOME`；配置、凭据和会话使用 `$XDG_CONFIG_HOME` 等应用私有文件系统，而非共享 HOME。

## 本地运行与验证

`install-local.py --archive <归档> --dependencies-source <固定鸿蒙依赖目录> --output <全新目录>` 校验归档摘要并准备独立本地运行目录；拒绝覆盖已有目录，不执行 npm 全局安装。

运行包依赖 `release.json` 指定的鸿蒙 node-pty、Koffi、sharp 与 ripgrep；不能使用上游 Linux 二进制。`local-dependencies.py` 为本地验证复制并核对已经安装的固定鸿蒙依赖，不修改现有安装。sharp 使用 WASM。system flock 扩展从当前源码在鸿蒙原生编译并签名。启动入口传入 `--expose-internals`，支持新版 Host 所需的 Node 内部加载器。

```sh
zsh /storage/Users/currentUser/dev/ohos/harness-ohos-0.2.0-local/run-web.zsh
python3 ohos/acceptance.py --dsh /absolute/local-package/package/bin/dsh --tmp-parent "$TMPDIR" --logs /absolute/local-validation-logs
```

本地启动器默认使用 `$XDG_CONFIG_HOME/dsh-0.2.0-local`、监听 127.0.0.1 并随机选择端口，不打开浏览器、不读取旧版配置。打开它打印的认证 URL。App 首页命令写入独立 `~/Documents/dsh-0.2.0-run.log`，只连接这一日志中的服务。导出工程为 `export/DSHApp-0.2.0`；bundle 名不变，安装会升级同名 App 而非并存，交付工程不含个人签名配置。

针对性测试及五项隔离运行验收的实际结果记录在 `LOCAL-VALIDATION.md`。验收使用本地确定性模型服务，不代表真实模型 API 或浏览器/ArkWeb 人工交互已经验证。不默认运行全仓回归，不验证其他软件包。旧版测试结果不计入新版证据。

## 平台限制

**0.2 新增的 LibreOffice Kit 0.1.1 没有 OpenHarmony 引擎选择分支。** 已实际确认其能力查询返回 `Unsupported LibreOfficeKit host: openharmony-arm64`。默认 Web 组合已在鸿蒙禁用 Office 转 PDF 提供者，保留通用文档预览和独立 Excel/CSV 字节查看器；本地移植不支持由它执行的 Office 转 PDF、转换、重算及渲染；其他 JS/Python Office 编辑工具未验证。不采用 Linux 二进制，也不伪装全局 `process.platform`。

Shell 使用 `/usr/bin/zsh`；持久终端需具备 termios 的 Python 3，不能精确判断子进程是否等待输入。鸿蒙无受支持的进程沙箱后端，默认完整访问和关闭审批；显式请求沙箱必须失败，不能静默退化。HOME 文件系统不支持硬链接或私有 chmod，原子文件发布使用鸿蒙兼容实现。设置文件无法通过外部应用打开时返回路径。App 保留 Documents 权限与两步启动流程，不增加 UserFile 权限、broker 启动按钮或配置编辑器桥接。HAP 构建、个人签名、安装及真机交互由用户在 DevEco 中完成。
