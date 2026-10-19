# mc-agent 文档导航

当前方向已确定：**Fork PI-Desktop，继承 Agent 能力，重点完善项目文档、资源与开发任务管理。** 已进入开发阶段，R1–R11 已合入 `main`。

## 阅读顺序

| 顺序 | 文档 | 阅读重点 |
|---|---|---|
| 1 | [功能与项目管理缺口](pi-desktop-analysis.md) | 上游已有多少、真正缺什么、证据和限制 |
| 2 | [需求文档](requirements.md) | 已确认定位、继承能力、新增需求 R1–R11（首版 R1–R5、R10；界面 R11） |
| 3 | [架构文档](architecture.md) | 沿用哪些模块，项目管理在哪里扩展 |
| 4 | [现状架构](as-built-architecture.md) | 仓库里已有代码的进程和边界 |
| 5 | [功能代码索引](code-index.md) | 功能到目录的对照，末尾两节是 mc-agent 新增代码 |

## 评审时再看

| 文档 | 用途 |
|---|---|
| [流程与原型](prototype.md) | 看项目概览、资料、任务和验收是否符合习惯 |
| [协议与数据](protocol-data.md) | 确认资料版本、项目身份、会话关联与恢复规则 |
| [验收与开发计划](validation-plan.md) | 先验证继承能力，再验证新增闭环 |
| [决策清单](decisions.md) | 集中处理待确认问题 |
| [M1 基线记录](m1-baseline.md) | 构建、冒烟和 B1–B8 实测结果 |
| [MC-ADR-0005](adr/mc-0005-work-panel-terminal-and-tools.md) | 工作面板终端与工具栏 |
| [MC-ADR-0006](adr/mc-0006-background-commands.md) | 后台命令与后台任务面板 |
| [MC-ADR-0004](adr/mc-0004-app-rail-and-title-tabs.md) | 左侧竖栏、顶部标签栏与设置标签 |
| [MC-ADR-0003](adr/mc-0003-equal-workspaces-and-project-home.md) | 多工作区平等与项目资料目录 |
| [MC-ADR-0002](adr/mc-0002-fork-pi-desktop.md) | 当前 Fork 架构决定 |
| [MC-ADR-0001](adr/mc-0001-chatgpt-architecture-pi-kernel.md) | 已被替代的历史方案 |

## 还缺什么

- 样例项目已就绪：`examples/fixtures/mc-agent/`，用于 S1–S3。
- 技术细节：见[决策清单](decisions.md)中未标“已定”的条目，各阶段编码前定。

产品范围已于 2026-10-14 确认：首版 R1–R4（+R5），第二阶段 R6–R9。编号规则见[需求文档](requirements.md)第 5 节：B 继承能力、R 已确认需求、X 待评审提案。

## 状态约定

- 已确定：用户确认的方向或当前 Accepted ADR。
- 源码确认：存在实现路径，尚不等于运行验证通过。
- 建议／待评审：本轮提出的需求与设计，未冻结。
- 未验证：尚未构建、运行、登录或执行测试。

需求 R（继承能力 B）、页面 P、验收 V 编号互相对应。方案更新时同步需求、原型、数据与验收；避免把上游已有能力重新列为待开发。

## 进入开发前

- [x] 确认首版新增范围和原型。
- [x] 确认数据归属、版本、权限、删除及失败恢复。
- [x] 选定正式基线及模型／登录验证范围（M1 基线；实测模型 grok-4.7）。
- [x] 每项需求都有验收用例。
- [x] 用户明确进入开发阶段。

Fork 已建立：`origin` 为 kylinmac/mc-agent，`upstream` 为 vastsa/PI-Desktop。R1–R11 已合入 `main`，验证状态见[验收与开发计划](validation-plan.md)第 2.1 节。

## 放在哪

mc-agent 自己的文档都在 `docs/mc-agent/`，ADR 用 `MC-ADR-` 编号放 `docs/mc-agent/adr/`。`docs/` 其余内容（spec、adr、guide、zh-CN 和 VitePress 站点）属于上游，原样保留，便于同步。
