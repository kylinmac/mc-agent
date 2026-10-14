# MC-ADR-0001: 采用 ChatGPT.app 的进程架构，第一版内核用 Pi

**Status:** Superseded by [MC-ADR-0002](mc-0002-fork-pi-desktop.md)
**Date:** 2026-10-14
**Deciders:** 产品负责人

## Context

要对标的三款桌面 agent，循环都不在界面里，但边界不一样：

- Claude Desktop：Electron 壳只画标题栏。主内容是 `WebContentsView` 加载 `https://claude.ai`。循环在另拉起的 `claude` 二进制里，通道是 stdio JSONL。界面和内核绑在同一家的网页产品上，换内核就要动网页。
- ChatGPT.app：Electron 壳 + 本地 React。主进程 `spawn` 安装包里的 `codex`，默认 **JSON-RPC over stdio**（`app-server`）。界面不包含任何 agent 实现。审批是内核发起的 request，必须能归到 `threadId` + `turnId`。内核可以单独升级。
- grok-app：Tauri/Rust Host，`spawn grok agent stdio`，ACP JSON-RPC。同样是「Host 不是循环」。

目标是自己的桌面产品，后面要能换内核（Pi、自研、以后再接别的二进制），界面和会话列表不能跟着内核重写。

Pi 的循环在 `packages/agent`（`@earendil-works/pi-agent-core`）的 `runLoop`。它是库：调用方持有 `AgentState`，工具可按名字开关，`customPrompt` 可以整段换掉默认提示词。它不要求改调用方的工程结构。

Pi 自己的 `packages/server` **不含** `pi-agent-core`，本仓没有把 loop 跑起来的 server 实现。`AgentHarness` 全部返回 `HarnessNotImplemented`，不是运行路径。所以不能把 Pi 的 CBOR client/server 当成产品协议。

## Decision

1. 产品架构采用 ChatGPT.app 的形状：本地界面 + Host 进程 + 独立内核进程。通道是 newline-delimited JSON-RPC over stdio。默认不用 unix socket。
2. 第一版内核进程内部调用 Pi 的 `pi-agent-core`（`Agent.prompt` → `runLoop`）。只依赖 `packages/agent` 和 `packages/ai`。不依赖 `coding-agent`、`tui`、`server`、`client`。
3. 界面、Host、协议类型三者都不 import Pi。换内核只换内核进程。
4. 权限、提问、计划确认都是内核发起的 request，带 `threadId` 和 `turnId`。Host 只负责弹窗并回 `{id, result}`。

## Options Considered

### Option A: ChatGPT.app 形状 + Pi 内核（本决定）

| Dimension | Assessment |
|-----------|------------|
| Complexity | 中。要自己写一层很薄的 JSON-RPC 适配，Pi 没有现成 app-server |
| Cost | 低。无 Chromium 以外的新运行时；内核就是 Node 进程 |
| Scalability | 多前端（App / CLI / CI）可以共用同一条协议 |
| Team familiarity | 高。协议形状已在 Codex 分析里对过 |

**Pros:** 界面和循环解耦；Pi 对调用方侵入小，适合作第一版内核；以后换成别的二进制不用改 UI。
**Cons:** Pi 的工具、会话 jsonl、提示词装配在 `coding-agent` 里，不能直接拿来用，要在内核进程里自己接一层。

### Option B: 照 grok-app，Host 用 Rust/Tauri，内核仍是外部 CLI

| Dimension | Assessment |
|-----------|------------|
| Complexity | 高。壳、权限、文件预览都要在 Rust 里重做 |
| Cost | 中。跨平台 WebView 行为不一致 |
| Scalability | 和 Option A 同类，但 Host 语言把 UI 迭代拖慢 |
| Team familiarity | 低。现有分析材料都是 Electron 主进程 + JS 渲染 |

**Pros:** 安装包小，系统 WebView。
**Cons:** 第一版要同时学 Tauri 和 Pi，边界收益不大。ChatGPT 的可复制部分是进程和协议，不是 Rust。

### Option C: 把 Pi 嵌进渲染进程或 Electron 主进程

| Dimension | Assessment |
|-----------|------------|
| Complexity | 低，短期最少代码 |
| Cost | 低 |
| Scalability | 差。UI 崩溃即循环崩溃；无法单独升级内核；第二个前端要再嵌一次 |
| Team familiarity | 高 |

**Pros:** 没有协议层。
**Cons:** 这是在否定 ChatGPT 架构。Pi 的「侵入小」会被浪费掉：一嵌进 UI，后面换内核就要拆 UI。

## Trade-off Analysis

选 ChatGPT 而不是 Claude，是因为主界面必须是本地包。Claude 的主内容在 claude.ai，产品边界不在我们手里。

选 ChatGPT 而不是 grok-app，是因为要复制的是「spawn 内核 + JSON-RPC」，不是 Tauri。Host 用 Electron 主进程即可，和已分析的 ChatGPT.app 同构。

选 Pi 而不是先写自己的 loop，是因为 `runLoop` 已经有双层 while、流式替换、并行工具、steer。这些不是产品差异点。产品差异点在协议、权限归属、会话列表。Pi 作为库调用，不要求我们采用它的目录、TUI 或未完成的 server。

不采用 Pi 的 CBOR 协议。那条协议的 server 端没有 loop，快照模型也和 app-server 的 thread/turn 不一样。产品协议向 ChatGPT 的 app-server 对齐，Pi 只待在适配器里面。

## Consequences

- 更容易：换内核、加第二个前端、内核单独版本号。
- 更难：第一版要维护一份最小 JSON-RPC（initialize、thread、turn、item 事件、审批回填）。不能假装 Pi 已经提供了这条协议。
- 要重访：工具面。Pi 内置 7 个工具、默认开 4 个，执行器在 `coding-agent`。内核适配器要自己注册工具，不能把 `coding-agent` 整包拖进来。
- 要重访：会话落盘。Pi 的 jsonl 属于 `coding-agent` 的 `SessionManager`。产品会话记录由 Host 按协议事件写，不读 Pi 的私有文件格式。

## Action Items

1. [ ] 定最小协议：`initialize`、`thread/start`、`turn/start`、`turn/steer`、`turn/interrupt`、`item/*` 通知、`item/tool/requestApproval`（内核→Host，带 `threadId`+`turnId`）
2. [ ] 内核进程只包 `pi-agent-core` + `pi-ai`，入口调用 `runLoop`
3. [ ] Host 只 spawn 该进程并读写 stdio，渲染进程不出现 Pi 的包名
4. [ ] 协议变更写 MC-ADR-0002，不要改本文件的 Decision

以上待办随 MC-ADR-0002 作废，不再执行。
