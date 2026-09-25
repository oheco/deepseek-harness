# 0.1.7-rc.2 鸿蒙 Web 本地验证记录

## 范围与基线

- 上游：`dsh-v0.1.7-rc.2`，`477b4f420553e8a52c2fbccc464d7561b239c443`；选择时 GitHub 最新已发布 0.1.7 版本为 RC.2。
- 本地目录：`/storage/Users/currentUser/dev/ohos/deepseek-harness-0.1.7`；分支：`ohos/0.1.7-rc.2`。
- 本地包版本：`0.1.7-rc.2-ohos.1`，**未发布**；没有推送、标签、Release、软件目录更新或现有安装替换。
- 仅 CLI/Web，不迁移上游桌面应用或 0.1.5 的鸿蒙 App，不写 `export/DSHApp`。
- 旧适配参考范围为 `c291e7961a..79bc906508`，不是旧版标签到分支的全部差异；新版上游代码保持为基础。

## 本机环境与固定输入

验证在鸿蒙 ARM64 本机执行，Node `24.21.0`（`process.platform=openharmony`）、Python `3.14.7`（`sys.platform=ohos`）、pnpm `11.7.0`、`/usr/bin/zsh`，使用本机 clang 和 `binary-sign-tool` 构建、签名 flock 扩展。

- 源码锁 SHA-256：`7aad51aef46df07f8a26432f09e858a2d92193f6b53cb04ea411ce5811780d97`。
- 上游 registry package resolutions 和 snapshots 与发布标签逐项一致，新增内容仅为鸿蒙工作区链接和复用的 Koffi 依赖。
- `prepare-runtime.py` 生成 285 个目标平台工作区包，排除其他平台的原生包和桌面应用；本地发行布局包含 573 个运行包记录（含四个外置适配依赖）。
- `tpr/ohos-build-tools/SOURCES.json` 固定工具来源、校验与许可；归档校验通过，OHOS ELF 工具在私有副本中签名。
- node-pty、Koffi、sharp、ripgrep 使用 `release.json` 中已适配的固定版本。`local-dependencies.py` 只读复制已有安装到隔离副本，记录文件树哈希；pnpm 自动生成的 `.bin` 便利入口不计入该树哈希。
- 新依赖经已配置代理获取；正式构建输入准备后，安装和生产部署均使用 offline/frozen/copy 模式。

## 已完成适配

1. 保留旧版 zsh 执行、持久终端、procfs 进程识别及模型工具说明；接入新版生命周期和配置接口。
2. flock 新增 OpenHarmony ARM64 平台包；编译/签名在 `$TMPDIR`，复制到目标目录唯一 pending 文件后原子替换并清理。
3. 文件新建、会话代际发布和附件发布使用 `renameat2(RENAME_NOREPLACE)`，不依赖共享用户目录不支持的硬链接，不覆盖已有目标。
4. 附件别名经私有 staging、摘要验证、同步后原子发布；只在鸿蒙不可遍历祖先目录的 open 权限边界停止向上同步，不吞实际 fsync 失败。
5. 保留显式权限配置；鸿蒙默认完整访问且关闭审批，显式沙箱请求仍失败，不静默降级。
6. Web 资源地址解析不依赖 ArkWeb 对自定义 scheme authority 的处理；没有原生 opener 时显示并允许复制设置文件路径。
7. 新版 Host resolver 在鸿蒙通过启动器的 `--expose-internals` 加载 Node 内部模块，避免加载上游未提供的 `node-addon-require-builtin-openharmony-arm64`；缺 flag 明确失败，其他平台不变，不禁用 HMR。
8. 独立 `build:ohos` 执行 Host/Client/Web 构建及原版品牌，不运行桌面 bundle 步骤。

## 实际执行的验证

