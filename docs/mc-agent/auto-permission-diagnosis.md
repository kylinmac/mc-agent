# 全自动模式 Bash 重复审批排查

日期：2026-10-30。范围：flink-cdc 项目正在使用的对话与当前代码。用户要求修复误报，真正的危险操作仍走审批。

## 结论与证据

**运行日志确认：近期三次询问都是规则误报，全自动设置没有失效。**

对话标题为“拉doris-connector到最新稳定分支”，当前归属 flink-cdc 项目。只读查询时，其数据库配置为 `permission_mode = auto`、`mode = agent`。

| 时间（Asia/Shanghai） | 实际操作摘要 | 权限日志理由 | 判断 |
|---|---|---|---|
| 2026-10-28 23:41:18 | `docker run --rm`，容器内查找文件、读取 Java 版本 | 删除项目外文件 | 误把 `--rm` 的词尾当成 `rm` 命令，再把后续绝对路径当作删除目标 |
| 2026-10-28 23:46:02 | `docker run --rm --network none --entrypoint /bin/sh`，容器内查找文件 | 删除项目外文件 | 同一误报；没有执行宿主机删除命令 |
| 2026-10-29 23:45:15 | `javap` 检查 Java 类，再以 `grep` 搜索 `releaseClassLoader\|shutdown\|close` | 改磁盘或关机重启 | 误把搜索模式中的 `shutdown` 当成关机命令 |

最后一条在审计记录里等待了 180,959 毫秒，随后用户选择“本会话允许”。根据既有 [MC-ADR-0020](adr/mc-0020-auto-mode-guard.md)，全自动的危险操作例外每次都会询问；“本会话允许”不会关闭这些例外。因此误报会造成反复打断。

证据来源：`~/.mc-agent/logs/app/permission.log`、`~/.mc-agent/logs/host/permission.log`、对应会话 JSONL 和 `pi.sqlite` 的 `sessions` / `audit_log`。只读取，不修改、不重启正在运行的实例。本文只保留操作摘要，不复制对话里的凭据、完整命令或数据。

更早的普通 Bash、Write、Edit 询问没有记录当时的有效权限模式。当前 `auto` 状态不能证明过去每次也为 `auto`，本次不把那些记录认定为同一问题。

## 修复范围

源码确认：`mc_auto_guard.rs` 原来直接对整串文本做正则匹配。

- 仅对外部删除与磁盘/关机两类规则做有限排除：识别普通命令分隔与引号，只忽略 `grep` / `rg` / `javap` 等明确读取文本的命令参数（`rg --pre` 除外），以及 Docker 独立的 `--rm` 标志。
- `find -exec`、`xargs`、`ssh`、`eval` 等未知执行器继续保守扫描全部参数；shell `-c` 脚本、管道送入 shell、容器内的真实删除或关机仍询问。
- 实际命令替换、here-doc、不完整引用仍使用原来的保守扫描。没有引入 shell 解释器，也不解析动态变量指向的命令。
- `tools.execute` 和 `permissions.evaluate` 仍调用同一个函数。其余危险规则、权限模式、审批结果和会话授权逻辑不变。
- 回归覆盖这三类实际误报，以及真实 `rm`、关机、重启、命令替换、shell 脚本等仍被拦截的情况；RPC 预判同时覆盖安全与危险命令。

这是对既有规则的误报修正，不是新的安全沙箱。复杂 shell 文本仍可能保守询问；其余规则仍按原有文本规则匹配。若继续优化复杂脚本，应使用完整的 shell 解析器，不再扩充此处的局部分词逻辑。

## 验证

- 新增误报回归在修复前失败，修复后通过。
- `cargo test -p host-core --locked mc_auto_guard -- --nocapture`：6 项通过，覆盖模块和 RPC。
- `cargo fmt --check`、`cargo clippy -p host-core --all-targets`：通过；Clippy 仅报告未改文件中的已有警告。
- 全量 `cargo test -p host-core --locked`：沙箱内因临时监听等限制出现 33 项失败；允许临时测试服务器后重跑，1143 项通过、1 项失败、1 项忽略。唯一失败为 `data_relocation::tests::relocated_project_memory_remains_readable_through_the_repository`（迁移后项目记忆为空）。在独立临时目录导出并强制编译基线 `0c62bd274` 后，同一测试以相同断言失败，确认不是本次权限修复引入；未扩展修复这项既有问题。
- `git diff --check` 和文档检查通过（642 页）；相对链接已核对。
- 未在用户正在运行的实例执行测试命令，也未自动确认其待审批操作。安装版需要更新后才会采用修复。
