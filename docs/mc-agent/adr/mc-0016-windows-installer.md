# MC-ADR-0016: Windows 安装界面与静默更新

**Status:** Accepted
**Date:** 2026-10-22
**Deciders:** 产品负责人

## 背景

R15 要求重做整个安装页面，使用与应用一致的暗色设计；更新只需点击“重启并更新”，不再重复操作安装向导。仅给 NSIS 向导更换插图不满足要求。

## 决定

- 首次安装使用独立 WPF 界面，源码放 `apps/windows-installer/`。复用 Windows 自带 .NET Framework，不下载额外 UI 运行时，不引入网页、远端内容或 Node 权限桥。
- 安装、进行中、完成、失败在同一窗口切换；原生窗口保留拖动、最小化、键盘操作，标题栏采用暗色。主体沿用应用的灰阶、字号和圆角。
- `mc-agent-Setup-<版本>.exe` 内嵌同版本 NSIS 载荷，释放后校验 SHA-512，再用绝对路径直接启动；不经过 shell。首次安装默认为当前用户，可选本机目录；已有安装从本应用精确注册表键读取路径，不迁移目录或用户范围。
- `mc-agent-Update-<版本>.exe` 是 NSIS 载荷，也是 `latest.yml` 和 blockmap 的唯一更新目标。首次安装界面不参与日常更新；Windows 调用 `quitAndInstall(true, true)`，静默安装并强制重新启动。校验和、签名策略、退出时的子进程清理沿用现有实现。
- 保持 appId 不变，因此旧 NSIS 注册信息可继续使用。便携版默认仍为手动更新；保留用户明确选择的更新偏好。macOS 不变。
- 正式 Setup 不包含测试驱动入口；集成测试单独编译 `INSTALLER_TEST`，使用随机应用 ID、专用目录和无业务数据的 .NET 程序。

## 边界

- 尚无 Windows 代码签名证书；本次不关闭系统安全校验。取得证书后 Setup 和 NSIS 载荷都需要签名。
- 安装目录是可替换的程序文件，不应存放用户数据。mc-agent 的用户数据仍在独立的 `~/.mc-agent`。
- 不承诺 NSIS 在断电或进程被强制终止时提供事务式回滚；错误显示与重试保留。真实应用版本升级和全机器安装提权需发布前继续验证。

## 关联

[需求 R15](../requirements.md)、[原型 P10](../prototype.md)、[验证 V50](../validation-plan.md)、[安装与更新说明](../windows-install-update.md)。
