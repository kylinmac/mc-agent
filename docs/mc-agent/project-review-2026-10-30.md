# 2026-10-30 整体代码复查

## 范围与结论

基线：`main` 的 `0c62bd274`，同时检查 PR #55 的可选提问和权限修复。按高风险用户路径跨模块检查，范围不限本次 diff；不是逐行穷举整个仓库。

使用负载按个人桌面应用判断：多个会话、工作区和生成任务可以并行，另有 headless 宿主；没有按多租户服务重新设计。

确认的问题主要集中在路径身份、异步结果晚到、跨会话状态，以及读写之间发生并发修改。修复沿用现有模块和协议，未引入新的依赖或通用框架。具体编号见[问题记录](bugs.md)。

## 已确认的问题

| 编号 | 问题与触发条件 | 修复位置与方式 |
|---|---|---|
| B-018 | 数据目录的路径包含别名或软链接父目录；迁移后的项目记忆为空、项目组归属找不到 | [data_relocation.rs](../../crates/host-core/src/data_relocation.rs)：项目路径、记忆键、项目组根和当前项目采用与仓库读取相同的规范路径 |
| B-019 | 搬迁数据目录或重命名资料目录后，创作库仍指向旧路径 | 同一迁移函数补齐素材路径、任务结果路径、创作存储配置与保留的绘图脚本路径；提示词、命令和脚本原始来源保持历史内容 |
| B-020 | 两个会话同时 `Remember`，后保存的整份内容覆盖前一条 | [mc-agent-memory.ts](../../apps/desktop/electron/main/mc-agent-memory.ts)、[mc_memory_rpc.rs](../../crates/host-core/src/rpc/mc_memory_rpc.rs)：存储端比较完整快照；冲突后重新合并，重试有上限 |
| B-021 | 任务完成或失败事件早于启动确认，状态重新变为运行中，后续排队输入卡住 | [agent-host.ts](../../packages/agent-host/src/agent-host.ts)：晚到确认保留终态；继续推进队列 |
| B-022 | headless 宿主先清空进程引用，再通知运行时 sidecar 崩溃，活动任务未收尾 | [runtime-service.ts](../../packages/host-runtime/src/runtime-service.ts)：按实际绑定的 sidecar 判定退出归属，旧进程退出不影响替代进程 |
| B-023 | 计划调度器已销毁，重试定时器或尚未完成的启动准备仍继续执行计划 | [plan-dispatch.ts](../../packages/host-runtime/src/plan-dispatch.ts)：清理定时器、同任务重试去重、异步准备后复查生命周期；已认领但未启动的执行记为中断 |
| B-024 | 项目目标和目录说明的读取、保存返回覆盖输入，保存失败也清掉草稿 | [ProjectOverview.tsx](../../apps/desktop/src/features/project-workbench/ProjectOverview.tsx)、[ProjectWorkbench.tsx](../../apps/desktop/src/features/project-workbench/ProjectWorkbench.tsx)：读取和提交期间禁用对应字段；失败保留草稿；会话刷新不重载相同目录说明 |
| B-025 | 创作聊天没有展示待答问题，历史补选误发主聊天当前会话 | [StudioChat.tsx](../../apps/desktop/src/features/creative/StudioChat.tsx)：补自身会话上下文与待回答卡片，复用现有问答流程 |
| B-026 | 快速修改不同设置，后保存的旧快照覆盖此前修改 | [SettingsPage.tsx](../../apps/desktop/src/features/settings/SettingsPage.tsx)：调用现有 patch 契约，顺序保存，成功后合并当前 store；失败不阻断下一次修改 |
| B-027 | 主进程把设置写入的 `{ok:true}` 当作设置对象交给语音服务，意外结束通话；并发写入互相冲突 | [settings-ipc.ts](../../apps/desktop/electron/main/ipc/settings-ipc.ts)：写后读回真实快照，持久化、语音检查和系统副作用同序执行 |
| B-028 | 本次 PR 的文本参数豁免漏掉把管道文本当命令执行的情况 | [mc_auto_guard.rs](../../crates/host-core/src/mc_auto_guard.rs)：只有全部阶段为已知文本消费者的管道才豁免；未知执行器、分组、跨行与 `source` 保守检查 |
| B-029 | 旧版 node:sqlite 的 TEXT 读取在 NUL 处截断，Hermes 的 `\0json:` 消息被当空内容丢掉 | [hermes.ts](../../apps/desktop/electron/main/importers/hermes.ts)：仅将消息正文按 BLOB 读取，再解码 UTF-8；保留原有完整消息预期和只读源库检查 |
| B-030 | TLS 握手取消时，监听已被 AbortSignal 移除，但 socket 又排入一个 error 事件，造成未捕获异常 | [provider-https-metadata.ts](../../apps/desktop/electron/main/provider-https-metadata.ts)：取消仅关闭 socket，由现有 signal 链传递原始超时/取消原因；TLS 校验保持启用 |

