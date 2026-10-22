# 功能代码索引

对照仓库里的现有代码。路径相对仓库根。测试文件不列入，除非它是该功能唯一的入口说明。

mc-agent 新增功能（R1–R10）的代码见文末“mc-agent 项目管理”一节。


## 启动与窗口

| 功能 | 代码 |
|---|---|
| Electron 主入口 | `apps/desktop/electron/main/index.ts` |
| 启动、生命周期、关窗行为 | `apps/desktop/electron/main/bootstrap/` |
| preload / IPC 白名单 | `apps/desktop/electron/preload/index.ts` |
| IPC 注册 | `apps/desktop/electron/main/ipc/register.ts` |
| 应用 IPC（窗口、菜单、更新） | `apps/desktop/electron/main/ipc/app-ipc.ts`、`apps/desktop/electron/main/ipc/window-ipc.ts` |
| 托盘、未读角标 | `apps/desktop/electron/main/tray-sessions.ts`、`apps/desktop/electron/main/taskbar-unread-badge.ts` |
| 更新 | `apps/desktop/electron/main/updater.ts`、`apps/desktop/electron/main/update-policy.ts`、`apps/desktop/electron/main/update-cache.ts` |
| 单实例与数据目录 | `apps/desktop/electron/main/data-paths.ts`、`apps/desktop/electron/main/installation.ts`；Rust 侧 `PI_DESKTOP_DATA_DIR` 在 `crates/host-core/src/main.rs` |

## 聊天与会话

| 功能 | 代码 |
|---|---|
| 聊天界面 | `apps/desktop/src/features/chat/` |
| 转录渲染 | `apps/desktop/src/features/chat/transcript/` |
| 输入框、斜杠命令、粘贴 | `apps/desktop/src/features/chat/composer/`；主进程 `apps/desktop/electron/main/composer-mcp.ts`、`apps/desktop/electron/main/composer-paste.ts`、`apps/desktop/electron/main/composer-picker.ts` |
| 会话列表与页 | `apps/desktop/src/features/sessions/`、`apps/desktop/electron/main/ipc/session-ipc.ts` |
| 会话启动 | `apps/desktop/electron/main/runtime/session-launch.ts`、`apps/desktop/electron/main/runtime/session-coordination.ts` |
| 回合事件与落盘协作 | `packages/host-runtime/src/turn-events.ts`、`packages/host-runtime/src/turn-persistence.ts`、`packages/host-runtime/src/runtime-service.ts` |
| 无头回合队列、审批、事件日志 | `packages/agent-host/src/` |
| Rust 会话与转录 | `crates/host-core/src/sessions/`、`crates/host-core/src/transcripts.rs`、`crates/host-core/src/turn_queue.rs` |
| 会话搜索 | `crates/host-core/src/session_search.rs`；主进程 `apps/desktop/electron/main/services/session-search.ts` |
| 会话协作 | `crates/host-core/src/session_collaboration/`；主进程 `apps/desktop/electron/main/services/session-collaboration.ts` |

## Agent 循环

| 功能 | 代码 |
|---|---|
| sidecar 进程入口 | `packages/agent-runtime/src/sidecar.ts` |
| 运行时包装 | `packages/agent-runtime/src/runtime.ts` |
| 压缩 | `packages/agent-runtime/src/compaction-*.ts`、`packages/agent-runtime/src/pi-runtime-compaction-*.ts`、`packages/agent-runtime/src/context-budget.ts` |
| 系统提示词与项目说明 | `packages/agent-runtime/src/custom-system-prompt.ts`、`packages/agent-runtime/src/project-instructions.ts`、`packages/agent-runtime/src/mode-prompts.ts` |
| 子代理 | `packages/agent-runtime/src/subagent.ts`、`packages/agent-runtime/src/subagent-definitions.ts`、`packages/agent-runtime/src/delegation-*.ts` |
| 思考级别 | `packages/agent-runtime/src/thinking-level.ts` |
| 主进程拉起 sidecar | `apps/desktop/electron/main/agent-sidecar.ts`、`apps/desktop/electron/main/runtime/sidecar.ts` |
| sidecar 监督（不依赖 Electron） | `packages/host-runtime/src/agent-sidecar.ts`、`packages/host-runtime/src/runtime-supervisor.ts` |
| Pi 包版本与补丁 | `packages/agent-runtime/package.json`、`patches/` |

