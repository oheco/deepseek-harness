# 鸿蒙 ARM64 系统绑定

[English](README.md) | 中文

为鸿蒙 PC ARM64 提供已签名的 Node-API v8 `flock` 绑定。调用方持有文件描述符，关闭描述符即释放锁。此包不包含 Landlock 启动器。在鸿蒙的仓库根目录执行 `node native/system/scripts/build.ts --host-addon-only`，并确保 PATH 中有 `binary-sign-tool`。
