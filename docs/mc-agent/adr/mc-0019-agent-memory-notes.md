# MC-ADR-0019: Agent 自己记到项目记忆

**Status:** Accepted
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

项目记忆（上游的项目组记忆，条目为标题加正文）会在每次会话启动时放进系统提示，但只有用户能写。用户在对话里纠正过的做法、说明过的约束，下一次会话就忘了，只能靠用户自己去记忆面板抄一遍。

## 决定

1. **新工具 `Remember { title, content }`。** 只在 Agent 模式、且会话属于本地项目时提供（远程工作区没有）。Electron Main 实现（与 `SaveCreativeAsset` 相同的 host-local 工具），写进会话所属项目组的记忆；不在项目组里的旧项目写到该目录的记忆。
2. **与用户的条目并列，用 id 区分。** Agent 写的条目 id 以 `agent-` 开头。同标题（不分大小写）再次保存是替换，正文为空是删除；只能改删自己写的，用户的条目碰不到。每个项目最多 40 条 Agent 条目，标题不超过 80 字，正文不超过 2000 字。
3. **记什么写进工具描述。** 记用户给出的偏好和纠正（附原因）、项目的决定和约束、要用到的外部资源；不记代码结构、仓库里已有的内容、临时任务状态和任何机密。
4. **用户看得见。** 记忆面板里 Agent 的条目序号显示为 “AI”，悬停有说明，可以像其他条目一样修改或删除。
5. **权限。** host-core 把 `Remember` 列为低风险：只写本应用里的项目记忆，用户随时可改。
6. **并发保存。** `Remember` 通过 `project.group.context` 解析项目归属，保存携带刚读取的 `expectedMemory`。host-core 在同一状态锁内比较完整快照再写入；不一致返回 `MEMORY_CONFLICT`，工具重新读取、合并，最多尝试 3 次。只比较时间戳不足以区分同一毫秒的修改。已有界面整份替换接口保持兼容；此规则防止工具读写之间覆盖其他会话或用户的新修改，不替代界面编辑器的版本冲突管理。

## 影响

- 新增：`packages/shared/src/mc-agent-memory.ts`、`packages/agent-runtime/src/mc-memory-tool.ts`、`apps/desktop/electron/main/mc-agent-memory.ts`（含测试）。
- 改动上游：`runtime.ts`（工具名单、描述、参数各一处）、`runtime/sidecar.ts` 注册一行、host-core `permissions.rs` 与 `tools/mod.rs` 各一行、`ProjectMemoryDialog.tsx` 的序号。
- 新记下的条目从下一次会话起生效；当前会话里 Agent 本来就知道。
- 未用真实模型验证 Agent 是否会恰当地调用它。

## 重访条件

- Agent 记得太多或太杂时，改为先提议、用户确认后再写入。
- 需要跨项目的个人偏好时，另设全局记忆。
