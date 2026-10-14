# mc-agent

面向工作室、OPC 和多项目开发用户的桌面 Agent。当前方向是 **Fork PI-Desktop 二次开发**，继承其 Agent、模型、工具和会话能力，重点改善项目文档、资源与开发任务管理。

首发平台：macOS。接受开源方向。当前阶段只分析和完善文档，尚未开发。

## 文档

从 [文档导航](docs/mc-agent/README.md) 开始，优先阅读：

1. [PI-Desktop 功能与项目管理缺口](docs/mc-agent/pi-desktop-analysis.md)。
2. [需求文档](docs/mc-agent/requirements.md)。
3. [架构文档](docs/mc-agent/architecture.md)。

[MC-ADR-0002](docs/mc-agent/adr/mc-0002-fork-pi-desktop.md) 是当前架构决定；MC-ADR-0001 保留为已被替代的历史方案。

当前仓库已包含 PI-Desktop 0.20.1 源码。规划增量仍以 MC-ADR-0002 为准；已有代码的地图见 [现状架构](docs/mc-agent/as-built-architecture.md) 和 [功能代码索引](docs/mc-agent/code-index.md)。

上游 PI-Desktop 的原说明见 [vastsa/PI-Desktop](https://github.com/vastsa/PI-Desktop)；`README.zh-CN.md` 仍是上游内容。
