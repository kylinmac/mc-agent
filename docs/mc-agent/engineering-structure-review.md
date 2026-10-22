# 新增功能工程结构评审

**日期：** 2026-10-22  
**状态：** 2026-10-22 用户确认按本文建议实施，已完成；逐条结果见第 10 节。下文第 2–9 节保留评审时的原文，作为当时的依据。  
**范围：** mc-agent 新增的项目管理、创作工作台、并列对话、终端与后台命令、提示词、用量统计、更新和 Computer Use。评审基于 `7e0ea3fb0` 及当时工作区的未提交改动，按个人使用、单人维护、持续合并上游的场景判断。

## 1. 结论

需要局部整理：统一跨进程契约，提取已经被多个功能使用的能力，拆开职责混杂的模块。暂不新增通用框架，也不重新划分整个仓库。

新增功能总体保持 Renderer → Preload IPC → Electron Main → host-core / agent-runtime 的分层。主要结构压力集中在创作模块、会话保留能力和功能接线位置。

本文的“源码确认”只表示存在相应实现与依赖，不表示运行验证通过。第 2–5 节是结构整理建议，不是新增产品需求，也不新增 R／P／V 编号。第 7–8 节另行区分现有行为修正与 X-DIR／X-CONCEPT 待评审需求。若实施改变用户行为、数据语义或安全边界，须先同步需求、验收和必要的 ADR。

## 2. 优先整理

### 2.1 统一创作模块的跨进程契约

**优先级：高。**

源码确认：

- Renderer 在 [creative-types.ts](../../apps/desktop/src/features/creative/creative-types.ts) 定义完整 `CreativeJob` 和任务状态枚举。
- Main 在 [creative-generation.ts](../../apps/desktop/electron/main/creative/creative-generation.ts) 另定义一份 `CreativeJob`，状态使用 `string`。
- 公共 [api.ts](../../apps/desktop/src/lib/api.ts) 引用功能目录中的创作类型；`api.creative.call<T>(method: string, params)` 允许调用方自行声明返回类型。

影响：新增状态、视频字段或修改参数时，需要人工核对多份定义。拼错方法、漏参数或误写响应类型，可能无法在编译时发现。

建议：

1. 将素材、任务、状态、引用、生成请求等传输类型放入 `packages/shared`；界面专用状态仍留在功能目录。
2. 为现有 creative 方法建立请求／响应类型映射，让方法名决定参数和返回类型。
3. 保留现有 IPC 通道、方法白名单和运行时校验。类型声明不能替代边界校验。

不做：代码生成系统、通用 RPC 框架、Rust 与 TypeScript 全仓自动类型同步。

### 2.2 提取公共会话保留与加载能力

**优先级：高。**

源码确认：[StudioChat.tsx](../../apps/desktop/src/features/creative/StudioChat.tsx) 从分栏模块使用 `pinSessionPane` 和 `useColumnTranscript`；[mc-split-view.ts](../../apps/desktop/src/lib/mc-split-view.ts) 的 `isSplitColumn()` 对创作聊天保留的会话也返回 true。[session-runtime.ts](../../apps/desktop/src/stores/runtime/session-runtime.ts) 据此更新非焦点会话。

影响：创作聊天的实时更新和保留行为依赖分栏内部规则。调整分栏淘汰逻辑时，必须同时理解创作页面。

建议：

- 将会话保留／释放、非焦点会话转录补载移到会话基础模块，沿用现有 [session-panes.ts](../../apps/desktop/src/lib/session-panes.ts) 和转录状态路径。
- 分栏和创作聊天分别声明自己需要保留的会话；订阅结束时释放。
- 列顺序、宽度、焦点、拖放仍由分栏模块管理。

不做：把完整聊天、分栏聊天和创作聊天合成一个带大量模式开关的组件。

### 2.3 按职责拆分创作模块

**优先级：中；扩展视频前处理。**

源码确认：

- [CreativePage.tsx](../../apps/desktop/src/features/creative/CreativePage.tsx) 约 1,200 行，除页面组合外，还管理框选、拖放、移动／撤销、生成表单、分类和队列。
- [mc_creative.rs](../../crates/host-core/src/mc_creative.rs) 约 2,250 行，含测试，覆盖素材、文件分类、任务、对比集、项目用途和账号模型设置。
- `ensure_schema` 在业务模块内建表、探测字段并补列。

影响：增加一种生成任务时，会进入同时包含素材文件操作、数据库结构和对比功能的模块；修改页面交互也需要处理大量不相关状态。

建议：

| 部分 | 最小调整 | 保持不变 |
|---|---|---|
| 前端 | 先提取“网格选择与拖放”和“素材操作”，继续使用已有 `useStudioData` | 页面行为、状态归属和现有子组件 |
| Rust | 按素材／目录、生成任务、对比集拆内部模块；类型与必要公共规则留在模块内共享 | 对外函数、RPC 方法和数据语义 |
| 数据库 | 将表结构演进收敛到明确的初始化／版本迁移入口，补旧库升级测试 | SQLite 仍只由 host-core 读写 |

