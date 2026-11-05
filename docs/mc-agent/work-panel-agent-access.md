# 工作面板的 Agent 访问

2026-11-05；R27；P8；V78–V80。用户已确认并要求实现、提交 PR、发版。权限边界见 [MC-ADR-0026](adr/mc-0026-work-panel-agent-access.md)。V77 已用于 macOS 固定证书签名。

## 已实现的入口

WorkPanelList、WorkPanelRead、WorkPanelAction 作为本机会话常驻工具。用户说“看右边报错”时，Agent 先列出本会话标签，再读取具体目标；不依赖用户复制日志，也不每轮注入全部面板内容。远程会话不提供这些本机工具。

| 面板 | 读取 | 操作 |
| --- | --- | --- |
| 交互终端 | 启动 shell、启动目录、输出游标、有界尾部、退出码；screen 读取当前可见屏幕和选区 | input、回车、中断、常用控制键、关闭、重启已退出且仍显示的终端；必须传上次读取的 termId，重启后旧实例失效 |
| 浏览器 | 指定标签的无障碍树、控制台；screenshot 图像 | 指定同一标签导航、点击、填充；复用 URL／CDP 限制 |
| 文件管理器及其他插件页 | 当前可见页面的无障碍树，含编辑器未保存的可访问文本；截图 | snapshot＋uid 点击／正常输入；保存、撤销、全选、方向键等键盘操作；沿用编辑器保存和冲突检查 |
| 文件预览 | 路径通过已有 Read 工具读取，仍经过文件权限 | Edit／Write 继续操作实际文件 |
| 变更审查 | 本会话项目的 diff | 通过已有文件／Bash 工具修改、暂存或撤销，不将“查看”当成授权 |
| 后台任务 | 仅本会话任务清单；backgroundId 读取输出 | stop 停止指定本会话任务；BashOutput／KillBash 仍可用 |
| 画布 | CanvasRead 读取当前画布／项目列表 | CanvasWrite／CanvasComment 沿用版本和评论权限 |
| 子代理 | 当前已加载阅读范围内的委派正文和工具结果，排除思考行 | TaskList／TaskWait／TaskStop／Task resume；resource 是 delegationId，不是会话 ID |

通用 focus 只切换当前可见会话的标签，不自动切走用户正在看的其他会话。未适配的动作明确失败，不能声称已执行。

## 重要语义

- 终端与 Agent Bash 是不同进程。启动 cwd 不是运行中 shell 的实时 cwd；输出送达不等于命令成功，操作后需再次读取核验。
- Main 保留每个终端最多 128 Ki 字符，单次读取最多 32 Ki 字符，返回游标、截断标识；退出记录最多 16 个，关闭标签／应用清理。screen 是 xterm 当前视口，包括全屏程序的渲染结果。
- 插件视图本身是共享 UI，只能访问正显示在调用会话中的实例。隐藏、换会话、页面导航或实例换代使快照失效。每次动作消耗快照，下一次动作前重读。
- 文件管理器通过真实编辑事件操作，未增加另一套草稿存储。虚拟化编辑器的屏外内容可能不在无障碍树里，结果会说明；完整磁盘文本用 Read，视觉内容用 screenshot。密码字段的值不输出。
- 第三方插件的 UI 读取和操作限于无障碍树与普通交互；插件自己的网络、文件和保存权限不变。不能保证任意插件的自绘控件都可定位。
- 子代理读取是有界的已加载片段，不冒充完整历史；详细状态和后续控制用既有委派工具。

## 权限与生命周期

三个工具全部先经过 host-core 授权，再执行 Main 本地处理。List／Read 为低风险，Action 为高风险；Plan／Goal 禁止 Action。Renderer 只提供标签信息和只读画面，不接收模型指定的任意 IPC。回复只接收主窗口发送者，并绑定随机请求 ID，5 秒超时，可取消。

终端创建绑定本机会话和目录；读取、输入复核所有权。终端动作带 termId，防止审批期间重启后误输入。浏览器固定 sessionId＋tabId。插件动作每一步复核可见归属和实例代次，只有固定 UI 操作，没有模型任意 JavaScript 执行入口。

自动模式下，带 termId 的终端动作（聚焦除外）仍需逐次审批。交互 shell 可能已有输入或处于其他程序中，不能把本次文本当成完整命令来判断安全性；普通命令继续走 Bash 的现有规则。

所有日志、网页、编辑器和工具返回均为不可信数据，不视为指令或授权。不改数据库结构，不改变 SQLite 所有权。

## 终端快捷键

| 按键 | 行为 |
| --- | --- |
| Ctrl+Shift+C；选区存在时 Ctrl+C；Mac Cmd+C | 复制选区；失败提示 |
| Ctrl+Shift+V；Mac Cmd+V | 保留 xterm 原生粘贴，包含括号粘贴处理，不重复发送 |
| Ctrl+Shift+A | 全选 |
| Ctrl+Shift+K；Mac Cmd+K | 清除滚动历史，不终止进程 |
| Shift+PageUp／PageDown | 滚动一页 |
| Shift+Home／End | 滚到顶部／底部 |
| 无选区 Ctrl+C | 保留 shell 中断 |

工具栏帮助图标显示说明。粘贴原本能用，是 xterm 已绑定浏览器 paste 事件；本次补上显式复制快捷键。

## 代码位置

- 契约：`packages/shared/src/work-panel-agent.ts`、`protocol.ts`。
- 工具：`packages/agent-runtime/src/mc-work-panel-tools.ts`；host 授权：`packages/host-runtime/src/agent-sidecar.ts`、`crates/host-core/src/permissions.rs`、`tools/mod.rs`。
- Main：`apps/desktop/electron/main/work-panel-agent/`、`mc-terminal.ts`、`plugin-view-host.ts`。
- UI：`apps/desktop/src/features/work-tools/use-work-panel-agent.ts`、`terminal-clipboard.ts`、`TerminalTab.tsx`。

## 验证

- V78：管理器和工具测试覆盖用户报错→发现→读取→输入→读取结果、游标、退出、关闭、跨会话、旧实例、取消；真实 stdio 反向 RPC 覆盖审批通过／拒绝和 Plan；Rust 权限测试通过。
- V79：隔离 Electron 窗口通过插件读取／点击／输入／保存、快照失效及换会话拒绝；真实内置文件管理器 CodeMirror 完成“读未保存内容→编辑→保存”路径。浏览器指定标签路由有测试，复用已有浏览器／面板回归。后台、画布、委派仍沿用已有工具契约。
- V80：真实 xterm 验证复制选区、无选区中断、paste 仅一次；单测验证复制失败、全选、清屏和滚动。剪贴板写入使用测试替身，未覆盖系统剪贴板／macOS 实机。
- 桌面相关回归 83 项通过、1 项 Unix shell 在 Windows 跳过；运行时 383 项通过；host bridge 10 项通过。Desktop／agent-runtime／host-runtime 类型检查、规范、架构、Rust fmt／Clippy 已跑，结果在 PR 更新。
- Windows host-core 首轮全量结果：1129 通过、30 失败、1 忽略；改动前 eb03d587f 的独立 worktree 为 1128 通过、相同 30 项失败、1 忽略。新增权限测试通过；后续自动模式保护有单独回归。不能把本机全量说成通过，云端 Linux 全量结果以 PR CI 为准。不使用付费模型或用户正在运行的安装版测试。