循环本体在依赖 `@earendil-works/pi-agent-core`，不在本仓库。

## 模型与账号

| 功能 | 代码 |
|---|---|
| Provider 持久化 | `crates/host-core/src/providers/` |
| 模型目录 | `apps/desktop/electron/main/models-dev-catalog.ts`、`apps/desktop/electron/main/pi-model-metadata.ts`、`apps/desktop/electron/main/vendor-live-models.ts` |
| OAuth | `apps/desktop/electron/main/oauth.ts`；IPC `apps/desktop/electron/main/ipc/provider-ipc.ts` |
| 密钥 | `crates/host-core/src/secrets.rs` |
| 传输重试、代理 | `packages/agent-runtime/src/provider-retry.ts`、`packages/agent-runtime/src/provider-transport-recovery.ts`、`packages/agent-runtime/src/socks5.ts`、`packages/agent-runtime/src/system-proxy-relay.ts` |
| 从 Claude / Codex / OpenCode / Pi 导入 | `apps/desktop/electron/main/importers/` |
| 导入项目与对话（mc） | 界面 `apps/desktop/src/features/project-import/`（`ProjectImportDialog.tsx`、`import-model.ts`），入口在 `components/Sidebar.tsx`；PI-Desktop 来源 `electron/main/importers/pi-desktop.ts` → host-core `src/mc_import.rs`（`mcImport.*`）；通道 `ipc/session-ipc.ts` 的 `sessionImportScan/Run` |
| 系统提示词（mc） | 查看器 `apps/desktop/src/features/session-info/SystemPromptDialog.tsx`（运行时 `systemPromptView`、sidecar `agent.systemPrompt`）；模板设置页 `src/features/settings/SystemPromptsPage.tsx`；存储 host-core `src/mc_prompts.rs`（`mcPrompts.*`）；匹配 `electron/main/mc-system-prompts.ts`，在 `runtime/session-launch.ts` 应用 |
| 用量统计（mc） | host-core `src/mc_usage.rs`（`mcUsage.summary`）；页面 `apps/desktop/src/features/settings/UsagePage.tsx`、`usage-model.ts`；通道在 `ipc/mc-usage-ipc.ts` |

## 工具、权限、工作区

| 功能 | 代码 |
|---|---|
| 工具执行入口 | `crates/host-core/src/tools/mod.rs` |
| Shell | `crates/host-core/src/tools/shell.rs` |
| Grep | `crates/host-core/src/tools/grep_rg.rs` |
| 按行哈希编辑 | `crates/host-core/src/tools/hashline/` |
| 权限 | `crates/host-core/src/permissions.rs`；插件权限 `crates/host-core/src/plugins/permissions.rs` |
| 工具预算 | `crates/host-core/src/tool_budget.rs` |
| 工作区根 | `crates/host-core/src/workspace.rs`；主进程 `apps/desktop/electron/main/workspace-roots.ts`、`apps/desktop/electron/main/workspace-git.ts` |
| 文件索引与 diff | `packages/host-runtime/src/workspace-files.ts`、`packages/host-runtime/src/workspace-diff.ts`、`packages/host-runtime/src/fs-index.ts` |
| 工作面板 UI | `apps/desktop/src/components/workpanel/` |
| 内嵌浏览器 | `apps/desktop/electron/main/browser-host.ts`、`apps/desktop/electron/main/browser-view.ts`、`apps/desktop/electron/main/browser-cdp.ts` |
| MCP | `apps/desktop/electron/main/mcp-registry-catalog.ts`、`apps/desktop/electron/main/mcp-stdio-launch.ts`、`apps/desktop/electron/main/mcp-oauth.ts`；IPC `apps/desktop/electron/main/ipc/mcp-ipc.ts` |