不做：只按行数切文件、把整页状态搬进一个同样庞大的 hook、引入通用 Repository 或任务引擎。文件拆分与迁移改造分步实施。

## 3. 后续低风险整理

| 项目 | 源码确认与影响 | 建议 |
|---|---|---|
| IPC 按业务拆分 | [project-resources-ipc.ts](../../apps/desktop/electron/main/ipc/project-resources-ipc.ts) 同时注册项目资源、上下文拆分、用量统计和系统提示词等能力，依赖混在同一注册函数中 | 将会话检查、提示词配置、用量统计移到各自注册模块；顶层统一接线，通道及校验不变，不抽万能 handler 工厂 |
| 样式跟随功能 | [app-rail.css](../../apps/desktop/src/styles/app-rail.css) 约 2,500 行，包含会话信息、终端、后台任务、提示词、统计、扩展和定时任务样式 | 按已有功能边界拆文件；外壳文件保留布局和跨页面规则。首次拆分保持选择器及加载顺序，不顺手修改视觉效果 |
| 更新架构说明 | [现状架构](as-built-architecture.md) 仍写默认目录为 `~/.pi-desktop`、项目增量模块“还没建” | 将上游基线与当前 Fork 状态明确区分，依据代码更新，并与[代码索引](code-index.md)对应；避免后续按旧说明扩展 |

## 4. 保持现状的边界

| 能力 | 当前结构与判断 |
|---|---|
| 生图公共链路 | 表单与 Agent 已共用 `createCreativeGenerator`，鉴权共用 `resolveImageBinding`，底层共用 `generateImageBatch`。保留这条链路，不再增加一层调度封装。见[创作生成](../../apps/desktop/electron/main/creative/creative-generation.ts)、[生图服务](../../apps/desktop/electron/main/services/image-generation-service.ts) |
| 项目模板编辑 | 当时工作区的 [ProjectTemplatesPage](../../apps/desktop/src/features/settings/ProjectTemplatesPage.tsx) 直接复用 `TemplateManager`。保留单一编辑实现，无需模板管理框架 |
| Computer Use | 独立 `mc-computer` 进程，通过插件／MCP 接入，平台差异收在 [Backend](../../crates/mc-computer/src/backend.rs)。边界清楚，不合入主进程或 host-core 工具实现 |
| 不同任务系统 | 项目任务有验收，创作任务有素材登记，定时任务有调度，后台 Shell 有进程监管。取消、恢复和完成语义不同，暂不合成统一任务引擎 |
| 不同模板概念 | 项目目录模板、系统提示词模板、定时任务预设只有名称相似，不统一存储或执行模型 |
| 基础工具函数 | 简短的校验或存储代码不因形式相似就抽象。只有同一规则已由多个调用方共同维护时，才提取共享实现 |

## 5. 实施顺序与验证

每步保持行为不变，独立审查和验证，不把结构整理与功能扩展混在一起。优先在新增模块内部调整，减少上游大文件改动。

| 顺序 | 工作 | 验证重点 |
|---|---|---|
| 1 | 统一创作契约 | shared 与 desktop 类型检查；请求／响应和事件消费者保持一致；IPC 拒绝非法方法、参数的测试继续通过 |
| 2 | 提取会话保留能力 | 分栏与创作聊天均能持续更新；切换项目、卸载、删除会话时正确释放；多个使用方不互相提前释放会话 |
| 3 | 拆创作前端与 Rust 模块 | 选择／拖放／撤销用户路径；素材归属、生成结果登记、失败恢复、对比集测试；RPC 契约保持一致 |
| 4 | 收敛创作数据库初始化／迁移 | 空库、已有创作数据、缺旧字段的数据库均能升级；重复启动不破坏数据；遵守仓库 schema 版本与迁移规范 |
| 5 | IPC 与样式归位 | IPC handler 无漏注册或重复注册；相关页面、分栏、侧栏折叠及主题做视觉回归 |
| 6 | 同步架构与索引文档 | 相对链接有效；`git diff --check` 和文档检查通过 |

具体命令按 [AGENTS.md](../../AGENTS.md) 中的改动范围选择。未经用户同意，不使用真实付费模型、生产服务或正在使用的桌面实例验证。

## 6. 本轮检查边界

- 已做：重点模块的源码、依赖和调用路径检查；包含当时未提交的模板设置页等修改。
- 未做：逐文件功能审计、运行测试、实际重构、跨平台运行验证。
- 尚未验证：整理后的净代码减少量、性能变化和视觉一致性，不预先承诺收益数字。
- 后续实施前需重新读取工作区状态；本文的文件长度与结构描述是评审时的快照。

## 7. 目录概念、创作存储与模板整理（开发交接）

**补充日期：2026-10-22。** 本节的“现状”为源码确认；修改方案尚未实施。D1–D4 为保持现有行为的整理／修正；X-DIR-01、X-DIR-02 为待评审的行为需求，确认后再纳入正式 R／P／V 与 ADR，不默认随结构重构实现。

