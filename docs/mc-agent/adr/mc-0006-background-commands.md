# MC-ADR-0006: 后台命令与后台任务面板

**Status:** Accepted
**Date:** 2026-10-19
**Deciders:** 产品负责人

## 背景

上游的 Bash 工具必须等命令结束才返回（默认 60 秒，Agent 可设到 6 小时，ADR 0167）。开发服务器、监听、长时间构建这类命令要么一直占着这一轮直到超时，要么只能让用户自己去终端启动。Claude Code 的做法是让 Agent 把命令放到后台：立即拿到一个编号，继续干别的，之后读取新输出、需要时停掉；界面上有“后台任务”列出正在跑的东西。

mc-agent 已有在后台运行的东西（`Task` 子代理、派出的会话），但没有后台命令，也没有一个地方集中看。

## 决定

1. **Bash 增加 `runInBackground`。** 为真时命令照常经过权限审批、同一个 runner 和进程树归属（与前台 Bash 相同的启动路径），审批通过后 host-core 启动进程并立即返回 `backgroundId`，不再等待；超时不适用。只在 Agent 模式可用；远程会话、子代理（带 `permissionScope` 或 `delegationId` 的调用）和计划/目标模式一律拒绝。
2. **两个新工具。** `BashOutput { backgroundId }` 返回上次读取之后的新输出（stdout 与 stderr 合并，单次最多 32KB，超出只给最新部分并注明）和状态；`KillBash { backgroundId }` 结束进程树并等待最多 3 秒确认。两者只作用于本会话自己启动的后台命令，不需要再审批（启动它的 Bash 调用已经审批过）。它们在 Agent 模式的核心工具里，模型不必先搜索。
3. **进程由 host-core 持有。** 新模块 `crates/host-core/src/tools/background.rs`，注册表放在 `AppState`（内部锁，不占 AppState 锁）。每条命令保留最近 1MB 输出，记录启动、结束时间、状态（running / exited / killed / failed）和退出码；只有自行退出的命令才带 `exitCode`，避免对话里的工具卡片把“已停止”显示成失败。Python 输出到管道时会缓冲，后台命令默认设 `PYTHONUNBUFFERED=1`。
4. **生命周期。** 后台命令跨轮次运行，用户点“停止”这一轮不会结束它。结束的情形：命令自己退出、Agent 调 `KillBash`、用户在面板点“停止”、会话被删除、host-core 关闭（`AppState::shutdown`）。host-core 异常退出时，runner 发现控制管道关闭会结束自己的进程组，与前台 Bash 相同。
5. **数量上限。** 每个会话同时运行最多 8 条，全部会话最多 32 条；每个会话最多保留 20 条记录，超出时先删最早结束的。
6. **桌面端。** host-core 新增 `backgroundShells.list / view / kill`，Main 通过 `pi-desktop/mc-background/*` 转给渲染进程，每次调用都限定在该会话。工作面板新增“后台任务”分区（MC-ADR-0005 的分区之一）：列出后台命令（状态、命令、已运行时间、最近几行输出），点开看完整输出（运行中每 1.5 秒刷新），可停止；下方列出仍在运行的子代理，点开在工作面板看过程。标题栏工具图标里加“后台任务”，有命令在跑时显示数量。列表每 2 秒刷新一次。

## 备选与代价

- **只做汇总面板，不做后台命令**：改动小，但 Agent 能力不变，跑开发服务器的问题仍在。未采用。
- **用工作面板终端代替**：终端是用户自己的 shell，Agent 读不到输出，也不经过权限审批。不合适。
- **进程放在 Electron Main 或 sidecar**：会绕过 host-core 的权限、进程归属和退出清理，等于再写一套。未采用。

## 影响

- 改动上游：host-core 的 `tools/mod.rs`（注册模块）、`state.rs`（注册表、关闭时结束）、`rpc/mod.rs`（`tools.execute` 分支、会话删除、`backgroundShells.*`）；agent-runtime 的 `runtime.ts`（Bash 参数、两个工具、核心工具名单）；上游运行时测试里的核心工具列表相应调整。同步上游时这些地方可能冲突。
- 后台命令可能长期占用端口和资源；面板和 `KillBash` 是唯一的回收手段，Agent 的提示里要求用完即停。
- 打包后的安装版未测。

## 重访条件

- 上游加入后台命令或进程管理时，改为跟随上游。
- 需要在远程会话里运行后台命令时，评估远程主机通道。