host-core 也可作为内部工具子进程启动（`tools::INTERNAL_TOOL_RUNNER_FLAG`，见 `crates/host-core/src/main.rs`）。

## 插件

| 功能 | 代码 |
|---|---|
| 安装、清单、市场、校验 | `crates/host-core/src/plugins/` |
| 插件运行时与面板宿主 | `apps/desktop/electron/main/plugin-runtime.ts`、`apps/desktop/electron/main/plugin-panel-host.ts`、`apps/desktop/electron/main/plugin-view-host.ts` |
| 渲染槽位 | `apps/desktop/src/plugins/` |
| 插件页 | `apps/desktop/src/pages/PluginsPage.tsx`、`apps/desktop/src/features/plugins/` |
| 作者 SDK / 打包 | `packages/plugin-sdk`、`packages/plugin-devkit` |
| 技能 | `crates/host-core/src/user_skills/`；主进程 `apps/desktop/electron/main/builtin-skills.ts`、`apps/desktop/electron/main/skill-market-catalog.ts` |

## 项目、worktree、计划、定时

| 功能 | 代码 |
|---|---|
| 项目页 | `apps/desktop/src/pages/ProjectsPage.tsx`、`apps/desktop/src/features/projects/` |
| 项目组数据 | `crates/host-core/src/db/project_groups.rs` |
| worktree | `crates/host-core/src/session_worktrees/`；IPC `apps/desktop/electron/main/ipc/worktree-ipc.ts`；UI `apps/desktop/src/features/worktree/` |
| 计划 | `crates/host-core/src/plans/`；编排 `packages/host-runtime/src/plan-execution.ts`、`packages/host-runtime/src/plan-dispatch.ts` |
| 会话待办 | `crates/host-core/src/todos.rs`；UI `apps/desktop/src/features/chat/todos/` |
| 定时任务 | `crates/host-core/src/scheduled/`；UI `apps/desktop/src/pages/ScheduledPage.tsx`、`apps/desktop/src/features/scheduled/` |
| 用户子代理定义 | `crates/host-core/src/user_subagents/` |

`session_todo` 是会话内清单，不是规划文档里的项目任务。

## 远程 Host

| 功能 | 代码 |
|---|---|
| 无头 Host 进程 | `apps/pi-host/src/app.ts`、`apps/pi-host/src/cli.ts` |
| RACP | `packages/racp/src/` |
| SSH 引导与隧道 | `apps/desktop/electron/main/remote/ssh-bootstrap.ts`、`apps/desktop/electron/main/remote/ssh-tunnel.ts`、`apps/desktop/electron/main/remote/pi-host-installer.ts` |
| 远程工作区工具 | `apps/desktop/electron/main/remote/remote-workspace-tools.ts`；Host 侧 `apps/pi-host/src/workspace-tools.ts` |
| 远程文件 | `apps/pi-host/src/workspace-files.ts` |
| 连接与注册 | `apps/desktop/electron/main/remote/remote-host-connection.ts`、`apps/desktop/electron/main/remote/remote-host-registry.ts`、`apps/desktop/electron/main/remote/remote-host-supervisor.ts` |
| 远程 UI | `apps/desktop/src/components/remote/` |

## 语音

| 功能 | 代码 |
|---|---|
| 本地转写运行时 | `packages/voice-runtime/src/` |
| 实时通话（OpenAI / Gemini / Codex 适配） | `apps/desktop/electron/main/live-voice/` |
| 通话 UI | `apps/desktop/src/features/voice/` |
| 桌面语音服务 | `apps/desktop/electron/main/services/speech-service.ts`、`apps/desktop/electron/main/voice-service.ts` |

## 设置、同步、国际化

| 功能 | 代码 |
|---|---|
| 设置页 | `apps/desktop/src/pages/SettingsPage.tsx`、`apps/desktop/src/features/settings/` |
| 配置同步（加密、S3） | `crates/host-core/src/config_sync/` |
| 数据目录搬迁 | `crates/host-core/src/data_relocation.rs` |
| 文案 | `packages/i18n/src/locales/`；渲染层 `apps/desktop/src/locales/` |
| 数据库 schema 与迁移 | `crates/host-core/src/db/schema.rs`、`crates/host-core/src/db/migrations.rs` |

