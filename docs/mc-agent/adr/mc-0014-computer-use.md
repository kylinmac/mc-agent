# MC-ADR-0014: 电脑操作（Computer Use）内置插件

**Status:** Accepted
**Date:** 2026-10-21
**Deciders:** 产品负责人

## 背景

需求 R12：让 Agent 操作本机桌面应用，参考 Codex 的 Computer Use，要求完全本地运行；先做 macOS，Windows 留扩展。方案见 [电脑操作方案](../computer-use.md)。

## 决定

1. **形态：内置插件。** `apps/desktop/resources/plugins/mc.computer-use`，manifest 声明一个本地 MCP 服务（`bin/mc-computer mcp`）和一份技能，默认关闭，在扩展页启用。走现有插件通道，不改插件契约，不在宿主里加专用代码。
2. **原生层：Rust 程序 `mc-computer`。** 新 crate `crates/mc-computer`，本身是 MCP stdio 服务。平台差异只在 `Backend` 接口之下：macOS 用 Accessibility（AXUIElement）、CGEvent 和系统自带的 `screencapture` / `sips`；Windows 实现同一接口（UI Automation、SendInput、Graphics Capture）。不复用、不修改 OpenAI 的二进制，不照抄其提示词原文。
3. **完全本地。** 程序不发网络请求，没有远程开关、遥测、登录校验、云端 URL 判定和自动更新。依赖只用系统框架和工作区已有的 crate。
4. **工具与返回。** 十一个工具（权限、列应用、取状态、点击、拖动、输入、按键、滚动、设值、动作、批量 `run`）。元素按深度优先编号；状态默认只有文字，首次全树、之后只给相对上次的变化；截图按需取（JPEG），按截图像素坐标操作，程序换算到屏幕坐标；动作后等界面稳定再返回变化。（2026-10-21 修订，见下。）
5. **权限。** 插件 MCP 工具默认中风险，每次调用经权限卡片，用户可按会话放行。应用自带的插件可以用 manifest 的 `mcpServers[].toolRisk` 给自己的工具定风险；本插件把只读的 `permissions`、`list_apps`、`get_app_state` 定为低风险。系统权限缺失时返回说明；`permissions` 可请求授权。高风险操作的先问规则写在技能里。
6. **打包。** macOS 构建先编译 `mc-computer --release`，electron-builder 把它放进插件的 `bin/`。开发时由 `scripts/build-mc-computer.mjs` 编译并复制。

## 影响

- 改动上游：`Cargo.toml`（工作区成员）、`apps/desktop/package.json`（打包资源、构建脚本）、插件运行时注册 MCP 工具时的风险（`mcpToolRisk`）、插件 SDK 的 `PluginMcpServerContrib.toolRisk` 与校验、`host-process.ts` 导出内置插件目录。
- 新增：`crates/mc-computer`、`apps/desktop/resources/plugins/mc.computer-use`、`scripts/build-mc-computer.mjs`。

## 暂未做

- Windows 后端实现。
- 后台观察 / 记忆、锁屏接管、虚拟光标、按应用操作手册。

## 重访条件

- Windows 分析完成、开始实现后端时。
- 上游插件运行时提供按工具声明风险的 MCP 通道时，改用上游机制。

## 修订（2026-10-21）：效率对齐 Codex

用户实测效率远低于 Codex。分析 Codex 的 JS 层和会话记录（[行为分析](../computer-use-codex-analysis.md)）后结论是：Codex 单步并不快，快在少往返（一段脚本做多步）、少返回（默认只回 diff、截图按需）和少确认。据此改为：

- 新增 `run`，一次做多步、读一次状态；
- 状态默认只返回变化，截图默认不带、改用 JPEG；
- 元素行改成简短英文角色名加括号状态，过滤掉无用的动作名；
- 元素属性批量读取；动作后按“两次读取一致”判断稳定；
- 屏幕锁定时直接说明（锁屏下 macOS 把每个窗口都当成应用本身返回，曾产生上万行重复元素）；
- 读取类工具定为低风险。安全边界：只认从应用自带插件目录加载、非开发模式的插件，别处安装的插件声明了也无效，动作类工具仍需确认。
