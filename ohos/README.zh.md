# 鸿蒙 CLI/Web — 0.2.2-rc.3-ohos.1

[English](README.md) | 中文

## 范围

本地移植基于上游 `dsh-v0.2.2-rc.3`。[release.json](release.json)固定源码、鸿蒙运行依赖和已审核锁文件。源码改动限于鸿蒙文件发布、原生文件锁和输出创建、PTY 检查、zsh 及 Node 内部模块访问。鸿蒙额外接受权限为 `0660` 的凭据文件；其他平台保留上游权限检查。创建文件仍请求 `0600`。

本体不增加固定 Web token、自定义 WebSocket 分片、设置路径弹窗或对话标题栏工厂。源码工作区版本保留 `0.2.2-rc.3`，外层运行包记录适配修订。鸿蒙发行包发布在 [oheco/deepseek-harness](https://github.com/oheco/deepseek-harness/releases/tag/v0.2.2-rc.3-ohos.1)，通过 [oheco 软件目录](https://oheco.org/)安装。

## 本地使用

需要 Node.js `>=24.9.0`、带 termios 的 Python 3，以及 `release.json` 中固定的依赖。通过构建归档准备独立安装：

```sh
python3 ohos/install-local.py --archive <runtime.tgz> --dependencies-source <adapted-node_modules> --output <new-private-directory>
<new-private-directory>/package/bin/dsh --version
<new-private-directory>/package/bin/dsh web --host 127.0.0.1 --port 0 --no-open
```

启动器在用户显式覆盖之前加载[compat.patch.yml](compat.patch.yml)。该部署配置禁用 HMR、遥测，并把已有 Gateway 心跳间隔设为 60 秒。启动器默认 `DSH_PERMISSION_MODE=danger-full-access`，保留显式环境值。鸿蒙没有受支持的进程隔离后端，显式请求隔离会失败。官方组合源码保持不变。

默认 harness home 仍为 `~/.dsh`。共享 HOME 中凭据表现为 `0660`，本移植接受该权限；也可以用 `DSH_HOME` 选择应用私有目录。共享 HOME 无法落实私有 chmod 权限。临时文件使用 `$TMPDIR`，缓存和可执行构建工具使用 `$XDG_CACHE_HOME`。

App 源码复制自上一版最新修订，版本见[app-release.json](app-release.json)。其本地启动器和 broker SDK 保持原样，包含已有的文档开始时 ArkWeb URL 兼容注入。[App 参考](app/README.zh.md)描述这些功能。源码复制不代表新的设备安装或验收结果。

## 构建

固定工具归档、源码输入、摘要和许可证保留在 `tpr/ohos-build-tools`。构建复用上游 Host/Client 库步骤和 Web 构建，排除 Electron Desktop。原生扩展及类型感知 lint 后端在鸿蒙上构建或准备并签名。先通过配置的代理预取注册中心输入，再以 copy 模式冻结离线安装。

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store <prepared-pnpm-store> --output <fresh-build>
python3 ohos/package.py --deployment <fresh-build>/deployment --output <fresh-package>
```

构建前审核更新后的锁文件及 `release.json` 中的摘要。生成产物后运行 `build:check`。[LOCAL-VALIDATION.md](LOCAL-VALIDATION.md)只记录本修订实际执行的检查，上一版证据不作为本次通过结果。

## 限制

持久终端无法精确检测 Linux syscall 级的等待输入状态；原生实现保留前台进程组检查和 PID 身份保护。系统 zsh 的交互会话执行 `exec` 替换时会结束，终端会报告退出，下一次调用重建 shell。需要保留持久状态时应直接执行命令。会话及附件通过原子禁止替换操作发布，不要求共享 HOME 支持硬链接。

上游 LibreOffice Kit `0.2.3` 能在鸿蒙发现 WASM 后端，但没有原生预览。本次本地移植尚未验收实际文档转换。本移植不实现 Office 引擎，也不增加 Office UI 替代方案。独立浏览器的 ArkWeb 行为不在 App URL 注入修复范围内。外部插件需要适配上游宿主 API，旧私有标题栏工厂不会恢复。
