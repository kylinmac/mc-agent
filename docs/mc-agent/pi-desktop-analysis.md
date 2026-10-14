# PI Desktop 功能与项目管理缺口分析

结论：采用 Fork 二次开发方向，复用已有 Agent 和桌面工作台；新增重点是让项目文档、资源、开发任务与验收结果建立可追溯关系。无需重建模型接入、工具执行、会话系统或项目分组。

## 1 分析基线与可信度

- 分析日期：2026-10-14。
- 源码快照：[b59422c](https://github.com/vastsa/PI-Desktop/tree/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a)，主分支；根 package.json 版本为 0.20.1。它是分析基线，不是已经通过验收的发布基线。Fork 后本地 main 为 `a20a9ca`，比该基线多 2 个上游提交（9 个文件，只改 worktree 菜单文案与样式），不影响本文结论。
- 方法：阅读项目说明、规格及实际源码，重点核对项目 UI、IPC、Rust 数据层、Agent 上下文组装及相关测试。
- 未安装依赖、启动应用、连接模型或执行测试。表中“源码确认”表示存在实现路径，不等于功能验收通过。
- “缺口”指本次检索与阅读范围内，未找到能满足 mc-agent 需求的完整流程；不代表穷尽所有插件或上游后续版本。
- 分析时用的是临时只读源码快照。之后已建立 Fork（kylinmac/mc-agent），源码在本仓库；仍未修改业务代码或发布产品。

## 2 现有能力清单

| 能力 | 本次证据与边界 | mc-agent 处理 |
|---|---|---|
| 多模型及 API 配置 | provider 配置和绑定实现存在；需按服务逐项验证 | 继承，不另写模型适配层 |
| 账号登录 | Electron OAuth 桥接 pi-ai 登录及凭据存储；不是只支持 API Key | 继承；“Pi 全支持”仍需覆盖矩阵 |
| 对话、流式、停止、插话 | runtime 有 prompt、steer、abort、graceful stop；即时停止和完成当前批次后停止不同 | 保留既有语义 |
| 文件、命令及权限 | Rust Host 执行工具并管理权限，Node 负责模型循环 | 复用执行入口，不绕过权限 |
| Plan 与 Goal | 已有计划／目标提交、审批及执行路径 | 复用；产品验收不能等同执行审批 |
| 会话管理 | 会话、轮次、排队、搜索、分支及历史存储路径存在 | 保留，新增任务关联 |
| 多目录项目 | 项目组有 ID、主目录、其他目录、排序及历史兼容映射 | 复用项目组，不另造平行项目列表 |
| 项目入口 | ProjectsPage 与详情面板已有目录、分支、会话、重命名、归档等入口 | 扩展成项目工作台 |
| 项目记忆与指令 | 有可编辑记忆条目和项目组指令；启动会话时传给 Agent | 复用，补资料来源及版本关系 |
| 会话待办 | session_todo 按会话和位置保存；最多 50 项，最多一个进行中 | 保留为会话执行步骤，不当项目任务库 |
| 文件产物 | artifacts 按会话与路径记录 Write/Edit 等产物，重复修改更新同一记录 | 复用结果入口，补任务关联及验收信息 |
| 文件引用与预览 | 文件索引、引用解析、Work Panel 已有实现与规格 | 复用查看入口，补项目级资料目录 |
| MCP、Skills、插件、多 Agent | 文档、模块和测试入口存在；本次未逐项深入验证 | 保留上游，不列为从零建设 |
| 定时、远程、语音等 | 源码与入口存在；本轮非重点 | 不删除；暂不扩展或承诺全部已验收 |

核心证据：
- 模型与登录：[OAuth 桥接](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/apps/desktop/electron/main/oauth.ts)、[provider 绑定](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/packages/agent-runtime/src/provider-binding.ts)。
- 执行与模式：[runtime 规格](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/docs/spec/03-runtime/02-agent-runtime.md)、[架构规格](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/docs/spec/02-architecture/01-architecture.md)。
- 会话与项目：[数据库结构](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/db/schema.rs)、[项目组实现](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/db/project_groups.rs)、[项目页面](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/apps/desktop/src/pages/ProjectsPage.tsx)。
- 扩展功能：[根脚本和测试入口](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/package.json)。测试文件存在不能证明测试已通过。

## 3 项目管理已有到什么程度

### 项目是多个目录与会话的组织入口

项目组已能关联多个根目录并指定主目录，不能再把“一个项目支持多个目录”列为缺失功能。项目详情主要展示目录、分支与会话；其中“新建任务”打开的是会话流程，不能仅根据按钮文案认定已有独立的业务任务管理。

依据：[项目组模型](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/db/project_groups.rs)、[项目详情组件](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/apps/desktop/src/features/projects/ProjectDetailPanel.tsx)。

### 项目记忆已经会进入 Agent 上下文

记忆条目包含 ID、标题、内容；项目组还有单独指令。会话启动读取项目组上下文，再传给运行时。它解决“长期记住一些项目背景”，但当前条目本身未表达文档版本、批准状态或任务引用关系。

依据：[记忆模型](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/db/model.rs)、[上下文组装](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/apps/desktop/electron/main/runtime/session-launch.ts)、[记忆提示词边界](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/packages/agent-runtime/src/project-memory-prompt.ts)。

### 会话待办和产物记录已经存在

session_todo 的主键是会话加位置，是一轮工作过程的清单；不能直接承载跨会话、带固定 ID 与验收依据的项目任务。产物记录按会话与文件去重，不能单独承担资料版本或业务验收记录；会话删除还会级联删除这些产物索引。

依据：[待办与产物表](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/db/schema.rs)、[TodoWrite 处理](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/rpc/todos.rs)、[产物记录与删除测试](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/artifacts.rs)。

## 4 相对于你的定位还缺什么

以下是需求建议；优先级待你评审。P0 是建议首版新增，P1 是后续。

| 缺口 | 现有能力为何不足 | 最小补充 | 需求 |
|---|---|---|---|
| 项目总体状态 | 会话列表反映最近聊过什么，不能直接说明项目目标和阻塞 | 项目概览：目标、任务状态、待验收、待更新资料 | R9 P0 |
| 文档和资源目录 | 文件树、预览、记忆分散，未找到统一的类型与确认状态 | 登记现有文件／链接，标记需求、架构、原型、参考资料 | R10 P0 |
| 当前依据与变更提示 | 普通记忆和路径引用不记录批准时的内容版本 | 草稿／已确认／已废弃，记录确认哈希并提示外部修改 | R11 P0 |
| 跨会话开发任务 | TodoWrite 属于会话步骤；计划审批属于执行授权 | 独立任务 ID、目标、验收条件、资料和会话关联 | R12 P0 |
| 可核对的任务上下文 | 有通用项目背景，但未找到面向业务任务的依据版本清单 | 启动前预览将引用的资料，固定本次来源记录 | R13 P0 |
| 结果与验收闭环 | 工具成功或会话完成并不代表需求达成 | 关联产物和验证记录，先待验收，再由用户确认完成 | R14 P0 |
| 资料冲突与失效 | 文件可被外部编辑、移动、删除 | 重新读取时校验；失效可修复关联，不静默覆盖 | R15 P0 |
| 多项目资源统筹 | 已有项目组织，但未深入发现业务层排期或预算体系 | 跨项目汇总、里程碑、依赖、费用视图 | P1，按实际需要再加 |

检索范围：项目页面与组件、shared 类型、Host RPC 分发、db schema／kv 项目组存储、session_todo、artifacts、项目记忆注入；并搜索 project task、document registry、resource registry、milestone、kanban 等。未逐一检查第三方插件；上游 docs/project 等文件是上游自身开发文档，不应直接算成应用提供的文档管理功能。

## 5 建议首版闭环

导入已有项目 → 登记需求、架构与参考资源 → 确认作为依据的资料 → 创建带验收条件的任务 → 从任务启动上游会话 → 查看执行过程和产物 → 用户验收 → 更新任务状态。

先支持本地文件和链接登记、简单任务列表、显式选择上下文。暂不新增知识库向量检索、多人权限、自动排期或完整在线文档编辑器。已有上游功能继续保留。

## 6 二次开发位置与成本

| 层 | 复用位置 | 拟新增职责 |
|---|---|---|
| UI | ProjectsPage、features/projects、现有组件与 Work Panel | 项目概览、资料目录、任务与验收入口 |
| Electron | main/ipc/workspace-ipc、main/runtime/session-launch | 新入口路由、任务上下文传递 |
| Shared | protocol 与 types | 项目资料、任务、执行依据的类型及校验契约 |
| Rust Host | db、rpc、project_groups、artifacts | 元数据事务、关联校验、状态和权限边界 |
| Node runtime | agent-runtime 的既有上下文路径 | 消费选定资料，保留原循环和模型接入 |

Fork 的主要代价是持续合并上游，以及维护新增元数据与旧数据的兼容。新增功能集中在项目域，少改核心循环，避免大范围改名或目录重排。

## 7 已发现的文档漂移及选型风险

- 规格索引仍写 app 0.14.x／schema 16；实际 package.json 为 0.20.1，Rust db.rs 为 schema 24，shared/protocol.ts 的 schema 常量仍为 16。只能确认有版本表述不一致，不能据此断言运行时有故障。开发前核对消费者和升级行为。
- 当前项目上下文读取存在 best-effort 回退；新增“任务必需资料”不能沿用静默忽略，否则可能在依据缺失时继续执行。
- 原生 Pi 会话走 SessionManager，TodoWrite 明确拒绝 native-pi 会话。新增任务首版建议绑定 Desktop 托管会话，避免误以为所有会话共享同一种存储。
- 上游更新器有固定发布源；未来分发自己的应用前，应独立应用 ID、数据目录、更新源与签名，避免覆盖用户的 PI-Desktop。
- LGPL-3.0 已接受，但仍需核对依赖、素材、署名及分发包义务。

依据：[规格索引](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/docs/spec/README.md)、[实际 DB 版本](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/crates/host-core/src/db.rs)、[共享协议常量](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/packages/shared/src/protocol.ts)、[原生 Pi 会话](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/packages/agent-runtime/src/native-pi-session.ts)、[LICENSE](https://github.com/vastsa/PI-Desktop/blob/b59422c637d20cebab102a7e1c4bb0ab7b38eb5a/LICENSE)。

## 8 进入开发前的验证门槛

1. 锁定正式 Fork 的提交／发布版本，在 macOS 构建并完成基础 Agent 冒烟验证。
2. 列出继承功能与 API／登录覆盖矩阵，区分已通过、受账号限制、未测。
3. 用两个真实项目评审文档、任务、会话、产物关联是否够用。
4. 确认新增元数据存储、项目身份、资料版本与删除规则。
5. 再决定第一个实现阶段；本轮尚未进入上述运行验证。