## IPC 对照

渲染进程能调用的通道都从 `apps/desktop/electron/main/ipc/` 注册。新增 UI 能力先加这里的 handler，再决定数据落在 host-core 还是只留在 Main。不要从渲染进程直接 spawn host-core 或 sidecar。

## mc-agent 界面外壳（R11）

| 功能 | 代码 |
|---|---|
| 左侧竖栏 | `apps/desktop/src/features/app-rail/AppRail.tsx`；样式 `apps/desktop/src/styles/app-rail.css`（竖栏、标题栏与三层配色）；其余 mc 样式按功能拆在 `styles/mc-*.css`（标签栏、信息栏、工作面板、后台任务、提示词、用量、扩展页、定时任务、更新按钮、系统权限），在 `globals.css` 里按原顺序引入 |
| 顶部标签栏 | `apps/desktop/src/features/session-tabs/`（`tab-list.ts` 纯逻辑，`SessionTabs.tsx` 组件）；挂在 `ConversationTopbar.tsx` 与 `AppShell.tsx` 的 `main-titlebar` |
| 设置以标签打开 | `apps/desktop/src/features/app/AppShell.tsx`（`mc-settings-tab`）；设置导航进侧边栏 `features/sidebar-slot/SidebarSlot.tsx` |
| 侧边栏按项目合并 | `apps/desktop/src/features/project-sidebar/`；host 侧失效目录查询 `project.folders.missing`（`rpc/resource_dirs_rpc.rs`） |
| 工作面板终端与工具 | Main：`apps/desktop/electron/main/mc-terminal.ts`、`ipc/mc-terminal-ipc.ts`；界面：`apps/desktop/src/features/work-tools/`（`TerminalTab.tsx`、`WorkPanelQuickTools.tsx`、`tool-tabs.ts`；分区 `WorkPanes.tsx`、`work-panes-model.ts`、`pane-layout.ts`）；多个插件视图同时显示：`apps/desktop/electron/main/plugin-view-host.ts` |
| 后台命令 | host-core：`crates/host-core/src/tools/background.rs`（注册表、监管、读写），接线在 `rpc/mod.rs`（`tools.execute` 分支、`backgroundShells.*`、会话删除）与 `state.rs`（关闭时结束）；运行时：`packages/agent-runtime/src/runtime.ts`（Bash `runInBackground`、`BashOutput`、`KillBash`）；桌面：`apps/desktop/electron/main/ipc/mc-background-ipc.ts`、`src/features/work-tools/BackgroundPane.tsx`、`background-shells.ts` |
| 并列对话 | 状态与纯逻辑 `apps/desktop/src/lib/mc-split-view.ts`；视图与操作 `src/features/split-view/`（`SplitColumns.tsx`、`split-actions.ts`）；接线在 `components/ChatSurface.tsx`、`features/app/AppShell.tsx`、`components/workpanel/WorkPanel.tsx`（`WorkPanelBottomDock`）、`lib/session-panes.ts`（固定窗格）、`stores/runtime/session-runtime.ts`（非焦点列实时）；标签入口在 `features/session-tabs/SessionTabs.tsx`；样式 `src/styles/split-view.css` |
| 会话信息栏 | `apps/desktop/src/features/session-info/`（停靠与浮层、行计算在 `session-info-model.ts`；子任务列表 `session-subagents.ts`，复用 `lib/subagent-topology.ts` 的状态规则）；按类别估算 `packages/agent-runtime/src/context-breakdown.ts`，sidecar 方法 `agent.contextBreakdown`，Main 通道在 `project-resources-ipc.ts` |
| 提示显示在右侧 | `apps/desktop/src/components/ui.tsx` 的 `tooltipSide` |
| 图标源文件 | `apps/desktop/build/icon.svg`、`tray-icon.svg`、`logo-dark.svg` |
| 模板编辑 | `crates/host-core/src/template_editor.rs`（多层文件夹、用途）；设置页 `features/settings/ProjectTemplatesPage.tsx` → `features/project-workbench/TemplateEditor.tsx`（`TemplateManager`）、草稿逻辑 `template-draft.ts` |
| Session Orchestrator（含 `workspace`） | `plugins/session-orchestrator/` |