### 7.1 目录概念与实际位置

`~` 表示当前用户主目录；macOS 通常为 `/Users/<用户名>`。下表是源码默认值，不代表已经检查运行实例的环境变量。

| 概念 | 含义与归属 | 默认位置／规则 |
|---|---|---|
| 项目 | `ProjectGroupRecord` 逻辑分组，有稳定 ID；关联工作区、可选资料目录、会话等 | 没有唯一物理目录。不要把 `primary_path` 当成所有内容的父目录 |
| 工作区目录 | 用户实际工作的文件夹；同一项目可关联多个 | 用户选择的任意合法目录，不自动移入 mc-agent 的资料根目录 |
| 参考目录 | 用户关联的外部参考文件夹，`reference` 类型不意味着只读 | 用户选择；权限与工具行为沿用工作区规则，见 8.1 |
| 项目资料目录 | 项目关联的 `resources` 根目录，用于需求、设计、参考资料 | `<资料根目录>/projects/<项目名>/`；重名时实际名称可能带后缀，以返回路径为准 |
| 资料根目录 | 集中存放资料模板和项目资料 | 系统 Documents 目录下的 `mc-agent`，通常为 `~/Documents/mc-agent`；由 `MC_AGENT_HOME` 覆盖 |
| 资料模板目录 | 目录骨架、初始文件及模板描述 | `<资料根目录>/templates/<模板名>/`；内置 `blank`、`software` |
| 创作存储位置 | 项目选定的一个关联目录下面的创作文件夹 | `<选中的工作区或资料目录>/creative/`；两种根目录规则相同 |
| 创作分类目录 | 创作文件的物理分类 | `<创作存储位置>/<分类相对路径>/`；支持嵌套 |
| 创作保留目录 | 未分类结果和生成脚本 | `<创作存储位置>/未分类/`、`<创作存储位置>/scripts/`；不能作为普通一级分类名 |
| 应用数据目录 | host-core 数据库及日志、插件、缓存等运行数据 | 安装版 `~/.mc-agent`；开发版 `~/.pi-desktop-dev`；由 `PI_DESKTOP_DATA_DIR` 覆盖 |
| 资料目录的归属标记 | 标记该资料目录所属项目及模板来源 | `<项目资料目录>/.mc-agent/project.json`；与主目录下的应用数据目录不同 |

依据：[项目记录](../../crates/host-core/src/db/project_groups.rs)、[资料目录](../../crates/host-core/src/resource_dirs.rs)、[模板元数据](../../crates/host-core/src/resource_templates.rs)、[创作存储](../../crates/host-core/src/mc_creative.rs)、[桌面数据路径](../../apps/desktop/electron/main/data-paths.ts)。Electron 自己的 `userData` 是另一个运行状态目录，不应与项目资料或创作文件合并。

示例：项目“游戏 A”关联代码工作区和资料目录，并选择代码工作区保存创作文件。以下是示意，不是本机已有目录清单。

```text
~/
├── .mc-agent/                         应用数据
├── Documents/mc-agent/
│   ├── templates/software/            资料模板
│   └── projects/游戏A/                 项目资料目录
│       ├── requirements/
│       ├── architecture/
│       ├── prototype/
│       └── reference/
└── work/game-a/                        工作区
    ├── src/
    └── creative/                      创作存储位置
        ├── 未分类/
        ├── scripts/
        └── 角色/
```

若选择资料目录保存创作文件，位置变成 `~/Documents/mc-agent/projects/游戏A/creative/`。工作区与资料目录是项目的逻辑关联项，物理上不要求互为父子。不要为了“统一”移动用户工作区、合并应用数据与资料根目录，或改动现有默认路径。

### 7.2 存储、目录模板与生成预设的边界

| 概念 | 负责什么 | 不负责什么 |
|---|---|---|
| 创作存储位置 | 决定后续创作文件写到哪里 | 不自动迁移旧文件，不决定生成参数 |
| 资料目录模板（已有） | 创建资料目录时复制骨架和初始文件一次 | 后续修改不自动同步既有项目；不是持续绑定的目录管理器 |
| 创作目录模板（X-DIR-02） | 初始化 `creative/` 下的用户分类结构 | 不创建第二个项目身份，不修改生成模型或自动整理旧素材 |
| 生成预设 | 描述提示词、模型、尺寸等生成配置的概念 | 不承担文件目录初始化；是否新增预设管理另行评审 |

当前只有资料目录模板链路；不能把“创作目录模板”和“生成预设”当作现有能力。参考图、生成结果、收藏等是素材属性／视图，也不应仅因为界面有分组就强制新增一套物理目录。

### 7.3 可以先执行的修正与整理

