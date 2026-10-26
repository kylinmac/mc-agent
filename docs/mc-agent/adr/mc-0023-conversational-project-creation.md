# MC-ADR-0023: 用对话新建项目

**Status:** Accepted
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

新建项目要打开对话框，自己选文件夹、选类型和模板。用户想直接说“我要做一个什么样的项目，放在哪”，由 Agent 选位置、挑模板，没有合适的模板就现做一套。交互方案（入口、卡片、流程）已由用户确认：主入口在首页输入框，目录、模板和方案这几处要用户拍板的地方用卡片，Agent 新做的模板默认只用这一次，建完不自动写需求文档。

## 决定

1. **两个工具加一个内置技能。** 在 Agent 模式的本地会话里提供：
   - `ProjectTemplates`：只读，列出现有的资料目录模板（名称、说明、目录及说明）、系统提示词模板，以及建议的父目录：用户在 设置 → 项目模板 里设的“新项目位置”排在最前（可设多个，每个带一句用途说明，第一个为默认；Agent 按说明挑最合适的，挑不出用默认；存在数据目录的 `mc-project-defaults.json`），其后是已有项目所在的目录和用户主目录。
   - `CreateProject`：提交一份方案，内容包括名称、位置、按匹配度排序的模板，或者 Agent 起草的模板，以及系统提示词。

   内置技能 `mc-agent/new-project` 教 Agent 走这套流程。三个工具都由 Electron Main 实现，属于 host-local 工具。
2. **卡片就是确认。** `CreateProject` 不直接动磁盘，而是在输入框上方弹出方案卡片，一直等到用户操作，用法和 `Ask` 卡片相同。卡片分三步：
   - **位置**：可以改文件夹名，“换个位置…”打开系统选择框。卡片会检查目录是否存在、是否为空、是不是已有项目、能不能写入。
   - **模板**：现有模板，或者 Agent 起草的模板草稿，或者只建文件夹。
   - **确认方案**。

   Agent 只给了一个模板时跳过模板步骤。用户点“创建”之前磁盘上什么都不写。用户选“让 Agent 新做一套”或“改一改”时，工具会把用户的选择交回 Agent，由 Agent 继续对话。
3. **创建复用现有路径。** 渲染进程依次调用已有的 IPC：
   - 新建文件夹（新增）。
   - `project.group.create`。
   - `project.resources.ensure`，或者先保存模板再 ensure。
   - 系统提示词的目录规则。

   项目建好后加进侧栏，但不切走当前对话。中途失败会停在出错的那一步；如果文件夹是这次新建的且仍然为空，就删掉它。
4. **只用这一次的模板。** host-core 新增 `project.resources.ensureDraft`，按草稿在资料目录里建出目录，草稿本身另存一份到 `.mc-agent/template.json`。`project.json` 记 `oneOff: true`，分类说明从这份副本里读，模板管理里看不到它。只有用户选“保存为模板并使用”，草稿才进模板库。草稿里的系统提示词会存成一个以项目命名的提示词模板，并为项目目录加一条规则，按 MC-ADR-0010 生效。
5. **入口。**
   - **首页输入框**：输入内容像是要建项目时，输入框上方出现建议条。点“作为新项目创建”，就带着技能把这条消息发出去；点“只是聊聊”关掉建议条。
   - **新建项目对话框**：新增“用对话新建”选项。
   - **侧栏“项目”右键菜单**：新增一项入口。
   - **`/` 菜单**：可以选这个技能。

   后三个入口都会回到首页，并把输入框切换到新项目模式。
6. **交接。** 建好后，对话里会出现完成卡片，上面有“打开项目”和“在项目里继续”两个按钮。后者把这段对话移到新项目下，要等这一轮结束后才能点。
7. **权限。** host-core 把两个工具都列为低风险。`CreateProject` 写盘之前必须经过用户点击卡片，卡片本身就是审批；位置限定为本机绝对路径。远程会话和非 Agent 模式不提供这两个工具。

## 影响

- 新增：
  - `packages/shared/src/mc-project-proposal.ts`
  - `packages/agent-runtime/src/mc-project-tools.ts`
  - `apps/desktop/electron/main/mc-project-create.ts`（含 IPC 和测试）
  - `apps/desktop/src/features/project-create/`
  - `resources/skills/new-project.md`
  - host-core `project_draft_template.rs`
- 改动上游文件，每处都只是接线：
  - `runtime.ts`：工具名单、描述、参数。
  - `runtime/sidecar.ts`：注册。
  - `permissions.rs`、`tools/mod.rs`、`rpc/mod.rs`。
  - `Composer.tsx`：卡片位置和首页建议条。
  - `useComposerSubmit.ts`：发送时可以加前缀。
  - `AssistantTurn.tsx`：完成卡片。
  - `Sidebar.tsx`：右键菜单项。
- 还没有用真实模型验证 Agent 是否按流程调用。

## 重访条件

- 如果建议条误报太多，就改成只靠明确入口触发。
- 如果需要建在远程主机上，再给位置卡片加主机切换。
