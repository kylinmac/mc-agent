# MC-ADR-0017: 更新后的“更新内容”与版本更新说明

**Status:** Accepted（2026-10-26 弹窗上线）
**Date:** 2026-10-26
**Deciders:** 产品负责人

## 背景

[MC-ADR-0012](mc-0012-releases-and-updates.md) 管的是**装之前**：发现新版本后，在左侧竖栏的更新按钮、更新横幅和设置“关于”里提示、下载、重启更新，不用弹窗打断用户。装好新版本**之后**，用户不知道这一版改了什么。

现有材料都接不上：

- 上游的 `CHANGELOG`（`packages/shared/src/changelog-*.ts`）是 PI-Desktop 0.x 的说明，随同步上游原样合入，并受上游 `scripts/check-release-docs.mjs`（`APP_VERSION` 0.21.0）约束；mc-agent 1.x 的版本在里面查不到，`updater.ts` 的 `notesFor()` 和设置里的 `ReleaseNotesDialog` 对安装版因此没有内容。
- GitHub Release 正文由 `--generate-notes` 按 PR 标题生成，是写给开发者的。
- PR 描述没有固定格式，用户可见的变化要发版时再从改动里猜。

## 决定

1. **独立的 mc-agent 更新说明。** `packages/shared/src/mc-changelog-zh-CN.ts`（源语言）和 `mc-changelog-en.ts`（可选；中文界面读中文，其他界面语言读英文，缺英文则回落中文），由 `mc-changelog.ts` 汇总并从 `@pi-desktop/shared` 导出。只写 mc-agent 1.x 版本，不改上游 `changelog-*.ts`，同步上游时不冲突。每个版本一条，按 `features`（新功能）/ `improvements`（优化）/ `fixes`（修复）分组（`McReleaseNotes`，见 `mc-changelog-types.ts`），三类都没有表示本版没有用户可见变化；对外的 `McChangelogEntry` 同时带分组 `sections` 和拍平的 `highlights`（兼容上游 `ChangelogEntry`）。2026-10-26 补充：1.0.20–1.0.22 原为扁平 `highlights`，已改为分类并重写成短句；这三个版本的旧标签仍可通过门禁（`FLAT_HIGHLIGHTS_UNTIL`）。
2. **PR 模板。** `.github/pull_request_template.md` 固定四节：改动 / 更新说明（用户可见）/ 刻意未改 / 验证。「更新说明」写给最终用户，没有就写「无」。PR 合入时不改 `mc-changelog`；发版前把该版本所有 PR 的「更新说明」汇总成一条（流程见[更新说明流程](../release-notes.md)）。
3. **发布门禁。** `scripts/check-mc-changelog.mjs`：Docs check 校验已有条目的格式；`mc-agent Release` 的 prepare 在校验版本号和标签之后、建草稿之前，在版本标签的 worktree 上加 `--require <版本>`，没有条目就失败，不建草稿、不构建。从 `1.0.20` 起生效（`REQUIRED_FROM`），之前的标签不追溯、不补条目。
4. **弹窗触发。** 本机在数据目录的 `release-notes-seen.json` 里记录上次看过的版本（Electron Main 读写）。安装版启动后若当前版本比它新，取两者之间有内容的条目（`mcReleaseNotesSince()`，已在本 PR 提供并测试）弹一次“更新内容”，关闭即把记录更新为当前版本；全是空条目则静默更新记录。没有记录时：新安装只写入当前版本、不弹窗；已有安装（数据目录里已有 `window-state.json` 或 `close-behavior.json`，例如第一次带上此功能的版本）视为从上一个版本升级，只弹当前版本这一条；降级不弹；开发版不弹。设置“信息”里的“发版日志”也改为读这份目录（`mcChangelogEntries()`），不再显示上游 0.x 的说明。弹窗标题为“更新内容”，按「新功能 / 优化 / 修复」分组显示；设置里的发版日志同样分组。

与 MC-ADR-0012 的界线：0012 仍不在“有新版本可下载”时弹窗；本 ADR 只在**已经装好**新版本后的首次启动弹一次，且内容来自打包进应用的目录，不联网。

## 影响

- 新增：`.github/pull_request_template.md`、`docs/mc-agent/release-notes.md`、`packages/shared/src/mc-changelog*.ts`（含测试）、`scripts/check-mc-changelog.mjs`（含测试）。
- 改动：`packages/shared/src/index.ts` 增加一行导出；`docs-check.yml` 增加格式检查；`mc-release.yml` 的 prepare 增加门禁（需要 Node 24 运行 TypeScript 类型擦除，数据文件只允许 `import type`）。
- 上游的 `changelog-*.ts`、`check-release-docs.mjs`、`APP_VERSION` 都不变。
- 发版多一步：打标签前先合入版本条目。

## 重访条件

- 若要求 GitHub Release 正文与应用内一致，改 prepare 用该条目生成正文，替代 `--generate-notes`。
- 若英文用户增多，把英文条目改为必填。
