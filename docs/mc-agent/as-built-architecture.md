# 现状架构

R17 增量：[语音输入](voice-input.md)由 Renderer 采集麦克风，Main 持有凭据并发起转写请求。Codex 仅由 Main 协商 SDP，媒体走 WebRTC；不挂载 Agent 工具。与实时通话共用麦克风租约，录音不落盘。

本文描述仓库里已经在的代码。上游基线与 mc-agent 当前状态分开写：下面的进程与模块图是上游 0.20.1 的结构；mc-agent 新增的模块按功能列在[代码索引](code-index.md)，增量设计见[架构文档](architecture.md)和 [MC-ADR-0002](adr/mc-0002-fork-pi-desktop.md)。

许可 LGPL-3.0-or-later。目录（2026-10-22 核对，见[工程结构评审](engineering-structure-review.md) 7.1）：

| 目录 | 安装版 mc-agent | 开发版 | 上游 PI-Desktop（历史基线） |
|---|---|---|---|
| 应用数据（host-core 数据库、日志、插件） | `~/.mc-agent` | `~/.pi-desktop-dev` | `~/.pi-desktop` |
| Electron userData | `~/Library/Application Support/mc-agent` | `…/PI-Desktop Dev` | `…/PI-Desktop` |
| 资料根目录（模板、项目资料目录） | `~/Documents/mc-agent`（`MC_AGENT_HOME` 可覆盖） | 同左 | 无 |

`PI_DESKTOP_DATA_DIR` 可覆盖应用数据目录。项目是逻辑分组，没有唯一的物理目录；资料目录、工作区、创作存储（`<所选目录>/creative/`）都是它关联的位置。

## 进程

```text
React 渲染进程          apps/desktop/src
    │ preload 白名单 IPC   apps/desktop/electron/preload
Electron Main            apps/desktop/electron/main
    ├─ stdio JSON-RPC ── Rust host-core     crates/host-core
    │                      二进制 pi-desktop-host-core
    │                      SQLite、权限、工具、插件登记、凭据
    └─ stdio NDJSON ──── Node agent sidecar  packages/agent-runtime
                           pi-ai + pi-agent-core + pi-coding-agent
                           调模型；工具请求经 Main 转回 host-core

可选，远程实验：
apps/pi-host
    本机 loopback RACP-WS
    SSH 只做网络边界
    远端同样拉起 host-core + agent-runtime
    内部 host-core RPC 不暴露到网络
```

渲染进程不读 SQLite，不拿模型密钥，不直接跑特权工具。Agent 循环不在窗口进程里。同一份 host-core 进程被 Main 持有，sidecar 通过 Main 代理访问它，避免两个写库进程。

## 层

| 层 | 路径 | 职责 |
|---|---|---|
| 界面 | `apps/desktop/src` | React 页面、聊天、设置、工作面板 |
| 壳 | `apps/desktop/electron` | 窗口、托盘、IPC、OAuth、更新、远程 SSH |
| 契约 | `packages/shared` | IPC 名、共享类型、错误码 |
| 编排 | `packages/host-runtime` | 与 Electron 无关的 sidecar 监督、回合事件、工作区文件 |
| 循环 | `packages/agent-runtime` | Pi 适配、压缩、子代理、工具声明、sidecar 入口 |
| 无头 Host | `packages/agent-host` | 准入、回合队列、审批、事件日志 |
| 远程协议 | `packages/racp` | RACP-WS 服务端/客户端、设备令牌配对 |
| 特权后端 | `crates/host-core` | 持久化与工具执行 |
| 远程进程 | `apps/pi-host` | 无头 Host：RACP + agent-host + runtime + host-core |
| 插件 | `packages/plugin-sdk`、`plugin-devkit` | 作者类型、打包、校验 |
| 文案 | `packages/i18n` | 英文源目录 |
| 语音 | `packages/voice-runtime` | 本地转写，与实时通话适配器分开 |

## 两条通道

Host RPC：`crates/host-core/src/rpc/mod.rs` 读 stdin 上的 JSON-RPC。Electron 侧启动在 `apps/desktop/electron/main/host-process.ts`。只有 Rust 写 SQLite 和 provider 持久化。

Agent sidecar：`packages/agent-runtime/src/sidecar.ts` 注明协议是与 Electron main 之间的 NDJSON JSON-RPC。Host 访问经 `parent-host-proxy.ts` 转回 Main，再进唯一的 host-core。循环入口在 `runtime.ts`，底层是 `@earendil-works/pi-agent-core` 1.1.0，并依赖 `pi-ai`、`pi-coding-agent`。补丁在 `patches/`。

这不是 MC-ADR-0001 里那套自建 `thread/start` 协议，也不使用 Pi 自己未完成的 CBOR server。

## 不变量

- 执行目录属于会话或 worktree，不跟界面当前选中的项目组漂移。
- 项目组 ID（字符串）和 `projects` 表 ID（整数）不是同一个东西。legacy 项目还有按路径的映射。见规划架构文档第 4 节。
- 远程断开时工具失败，不回退到本机文件系统。重连不重放写操作。
- 插件运行时目标是独立进程（ADR 0008）。渲染进程只拿 preload 允许的 IPC。

## 和规划文档的关系

[architecture.md](architecture.md) 写的是项目管理增量该接在哪；这些模块已经建好（R1–R14），文件位置见[代码索引](code-index.md)。本文的进程与模块图仍以上游结构为准。
