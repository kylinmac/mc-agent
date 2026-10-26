# 更新说明流程（PR 模板 → 版本条目 → 发布门禁）

状态：建议，待确认（2026-10-26）。决定记录见 [MC-ADR-0017](adr/mc-0017-post-update-whats-new.md)。本文件只管“写什么、什么时候写、发布时怎么查”；安装后自动弹出“更新了什么”的界面在下一个 PR。

## 1. 每个 PR：写「更新说明（用户可见）」

`.github/pull_request_template.md` 规定四节：改动 / 更新说明（用户可见）/ 刻意未改 / 验证。

- **改动** 写给评审：做了什么、为什么，可以有文件名和实现细节。
- **更新说明（用户可见）** 写给最终用户：一行一件事，说用户现在能做到什么、看到什么、哪里不再出问题。不写文件名、函数名、PR 号。没有用户可见变化写「无」。
- 合入 PR 时**不改** `mc-changelog`。一个版本常包含多个 PR，逐个 PR 改同一个数组容易冲突，措辞也不统一。

## 2. 发版前：多个 PR 合成一条版本条目

一个 mc-agent 版本（如 `1.0.20`）在 `packages/shared/src/mc-changelog-zh-CN.ts` 里只有**一条**：

```ts
{
  version: "1.0.20",          // 不带 v，与标签一致
  date: "2026-10-27",         // 可选
  highlights: [
    "输入框左侧显示订阅账号剩余额度，悬停可看每个窗口的重置时间。",
    "按住 ⌘⇧Space 说话，松开后转成文字填进输入框。",
  ],
},
```

步骤：

1. 列出上一个标签以来合入的 PR：`gh pr list --state merged --base main --search "merged:>=<上个版本日期>"`，或看 `git log v<上个版本>..main --merges`。
2. 收集每个 PR 的「更新说明（用户可见）」，去掉「无」。
3. 合并同类、删掉对用户没意义的细节，按“新功能 → 改进 → 修复”排序；一般不超过 8 行。
4. 全部 PR 都是「无」时也要加一条，写 `highlights: []`：表示有意的静默版本，装好后不弹窗。
5. 英文 `mc-changelog-en.ts` 可选；写了就要与中文条数一致。中文界面读中文，其他界面语言读英文，缺英文时回落到中文。
6. 这条改动走一个普通 PR（如 `docs: 1.0.20 更新说明`）合入 main，**然后**再打标签。条目必须在标签里，因为安装包里的弹窗只读打包进去的内容。

这里只写 mc-agent 自己的 1.x 版本。上游 PI-Desktop 0.x 的说明在 `packages/shared/src/changelog-*.ts`，同步上游时原样合入，不在里面加 mc-agent 的版本，也不把上游条目搬过来。合入上游带来的用户可见变化，由合并 PR 的「更新说明」挑出要点写进 mc-agent 版本条目。

## 3. 发布门禁

| 位置 | 检查 | 作用 |
|---|---|---|
| Docs check（PR 和 main，`docs-check.yml`） | `node scripts/check-mc-changelog.mjs` | 已有条目的格式：版本 `x.y.z` 且 ≥ 1.0.0、不重复、新版本在前；日期 `YYYY-MM-DD`；要点是非空字符串、不带项目符号；英文版本必须在中文里存在且条数一致 |
| `mc-agent Release` 的 prepare（`mc-release.yml`） | 在 `v<版本>` 的 worktree 上跑 `check-mc-changelog.mjs --require <版本>` | 标签里没有该版本条目、或有比它还新的条目时失败，**不会创建草稿**，也不会开始构建 |

- 门禁从 `1.0.20` 开始（脚本里的 `REQUIRED_FROM`）。`v1.0.19` 及之前的标签早于本流程，重跑它们的草稿不受影响；本 PR 不为历史版本补条目。
- 第一条真实条目随第一个用到门禁的版本（`1.0.20` 或之后）一起写。
- 上游的 `scripts/check-release-docs.mjs`（`APP_VERSION` 0.21.0、`changelog*.ts`）不读 `mc-changelog*`，两者互不影响。
- 门禁失败的处理：补条目的 PR 合入 main 后，标签要指向包含条目的提交。标签还没公开发布时可删掉重打；已公开的版本不可覆盖（见[云端发布](cloud-release.md)），只能发下一个版本。

## 4. 发布顺序（补充[云端发布](cloud-release.md)）

1. 功能 PR 按模板写好「更新说明」，通过检查后合入 main。
2. 汇总成版本条目（第 2 节），PR 合入 main。
3. 在该提交上创建并推送 `v<版本>`。
4. `gh workflow run mc-release.yml -f version=<版本>`；prepare 先检查条目，再建草稿、构建、发布。

GitHub Release 页面的正文暂时仍是 `--generate-notes` 自动生成；是否改用同一条目，等弹窗上线后再定。
