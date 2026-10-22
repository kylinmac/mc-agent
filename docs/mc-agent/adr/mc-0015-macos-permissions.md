# MC-ADR-0015: macOS 系统权限页与授权归属

**Status:** Accepted
**Date:** 2026-10-22
**Deciders:** 产品负责人

## 背景

电脑操作需要辅助功能和屏幕录制，语音需要麦克风。用户分不清该给哪个应用开、开完是否生效；开发版在系统设置里显示成上游的 PI-Desktop；ad-hoc 签名的安装包每次更新都会丢授权。分析与方案见 [macOS 权限归属与授权体验](../macos-permissions.md)。

## 决定

1. **在用的地方检查。** 辅助功能、屏幕录制由电脑操作 helper（`mc-computer`）自己检查，经插件已运行的 MCP 服务调用 `permissions`；麦克风由 Electron 检查。helper 没运行就报“未运行”，不为检查而启动它，也不另起探测进程。
2. **状态照实给。** helper 只知道允许或未允许；麦克风保留允许、拒绝、受限、未询问、未知。helper 出错、超时与“未授权”分开。
3. **一次一项，点了才问。** 检查不弹窗；“授权”只请求所选一项（辅助功能同时打开设置页，屏幕录制先弹系统提示，麦克风未询问时弹提示、已拒绝时打开设置页）。设置页地址和命令固定在 Main，渲染进程只能传一个固定的项目名。
4. **设置“系统权限”页。** 每项显示用途、状态、手动路径和按钮；显示授权对象（系统设置里的应用名和安装位置）、签名类型，诊断信息可展开；回到前台复检（限频，离开清理）。电脑操作插件详情有“检查权限”入口。系统授权与应用内工具审批分开说明。
5. **归属。** P0 检查：helper 位于 `Contents/Resources/plugins/mc.computer-use/bin/`，单独 ad-hoc 签名，整包 `codesign --verify --deep --strict` 通过，由主进程直接拉起（`shell: false`）；实测授权归在 mc-agent 上，所以不做独立辅助应用。
6. **发布与开发身份。** 发布脚本校验包内 helper 的存在、架构、签名和可运行；开发版改名 `mc-agent Dev`（见 MC-ADR-0008 修订）。

## 影响

- 新增：`electron/main/mc-macos-permissions.ts`、`ipc/mc-permissions-ipc.ts`、`features/settings/SystemPermissionsPage.tsx`、`packages/shared/src/types/mac-permissions.ts`；`mc-computer` 的 `permissions` 支持 `request_item`、`open_settings`，旧的 `request: true` 仍可用。
- 改动上游：`packages/shared/src/protocol.ts`（3 个通道）、`apps/desktop/package.json`（用途说明改为 mc-agent）、`scripts/dev-electron.mjs` 与其测试。

## 暂未做

- Developer ID 签名与公证：没有证书。ad-hoc 包每次更新仍需重新授权，页面会提示；有证书后授权才能跨版本保留。
- 授权生命周期（首次、拒绝、撤销、多副本、升级）的完整测试需要隔离账号或虚拟机，不在用户的机器上做。
- 语音失败提示里直接跳到权限页：上游测试固定了错误码映射，暂不改；麦克风状态与授权已在权限页。

## 重访条件

- 有开发者证书时：改为签名并公证，复测升级后授权是否保留。
- 正式签名后授权仍不能稳定归到 mc-agent 时，再评估独立命名的辅助应用（另立 ADR）。
