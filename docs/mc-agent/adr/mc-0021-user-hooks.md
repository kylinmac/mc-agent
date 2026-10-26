# MC-ADR-0021: 用户钩子

**Status:** Accepted
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

“改完自动格式化”“结束前跑一遍测试”“不许 Agent 跑某类命令”这类要求，现在只能写进提示词或项目指令，模型可能照做，也可能忘。上游的扩展可以接 `tool_call` / `tool_result` 事件，但要写插件代码。

## 决定

1. **设置 → 智能体 → 钩子。** 每条钩子是：时机、工具匹配（对工具名的正则，整名匹配；留空或 `*` 为全部；“Agent 要结束时”不看工具）、一条 shell 命令、超时（默认 60 秒，最长 600 秒）、开关。最多 50 条。Electron Main 存为数据目录下的 `mc-hooks.json`，每次会话启动读一次，修改从各对话的下一次发送起生效。
2. **三个时机。**
   - 工具调用前（PreToolUse）：退出码 2 拦下这次调用，stderr（为空时用 stdout）作为原因交给模型。
   - 工具调用后（PostToolUse）：退出码 2 把输出附在这次工具结果后面，例如格式检查失败。
   - Agent 要结束时（Stop）：退出码 2 把输出作为自动通知发回，Agent 继续干；每次发送最多续 3 轮，防止死循环。
   其他退出码、超时都忽略，坏掉的钩子不会卡住一轮。
3. **执行环境。** 在会话的工作目录（隔离会话为其 worktree，否则为项目目录）里用用户的 shell 运行（macOS/Linux 为 `$SHELL -lc`，Windows 为 `cmd /c`），超时杀整个进程组。事件经环境变量传入：`MC_HOOK_EVENT`、`MC_TOOL_NAME`、`MC_TOOL_INPUT`（JSON）、`MC_TOOL_RESULT`、`MC_LAST_REPLY`、`MC_SESSION_ID`、`MC_PROJECT_DIR`，每个值最多 64KB。
4. **范围。** 只对主 Agent 在本地项目会话里的工具调用生效；没有项目的会话、远程工作区、子代理的调用不跑钩子。钩子是用户自己配置的命令，不再经过权限审批。

## 影响

- 新增：`packages/shared/src/mc-user-hooks.ts`、`packages/agent-runtime/src/mc-user-hooks.ts`（含单元测试和经过真实运行时的测试）、`apps/desktop/electron/main/mc-user-hooks-store.ts`、`features/settings/HooksPage.tsx`。
- 改动上游：`runtime.ts`（选项、复用比较、工具调用前后、两处结束点各一处）、`sidecar.ts` 参数、`session-launch.ts` 一行、`register.ts` 两个 IPC、`protocol.ts` 两个通道、设置导航与搜索索引。
- 钩子的命令以用户身份运行，能做用户能做的任何事；只应添加自己理解的命令。
- 未在真实模型的会话里跑过钩子；运行时测试用脚本化的模型覆盖了拦截和继续两条路径。

## 重访条件

- 需要按项目区分钩子时，支持项目目录里的配置文件。
- 子代理也需要钩子时，接到子代理的工具调用路径。
