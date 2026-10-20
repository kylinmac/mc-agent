# MC-ADR-0010: 系统提示词查看与模板

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** 产品负责人

## 背景

系统提示词此前不可见，只能用 pi 兼容的 `SYSTEM.md`（替换身份）/ `APPEND_SYSTEM.md`（附加）文件定制，项目级优先于全局，没有界面，也不能按模型区分。不同模型适合不同的提示词，不同项目也有各自的要求。

## 决定

1. **查看。** 信息栏“上下文”里的“系统提示”可点开查看本对话实际发送的系统提示词，按段落（基础提示、已激活工具、插件技能、模式与项目上下文）分块、可折叠、可全部复制，并注明命中的模板。查看前先按当前配置重新准备运行时，显示的就是下一条消息会发送的内容。
2. **模板。** 设置新增“系统提示词”页：模板由“身份”（替换默认身份，留空保留）和“附加规则”（追加在基础提示之后、项目指令之前）组成。运行规则、项目 AGENTS.md 和项目记忆始终保留，模板不能替换。
3. **覆盖而非叠加。** 一个对话只用一个模板，整体生效：先看项目规则（对话所在项目的任一目录），再看模型规则（模型名，`*` 通配，不区分大小写；具体型号优先于通配，通配中字面更长的优先），最后全局默认；都不匹配时沿用 `SYSTEM.md` / `APPEND_SYSTEM.md` 文件，再没有就是内置提示。暂不做“项目 + 模型”组合规则和单个对话的临时覆盖。
4. **存储。** 模板和规则作为一个文档存在 host-core 数据库（`kv` 命名空间 `mc.systemPrompts`），`mcPrompts.get / set` 读写并校验（模板 ≤ 50 个、每段 ≤ 64KB、规则 ≤ 200 条、引用的模板必须存在、模式与项目不重复）。Electron main 在启动会话时解析命中的模板，替换 `customSystemPrompt`；配置变化会让运行时在下一条消息前重建。

## 影响

- 改动上游：agent-runtime `runtime.ts`（`systemPromptView`）、`sidecar.ts`（`agent.systemPrompt`）、`runtime/session-launch.ts`（解析模板）、`ipc/project-resources-ipc.ts`、设置导航 `lib/settings-search.ts` 与 `features/settings/SettingsPage.tsx`；新增 `crates/host-core/src/mc_prompts.rs`、`electron/main/mc-system-prompts.ts`、`features/settings/SystemPromptsPage.tsx`、`features/session-info/SystemPromptDialog.tsx`。
- 对话中切换模型可能换模板，那一次请求不能复用提供商的提示缓存。

## 重访条件

- 需要“项目 + 模型”组合或单对话覆盖时再加。
- 上游提供自己的系统提示词管理时改为跟随。
