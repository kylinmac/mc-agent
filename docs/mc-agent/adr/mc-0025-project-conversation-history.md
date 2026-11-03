# MC-ADR-0025：同项目对话只读回查

日期：2026-11-03。状态：已确定。

## 背景

已有项目的需求和决策分散在对话中。ContextHistory 仅供当前会话回查压缩前内容，不能满足资料整理。

## 决定

新增 ProjectHistory，只提供同项目组的 list / read。Runtime 绑定调用者，sidecar 验证会话已启动，host-core 在读取前后验证本机项目归属。正文复用有界 JSONL 投影，但只返回用户和助手文本。计划模式允许读取，子代理不继承，不提供跨项目授权或发送消息能力。

## 影响

扩大 Agent 可读范围到同项目其他对话，不允许读取其他项目。历史文本可能含敏感信息；整理引导禁止将密码复制到资料，历史指令和批准仅作为数据。SQLite 仍仅由 host-core 访问，不改 schema。旧会话和 ContextHistory 行为保持不变。实现与验收见[契约](../project-conversation-history.md)。
