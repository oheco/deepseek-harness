# Agent Note：鸿蒙上不使用硬链接的发布

Status: implemented

[English](2026-09-13-harmonyos-no-replace-publication.md) | 中文

## 问题

鸿蒙的应用文件系统以 `EPERM` 拒绝 `link(2)`。仍有两条已交付路径通过硬链接发布，因此它们在通过 `rename(2)` 的替换仍正常工作时失败：

- `dsh-fs-local` 的带防护创建（`createIfAbsent`，即 `write` 工具新建文件的路径）在每次新建文件时以原始 `EPERM` 失败。
- `dsh-attachment-local` 的对象与别名发布在每次保存图片、通用文件与已存储文件时以 `Unable to persist attachment.` 失败。

附件存储还通过把每个祖先目录 fsync 到文件系统根目录来证明 DSH_HOME 的持久性。鸿蒙把 `/storage` 与 `/storage/Users` 以仅可执行方式挂载（`drwx--x--x`），在那里 `open(directory, O_RDONLY)` 失败，因此任何附件都无法写入。

## 决策

`dsh-fs-local` 与 `dsh-attachment-local` 各自拥有私有的 `src/ohos.ts`，通过 Koffi 绑定 `renameat2(AT_FDCWD, source, AT_FDCWD, target, RENAME_NOREPLACE)`，与[鸿蒙运行时笔记](../architecture/2026-09-12-harmonyos-runtime.zh.md)中的 JSONL 发布决策一致。带防护的创建保留其不覆盖保证：目标已存在时报告 `EEXIST`，文件系统接缝把它映射为 `FS_NOT_OBSERVED`；附件存储则改为校验已有对象的摘要。不支持 `RENAME_NOREPLACE` 的文件系统会拒绝发布，绝不回退为覆盖或部分复制。

选择条件是 `internals.platform ?? process.platform === 'openharmony'`；其他主机继续使用 `link(2)`。两个包都把发布边界暴露为有文档的测试钩子，因此平台路径在每个宿主上都能被覆盖。

附件别名必须保留原对象，所以在鸿蒙上改为排他复制（`COPYFILE_EXCL`）并 fsync 复制出的 inode。这些字节是内容寻址且不可变的，因此复制在保留引用约定的同时会重复占用字节。

`ensureDurableHome` 在遇到本进程无法打开的第一个目录（`EACCES`/`EPERM`）时停止祖先遍历而不是失败。平台拥有的挂载点不会被本应用创建或删除，因此其下已同步的目录项就是边界；附件根内的发布目录仍保持严格遍历。

## 备选方案

**先占位再改名。** 用 `open(target, 'wx')` 再 `rename` 无需新依赖，但读取方可能观察到空的占位文件，且写入相同内容的并发方随后可能摘要校验失败。`RENAME_NOREPLACE` 在没有该窗口的情况下发布完整字节。

**用 `COPYFILE_EXCL` 复制暂存文件。** 它同样存在读取窗口，且无法消耗暂存名，因此对象发布仍需要一次移动。

**在鸿蒙上用符号链接做别名。** 符号链接会改变消费方与信任检查观察到的目录项类型；复制则保持普通只读文件。

**在鸿蒙上跳过祖先遍历。** 该遍历还要证明 DSH_HOME 在并发创建者之后仍然持久；只丢弃平台拥有的前缀。

## 后果

`write` 与 `str_replace_editor` 的新建文件、附件与已存储文件的保存都能在鸿蒙上工作，且并发创建者仍会被拒绝。通用已存储文件在那里每个名字占用一份副本，而不是共享同一个对象 inode。`dsh-attachment-local` 把 `koffi` 声明为运行时依赖，因此 `ohos/release.json` 中已审查的锁文件固定值随之更新。鸿蒙上的持久性证明止于第一个平台拥有的祖先，而非文件系统根目录。鸿蒙应用文件系统不强制执行 POSIX 权限位，因此仅所有者可访问的暂存权限与只读对象权限仍是由应用沙箱支撑的约定，而非由文件系统强制。