## 检查覆盖

| 链路 | 实际检查内容 |
|---|---|
| 数据与项目 | 目录搬迁、资源目录重命名、项目路径规范化、项目组归属、记忆读取/写入、创作存储/素材/生成任务记录 |
| 权限与工具 | Auto guard 规则、文本参数与管道执行器、审批/取消/执行前路径检查、远程工具主链 |
| 会话与后台 | AgentHost 直接启动/排队、运行时完成事件与确认顺序、sidecar 退出、计划重试/销毁、可选提问计时和恢复 |
| 界面 | 项目目标/说明的读取与保存；提问卡片和历史补选的会话归属；设置保存的并发路径 |
| 创作 | 存储配置、素材路径、脚本保留、项目迁移与重命名；未调用真实生图服务 |
| 导入 | 项目导入取消/失败路径源码检查，Hermes 临时 SQLite 及结构化消息转换回归；未读取真实 Hermes 库 |
| 网络 | 模型元数据 HTTPS 取消、TLS 握手、连接关闭及原始超时原因；本地 TCP/TLS 回归，未连接真实供应商 |

## 验证与限制

修 bug 先用临时库、可控异步返回或隔离桌面环境复现，再运行修复后的回归。

| 检查 | 实际结果 |
|---|---|
| 桌面完整测试：`node --test --test-concurrency=4 test/*.test.mjs`（在 `apps/desktop`） | 4658 通过、0 失败、0 取消、4 跳过 |
| `cargo test -p host-core --locked` | 1148 通过、0 失败、1 忽略；包含迁移、资源目录、权限与记忆 RPC |
| Rust fmt / Clippy | 通过；Clippy 有未改文件中的既有警告 |
| AgentHost / host-runtime 全部测试 | 68 / 131 通过 |
| Runtime 提问针对性测试 | 16 通过（其余 343 未选；先前本 PR 完整 runtime 测试 359 通过） |
| Remember | 7 通过：并发合并、旧内容保留、重试上限、保存错误 |
| 隔离 Electron 项目表单 | 原有编辑路径及新增草稿保护、新增目录重载通过 |
| 隔离 Electron 提问 | 普通回答、可选计时、晚答、原会话归属、创作待答卡片、Enter/换行/IME 通过，累计 6 次解答 |
| 设置 / 语音 | 保存并发、失败继续、真实 LiveCallService 生命周期配合 mock 麦克风与适配器回归通过 |
| HTTPS 元数据 | 10 通过，含握手取消和超时原因保留；未关闭证书校验 |
| TypeScript / 静态检查 | shared、i18n、agent-host、agent-runtime、host-runtime 构建和 desktop 类型检查通过；Biome 配置范围 147 文件、样式 token、diff 检查通过 |
| 文档 | 643 页检查及本轮相对链接核对通过；保留 6 条上游 ADR 格式提示 |

整套检查同时修正了旧 AskTool/设置源码契约断言，以及测试仅等待无引用定时器、事件循环提前退出的问题；保留生产定时器的 `unref`。扫描性能测试默认高并发时曾超阈值，单独运行通过（100k 文本 p95 1.65 ms，阈值 25 ms），最终 4 并发整套也通过；未抬高阈值或修改扫描实现。

- 所有数据测试使用临时目录；未重启、升级或写入正在运行的安装版。
- 未使用付费模型、真实生产服务；macOS TCC、签名安装、Windows 原生行为及真实远程 SSH 未实测。
- Shell 规则仍是保守启发式检查，不是完整解释器或沙箱；复杂执行形式可能继续要求审批。
- 路径修复用于后续迁移和目录重命名，未自动扫描、猜测或改写用户历史库里已经失效的路径。
- 本轮没有实施大范围模块合并；工程结构建议仍见[工程结构评审](engineering-structure-review.md)。
