# 功能代码索引

对照仓库里的现有代码。路径相对仓库根。测试文件不列入，除非它是该功能唯一的入口说明。

规划中的项目资料、项目任务、验收（R9–R15）没有对应代码。不要到下面的路径里找它们。

## 启动与窗口

| 功能 | 代码 |
|---|---|
| Electron 主入口 | `apps/desktop/electron/main/index.ts` |
| 启动、生命周期、关窗行为 | `apps/desktop/electron/main/bootstrap/` |
| preload / IPC 白名单 | `apps/desktop/electron/preload/index.ts` |
| IPC 注册 | `apps/desktop/electron/main/ipc/register.ts` |
| 应用 IPC（窗口、菜单、更新） | `apps/desktop/electron/main/ipc/app-ipc.ts`、`window-ipc.ts` |
| 托盘、未读角标 | `tray-sessions.ts`、`taskbar-unread-badge.ts` |
| 更新 | `updater.ts`、`update-policy.ts`、`update-cache.ts` |
| 单实例与数据目录 | `data-paths.ts`、`installation.ts`；Rust 侧 `PI_DESKTOP_DATA_DIR` 在 `crates/host-core/src/main.rs` |

## 聊天与会话

| 功能 | 代码 |
|---|---|
| 聊天界面 | `apps/desktop/src/features/chat/` |
| 转录渲染 | `features/chat/transcript/` |
| 输入框、斜杠命令、粘贴 | `features/chat/composer/`；主进程 `composer-mcp.ts`、`composer-paste.ts`、`composer-picker.ts` |
| 会话列表与页 | `features/sessions/`、`ipc/session-ipc.ts` |
| 会话启动 | `electron/main/runtime/session-launch.ts`、`session-coordination.ts` |
| 回合事件与落盘协作 | `packages/host-runtime/src/turn-events.ts`、`turn-persistence.ts`、`runtime-service.ts` |
| 无头回合队列、审批、事件日志 | `packages/agent-host/src/` |
| Rust 会话与转录 | `crates/host-core/src/sessions/`、`transcripts.rs`、`turn_queue.rs` |
| 会话搜索 | `session_search.rs`；主进程 `services/session-search.ts` |
| 会话协作 | `session_collaboration/`；主进程 `services/session-collaboration.ts` |

## Agent 循环

| 功能 | 代码 |
|---|---|
| sidecar 进程入口 | `packages/agent-runtime/src/sidecar.ts` |
| 运行时包装 | `runtime.ts` |
| 压缩 | `compaction-*.ts`、`pi-runtime-compaction-*.ts`、`context-budget.ts` |
| 系统提示词与项目说明 | `custom-system-prompt.ts`、`project-instructions.ts`、`mode-prompts.ts` |
| 子代理 | `subagent.ts`、`subagent-definitions.ts`、`delegation-*.ts` |
| 思考级别 | `thinking-level.ts` |
| 主进程拉起 sidecar | `electron/main/agent-sidecar.ts`、`runtime/sidecar.ts` |
| sidecar 监督（不依赖 Electron） | `packages/host-runtime/src/agent-sidecar.ts`、`runtime-supervisor.ts` |
| Pi 包版本与补丁 | `packages/agent-runtime/package.json`、`patches/` |

循环本体在依赖 `@earendil-works/pi-agent-core`，不在本仓库。

## 模型与账号

| 功能 | 代码 |
|---|---|
| Provider 持久化 | `crates/host-core/src/providers/` |
| 模型目录 | `electron/main/models-dev-catalog.ts`、`pi-model-metadata.ts`、`vendor-live-models.ts` |
| OAuth | `oauth.ts`；IPC `ipc/provider-ipc.ts` |
| 密钥 | `crates/host-core/src/secrets.rs` |
| 传输重试、代理 | `packages/agent-runtime/src/provider-retry.ts`、`provider-transport-recovery.ts`、`socks5.ts`、`system-proxy-relay.ts` |
| 从 Claude / Codex / OpenCode / Pi 导入 | `electron/main/importers/` |

## 工具、权限、工作区