## mc-agent 项目管理（R1–R10）

| 功能 | 代码 |
|---|---|
| 资料目录标记、挂载、Worker 目标工作区校验 | `crates/host-core/src/db/project_resources.rs`；`project_groups.rs` 中的 `kind` 字段 |
| 资料目录创建、模板、改名跟随 | `crates/host-core/src/resource_dirs.rs`；路径改写复用 `data_relocation.rs::rewrite_database_paths` |
| 新建类型、转换与解除（R1.7） | 对话框 `apps/desktop/src/features/project-workbench/ProjectKindPicker.tsx`；转换 `ConvertToManaged.tsx`；解除 `db/project_resources.rs::detach_project_resource_root`；接回旧目录在 `resource_dirs.rs::ensure_project_resources` |
| 工作区说明（`workspaces.md`） | `crates/host-core/src/workspace_notes.rs` |
| 资料清单、确认、项目目标 | `crates/host-core/src/resource_catalog.rs`；分类索引 `resource_index.rs`（`INDEX.md`）；总索引 `resource_overview.rs`（`RESOURCES.md`）；模板元数据 `resource_templates.rs` |
| 项目任务、执行、验收 | `crates/host-core/src/project_tasks.rs` |
| RPC | `crates/host-core/src/rpc/resource_dirs_rpc.rs`、`resource_catalog_rpc.rs`、`project_tasks_rpc.rs` |
| Main IPC | `apps/desktop/electron/main/ipc/project-resources-ipc.ts`；会话信息 `mc-session-insight-ipc.ts`、系统提示词 `mc-prompts-ipc.ts`、用量 `mc-usage-ipc.ts` |
| 会话“项目目录”说明 | `packages/shared/src/project-folder-guide.ts`（三条启动路径共用） |
| 界面 | `apps/desktop/src/features/project-workbench/`（工作台、概览、资料、任务、AI 整理、模板选择） |
| 文案 | `packages/i18n/scripts/mc-agent-strings.json` 生成各语言 `mcProject` 区块 |
| 端到端测试 | `scripts/e2e-project-resources.mjs`（`pnpm test:e2e:project-resources`） |

## mc-agent 创作、会话保留与系统权限（2026-10-22）

| 功能 | 代码 |
|---|---|
| 创作跨进程契约 | `packages/shared/src/types/creative.ts`（记录类型、`CreativeMethods` 方法表、`CREATIVE_RENDERER_METHODS`）；契约测试 `apps/desktop/test/mc-creative-contract.test.mjs` |
| 创作 host-core | `crates/host-core/src/mc_creative/`：`mod.rs`（用途、存储、记录、公共辅助）、`assets.rs`（素材、分类、创作模板）、`jobs.rs`（生成任务）、`comparisons.rs`（对比集）、`schema.rs`（`mc_schema_versions` 迁移）；RPC `rpc/mc_creative_rpc.rs` |
| 创作界面拆分 | `apps/desktop/src/features/creative/use-grid-selection.ts`（选择、框选、方向键）、`use-asset-actions.ts`（导入、移动、移除、删除文件） |
| 会话保留 | 计数与来源注册 `apps/desktop/src/lib/session-holds.ts`；React 钩子 `lib/use-held-session.ts`；分栏把列注册为来源（`lib/mc-split-view.ts`），创作聊天用 `useHeldSession` |
| 系统权限 | Main `electron/main/mc-macos-permissions.ts`、`ipc/mc-permissions-ipc.ts`；页面 `src/features/settings/SystemPermissionsPage.tsx`；类型 `packages/shared/src/types/mac-permissions.ts`；helper 的分项检查在 `crates/mc-computer/src/macos/mod.rs` |
| 内置插件工具风险 | `electron/main/plugin-runtime.ts` 的 `mcpToolRisk`（只认应用自带插件目录）；manifest `mcpServers[].toolRisk` |
