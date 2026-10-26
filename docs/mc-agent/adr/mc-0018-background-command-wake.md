# MC-ADR-0018: 后台命令结束时通知 Agent

**Status:** Accepted
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

[MC-ADR-0006](mc-0006-background-commands.md) 让 Agent 把构建、测试、开发服务器放到后台，但命令结束时没人告诉 Agent：它只能反复调 `BashOutput` 轮询；如果这一轮已经结束，就要等用户再发一句话才会接着干。子代理没有这个问题，运行时会在子代理结束后把报告交回给父代理（上游 D328）。

## 决定

1. **Electron Main 监听结束。** host-core 每次后台任务变化都会发 `backgroundTasks.changed`；`mc-background-wake.ts` 收到后重新列出任务，找出从运行中变为 `exited` 或 `failed` 的命令。`stopped`（用户在任务栏停止、Agent 调 `KillBash`、会话删除）不通知；应用启动前就已结束的不通知。
2. **一条通知，三种送达。** 同一会话 1.5 秒内结束的命令合成一条通知，内容是命令、退出码和最后约 2000 字符的输出。会话正在运行时作为插话送进当前这一轮；这一轮已不接受插话就排进队列；会话空闲时开新的一轮。
3. **通知自称自动。** 通知以 “[Automatic notice, not a message from the user]” 开头，在对话里显示为一条用户消息，模型不会把它当成用户的新要求。
4. **防止循环。** 同一会话 10 分钟内最多唤醒 5 次，超过的只记日志。
5. **提示词。** Bash 和 `BashOutput` 的工具描述改为：命令结束会自动通知，不要 sleep 或循环轮询。

## 影响

- 新增 `apps/desktop/electron/main/mc-background-wake.ts`（含测试）；`mc-background-ipc.ts` 增加注册函数。
- 改动上游：`runtime/host.ts` 的 `backgroundTasks.changed` 分支多调一次 `emitBackgroundTasksChanged()`；`ipc/register.ts` 多一处注册；`runtime.ts` 里 Bash / `BashOutput` 描述各改一句。
- 空闲会话会被自动唤醒，会消耗一轮模型调用；只对 Agent 自己启动的后台命令生效。
- 未用真实模型端到端运行；通知的投递路径（插话、排队、新一轮）复用现有的 `agentSteer` / `agentQueuePush` / `agentPrompt`。

## 重访条件

- 用户反馈自动唤醒打扰时，加设置开关，或只在命令失败时唤醒。
- 需要在对话里把通知和用户消息区分显示时，给消息加专门的字段（host-core 的 `UiMessage` 要随之扩展）。