| 编号 | 问题与修改位置 | 怎么改 | 验收 |
|---|---|---|---|
| D1 | [NewCreativeDialog.tsx](../../apps/desktop/src/features/creative/NewCreativeDialog.tsx) 将资料根目录预览为 `/assets`，但 Rust `storage_for` 对两种根目录均使用 `/creative` | 删除资料目录对应 `/assets` 的特殊分支，保留实际存储规则；预览处理末尾分隔符，兼顾 Windows。创建成功后的实际路径以 host 返回的 `storage.base` 为准，不为修正文案增加预览 RPC | 新建项目、已有工作区、已有资料目录、追加文件夹四条路径的预览与实际目标一致；先补能捕获原错误的用例 |
| D2 | [CreativePage.tsx](../../apps/desktop/src/features/creative/CreativePage.tsx) 的 `moveStorage` 只是切换位置；名称及提示容易被理解为迁移 | 内部名称改为明确的切换语义；界面使用“更改创作存储位置”，成功提示说明“后续文件写入新位置，已有文件保留原位”；检查新建入口、存储菜单与项目资料入口用词。新文案进 `packages/i18n`，至少 en／zh-CN | 切换后新文件进入新位置，旧文件及素材记录不被搬动或重写；不声称旧文件始终可访问（解除旧根关联后仍受权限约束） |
| D3 | 创作存储响应类型在页面调用处重复声明，路径规则也在界面多处出现 | 与 2.1 一并将现有 `Storage` 响应字段纳入 shared 类型与方法映射；前端当前位置读取 `storage.base`，仅未提交选择的预览做轻量路径显示。host-core 保持路径校验和存储解析的权威实现 | Rust 序列化、Main／Preload、Renderer 类型字段一致；非法根目录仍被拒绝；不增加通用“目录服务”框架 |
| D4 | [现状架构](as-built-architecture.md)、[协议与数据](protocol-data.md)、[创作方案](creative-studio.md)及 `data-paths.ts` 顶部历史注释存在过时或易混淆的目录表述 | 按 7.1 校对术语和路径；历史 PI-Desktop 说明明确标注历史范围；对照 [MC-ADR-0003](adr/mc-0003-equal-workspaces-and-project-home.md)、[MC-ADR-0008](adr/mc-0008-installed-identity.md)、[MC-ADR-0013](adr/mc-0013-creative-studio.md) 更新受影响契约。保留环境变量名及兼容语义 | 文档不再把项目等同资料目录，不把 `~/.mc-agent/projects` 写成当前默认资料位置；文档检查与相对链接检查通过 |

D1–D4 不要求移动任何用户数据，不要求数据库迁移。遇到实际需要变更持久化结构的实现方案，应另列迁移影响，不能隐藏在类型或文案整理中。

### 7.4 X-DIR-01：显式存储位置失效时停止隐式回退（待评审）

**源码确认：** `mc_creative.rs::storage` 在用户从未选择位置、或已保存的根目录不再属于项目时，都会回退到第一个工作区，再回退到项目第一个根目录。两种原因目前没有区分。

**建议行为：** 从未配置时保留默认选择；已经配置但关联被移除时，显示位置失效并要求重新选择。关联仍在但磁盘离线／权限不足时明确报错，不改写为其他存储位置。这个方案会改变现有行为，须先确认。

实施落点：

1. host-core `storage` 区分未配置、有效配置、失效配置；通过现有错误契约表达失效，不顺手改成任意目录访问。
2. [mc_creative_rpc.rs](../../crates/host-core/src/rpc/mc_creative_rpc.rs) 及生成调用链保留错误；检查表单生成、Agent 工具、导入、分类创建等所有写入入口，避免某条路径继续使用独立回退。
3. `CreativePage` 当前读取位置失败会 `setStorage(null)`，需改为显示可恢复错误及重新选择入口，不能只隐藏存储信息。
4. 正在运行的任务切换位置时的目标必须明确：实施前检查当前任务记录和写入时机，保证一个任务的文件与登记路径一致；若要改变任务目标确定时机，单列为行为变更，不能直接顺带实现。

验收：未配置保持原默认；已配置有效时不受根列表排序影响；移除所选关联后不向另一个根写入；离线目录不触发切换；重新选择后恢复。全部用临时目录与模拟生成，不调用付费模型。

### 7.5 X-DIR-02：复用目录模板编辑能力，增加明确的创作初始化目标（待评审）

**建议：共享模板编辑／校验能力，分开资料与创作的应用目标。** 第一阶段只做新创作目录初始化，不做既有素材重排、模板自动同步或批量迁移。

