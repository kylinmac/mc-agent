# MC-ADR-0020: 全自动模式下仍要询问的命令

**Status:** Accepted
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

权限模式“全自动”（`auto`）对所有工具调用直接放行（上游 D115）。日常开发这样最省事，但少数命令一旦执行就收不回，或者会影响项目以外的东西：强制推送、合并 PR、发版、发布包、删除项目以外的文件、以管理员身份运行等。用户选“全自动”，是不想被常规操作打断，不等于同意 Agent 自己做这些。

## 决定

1. **host-core 里的一张规则表。** `mc_auto_guard.rs` 按命令文本匹配 Bash 调用，命中时即使在全自动模式也弹出普通的审批卡，理由写明原因（例如 “Auto mode still asks: pushes to the main branch”）。
2. **规则范围。** 强制推送、删除远程分支、推到 main/master；`reset --hard`、`clean -f`、`branch -D` 等丢弃本地改动；`gh pr merge`、`gh release`、`gh repo` 修改、`gh workflow run`；npm/pnpm/yarn/cargo 等的 publish；`rm -r`/`rm -f` 删除 `/`、`~`、`$HOME` 开头的路径；sudo/doas/su；下载后管道给 shell；terraform apply/destroy、kubectl apply/delete、helm 安装升级、docker push/system prune；mkfs、写裸盘的 dd、关机重启。普通推送、提交、建 PR、删除工作区里的构建目录不受影响。
3. **只改变全自动模式。** 其他模式本来就会对 Bash 询问，行为不变。在审批卡里选“本会话允许”，不会让这些命令以后免审：全自动模式下命中规则的命令每次都问。
4. **两处入口一致。** `tools.execute` 的审批和 `permissions.evaluate` 的预判都走同一张表。
5. **设置里的说明**（中英文）补一句哪些操作仍会询问。

## 影响

- 新增 `crates/host-core/src/mc_auto_guard.rs`（含单元测试）和 `rpc/mc_auto_guard_tests.rs`；`rpc/mod.rs` 两处各加几行；三种语言的设置说明改一句（其余语言沿用上游原文）。
- 这是对命令文本的模式匹配，不是沙箱：刻意换个写法可以绕过。它防的是常规任务里顺手做了这些事。
- 以绝对路径删除项目内的目录（`rm -rf /Users/...`）也会询问。

## 重访条件

- 误拦太多时，加设置让用户关闭某几类。
- 需要按上下文判断（用户这次是否要求了这件事）时，评估用小模型分类。
