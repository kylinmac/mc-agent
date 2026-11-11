# 上游修复复核（2026-11-11）

延续 [11 月 6 日起的同步记录](upstream-review-2026-11-06.md)。本轮基线是 Fork `2a09f8fa8c5e2ba6a51470d9a9fa1b1e3896a0f7`，同时核对 11 月 8 日的后续同步记录；不把本机较旧分支视为当前 main。用户要求合入 #1922、审查遗漏修复并发布，本轮是缺陷修复，不增加需求编号。

## 选取范围

| 上游 PR | 修复与适配 |
| --- | --- |
| [#1922](https://github.com/vastsa/PI-Desktop/pull/1922) | 旧用户消息的版本标记使用持久化确认事件，只更新已加载消息；补充投影与真实 Host 回归 |
| [#2191](https://github.com/vastsa/PI-Desktop/pull/2191) | 激活分叉会话时清除残留的会话选择状态 |
| [#2224](https://github.com/vastsa/PI-Desktop/pull/2224)、[#2233](https://github.com/vastsa/PI-Desktop/pull/2233) | 全量和窗口历史读取均检查缓存身份，避免覆盖等待期间的新消息 |
| [#2225](https://github.com/vastsa/PI-Desktop/pull/2225) | 停止请求失败时保留真实运行状态 |
| [#2236](https://github.com/vastsa/PI-Desktop/pull/2236) | 队列事件使旧刷新请求失效，避免已发送消息复活 |
| [#2244](https://github.com/vastsa/PI-Desktop/pull/2244)、[#2256](https://github.com/vastsa/PI-Desktop/pull/2256)、[#2262](https://github.com/vastsa/PI-Desktop/pull/2262) | 余额不足终止重试、识别 SDK 状态码、按 DeepSeek/Dashscope/Groq 的输出限制执行一次降额重试 |
| [#2264](https://github.com/vastsa/PI-Desktop/pull/2264)、[#2266](https://github.com/vastsa/PI-Desktop/pull/2266) | 摘要忽略失败/中止/延迟响应的思考及未执行文件操作；保留 Fork 原有工具名适配 |
| [#2200](https://github.com/vastsa/PI-Desktop/pull/2200) | 主会话应用已保存模型绑定，兑现图片支持及窗口/输出限制；测试保留 Fork 的快速模式契约 |
| [#2252](https://github.com/vastsa/PI-Desktop/pull/2252) | 存储清理跳过非目录分区，兼容 ENOTDIR |

共选取 13 个上游 PR 的独立修复及对应测试，不整体升级 Pi、不引入新模式、启动器或电脑控制能力。保留 Fork 当前分层、权限与接口。上游受其他新特性影响的测试夹具按 Fork 现有接口适配。

[#2222](https://github.com/vastsa/PI-Desktop/pull/2222) 的模型配置写入排序在 Fork 最新 `session-slice.ts` 中已有串行队列实现，并保留失败待写配置，因此不重复移植。11 月 8 日已同步的 token 限制、thinking 预算、图片准入、checkpoint 和历史导航修复不重复添加。涉及其他功能边界的 MCP 重连、原生文件路由和主题变更暂不纳入本轮，需分别复核。

## 本次分支摘要修复

上游 #1922 解决重复投影，不能解决压缩摘要随分支切换丢失。补充 JSONL 版本快照的可选 `compactions` 字段，保存和恢复该分支自己的完整 checkpoint 链（含未变前缀锚点）。旧归档字段缺失仍走兼容路径，显式空数组不借用其他分支摘要。无 SQLite schema 或 IPC/RPC 变更。

详细根因、历史提交与修复前失败证据见 [上下文完整性记录](context-integrity-plan.md#会话版本切换缺陷2026-11-11)。已在旧版本丢失且未归档的摘要不能凭空恢复；本次未修改安装版数据或调用真实模型。

## 验证边界

初始本机分支上，本次重复投影/分支摘要修复通过 31 项界面相关测试、134 项 Rust 会话/归档测试及合成 3,484 条消息的真实 Host 跨进程回归；host 构建、desktop 类型检查、fmt/clippy 通过。完整 Rust 运行有 83 项失败，涉及网络和 Windows 环境等，未完成全部基线对照，不称全绿。

本机 Git 元数据写入和命令行网络受限。本轮将补丁应用到通过 GitHub 读取的最新 main 文件快照，保留本机已有未提交修改；最终候选提交以 PR CI 为准。新增版本切换、窗口读取竞态、队列事件竞态跨进程回归纳入 CI。安装版 UI 与真实模型调用不在此次自动验证范围。