| 涉及位置 | 开发方案与限制 |
|---|---|
| [template_editor.rs](../../crates/host-core/src/template_editor.rs)、[resource_templates.rs](../../crates/host-core/src/resource_templates.rs)、[resource_dirs.rs](../../crates/host-core/src/resource_dirs.rs) | 先检查现有目录路径校验与复制流程，复用确实相同的能力。模板元数据建议增加目标 `resources`／`creative`；旧模板缺字段解释为 `resources`。目标字段变更须同步序列化、校验及兼容测试 |
| 资料模板物理存储 | 建议继续使用现有 `templates/<模板名>/`，通过目标字段筛选；暂不引入另一套模板仓库。同名仍按现有规则处理，不因目标不同悄悄覆盖 |
| [TemplateEditor.tsx](../../apps/desktop/src/features/project-workbench/TemplateEditor.tsx)、[TemplatePicker.tsx](../../apps/desktop/src/features/project-workbench/TemplatePicker.tsx)、[ProjectTemplatesPage.tsx](../../apps/desktop/src/features/settings/ProjectTemplatesPage.tsx) | 复用现有编辑界面，明确显示模板用途，选择器按用途筛选；不复制一套创作模板编辑器。检查 `template-draft.ts`、shared 类型、IPC／RPC 和 i18n 的对应修改 |
| `mc_creative.rs`、`mc_creative_rpc.rs`、`NewCreativeDialog.tsx` | 在选定项目关联目录后，将创作模板应用到其 `creative/`，不再创建项目资料目录或额外项目记录。初期只允许目录骨架；复用创作分类深度、名称及保留目录校验，避免模板允许创建 UI 无法管理的分类 |
| 初始化与兼容 | 默认空模板；只接受不存在或空的创作目标，非空时明确拒绝应用并允许用户继续使用已有内容。不得覆盖文件、追踪模板更新或重新分类素材；防路径穿越和符号链接越界；失败不留下“成功”状态，不删除用户已有内容 |

验收：旧资料模板及资料创建行为不变；两类模板不会误选；创作模板只写入选定根的 `creative/`；保留名、超深分类、越界路径和非空目标被拒绝；重复初始化及中途失败不覆盖已有内容。若最终选择持久化模板来源，先定义来源字段与升级方式，不直接复用资料目录的项目归属标记。

### 7.6 开发 agent 接手顺序与交付要求

1. 重新读取工作区状态及目录内 AGENTS.md；已有未提交的模板编辑改动是当前基线，不覆盖、不回退。
2. 先做 D1、D2，修正预览与用户理解；D3 随创作契约整理完成；D4 同步更新事实文档。
3. X-DIR-01、X-DIR-02 在评审确认并同步需求／页面／验收及必要 ADR 后再实现；本节不授权数据迁移功能。
4. 前端跑 desktop 类型检查、lint 和相关测试；Rust 改动按仓库要求跑格式、host-core 测试及 clippy。跨进程路径增加相应用户路径验证，不只检查静态字符串。
5. 文档跑 `git diff --check`、`cd docs && node scripts/check-docs.mjs`，检查新增相对链接。汇报实际运行结果，未运行项说明原因。

本节只完成源码梳理和开发方案；没有修改运行代码，没有验证真实安装实例、跨平台目录行为或迁移流程。

## 8. 其他核心概念与边界检查（开发交接）

**日期：2026-10-22。范围：** 项目身份、会话与任务、资料与素材、提示词、模型配置、扩展能力及操作语义。以下为源码与文档交叉检查，不是全仓逐行审计，也不是运行验收。C 编号仅为本节整改索引，不替代需求编号。

### 8.1 建议统一的概念表

| 概念 | 源码确认的边界 | 对外表述／开发约束 |
|---|---|---|
| 项目与旧路径记录 | shared 同时有 `ProjectGroupRecord`（逻辑项目）和 `ProjectRecord`（路径记录）；会话另有 `projectPath` | UI 的“项目”指逻辑分组；`projectPath` 应按会话工作目录语境解释，不能直接当作项目 ID。保留旧契约，不做全仓字段改名 |
| 简单／模板项目与创作用途 | `ProjectKindPicker` 的 managed 由是否有关联资料目录推导，不持久化独立类型；创作模块另按 group ID 保存 `Purpose::Code/Creative` | “是否有资料目录”和“是否用于创作”是独立维度，不能合并成互斥的 simple／managed／creative 枚举；创作项目仍可有资料目录 |
| 参考目录 | `ProjectGroupRootKind::Reference` 表示外部参考文件夹，源码明确其工具和权限行为与工作区相同 | 与 `resources` 资料目录、生成请求的参考图分开；“参考”不等于只读。现有存储默认选择逻辑按“非 resources”筛选，因此也可能选中 reference 根 |
| 会话、回合、标签、分栏 | 会话有 session ID；一次运行有 turn ID；通知类型虽名为 `task.completed`，载荷含 sessionId 和 turnId；标签／分栏负责展示会话 | 标签关闭、回合结束、会话删除、项目任务验收是四种动作，不能因都显示“完成／关闭”就互相触发 |
| 项目任务与执行记录 | `ProjectTask` 有目标、验收条件、多个 `TaskRun` 和评审；执行结束进入待验收，Accepted 才使任务完成 | “执行结束”不写作“项目任务完成”；同一任务允许多次执行，任务 ID、run ID、session ID 不能互换 |
| 会话待办、计划、定时任务、生成任务、后台命令 | 分别由 todos、plans、scheduled、creative、background 模块维护；会话待办按 session 保存，创作 Job 有逐结果状态，后台命令有进程状态 | UI 标明具体任务种类；可共用状态徽标外观，但不能共用一套完成、取消、重试或恢复规则 |
| 项目资料与创作素材 | `ResourceItem` 描述资料定位和确认状态；`Asset` 描述创作文件、来源、收藏、生成任务等 | 同一个文件可能出现在两种视图；资料确认不等于素材收藏。不要把两种记录合成一个带大量可选字段的资源对象 |
| 资料确认与执行依据 | 资料确认保存当前内容哈希，变化显示 changed；`TaskRun.resources` 当前只保存 key、title、status | “已确认”是用户确认过该内容；不是文件版本库。“执行依据记录”目前不是可恢复原文的完整快照 |
| 模板与生效配置 | 资料模板复制一次；系统提示词模板在启动解析；定时任务模板只预填表单 | 用完整名称，不把它们统一成一个模板执行系统；“模板已修改”不自动表示已有项目、运行会话或已保存定时任务已经更新 |
| 服务商配置、账号、模型 | `ProviderPublic` 有独立 id、vendorKey、协议和鉴权方式；其 models 为 provider 内模型绑定；alias 只是显示名 | 配置实例不等于厂商，也不必然对应一个 OAuth 账号；选择和恢复使用 providerId + modelId，不能只靠模型名或别名 |
| 模型能力 | shared 区分图像输入能力等模型属性；创作模块另有账号图片模型与生图链路 | “能看图”不等于“能生图”；可发现、已配置、可调用也不是同一种状态，不因目录里列出了模型就承诺调用成功 |
| 插件、MCP、技能、工具 | 仓库分别有插件管理、MCP 接入、技能内容与 host 工具执行链路 | 建议解释为扩展包、连接器、操作指导、实际可执行动作；技能内容不构成权限授予，插件启用也不等于其所有连接器已连接。保留各自生命周期 |