- 固定工具校验、签名与依赖 offline/frozen 安装通过。
- `pnpm run build:ohos` 完整通过：Host/Client TypeScript、tsdown、Web Vite，以及 343 个客户端制品的构建记录。随后对 Host resolver 修复执行 app-boot TypeScript 和两个 bundle 的定向重建。
- 原生模块定向测试 39 项通过；真实已签名 addon 的锁获取、竞争拒绝、关闭后重新获取通过。
- packages 定向测试 228 项通过：文件/附件/会话 128，资源 26，侧栏 29，设置 store 5、组件 14、controller 3，进程识别/终端配置 23；另有 3 个平台条件跳过。
- 真实 zsh/自定义解释器/沙箱包装/持久终端选定测试 5 项通过；过滤掉 91 个非本轮用例，不将其计作已通过。
- 新增 Host resolver 真实 Node 子进程测试 2 项通过：带 flag 的安装、解析和卸载；无 flag 的明确拒绝。
- 锁文件生成幂等，YAML 可解析，上游 registry resolutions/snapshots 无漂移；Python 脚本语法、启动器 zsh 语法及差异空白检查通过。
- 原生模块与所修改 packages 的双语配对记录由各定向子任务检查通过；未运行全仓文档门禁。

运行包从本地 tgz 解压到 `$TMPDIR` 下的隔离目录，补入只读复制的固定依赖后执行；验收场景使用包含空格的工作目录：

```sh
python3 ohos/acceptance.py --dsh "$private/package/bin/dsh" --tmp-parent "$private" --logs <日志目录>
```

五项全部通过：

| 场景 | 验证内容 |
| --- | --- |
| headless | 真实 shipped profile、本地 Messages 模型往返、zsh 数组、写文件、日志持久化、退出 |
| search | glob 和 ripgrep 搜索实际文件，并将结果返回模型 |
| ptc | Node PTC 中调用 shell，验证实际文件效果及持久化的 PTC 事件 |
| persistent | 变量/数组/工作目录跨调用保留、退出码 7、shell 退出与重置 |
| web | 随机端口启动、鉴权 Cookie、原版标题、实际 JS 资源请求、设置文件路径回退、打包资源插件解析、进程关闭 |

验收模型按 0.1.7 的 DeepSeek Messages API 发送/接收事件，不再使用 0.1.5 的 Chat Completions fixture。它只模拟远端模型，工具、文件、会话、Web 服务和进程均真实运行。

## 发现并解决的失败

- pnpm SOCKS 环境代理请求失败：改用同一配置代理已验证可用的 HTTP CONNECT；大包超时后使用已有缓存完成下载。
- pnpm 重新解析缺少 offline metadata：仅生成平台 workspace links，并验证 registry resolutions/snapshots 不变；随后 frozen 安装通过。
- pnpm 再次安装重接到未签名原生工具：重新接入校验并签名的私有工具副本，实际 zsh 测试通过。
- 新版 Host 强制加载未提供的鸿蒙 require-builtin addon：新增显式 `--expose-internals` 接入，实际 Web 启动通过。
- 旧验收 fixture 使用 Chat Completions 格式：按新版 Messages 协议更新后五项验收全部通过。

## 未验证与限制

- 未调用真实远端模型提供商；新测试配置独立，不复制原来的凭据或会话。
- 未进行实际浏览器/ArkWeb 人工操作，不把 HTTP 与 bundle probe 当作视觉、剪贴板、附件上传 UI 或完整 HMR 热更新交互验收。
- 未运行全仓回归。完整 settings-controller 源码测试中 6 个依赖 HMR internal loader 的既有 fixture 在 Vitest 环境未通过；新增路径回退用例和真实打包 Web 对应接口均通过，不将这 6 项计入通过数。
- 持久终端不能精确识别“等待 stdin”；sharp 为 WASM，格式能力不同于原生 libvips；原生系统浏览器/编辑器启动未适配。
- GitHub native matrix 没有鸿蒙 runner，保留 fail-closed；本轮不扩展 CI 或开展正式发布。
- 编译产物最初来自本轮工作树，后续已整理成本地提交。包内 `build-info.json` 记录打包提交，`native_build` 保留实际构建阶段记录；这不是正式发布门禁完成声明。

日志及本地运行包位于相邻 `harness-ohos-0.1.7-local/`。验收临时目录和子进程均由脚本清理；未替换或停止原有 9000 服务。
