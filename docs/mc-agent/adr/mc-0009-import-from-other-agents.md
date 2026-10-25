# MC-ADR-0009: 从其他智能体导入项目和对话

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** 产品负责人

## 背景

用户在 Claude Code、Codex 和 PI-Desktop 里已经有很多项目和对话，希望一次带进 mc-agent，并能接着聊。

上游已有会话导入的后端：Electron main 的 `importers/`（Claude Code、Codex、OpenCode、`~/.pi`）扫描并转换，`session.import` 由 host-core 写入并按路径建项目；`sessionImportScan / sessionImportRun` 通道和渲染进程 API 都在。D645 / ADR 0319 删掉了设置里的导入界面，后端保留。缺的是：入口和选择界面；PI-Desktop（`~/.pi-desktop`）这个来源；新版 Codex 的 `custom_tool_call` 记录；导入后能直接继续。

## 决定

1. **入口与界面。** 侧边栏“项目”标题旁加“从其他智能体导入项目…”按钮。对话框扫描后按项目目录分组列出对话（来源标签、对话数、最近时间），项目可展开到单个对话；可按来源筛选、按标题或目录搜索；项目级、对话级勾选和“全选”（只作用于当前筛选结果）。已导入的对话显示“已导入”、不能再选。只提供用户选的三个来源：Claude Code、Codex、PI-Desktop。
2. **PI-Desktop 由 host-core 无损复制。** 两边存储格式相同（SQLite 索引 + 每个会话一个 JSONL），新增 `mcImport.piDesktopScan / piDesktopRun`：只读打开对方数据库、用普通读取函数读对方 transcript，按原样写入本地（消息块、思考、工具调用与结果、压缩检查点），会话 id 为 `import-pi-desktop-<原 id>`，重复导入跳过；消息 id 冲突时这一条失败、不影响其他。拒绝以本机自己的数据目录为来源。
3. **Codex 新格式。** 转换支持 `custom_tool_call` / `custom_tool_call_output`（`exec`、`apply_patch`，输出是内容数组），并跳过 `developer` / `system` 角色的注入指令。Claude Code 跳过“[Request interrupted by user]”占位。
4. **能接着聊。** 其他智能体的模型在本机未配置，导入时不带原模型（Claude Code、Codex 一律清空；PI-Desktop 仅当本机有同一提供商时保留），对话用本机默认模型继续。
5. **项目出现在侧边栏。** 导入后把涉及的项目目录加入侧边栏已打开的项目（不切换当前项目），对话出现在各自项目下。

## 影响

- 改动上游：`importers/codex.ts`、`importers/claude.ts`、`importers/types.ts`、`importers/index.ts`、`ipc/session-ipc.ts`（PI-Desktop 分支、清空模型）、`src/lib/api.ts`（来源类型）、`components/Sidebar.tsx`（入口按钮）、host-core `rpc/mod.rs`；新增 `crates/host-core/src/mc_import.rs`、`electron/main/importers/pi-desktop.ts`、`src/features/project-import/`。
- 导入的是对话副本，之后两边各自独立；源数据只读。
- Codex 加密的 `compaction` 记录无法导入，被压缩掉的早期内容不在导入结果里。
- 跨多天续用的外部对话，导入后某一轮的“已处理”时长会按真实时间显示得很长。

## 重访条件

- 需要导入 OpenCode、`~/.pi` 或 mc-agent 开发版数据时，把来源加进对话框（后端已支持前两者，开发版可复用 PI-Desktop 的复制方式）。
- 上游恢复自己的导入界面时，改为跟随上游。

## 修订（2026-10-25）：Grok 本地会话（R1.8 / P1 / V39）

- 已确定：导入入口增加 Grok，读取 `~/.grok/sessions/<编码项目目录>/<会话 ID>/summary.json` 与 `chat_history.jsonl`（chat format 1）；源文件只读，不读取账号凭据、系统提示词或 SQLite 搜索索引。
- 保留标题、项目目录、时间、用户和助手文本、工具调用参数及结果。跳过 system、synthetic_reason 注入消息与加密推理。图片只显示附件占位，不访问外部 URL；不支持的格式或损坏会话明确记录扫描警告，不能作为成功导入。
- 沿用现有选择、项目分组、稳定导入 ID 和重复跳过；导入后使用 mc-agent 当前默认模型继续。无逐消息时间时使用原会话创建时间，不伪造精确时间。
- 验证：Grok 与既有导入相关的 23 项测试、desktop typecheck、i18n 构建、lint 和文档检查通过；覆盖扫描、转换、重复 ID、过滤、损坏数据和路径边界。本机数据只做读取验证，不导入正在使用的实例。

- 本机只读验证：77 个会话、16 个项目均能扫描并转换，得到 4121 条可导入记录；未写入安装版，未调用模型验证续聊。

## 修订（2026-10-25）：Codex 分段会话修复（R1.8 / P1 / V39）

- 同一 Codex session ID 的多个 rollout 文件按创建时间合并为一个候选项，转换时读取全部扫描到的分段。跨文件完全相同且带同一时间戳的记录按出现次数去重，保留单文件内的重复消息；工具调用可以跨分段匹配结果。任何分段缺失或 ID 不符时拒绝导入，避免静默导入半段。
- 优先读取 `session_index.jsonl` 最新的 `thread_name`，缺失时回退第一条真实用户消息。只含助手记录的续段不会丢弃。附件包装里的 `## My request:` 保留为用户请求，不再连同系统上下文过滤掉。
- 旧导入采用随机消息 ID，且用户可能已续聊，不能安全原地覆盖。因此新转换使用 `import-codex-v2-<session id>`；检测到旧 `import-codex-<session id>` 时显示“重新导入完整副本（保留原会话）”。旧副本及本地新增消息完全保留，新副本再次导入跳过。此功能是一次性复制，不是自动同步；扫描文件上限仍为 250，达到上限会显示原有提示。
- 本机只读验证：目标会话两个分段合为一条，标题与 Codex 一致，包含最新 Grok 需求及 PR #17 回复。与 Grok、既有导入合计 26 项测试通过；安装版界面、导入写入和模型续聊未跑。
