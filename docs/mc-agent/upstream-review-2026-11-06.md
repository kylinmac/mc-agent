# 上游更新筛选（2026-11-06）

## 范围与结论

本次抓取 `vastsa/PI-Desktop` 的 `main`，审查到 `7c61674ea984f5faf1f3b1c08bf0af7231c02701`。相对 Fork 上次整体合入的 `c099b6a4c`，有 601 个尚未进入当前历史的提交，涉及 945 个文件；提交数包含 merge，不代表 601 项新功能。

优先移植现有能力的独立缺陷修复，不整体同步上游。本次在 `fix/upstream-fixes-20261106` 分支实施；发布状态以发布记录为准。Pi 依赖保持 1.3.0，mc-agent 的应用身份、更新渠道、项目结构、上下文恢复和工作面板契约保持不变。

整体同步仍应使用 merge。本次只按来源提交移植补丁，不把上游祖先提交标为已合入；下次 merge 需核对这些等价修复。2026-10-30 已移植的三个压缩修复不重复处理。

## 本次修复

均属于继承能力的缺陷修复，不新增 R 需求；沿用 P8 聊天与运行界面，以及基础验收 V1–V10。

| 修复 | 上游来源 | Fork 适配 / 验收关联 |
| --- | --- | --- |
| 大图 Base64 校验栈溢出：服务端已返回图片，客户端却报生成失败 | `7120625b9`（#2142） | 仅替换校验方式，保留 xAI 与图片尺寸扩展、原有大小限制；V3、V7 |
| Git 输出跨字节分块导致中文、重音字符和 emoji 文件名乱码 | `605d413fc`（#1914） | 流式 UTF-8 解码，保留文件搜索及忽略规则；V3 |
| 同一文件的 `./`、重复分隔符、`..` 别名绕开串行锁 | `2bee85715`（#1935） | 保留 Fork 现有互斥锁，不引入上游并行读改造；V3、V9 |
| CJK 内容、工具参数与工具 schema 的输出预算估算偏低 | `38ffd0c17`、`59a0e6df3`、`aee08f0de` | 只修估算，不改 R20 摘要或 R21 恢复策略；V2、V7 |
| 子代理降级上下文保留了已跳过助手消息的孤儿工具结果 | `c0b3c2bea`（#1937） | 复用压缩尾部的孤儿过滤规则，保留有效工具调用；V2、V7 |
| 计费、额度、Gemini 与上下文错误误分类，造成不当重试 | 见下方来源清单 | 保留 Fork 的无状态码无效请求保护；V1、V7 |
| 首次启动宿主握手超时后无法恢复 | `f3a8828ad`（#2127） | 仅握手超时重试一次，退出中不重试，其他错误不掩盖；V7 |
| 取消退出后定时任务、语音服务已被停止 | `4aee6d9df`（#2063） | 清理移到确认退出之后，仍只执行一次；V5、V7 |
| 中文输入法组合输入期间斜杠提前替换，导致重复字符 | `915f636df`（#1967） | 替换延后至组合输入提交；V8 |
| Todo / Tasks 页签内容串页、没有可见任务时仍占位 | `7a7b1679e`、`28d5d07de` | 保留 mc-agent 任务与工作面板接线；V2、V8 |
| 崩溃留下不完整 UTF-8 尾部，阻断后续消息更新及检查点恢复 | `cfaa08336`（#1885） | 与既有容错读取一致，不更改数据库结构；V6、V10 |

错误分类来源：`2d29e1704`、`e8f413bca`、`47cebe18b`、`5f4bb8d67`、`5476e5469`、`405a396ca`、`a6b7acf7c`。覆盖计费关键词、HTTP 402、Gemini JSON 错误、错误 API key、5xx 上下文溢出和 OpenCode Zen 额度提示。未引入依赖 Pi 1.5 的其他规则。

## 暂缓的上游变化

以下为建议待评审，不代表已确认需求或已实现。

| 变化 | 结论与原因 |
| --- | --- |
| Pi 1.5、模型目录更新 | 值得单独做兼容升级。当前 Fork 为 Pi 1.3，含本地补丁、摘要与恢复定制，不能只改版本号 |
| 并行工具批次、文件操作协调、工具图片持久化 | 值得专项评估，涉及 Host 身份、RPC、历史存储及恢复契约，本轮不混入 |
| 插件启动器、设置重排、模型选择器、启动动画 | 有可用改进，但与 mc-agent 界面外壳和工作面板重叠，需先确认需求 |
| 上游 Computer Use | mc-agent 已有自己的电脑操作能力，不能直接叠加另一套授权与生命周期 |
| Windows 后台进程树终止 | Fork 已有 JobObject 所有权与关闭兜底，不替换成上游 PID 快照方案 |
| 项目路径别名、外部目录改名恢复 | 上游方案涉及数据库迁移或项目根约束；需结合多工作区、资料目录做专项回归 |

## 验证

先加入回归用例验证旧实现失败，再移植生产代码。大图复现栈溢出，文件名分块复现乱码，运行时新增回归出现 43 项预期失败；历史损坏、首次握手、取消退出、任务页签及输入法也先复现后修复。

