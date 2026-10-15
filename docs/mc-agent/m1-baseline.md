# M1 基线验证记录

日期：2026-10-15。对应[验收与开发计划](validation-plan.md)的 M1。

## 环境

| 项 | 值 |
|---|---|
| 基线提交 | `d31b64428`（上游 `a20a9ca` + mc-agent 文档与样例） |
| 系统 | macOS（Darwin 27.0.0） |
| 工具链 | Node 22.23.2、pnpm 12.8.1、Rust 1.94.1 |
| 运行方式 | `pnpm dev`，未打包；复用主仓库已有依赖，未重新安装 |
| 数据目录 | `~/.pi-desktop-dev`（开发构建默认，与已安装 PI-Desktop 的 `~/.pi-desktop` 分开） |
| 模型 | xAI grok-4.7，推理等级 medium，用户授权 |
| 测试项目 | `examples/fixtures/mc-agent/single-project/` 的临时副本（`git init` 后），不在仓库内 |

## 结果

| 检查 | 方式 | 结果 |
|---|---|---|
| 构建 | `cargo build -p host-core --locked`、`pnpm build:js`（含 VitePress 文档站） | 通过 |
| Host 冒烟 | `pnpm test:e2e`（无模型） | 23/23 通过，2 项实时模型用例按设计跳过 |
| Electron 启动 | `pnpm test:e2e:boot`（临时配置） | 4/4 通过 |
| B1 模型 | 开发窗口内用 grok-4.7 对话 | 通过 |
| B2 连续对话 | 第一轮记住 42，第二轮回答 42 | 通过 |
| B3 工具 | 读 `docs/requirements.md`、运行 `git log --oneline` | 通过；提交号与实际一致（`bf92c2b`） |
| B4 审批 | “每次询问”模式：工作区内读文件不弹卡；Bash 弹卡并显示项目路径；“允许一次”执行；“拒绝”后文件未创建，回复如实说明被拒 | 通过 |
| B5 停止 | 长文生成中点停止 | 通过；输出在句中截断，发送按钮恢复 |
| B6 会话持久化 | 完全退出并重启应用后打开该会话 | 通过；历史与被停止的回复都在 |
| B7 错误与恢复 | 仅覆盖“工具被拒”路径 | 部分；断网、sidecar 崩溃未测 |
| B8 插话与排队 | — | 未测 |
| 日志 | 当天 error/warn | 仅 1 条 `tool.execution.failed`，即被拒绝的 `touch` |

## 观察

- 被停止的回合显示为“已处理 12s”，没有“已停止”标记，用户可能误以为已完整完成。属上游现有行为，先记录，不在 M1 修改。
- 开发构建已与正式安装隔离（`apps/desktop/electron/main/data-paths.ts`）。正式分发的应用身份（APP_ID、名称、数据目录）仍是上游值，留到 M5。

## 结论

基础工作流可运行，M1 通过。B7 的其余路径和 B8 在后续回归中补测。
