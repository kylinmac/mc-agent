# mc-agent 架构审查与迭代入口

2026-11-22。审查基点为 `c50eb9f07`。范围涵盖桌面壳、导入、Agent 循环、Rust 宿主、无头与手机接入、插件和开发检查。逐条核对关键入口、调用方及测试，运行结果记录在本次 PR 的验证栏。

## 从案例移植了什么

参考目录为本机 `agent-study/ai-dev-case-studies`。tty7 的 `.github/scripts/check-host-boundary.sh` 把宿主边界变成能失败的检查；openidea 的 `.agents/skills/issue-fix/SKILL.md` 用用户操作复现并验收修复。在 mc-agent 中，前者对应本地与 CI 共用的 `pnpm check:architecture`，后者对应下面的导入、恢复和设置回归用例。界面已有组件、样式变量和目录规则，继续沿用 `apps/desktop/src/AGENTS.md`。

## 源码审查与处置

| 用户路径 | 状态或权限归属 | 本次处置与验证入口 |
|---|---|---|
| 窗口调用宿主 | Preload 控制通道，Main 编排，Rust 执行特权操作 | 统一窗口和 Preload 对错误信封 `Result<T>` 的声明。依赖检查覆盖 Renderer、shared 和供浏览器使用的语音子入口 |
| 批量导入对话、模型配置 | Main 持有本轮扫描清单，Rust 写入目标数据 | 会话只回传公开字段，按来源和外部 ID 匹配。旧版本导入 ID 继续去重。重扫、重新注册、批量执行中更换宿主由 `session-import-ipc.test.mjs` 覆盖 |
| 添加或迁移技能、MCP | Main 识别来源，Rust 注册表拥有配置、启用状态及项目作用域 | 19 个 RPC 方法移入能力模块。导入结果使用宿主最终状态；停用状态写入失败时不会发布新定义。真实宿主测试覆盖项目间及全局迁移，设置页测试覆盖点击导入 |
| 会话、插件、工作区等 IPC 跨过一次等待 | 每次调用使用启动它的宿主或 sidecar | 去掉九个注册模块中会被下一次请求覆盖的后端引用。批量粘贴 MCP 时插入一次重启与第二个 IPC，验证原批次的两个条目都留在原宿主 |
| Agent 恢复对话和子代理 | agent-runtime 负责恢复提供给模型的内容，host-core 负责保存记录 | 共用工具结果解析，覆盖资源文本、链接、图片与旧版 Read 结果。子代理回归直接检查恢复后的模型消息，沿用原工具调用 ID 与 ToolSearch 元数据规则 |
| 保存应用偏好 | Rust 拥有合并、校验、旧值修复和写库，Main 应用桌面副作用 | `settings.get/set` 交给独立模块。无效写入返回既有 `INVALID_PARAMS`；历史非对象值首次读取时恢复默认。RPC 测试核对原偏好及落库值 |
| 无头、远程、手机和插件 | `apps/pi-host` 与桌面共用 `host-runtime`、`agent-host`。手机网关经 Main 分发，插件经独立进程调用受控能力 | 无头包加入反向依赖检查。对照了手机桥与插件加载和卸载入口；无头配对、读取工作区、断线重连可用 `pnpm test:e2e:remote-host` 验收 |
| 本地检查与 CI | 仓库脚本、桌面测试入口和 GitHub Actions | 大小预算按工作树内容检查新文件。桌面单测收集 `test/` 和 `electron/test/`，带显示环境的 CI 单独执行设置导入。错误码测试扫描拆分后的 Rust 路由，并补登记四个已存在的宿主错误 |

## 下次改动从哪里开始

| 顺序 | 适用的需求 | 第一个可独立验收的改动 |
|---|---|---|
| 1 | 修改摘要、恢复或上下文预算 | 从 `packages/agent-runtime/src/runtime.ts` 的 `buildCheckpoint`、`persistCheckpoint` 与现有 compaction 模块开始。把同一条“写入后恢复”路径放在一起，用旧转录、失败重试与取消用例验收 |
| 2 | 修改会话持久化或工具执行 | 从 `crates/host-core/src/rpc/mod.rs` 跟到 `sessions` 或 `tools` 中真正写数据的函数。一次迁一个方法族，用实际 RPC 验证会话归属、失败响应和旧数据读取 |
| 3 | 修改插件服务、快捷键或卸载 | 从 `apps/desktop/electron/main/plugin-runtime.ts` 的 `loadFromPath`、`unload`、`stopServices` 开始。资源的创建和释放一起迁移，用卸载后重新加载同一插件验收 |

当前架构决定见 [MC-ADR-0032](adr/mc-0032-domain-contracts.md)，模块入口见[代码索引](code-index.md)，进程关系见[现状架构](as-built-architecture.md)。
