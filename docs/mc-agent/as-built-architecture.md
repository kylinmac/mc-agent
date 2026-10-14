# 现状架构

本文描述仓库里已经在的代码，不是 R9–R15 的增量设计。增量放在哪，见 [架构文档](architecture.md) 和 [MC-ADR-0002](adr/mc-0002-fork-pi-desktop.md)。

产品名仍是上游 `pi-desktop` 0.20.1。许可 LGPL-3.0-or-later。数据目录默认 `~/.pi-desktop`（`PI_DESKTOP_DATA_DIR` 可覆盖）。

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

[architecture.md](architecture.md) 写的是项目管理增量（R9–R15）该接在哪。那些模块还没建。本文只索引已经存在的上游代码。