| 功能 | 代码 |
|---|---|
| 工具执行入口 | `crates/host-core/src/tools/mod.rs` |
| Shell | `tools/shell.rs` |
| Grep | `tools/grep_rg.rs` |
| 按行哈希编辑 | `tools/hashline/` |
| 权限 | `permissions.rs`；插件权限 `plugins/permissions.rs` |
| 工具预算 | `tool_budget.rs` |
| 工作区根 | `workspace.rs`；主进程 `workspace-roots.ts`、`workspace-git.ts` |
| 文件索引与 diff | `packages/host-runtime/src/workspace-files.ts`、`workspace-diff.ts`、`fs-index.ts` |
| 工作面板 UI | `apps/desktop/src/components/workpanel/` |
| 内嵌浏览器 | `electron/main/browser-host.ts`、`browser-view.ts`、`browser-cdp.ts` |
| MCP | `mcp-registry-catalog.ts`、`mcp-stdio-launch.ts`、`mcp-oauth.ts`；IPC `ipc/mcp-ipc.ts` |

host-core 也可作为内部工具子进程启动（`tools::INTERNAL_TOOL_RUNNER_FLAG`，见 `main.rs`）。

## 插件

| 功能 | 代码 |
|---|---|
| 安装、清单、市场、校验 | `crates/host-core/src/plugins/` |
| 插件运行时与面板宿主 | `electron/main/plugin-runtime.ts`、`plugin-panel-host.ts`、`plugin-view-host.ts` |
| 渲染槽位 | `apps/desktop/src/plugins/` |
| 插件页 | `apps/desktop/src/pages/PluginsPage.tsx`、`features/plugins/` |
| 作者 SDK / 打包 | `packages/plugin-sdk`、`packages/plugin-devkit` |
| 技能 | `crates/host-core/src/user_skills/`；主进程 `builtin-skills.ts`、`skill-market-catalog.ts` |

## 项目、worktree、计划、定时

| 功能 | 代码 |
|---|---|
| 项目页 | `apps/desktop/src/pages/ProjectsPage.tsx`、`features/projects/` |
| 项目组数据 | `crates/host-core/src/db/project_groups.rs` |
| worktree | `session_worktrees/`；IPC `ipc/worktree-ipc.ts`；UI `features/worktree/` |
| 计划 | `plans/`；编排 `packages/host-runtime/src/plan-execution.ts`、`plan-dispatch.ts` |
| 会话待办 | `todos.rs`；UI `features/chat/todos/` |
| 定时任务 | `scheduled/`；UI `pages/ScheduledPage.tsx`、`features/scheduled/` |
| 用户子代理定义 | `user_subagents/` |

`session_todo` 是会话内清单，不是规划文档里的项目任务。

## 远程 Host

| 功能 | 代码 |
|---|---|
| 无头 Host 进程 | `apps/pi-host/src/app.ts`、`cli.ts` |
| RACP | `packages/racp/src/` |
| SSH 引导与隧道 | `electron/main/remote/ssh-bootstrap.ts`、`ssh-tunnel.ts`、`pi-host-installer.ts` |
| 远程工作区工具 | `remote/remote-workspace-tools.ts`；Host 侧 `apps/pi-host/src/workspace-tools.ts` |
| 远程文件 | `apps/pi-host/src/workspace-files.ts` |
| 连接与注册 | `remote/remote-host-connection.ts`、`remote-host-registry.ts`、`remote-host-supervisor.ts` |
| 远程 UI | `apps/desktop/src/components/remote/` |

## 语音

| 功能 | 代码 |
|---|---|
| 本地转写运行时 | `packages/voice-runtime/src/` |
| 实时通话（OpenAI / Gemini / Codex 适配） | `electron/main/live-voice/` |
| 通话 UI | `apps/desktop/src/features/voice/` |
| 桌面语音服务 | `services/speech-service.ts`、`voice-service.ts` |

## 设置、同步、国际化

| 功能 | 代码 |
|---|---|
| 设置页 | `pages/SettingsPage.tsx`、`features/settings/` |
| 配置同步（加密、S3） | `crates/host-core/src/config_sync/` |
| 数据目录搬迁 | `data_relocation.rs` |
| 文案 | `packages/i18n/src/locales/`；渲染层 `apps/desktop/src/locales/` |
| 数据库 schema 与迁移 | `crates/host-core/src/db/schema.rs`、`migrations.rs` |

## IPC 对照

渲染进程能调用的通道都从 `apps/desktop/electron/main/ipc/` 注册。新增 UI 能力先加这里的 handler，再决定数据落在 host-core 还是只留在 Main。不要从渲染进程直接 spawn host-core 或 sidecar。