| 实际检查 | 结果 |
| --- | --- |
| agent-runtime 定向与邻近回归（错误分类、重试、预算、路径锁、子代理、压缩） | 8 文件 232 项通过 |
| 图片生成相关单测 | 5 文件 47 项通过 |
| 文件索引与 UTF-8 分块回归 | 2 文件 7 项通过 |
| 桌面启动、退出、后台任务、输入法、输入历史和深度文件搜索回归 | 49 项通过 |
| `cargo test -p host-core --locked transcripts::` | 59 项通过 |
| `regenerate-branch-archive.test.mjs` | 4 项通过 |
| `node scripts/e2e-image-generation.mjs` | 6 场景通过；含 6 MiB 图片完整落盘、Plan 拒绝、重启恢复 |
| `node scripts/e2e-composer-ime-stack.mjs` | 真实 Chromium 组合输入通过 |
| `node scripts/e2e-task-dock-tabs.mjs` | 2 场景通过 |
| `node scripts/e2e-scheduled-quit-cancel.mjs` | 4 步通过：启动、取消退出保留服务、到期任务调用本地模型并完成、再次确认退出且只清理一次 |
| agent-runtime、host-runtime、desktop 的 `typecheck` | 通过 |
| `pnpm lint` | 通过；两条既有测试产物断链警告 |
| `cargo fmt --check` / `cargo clippy -p host-core --all-targets` | 通过；Clippy 仍有未改代码的既有警告 |
| `cargo build -p host-core --locked` / 相关 JS 依赖和桌面构建 | 通过 |
| 文档检查 / 相对链接 / `git diff --check` | 652 页通过；所改文档 77 个相对链接无缺失；差异检查通过 |

未跑完整 Rust / JS 套件、macOS 系统输入法、真实麦克风、付费模型和安装包更新路径。结论限于以上自动回归，不代表安装版验收。

构建环境备注：现有 `build:deps` 的依赖过滤器在本机提示没有匹配项目。本轮按依赖顺序显式构建 shared、i18n、racp、plugin-sdk、voice-runtime、agent-runtime、agent-host、host-runtime，再构建桌面；未顺手改动既有构建脚本。

仅使用本地模拟服务、临时数据目录和隔离测试实例。不使用真实付费模型，也不操作已安装的 PI-Desktop / mc-agent 数据。

## 第二轮补入（2026-11-08）

继续审查 `7c61674ea..b7678c36c`（24 个非 merge 提交）。按来源提交 `cherry-pick -x` 保留出处，便于下次整体 merge 时识别等价修复。上游 `docs/spec/06-delivery/04-e2e-test-plan.md` 冲突一律保留 Fork 版本，上游 changelog 不引入。

| 补入 | 上游来源 | Fork 适配 / 验收关联 |
| --- | --- | --- |
| 输出上限按 Provider 声明的最大输出钳制 `max_tokens` | `76ed6ca5e` | 无冲突；V1、V7 |
| 压缩尾部保留的思考文本设上限 | `969c3c04b` | 无冲突，不改 R20/R21 策略；V2、V7 |
| DashScope 状态信封（HTTP 200 内嵌 400）先分类再重试 | `11a0da858` | 仅文档冲突；V1、V7 |
| 关闭已连接浏览器标签后清理工具连接 | `93bee3bb2`（#2162） | 一行修复；规格说明追加到组件规格末尾；V3 |
| 末尾分页保留最后一条消息之后的压缩检查点 | `4d4a17d7e` | 仅文档冲突；V6、V10 |
| 设置中显示生图标记对聊天模型选择的影响 | `4cd88649c` | 仅文档冲突；V8 |
| 对话缩略导航只标记用户消息 | `5caa0c227` | 无冲突；V8 |
| 插件 `workspace.get` / 已注册目录跟随调用会话的项目 | `89c292108` | 并列对话（MC-ADR-0007）下后台工具不再读到可见项目；去掉 Fork 没有的 `projects.list`；V3、V9 |
| 内联图片按像素尺寸准入（长边 > 8000 px 不内联，Host Read 拒绝，历史回放降级为路径/文本说明） | `49f23668d`（#1913） | 合并 Fork 压缩恢复的 import；决策日志只保留 D675；V3、V7 |
| 像素被拒的图片不占历史图片字节预算 | `bfc69c73a` | 依赖上一行，无冲突；V3、V7 |
| **新功能**：上下文面板与轮次用量胶囊显示本轮/会话费用 | `969b7f47a` | 新增只读 Host RPC `session.usageCost`，无数据库结构变化；订阅账号显示为“订阅”及等价价格，无单价请求标为下限。Fork 面板在没有轮次用量时仍显示会话费用；V8 |

费用显示补充 [MC-ADR-0011](adr/mc-0011-usage-statistics.md) 的“不算费用”：统计页仍只展示 token，会话内费用使用请求账本中已有的 Provider 实报或目录估算价格，自定义模型无单价时不猜测。

