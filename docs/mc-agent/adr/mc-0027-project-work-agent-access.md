# MC-ADR-0027：Agent 读写项目任务与资料

日期：2026-11-08。状态：已确定。

## 背景

项目任务和资料目录只有工作台界面，用户需要在对话和工作台之间手工转录（[kylinmac/mc-agent#104](https://github.com/kylinmac/mc-agent/issues/104)）。直接开放全部 RPC 或每轮注入看板，会越过权限边界并占用上下文。

## 决定

新增按需工具 ProjectTasks（list / get / create / update）和 ProjectResources（list / get / register / goal），走一个 host-core 方法 `session.projectWork`。沿用 ProjectHistory 的绑定方式：Runtime 绑定调用会话，sidecar 只转发已启动的会话，host-core 由会话的项目路径确定本机项目组；参数中不接受项目 ID。修改沿用任务 revision 冲突检查。启动、取消、重开、验收、资料确认与废弃、移除登记、改项目目标不提供动作。计划与目标模式只读，子代理不继承。

## 影响

Agent 可以在同一项目内新建、修改任务及登记资料草稿，可写范围扩大但不触及用户的验收与确认决定。返回内容有条数与长度上限，截断会标明。DeepSeek Flash 固定声明路径每次请求约增加 1,000 token。SQLite 仍只由 host-core 访问，不改 schema，原有 `project.tasks.*`、`project.resources.catalog.*` 行为不变。契约与输出约束见[项目任务与资料的 Agent 入口](../project-work-agent-access.md)。
