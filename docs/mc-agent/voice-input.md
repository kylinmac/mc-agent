# R17 语音输入（P13；V54）

已确定：新增独立于实时通话的语音输入。复用服务商配置和 Codex 登录，支持 Codex、OpenAI／兼容转写、Gemini、xAI。录音结果进入当前草稿，不自动发送。

| 编号 | 用户路径／验收 |
| --- | --- |
| P13 | 设置 → 语音 → 语音输入；选择服务商、转写模型；输入框麦克风开始／停止，取消丢弃 |
| V54 | 验证请求格式、鉴权隔离、取消与超时、麦克风互斥、切换会话不回填、现有草稿保留 |

## 实现约束

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