### 第二轮暂缓

| 上游提交 | 原因 |
| --- | --- |
| `9eb23cb2b`、`1283c8bd5`、`11fa50d37`、`dc3c29dee`、`b3acaae97`、`c0d36c925` 对话窗口分页 / 阅读锚点 | 依赖 Fork 未引入的上游有界挂载窗口（ADR 0130 实现、`transcript-content-window.ts`） |
| `1fc3736a2`、`a15dda3d3` 审查历史 | 依赖 Fork 未引入的 Review History 工作面板 |
| `dda598c6f`、`7d5abca83` 定时任务列表与编辑器 | Fork 定时任务页已按 mc 界面重写，需单独适配 |
| `028bece76` 压缩后按模型算窗口容量 | Fork 上下文面板改为快照（R20/R21），需单独适配 |
| `b7d03c657` 侧栏布局持久化 | Fork 使用自有项目侧栏（MC-ADR-0003） |
| `6c6d0ff7f`、`398f6d638` | 测试夹具，对应功能 Fork 未引入 |

### 第二轮验证

| 实际检查 | 结果 |
| --- | --- |
| agent-runtime `provider-retry` / `agent-errors` / `agent-messages` / `compaction-tail` | 4 文件 170 项通过 |
| 桌面 `usage-cost`、`usage-cost-user-path`、`image-model-disclosure-user-path`、`conversation-minimap`、`browser-background-session`、`plugin-workspace-session`、`transcript-projection` | 45 项通过 |
| `cargo test -p host-core --locked`（`transcripts::`、`usage`、`tools::`） | 63 项、15 项、112 项通过 |
| shared `image-dimensions`、agent-runtime `image-admission` / `attachment-history`、桌面 `prompt-inline-attachments` / `composer-paste-files` | 6 项、9 项、19 项通过 |
| `node scripts/e2e-compaction-tail.mjs` | 通过 |
| desktop `typecheck`、`pnpm lint`、`cargo fmt --check` | 通过 |
| `cargo clippy -p host-core --all-targets` | 无新增警告（既有 8 条在 mc_* 与未改动代码） |

未跑完整 Rust / JS 套件、浏览器后台 e2e 和真实付费模型；费用数值只用本地模拟账本验证。

## 第三轮：对话窗口导航与历史分页（2026-11-08）

单独分支 `feat/upstream-transcript-window`。上游这一块从 Fork 分叉以来有 37 个提交，与径向菜单、轮次变更卡、分组折叠、`@agent`、Pi 1.5 等功能交织。只移植导航 / 分页主链，不带入这些功能。

| 内容 | 上游来源 | 适配 |
| --- | --- | --- |
| 展开折叠、恢复中的运行轮次、项目切换时的跟随意图 | `9b4ea27d6`、`0a6f6a06f`、`0c8b038cb`、`69fba162e`、`0aeb5ccf2`、`6a0855bbd` | 测试导入合并 Fork 的 `extendTranscriptView` |
| 完成一轮后把提问滚到顶部（D676）及其输入打断、滚动归属修复 | `c764d8ab7`、`d3ba191d5`、`5fac16774`、`bf38d5372` | 长历史 e2e 保留 Fork 版本 |
| 加载历史时保持阅读位置、显式回到最新、预取更早历史 | `2192d31df`、`bd92cbb2b`、`5dfeb8e50`、`3fcdcbbae`、`e64d06f00`、`bb25eb013` | 去掉 Fork 没有的径向菜单代码 |
| 有界挂载窗口、阅读锚点、保留有状态 Markdown | `1283c8bd5`、`11fa50d37`、`dc3c29dee` | ADR 0130 取上游最新 |
| 回到最新时保留已加载页、原生平滑滚动 | 上游 #2169 的 merge 提交 `0a25866a2`、`2d20113e3` | 无法单独 cherry-pick；Fork 未改过的文件取上游 main，读取运行时手工移植并保留子代理卡片锚点（`messageParents`） |

未带入：径向菜单（`a440b7798` 等）、轮次变更卡（`73b714ed2`，随审查历史另做）、分组折叠（`c2f3845ca`）、`@agent`、Pi 1.5。

测试调整：`session-reading-position` 原断言“回到最新必须清空视图”，新规则下与实时尾部相连的页保留、只退出搜索态；页面随懒加载增高，原生平滑滚动给更大帧预算。`remote-session-user-path`、`session-switch-performance`、`gen-ui-card` 取上游同名测试修正。

| 实际检查 | 结果 |
| --- | --- |
| 桌面 transcript / reading / history / scroll / session 相关单测 | 817 项中 815 通过；2 项 ask 测试单独重跑通过，属并发偶发 |
| `e2e-transcript-*`：history-loading、prose-state、turn-completion、disclosure-anchor、minimap-jump、reading-position、render、cache | 全部通过（history-loading 在 main 上不存在） |
| desktop `typecheck`、`pnpm lint` | 通过 |

未跑完整桌面套件（交 CI）；未在安装版手工验证长对话滚动手感。
