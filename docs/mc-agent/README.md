# mc-agent 文档导航

[R17 语音输入：配置、行为与验证范围](voice-input.md)（P13；V54）。

[订阅剩余额度：来源、约束与验证范围](subscription-quota.md)。

当前方向已确定：**Fork PI-Desktop，继承 Agent 能力，重点完善项目文档、资源与开发任务管理。** 已进入开发阶段：R1–R12 已合入 `main`，R13、R14 等 2026-10-22 转正的需求代码已完成、待发版。需求是否确认、代码是否合入、是否验收通过分别记录，见[需求文档](requirements.md)和[验收与开发计划](validation-plan.md)第 2.1 节。

## 阅读顺序

| 顺序 | 文档 | 阅读重点 |
|---|---|---|
| 1 | [功能与项目管理缺口](pi-desktop-analysis.md) | 上游已有多少、真正缺什么、证据和限制 |
| 2 | [需求文档](requirements.md) | 已确认定位、继承能力、新增需求 R1–R14（首版 R1–R5、R10；界面 R11；电脑操作 R12；创作存储与模板 R13；系统权限 R14） |
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
| [新增功能工程结构评审](engineering-structure-review.md) | 契约与模块整理、目录位置、核心概念边界；2026-10-22 已按文档实施，各条结果见第 10 节 |
| [2026-10-30 整体代码复查](project-review-2026-10-30.md) | 数据迁移、记忆并发、权限、会话生命周期与界面异步状态；记录修复和验证边界 |
| [会话压缩与配置生效提示](compaction-performance.md) | R20：摘要保真与篇幅、推理策略、静默超时及进度、努力程度待生效提示；V59 |
| [压缩后的上下文恢复](compaction-context-restore.md) | X-COMPACT-01～03：回查压缩前原文、附回最近文件内容、摘要复用提示词缓存（计划，待评审） |
| [创作工作台方案](creative-studio.md) | 生图、生视频的入口、布局和分期（一期已实现） |
| [原型画布方案](prototype-canvas.md) | R18 原型画布：Agent 在会话工作面板里画 HTML 原型，人看、试交互、评论与 @Agent，视图上下文（A 档已实现）；B 档原型跳转与导出、C 档所见即所得编辑（待评审） |
| [macOS 权限归属与授权体验](macos-permissions.md) | 权限调用进程、签名身份、分步授权、复检；2026-10-22 已实施，结果见第 9 节 |
| [电脑操作方案](computer-use.md) | 内置 Computer Use 插件：macOS 与 Windows 后端、权限及验证边界 |
| [Windows 安装与更新](windows-install-update.md) | R15：暗色单页安装、后台下载、原目录静默更新 |
| [更新说明流程](release-notes.md) | PR 模板「更新说明」、多个 PR 汇总成一个版本条目、发布门禁 |
| [M1 基线记录](m1-baseline.md) | 构建、冒烟和 B1–B8 实测结果 |
 | [问题记录](bugs.md) | 开发阶段缺陷，编号 B，不占用 R / X |
| [MC-ADR-0005](adr/mc-0005-work-panel-terminal-and-tools.md) | 工作面板终端与工具栏 |
| [MC-ADR-0006](adr/mc-0006-background-commands.md) | 后台命令与后台任务面板 |
| [MC-ADR-0022](adr/mc-0022-forked-subagents.md) | 继承对话上下文的子代理（fork） |
| [MC-ADR-0021](adr/mc-0021-user-hooks.md) | 用户钩子 |
| [MC-ADR-0020](adr/mc-0020-auto-mode-guard.md) | 全自动模式下仍要询问的命令 |
| [MC-ADR-0019](adr/mc-0019-agent-memory-notes.md) | Agent 自己记到项目记忆 |
| [MC-ADR-0018](adr/mc-0018-background-command-wake.md) | 后台命令结束时通知 Agent |
| [MC-ADR-0007](adr/mc-0007-split-view.md) | 并列对话（分栏） |
| [MC-ADR-0008](adr/mc-0008-installed-identity.md) | 安装版使用独立身份 |
| [MC-ADR-0009](adr/mc-0009-import-from-other-agents.md) | 从其他智能体导入项目和对话 |
| [MC-ADR-0010](adr/mc-0010-system-prompt-templates.md) | 系统提示词查看与模板 |
| [MC-ADR-0011](adr/mc-0011-usage-statistics.md) | 用量统计 |
| [MC-ADR-0012](adr/mc-0012-releases-and-updates.md) | 发布到 GitHub Releases 与更新提醒 |
| [MC-ADR-0017](adr/mc-0017-post-update-whats-new.md) | 更新后的“更新内容”与版本更新说明 |
| [MC-ADR-0013](adr/mc-0013-creative-studio.md) | 创作工作台（一期：图片） |
| [MC-ADR-0024](adr/mc-0024-prototype-canvas.md) | 原型画布（A 档） |
| [MC-ADR-0014](adr/mc-0014-computer-use.md) | 电脑操作（Computer Use）内置插件 |
| [MC-ADR-0015](adr/mc-0015-macos-permissions.md) | macOS 系统权限页与授权归属 |
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

Fork 已建立：`origin` 为 kylinmac/mc-agent，`upstream` 为 vastsa/PI-Desktop。R1–R12 已合入 `main`，验证状态见[验收与开发计划](validation-plan.md)第 2.1 节。

上游同步：2026-10-25 合入上游 0.21.0（到 `c099b6a4c`）。后台命令改为基于上游的后台任务注册表（[MC-ADR-0006](adr/mc-0006-background-commands.md)）；输入框灰字建议与插件建议共用一个位置，mc-agent 的下一句建议优先；上游侧栏底部的版本号和更新入口不合入（见 bugs.md B-013）。

## 放在哪

mc-agent 自己的文档都在 `docs/mc-agent/`，ADR 用 `MC-ADR-` 编号放 `docs/mc-agent/adr/`。`docs/` 其余内容（spec、adr、guide、zh-CN 和 VitePress 站点）属于上游，原样保留，便于同步。

[可选提问超时继续](question-auto-continue.md)（R19；P10；V58）。
