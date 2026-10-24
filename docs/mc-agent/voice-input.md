# R17 语音输入（P13；V54）

已确定：新增独立于实时通话的语音输入。复用服务商配置和 Codex 登录，支持 Codex、OpenAI／兼容转写、Gemini、xAI。录音结果进入当前草稿，不自动发送。

| 编号 | 用户路径／验收 |
| --- | --- |
| P13 | 设置 → 语音 → 语音输入；选择服务商、转写模型；输入框麦克风开始／停止，取消丢弃 |
| V54 | 验证请求格式、鉴权隔离、取消与超时、麦克风互斥、切换会话不回填、现有草稿保留 |

## 实现约束

R17 修正：xAI 的 Grok/X 登录账号与 API Key 均可选择。登录账号通过现有 `VendorOAuth.resolveAuth` 刷新并获取访问令牌，只发送到官方 `https://api.x.ai/v1/stt`；不读取 API Key 存储，也不向 Renderer 返回令牌。未选择账号时显示启用条件。

本次修正先用已登录 xAI 账号的模拟用例复现 `DICTATION_PROVIDER_UNAVAILABLE`，修复后相关协议／设置测试 13 项通过，包含登录刷新失败不回退凭据、令牌固定发送到官方地址。未调用真实账号测试转写。

- 密钥仅由 Main 读取；Renderer 只传录音或 SDP，不接收凭据。
- OpenAI／兼容服务调用 audio/transcriptions；xAI 调用 stt；Gemini 使用音频理解模型，仅要求逐字转写。
- Codex 复用已有实时语音协议，但不挂载任务工具、不共享会话内容、不播放回复。此接口的服务端兼容性需账号实测。
- 最长录音 3 分钟；请求有取消和超时；录音只保存在内存。
- 切换会话或关闭组件取消，不把旧录音填到新会话；识别期间修改草稿时追加文字，不覆盖新输入。
- 不自动选择普通聊天模型作为转写模型。模型可单独配置。

## 接口依据

- [OpenAI 转写](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Gemini 音频理解](https://ai.google.dev/gemini-api/docs/generate-content/audio)
- [xAI 转写](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)

## 验证状态

### 账号与入口复查

设置菜单和页标题统一为“语音”，页面内保留“语音输入”和“实时语音”两个功能名称。设置搜索同时覆盖两者。

| 检查项 | 结果 |
| --- | --- |
| Codex 登录 | 源码及模拟流程确认：OAuth 刷新 → 账号 ID → 官方 SDP 协商；Renderer 只接收 SDP，不接收凭据 |
| xAI 登录 | 修复了账号被过滤、误读 API Key 存储的问题；支持登录和 API Key 两条路径 |
| OpenAI／兼容、Gemini | 保留 API Key 接入；不把不兼容 OAuth 账号混入列表 |
| 录音生命周期 | 模拟流程检查了停止、取消、迟到授权／结果、麦克风互斥和 Codex 尾句等待 |
| 设置入口 | “实时语音”菜单改为“语音”；补齐语音输入、转写模型、Codex、Gemini、OpenAI 和 xAI 搜索关键词 |

本轮上述相关测试 24 项通过。真实麦克风、账号权限和服务端协议兼容性仍未实测，不把模拟通过视为实际账号可用。

| 检查 | 状态 |
| --- | --- |
| 请求格式、WAV 校验、凭据隔离、端点变更、麦克风互斥、取消后迟到结果 | 模拟测试通过 |
| 录音→停止→WAV→返回文字、取消录音、迟到的麦克风授权、Codex 最后一句等待 | 模拟浏览器媒体与 IPC 的流程测试通过 |
| 原有实时通话生命周期与控制器 | 回归测试通过 |
| desktop typecheck、shared／i18n 构建、desktop build、pnpm lint、文档检查、git diff --check | 通过；构建只有现有体积提示，文档只有历史 ADR 格式提示 |
| 实际账号、真实麦克风、Windows／macOS 打包后体验 | 未验证；未调用付费接口或操作用户正在使用的实例 |

源码确认不等于云端服务可用。Codex 沿用项目既有内部接口，账号权限或服务端协议变化可能导致连接或最后一句识别失败。OpenAI／兼容服务必须提供转写端点；Gemini 必须使用音频理解模型，不能直接填写 Live 模型。

已提供英文与简体中文文案；其他语言暂回退英文。

相关测试共 34 项通过，覆盖 `dictation.test.mjs`、`dictation-session.test.mjs`、`live-voice-permission.test.mjs`、`voice-settings-surface.test.mjs`、`live-voice-codex-sdp.test.mjs`、`live-voice-service.test.mjs`、`live-voice-service-lifecycle.test.mjs`、`live-voice-controller.test.mjs`。
