# 参与 mc-agent

mc-agent 是个人维护的 PI-Desktop Fork，当前处于需求与文档阶段。贡献方向和开发范围以 [mc-agent 文档](docs/mc-agent/README.md) 为准。

## 开始前

- 阅读 [AGENTS.md](AGENTS.md) 的统一工作约定；CLAUDE.md 只是该文件的入口。
- 查看当前改动，保留他人工作。业务实现以代码、类型和测试为准；规划中的 R9–R15 尚未实现。
- 阅读受影响模块的说明和实际存在的子目录规则。上游 spec 与 ADR 提供技术背景，其维护者流程不适用于本 Fork。

## 修改与提交

- 单人维护允许直接修改 main；较大或试验性修改使用 feat/、fix/、docs/ 分支，不强制 worktree。
- 一次只解决一个问题，保持数据兼容、权限边界及原有行为；不顺手改名、重构或升级依赖。
- mc-agent 文档用中文，放在 docs/mc-agent；代码标识和提交信息使用英文。
- 提交使用 Conventional Commits，正文解释原因；只暂存本次明确修改的路径。
- Agent 仅在用户明确要求后 commit、push 或创建 PR；提交不自动意味着推送。
- origin 是 kylinmac/mc-agent，upstream 是 vastsa/PI-Desktop。保留上游来源及许可证，不改写已推送历史。

## 验证

文档修改运行 git diff --check、文档结构与中英对应检查，并核对改动链接。已有依赖可用时构建文档站点；不为文档整理安装业务运行环境。

代码修改按影响范围运行类型检查、单元测试和必要的端到端测试；涉及权限、数据和跨进程行为必须覆盖失败路径。未运行的检查应明确说明。

安全问题按 [SECURITY.md](SECURITY.md) 处理，不在公开 Issue 中披露敏感信息。
