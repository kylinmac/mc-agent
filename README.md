# mc-agent

面向工作室、OPC 和多项目开发用户的桌面 Agent，基于 **PI-Desktop（0.21.0）** Fork 持续演进，继承其多模型、工具、子代理与会话能力，并围绕多项目协作、工作面板工具、变更审阅与可视化草图沟通做深度增强。

- **支持平台**：macOS（Apple Silicon，固定证书签名 + 应用内自更新）与 Windows x64（NSIS 安装包 / Portable，应用内静默更新），安装包见 [GitHub Releases](https://github.com/kylinmac/mc-agent/releases)。
- **当前状态**：已进入持续开发与发版阶段（R1–R38 已合入 `main`），安装版使用独立数据目录 `~/.mc-agent`，与上游 PI-Desktop 隔离。

## 核心增强

- **多项目工作区与两列外壳**：平等工作区与项目资料目录（`MC-ADR-0003`）、极简两列外壳与底部导航（`MC-ADR-0029`）、项目组标签拖拽与滚轮横向滑动、并列分栏对话（`MC-ADR-0007`）。
- **工作面板与双向画布**：集成终端与后台命令唤醒（`MC-ADR-0005`、`MC-ADR-0006`）、HTML 原型画布（`MC-ADR-0024`）与离线 Excalidraw 白板双模式并存（`MC-ADR-0030`），支持手绘／贴图、HTML 画板送入白板圈画及 Agent 读写共创。
- **并行审阅与运维能力**：跨项目待处理聚合流、Diff 行级气泡攒批批注与文件级「已阅」进度（`MC-ADR-0029`）、内置电脑操作插件（macOS / Windows，`MC-ADR-0014`）、系统提示词模板、用量统计与语音输入。

## 文档入口

从 [mc-agent 文档导航](docs/mc-agent/README.md) 开始：

1. [需求文档](docs/mc-agent/requirements.md) — 已确认需求（R1–R38）与待评审提案（X）。
2. [架构文档](docs/mc-agent/architecture.md) 与 [现状架构](docs/mc-agent/as-built-architecture.md) — 进程边界与模块扩展点。
3. [功能代码索引](docs/mc-agent/code-index.md) — 功能到源码目录的快速对照。
4. [验收与开发计划](docs/mc-agent/validation-plan.md) — 各需求（V 编号）的实际验证记录与范围。

[MC-ADR-0002](docs/mc-agent/adr/mc-0002-fork-pi-desktop.md) 是当前 Fork 架构决定；上游 PI-Desktop 的原说明见 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)，`README.zh-CN.md` 保留为上游原文。
