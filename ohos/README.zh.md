# 鸿蒙 Web 移植 — 0.1.7-rc.2

[English](README.md) | 中文

## 范围

适配目标为鸿蒙 PC ARM64，上游标签 `dsh-v0.1.7-rc.2`，提交 `477b4f420553e8a52c2fbccc464d7561b239c443`，适配分支 `ohos/0.1.7-rc.2`。运行包提供 CLI/Web，不包含上游桌面应用。另行导出的[鸿蒙 App 工程](app/README.zh.md)已迁入 0.1.5 完成的封装功能，并启动已安装的 `dsh`；App 工程不嵌入 npm 包。发行制品及其验证记录在 GitHub Release 中，本文档描述构建与移植本身。

旧版移植仅作参考。必须使用独立的应用私有 `DSH_HOME`，不能用已有 0.1.5 会话测试新版存储格式。验收不使用现有 9000 端口服务。

## 构建

直接在鸿蒙上构建，准备 Node.js 24、Python 3、Node 开发头文件、SDK Clang，并确保 `binary-sign-tool` 在 `PATH`。固定构建工具归档、校验值及许可位于 `tpr/ohos-build-tools`，其中包含 pnpm，无需全局安装。先通过配置的代理准备依赖，再离线构建。

`prepare-runtime.py` 从新版上游预设依赖、工作区依赖及必需 peer 生成 Web/CLI 部署闭包，不复制旧版闭包。清单变更后重新生成闭包与锁文件；`update-workspace-lock.py` 仅补充鸿蒙工作区链接，复用既有 Koffi 版本，不重新解析上游注册中心版本。审核锁文件后，在 `release.json` 记录 SHA-256。

```sh
python3 ohos/prepare-runtime.py
python3 ohos/update-workspace-lock.py
python3 ohos/build.py --store /absolute/private/prepared-store --output /absolute/private/fresh-build
python3 ohos/package.py --deployment /absolute/private/fresh-build/deployment --output /absolute/private/local-package
```

构建使用全新依赖安装、离线冻结锁文件、copy 模式和上游 `official` 品牌，不执行桌面应用打包步骤。临时文件位于 `$TMPDIR` 并在结束时清理。生成本地运行包不等于发布。

## 运行与验证

运行包依赖 `release.json` 固定的鸿蒙版 node-pty、Koffi、sharp、ripgrep，它们不是上游 Linux 二进制。sharp 使用 WASM。system flock 扩展从本目录源码在鸿蒙编译并签名。应使用生成的 `bin/dsh` 启动器，它向鸿蒙 Node 传入 `--expose-internals`。

```sh
python3 ohos/acceptance.py --dsh /absolute/local-package/package/bin/dsh --tmp-parent "$TMPDIR" --logs /absolute/local-validation-logs
```

验收使用一次性应用私有数据、本地确定性模型服务与随机 Web 端口，不代表真实模型提供商或浏览器/WebView 渲染已验证。实际执行结果及准确命令在执行后写入 `LOCAL-VALIDATION.md`；旧版验收结果不能作为新版证据。

## 平台限制

Shell 工具使用 `/usr/bin/zsh` 而不是 bash。持久终端需要带 `termios` 的 Python 3，不能精确判断子进程是否正在等待标准输入。鸿蒙没有受支持的进程沙箱后端，因此平台默认仍为完整访问、关闭审批；显式请求沙箱时必须失败，不能静默退化为不受限制执行。共享用户文件系统不支持硬链接和私有 chmod 权限，凭据及会话状态必须放在应用私有存储。未提供原生应用打开器；设置文件无法外部打开时返回文件路径。