依据：[shared 工作区类型](../../packages/shared/src/types/workspace.ts)、[会话类型](../../packages/shared/src/types/sessions.ts)、[项目根类型](../../crates/host-core/src/db/project_groups.rs)、[项目类型入口](../../apps/desktop/src/features/project-workbench/ProjectKindPicker.tsx)、[项目任务](../../crates/host-core/src/project_tasks.rs)、[会话待办](../../crates/host-core/src/todos.rs)、[资料清单](../../crates/host-core/src/resource_catalog.rs)、[创作模块](../../crates/host-core/src/mc_creative.rs)、[模型类型](../../packages/shared/src/types/models.ts)、[服务商类型](../../packages/shared/src/types/providers.ts)。插件等这里只检查模块职责，不代表完成其权限链路安全审计。

### 8.2 具体需要整理的位置

#### C1：项目类型、用途与参考目录分开说明（优先）

**触发场景：** 开发 agent 把“创作项目”作为第三种互斥项目类型，可能使带资料目录的创作项目丢掉资料／任务入口；把 reference 当只读则会错误描述现有权限。

**修改：** 在 `ProjectKindPicker`、`ProjectWorkbench`、`NewCreativeDialog` 与项目说明中分别表达资料能力和创作用途；继续按现有资源根与 purpose 判断，不新建重复状态字段。第 7 节目录表应连同本节 reference 语义阅读。调整提示词中的目录说明时同步 [project-folder-guide.ts](../../packages/shared/src/project-folder-guide.ts)。

**验收：** 简单项目、带资料目录项目分别覆盖 code／creative 用途；参考目录标识不改变现有访问权限；转换／解除资料目录不误删创作用途或素材。

#### C2：“任务完成”明确指哪个对象（优先）

**触发场景：** 一次 turn 结束发出 `task.completed`，但对应项目任务仍在 awaitingReview；若通知和项目卡片都写“任务已完成”，用户会误认为已验收。

**修改：** 核查通知、会话信息栏、项目任务页、生成队列与后台面板的状态文案。回合完成用“本轮执行结束”，项目任务完成保留“已验收／已完成”，生成任务说明成功、部分成功或失败，后台命令显示退出／停止。先改显示映射及 i18n，不重命名历史事件、数据库枚举或 RPC。项目任务逻辑继续由 `project_tasks.rs` 控制，不接通用完成事件自动验收。

**验收：** 一次执行结束后通知与待验收卡片不矛盾；生成部分成功不被呈现为全部成功；停止后台命令不自动完成项目任务。具体当前通知文案需实施时逐入口核对，本次确认的是事件及状态语义差异。

#### C3：系统提示词“项目规则”实际为目录匹配（优先）

**源码确认：** [mc-system-prompts.ts](../../apps/desktop/electron/main/mc-system-prompts.ts) 按 `projectRules[].path` 匹配传入的项目路径集合，按配置顺序取第一个命中；其次匹配模型，再使用全局模板。[session-launch.ts](../../apps/desktop/electron/main/runtime/session-launch.ts) 将项目路径集合传入。不是按逻辑项目 ID 绑定，也不是多个项目模板叠加。

**触发场景：** 同一多目录项目的两个目录各有一条规则，实际选中第一条规则，不保证会话起始目录对应的规则胜出。

**最小修改：** [SystemPromptsPage.tsx](../../apps/desktop/src/features/settings/SystemPromptsPage.tsx) 的规则说明显示“按项目关联目录匹配；多条命中取列表首条”；系统提示词查看器展示实际命中的目录／模型／全局来源。补多目录、多命中、模型与全局回退测试，保留当前优先级。

