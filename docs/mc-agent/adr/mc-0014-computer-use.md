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
4. **工具与返回。** 十个工具（权限、列应用、取状态、点击、拖动、输入、按键、滚动、设值、动作）。元素按深度优先编号；截图按像素坐标，程序换算到屏幕坐标；动作后默认等界面稳定再返回新状态。截图作为 MCP image 内容返回，模型直接看到。
5. **权限。** MCP 工具在宿主里一律中风险（插件运行时既有规则，不放宽），每次调用经权限卡片，用户可按会话放行。系统权限缺失时返回说明；`computer_permissions` 可请求授权。高风险操作的先问规则写在技能里。
6. **打包。** macOS 构建先编译 `mc-computer --release`，electron-builder 把它放进插件的 `bin/`。开发时由 `scripts/build-mc-computer.mjs` 编译并复制。

## 影响

- 改动上游：`Cargo.toml`（工作区成员）、`apps/desktop/package.json`（打包资源、构建脚本）。
- 新增：`crates/mc-computer`、`apps/desktop/resources/plugins/mc.computer-use`、`scripts/build-mc-computer.mjs`。

## 暂未做

- Windows 后端实现。
- 只读工具（列应用、取状态）免确认：需要给“内置插件的 MCP 工具”单独定风险，涉及安全边界，另行决定。
- 后台观察 / 记忆、锁屏接管、虚拟光标、按应用操作手册。

## 重访条件

- Windows 分析完成、开始实现后端时。
- 上游插件运行时提供按工具声明风险的 MCP 通道时，评估放开只读工具。
