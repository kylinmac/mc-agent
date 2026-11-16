# 订阅剩余额度

输入框右侧、上下文圆环左边显示当前对话所用账号的剩余额度，例如 `5h 62%  周 80%`。只显示服务实际返回的窗口：有的只有周，有的只有月，没有就不显示。窗口按服务返回的时长命名（5h、日、周、月），不按位置猜。悬停显示每个窗口剩余多少和何时重置；剩余低于 20% 的窗口用警示色。

R11.21；P8；V92：同一已配置账号（providerId）的会话共享额度快照。切换会话立即使用已有值，运行中也可首次读取；不会因为换模型建立另一份额度。不同 providerId 独立，不按名称或模型猜账号是否相同。

## 来源

这些接口都没有官方文档，格式取自各家自带工具和社区监控工具，可能随时变化。读不懂的字段一律不显示，不猜。

| 服务 | 判定 | 接口 | 窗口 |
| --- | --- | --- | --- |
| ChatGPT／Codex 登录 | OAuth `openai-codex`／`openai-chatgpt` | `GET https://chatgpt.com/backend-api/wham/usage` | 按 `limit_window_seconds`：5h、周；部分套餐只有周（2026-10-26 开发版实测某账号只返回周窗口） |
| Claude 订阅登录 | OAuth `anthropic` | `GET https://api.anthropic.com/api/oauth/usage` | `five_hour`、`seven_day`；接口限流严，5 分钟才问一次 |
| GitHub Copilot 登录 | OAuth `github-copilot`（不含企业版） | `GET https://api.github.com/copilot_internal/user`，用登录时的 GitHub 令牌 | 每月 premium 请求；无限额或无额度时不显示 |
| Kimi Code | OAuth `kimi-coding`，或 Base URL 为 `api.kimi.com` 的 Key | `GET https://api.kimi.com/coding/v1/usages` | `limits[]` 的窗口（如 5h）和顶层每周额度 |
| GLM Coding Plan | Base URL 主机为 `api.z.ai` 或 `open.bigmodel.cn` 的 Key | `GET https://<同主机>/api/monitor/usage/quota/limit`，Key 不带 Bearer | `TOKENS_LIMIT` 的 5h、周；每月 MCP 工具额度不是模型用量，不显示 |
| Grok 订阅（xAI 登录） | OAuth `xai` | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`，带 `x-grok-client-mode: cli`；Grok Build CLI 读的积分池 | `creditUsagePercent` 对应的计费周期（目前为周）；格式参考开源客户端 [RongleCat/grok-app](https://github.com/RongleCat/grok-app) |
| MiniMax Token／Coding Plan | Base URL 主机为 `api.minimaxi.com` 或 `api.minimax.io` 的 Key | `GET https://<同主机>/v1/token_plan/remains` | 5h 区间、周；优先读剩余百分比，`usage_count` 实为剩余量 |

xAI API Key、OpenRouter 和其他 API Key 按量计费或没有已知的额度接口，不显示。

## 约束

- 凭据只在 Main 读取，只发往上表固定的官方主机；看起来相似的主机不匹配。渲染进程只拿到窗口时长、剩余比例和重置时间。
- 主进程继续按服务缓存 2～5 分钟；渲染窗口内每个可见账号只有一个 5 分钟轮询器，挂载和回复结束时复用 2 分钟内的快照与并发请求。最后一个订阅者卸载就停止轮询，但保留快照供切换回来时显示。
- 请求 10 秒超时、不跟随重定向。网络／服务端暂时失败保留上次成功额度，显示 `*`，悬停说明刷新失败及上次更新时间；首次读取失败且没有快照时仍隐藏。返回无额度、不支持的账号或 HTTP 401/403 时清空。不同账号的晚到响应不会互相覆盖。
- 远程会话不显示。

## 验证状态

2026-11-16：服务与共享状态 14 项离线测试、1 项隔离 Electron 用户路径通过。覆盖同账号合并请求与轮询、切换立即显示、运行中首次读取、失败保留并标注、成功后恢复、无额度清空、跨账号晚到响应、最后一个订阅者卸载后停止轮询。未使用真实额度接口或正在使用的桌面实例测试。

2026-10-28：Grok 每周重置后额度标签消失。实测接口在新周期用量为 0 时不返回 `creditUsagePercent`，只有周期起止时间；现在有有效周期但缺这个字段时按已用 0% 显示（周 100%），连周期也没有时仍不显示。

2026-10-26：加入 Grok 订阅。开发版用已登录的 xAI 账号实测：接口返回本周已用 6%，输入框显示“周 94%”，悬停有重置时间。

2026-10-26：解析与路由测试 10 项通过（各服务样例、窗口按时长区分、缓存、凭据主机限制）。开发版用已登录的 Codex 账号实测：接口返回只有周窗口，输入框显示“周 95%”。Claude、Copilot、Kimi、GLM、MiniMax 未用真实账号验证，格式依据社区实现，可能需要按实际返回调整。