**待评审 X-CONCEPT-01：** 若要真正绑定项目 ID，或起始目录优先，须单独确认匹配优先级、旧 path 规则兼容、项目改名／目录移动与远程项目身份。不在文案整理中偷偷切换语义。

#### C4：资料确认不是原文版本快照（优先核对契约）

**源码确认：** `resource_catalog` 保存确认哈希；`project_tasks::ResourceSnapshot` 只有 key、title、status，当前 TaskRun 不保存该次执行的文件内容或哈希。需求文档有“查到确认版本”“运行中记录原依据”的表述，不能仅凭现有结构承诺可还原当时原文。

**修改：** 在需求／协议文档与任务详情明确“已保存的依据清单”能查到哪些字段；如果原需求要求版本可追溯，应记录为实现缺口，不能只删承诺就算完成。实施前继续核对会话附件／转录是否另有完整依据副本，本轮未证明全系统不存在其他记录。

**待评审 X-CONCEPT-02：** 确定只需内容哈希追溯，还是需要原文可恢复。前者可给执行资源记录增加实际读取时的内容哈希与确认信息；后者涉及内容快照存储、大小限制与清理策略，另行设计。旧执行记录显示“未记录”，不以当前文件回填伪造历史。

**验收：** 修改并重新确认资料后，旧执行记录不冒充新版本；旧数据可读；执行前校验与实际读取之间的变化有明确处理；不宣称 URL 已保存不可变原文。

#### C5：资料目录内的创作文件会同时进入资料清单（需要产品边界）

**源码确认：** `resource_catalog::scan` 递归扫描资料根，排除隐藏文件和少量保留文件，未排除 `creative/`；`first_level_folders` 同样会把 creative 列为资料分类。

**触发场景：** 创作存储选在资料目录后，生成图片、脚本进入资料清单并参与资料统计；大量生成文件还会占用 2,000 文件的扫描上限。两种展示并不天然是 bug，但会使“项目资料”的含义随存储位置改变。

**待评审 X-CONCEPT-03：** 建议资料清单默认不自动收录受创作功能管理的输出，所需素材由用户显式登记引用。实现需同时核对 `scan`、分类列表、索引与显式登记路径；不能只在 UI 隐藏，否则统计和 Agent 上下文仍会包含它们。

**兼容限制：** 不能仅按目录名一律隐藏所有已有 `creative` 文件夹；先确定如何识别创作管理范围，及既有 `folder:creative/...` 资料引用的保留／提示方式。不得删除文件、清空确认记录或使既有项目任务引用静默消失。边界未确认前只说明现状，不改扫描规则。

#### C6：移除、删除、解除关联与切换位置必须分开（优先）

**源码确认：** `remove_asset` 标记 removed_at 并保留文件；`delete_asset_file` 删除文件再移出素材库；`restore_asset` 只恢复记录，不重建文件；删除分类会将素材归入父分类／未分类，并清理空目录。目录切换不搬旧文件。

**修改：** 检查 `AssetDetail`、`CreativePage`、`CategoryTree`、项目资料解除入口的按钮、确认提示与撤销说明。统一为“从素材库移除”“删除文件”“解除资料目录关联”“更改后续存储位置”等具体动作；分类删除提示说明素材去向。不要用一个通用 Delete handler 合并行为。

**验收：** 移除后文件仍在；删除文件后恢复记录不会声称文件已恢复；解除资料关联保留磁盘内容；分类删除保留素材并显示实际去向。保留当前权限校验，不把语义统一变成扩大删除范围。

#### C7：文档阶段和能力状态需与实现分开标记（可直接整理）

**源码／文档确认：** README 已写进入开发且 R1–R11 已合入，requirements 开头仍写“当前阶段只完善文档”；需求中已有 R12，导航范围仍主要写 R1–R11；“当前没有待评审 X”也无法涵盖本文新增的待评审提案。

**修改：** README、requirements、validation-plan、code-index 与本文入口统一说明各自时间／范围：已确认需求、源码实现、合入状态、运行验收分别记录，不依据需求编号或有代码就认定已发布／测试通过。README 的评审文档说明增加目录与概念整理范围。无需给所有继承功能重新编号。

**验收：** 同一功能的状态说明没有相互矛盾；旧阶段计划明确标注历史；本节 X-CONCEPT 与第 7 节 X-DIR 保持待评审，不自动列为已确认需求。

### 8.3 可以统一与不应统一的内容

- **统一：** 用户术语、共享传输类型、同一规则的显示映射、实际路径和匹配来源的展示、错误提示。
- **保持独立：** 项目任务验收与生成任务完成；资料状态与素材属性；目录模板、提示词模板和定时预设；厂商、账号配置与模型绑定；插件、连接器、技能和权限。
- **先做：** C1／C2／C3 的语义说明、C6 的操作措辞、C7 的文档状态核对，配合第 7 节 D1–D4。
- **先确认再改行为：** X-CONCEPT-01 提示词匹配、X-CONCEPT-02 执行依据追溯、X-CONCEPT-03 资料与创作自动收录边界。

本轮未执行业务测试，未逐条审查所有本地化文本、远程运行链路、插件权限实现或历史数据迁移；后续开发需按对应条目的验收范围验证，不能将本节视为这些功能全部通过审计。

## 9. macOS 权限体验专项

见[macOS 权限归属与授权体验改造](macos-permissions.md)。该专项涉及实际执行进程、签名发布、系统授权与应用内审批的边界，独立列出 X-PERM 提案、开发落点和验收。先核实安装包授权归属，再做分项请求与设置引导；不将重写进程架构作为默认前置条件。

## 10. 实施结果（2026-10-22）

全部条目已实施，未提交、未发版。X 提案已转为正式需求（见[需求文档](requirements.md)第 5 节、[验收计划](validation-plan.md) V42–V48）。

| 条目 | 结果 | 主要位置 |
|---|---|---|
| 2.1 创作契约 + D3 | 传输类型与 `CreativeMethods` 方法表进 `packages/shared`；`api.creative.call` 由方法名推出参数和返回；Main 放行列表即共享列表；契约测试核对 host-core 处理每个方法 | `types/creative.ts`、`mc-creative-ipc.ts`、`test/mc-creative-contract.test.mjs` |
| 2.2 会话保留 | 新增按使用方计数的会话保留模块，分栏注册列为来源，创作聊天用 `useHeldSession`；多个使用方互不提前释放 | `lib/session-holds.ts`、`lib/use-held-session.ts` |
| 2.3 拆创作模块 | 前端拆出选择与拖放、素材操作两个钩子（页面约 1,200 → 1,030 行）；Rust 拆为 5 个文件，对外函数与 RPC 不变 | `use-grid-selection.ts`、`use-asset-actions.ts`、`mc_creative/` |
| 4 数据库迁移 | 建表补列收进 `schema.rs`，版本记在 `mc_schema_versions`；补了空库、旧库（缺 category）、重复执行测试 | `mc_creative/schema.rs` |
| 3 IPC 与样式 | 会话信息、提示词、用量各自注册；`app-rail.css` 按功能拆为 12 个文件，顺序不变 | `ipc/mc-*-ipc.ts`、`styles/mc-*.css` |
| 3 架构说明 + D4 | 现状架构区分上游基线与当前目录；`data-paths.ts` 注释标明历史；协议、创作方案、代码索引同步 | `as-built-architecture.md` 等 |
| D1 | 预览改为 `<目录>/creative`，兼容末尾分隔符和 Windows 路径 | `creative-model.ts::creativeFolderOf` |
| D2 | 改为“更改创作存储位置（只影响之后的新文件）”，提示说明旧文件不动 | `CreativePage.tsx` |
| X-DIR-01 → R13.1 | 已选位置失效（解除关联或离线）时报错，不回退；页面显示原因与“重新选择” | `mc_creative::storage` |
| X-DIR-02 → R13.2 | 模板加用途；创作模板只在空 `creative/` 下建分类；资料模板与创作模板互不误用 | `template_editor.rs`、`mc_creative/assets.rs`、`NewCreativeDialog.tsx` |
| C1 | 新建对话框说明两种项目都可用于创作；工作台显示“用途：创作”；参考目录标注“读写同工作区，不是只读”，会话说明同步 | `ProjectKindPicker.tsx`、`ProjectWorkbench.tsx`、`project-folder-guide.ts` |
| C2 | 通知改为“本轮执行结束，项目任务需验收”；生成状态“全部成功／部分成功”；任务完成显示“已验收”。侧边栏会话状态保留上游写法 | `useAppShellRuntime.tsx`、`NotificationCenter.tsx` |
| C3 → R11.10 | 规则改称目录规则：起始目录优先，再按列表；查看器显示命中目录 | `mc-system-prompts.ts`、`SystemPromptDialog.tsx` |
| C4 → R7.1 | 执行记录保存每份资料开始时的内容哈希与确认时间（不存原文）；任务卡片可查看 | `project_tasks.rs`、`TaskBoard.tsx` |
| C5 → R3.2 | 创作项目存储在资料目录时 `creative/` 不进资料清单，确认过的文件保留 | `resource_catalog.rs`、`mc_creative::managed_resource_subfolder` |
| C6 | “解除资料目录关联”；删除文件提示不可撤销；文件已删的记录恢复写明“文件无法恢复”；分类删除说明素材去向 | `AssetDetail.tsx`、文案 |
| C7 | README、需求、验收、代码索引的阶段与范围说法统一，需求确认／代码合入／验收分开记录 | 各文档 |
| 新增：资料索引 → R3.1 | 资料目录根 `RESOURCES.md` 自动生成，项目文件夹说明指向它 | `resource_overview.rs` |

顺带修复：多层模板在 Main 的参数检查里被旧限制（128 字符、64 个）挡住，已与 host-core 对齐（200 个、6 层路径）。
