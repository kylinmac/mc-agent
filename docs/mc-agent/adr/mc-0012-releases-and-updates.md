# MC-ADR-0012: 发布到 GitHub Releases 与更新提醒

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** 产品负责人

## 背景

应用内更新沿用上游的 electron-updater：从 `kylinmac/mc-agent` 的 GitHub Releases 读取 `latest-mac.yml`，比较版本后下载。此前 fork 没有发布过 Release，每次打包的版本都是上游的 `0.20.1`，检查更新永远找不到新版本。另外安装包只做 ad-hoc 签名，macOS 的 Squirrel.Mac 要求新版本与正在运行的应用签名身份一致，ad-hoc 签名没有固定身份，应用内替换会被拒绝。

## 决定

1. **发布脚本。** `scripts/mc-release.mjs <版本>`（`pnpm release:mc <版本>`）：检查工作区干净、在 main 且已推送、版本比最新 Release 新；构建并 ad-hoc 签名；核对 `latest-mac.yml`、应用内版本和签名；打 `v<版本>` 标签并推送；以草稿上传 zip、dmg、两个 blockmap 和 `latest-mac.yml`，全部上传完成后才发布为 latest，更新检查不会读到半套文件。`--dry-run` 只构建和核对，`--skip-build` 复用已构建的产物。
2. **独立版本线，只写进安装包。** mc-agent 从 1.0.0 起有自己的版本号（1.0.1、1.1.0…），与上游 0.20.x 分开。 通过 electron-builder `extraMetadata.version` 写入打包后的 `package.json`，工作区各 `package.json`、`Cargo.toml` 保持上游版本，避免同步上游时冲突。
3. **ad-hoc 构建由应用自己替换（2026-10-21 修订）。** 发布脚本给安装包写入 `mcUpdateDelivery: "notify"`；macOS 上读到它时不走 Squirrel.Mac（它要求签名身份一致，ad-hoc 没有身份）。检查仍用 electron-updater；下载和安装改由 `electron/main/mc-self-update.ts` 完成：读该版本的 `latest-mac.yml`，下载本架构的 zip 并核对 SHA-512，解压后核对签名、bundle id 与版本；点“重启并更新”时写一个小脚本，等应用退出后替换 `.app`（失败则还原旧包）并重新打开。应用所在目录可写时才启用（状态里 `selfInstall`），否则仍是提示并打开 Release 页面。入口：左侧竖栏设置上方的圆形按钮（可下载 → 下载中进度环 → 重启并更新 → 失败可重试），以及更新提示和设置“关于”里的“下载并更新”。
   - 注意：ad-hoc 签名每次构建都不同，替换后 macOS 会把它当作新应用，辅助功能、录屏等系统权限需要重新授权。有 Developer ID 签名和公证后去掉标记即可恢复上游的应用内更新。
4. **Release 页面链接** 指向本仓库（`updater.ts` 的 `RELEASES_URL`），不再指向上游。

## 影响

- 改动上游：`electron/main/update-policy.ts`、`electron/main/updater.ts`、`electron/main/ipc/app-ipc.ts`（打包版报告自己的名称与版本）、`components/UpdateBanner.tsx`、`features/settings/agent-sections.tsx`、`packages/shared/src/types/platform.ts`（`selfInstall`）、`test/update-preference.test.mjs`；新增 `scripts/mc-release.mjs`、`electron/main/mc-self-update.ts`、`features/app-rail/UpdateRailButton.tsx`。
- 关于页显示安装包自己的名称和版本；开发版仍显示上游的 `APP_VERSION`。
- 不经脚本、直接 `dist:mac` 打出的包没有通知标记，版本也是上游的，只适合本地使用。

## 重访条件

2026-10-22：Windows 安装界面和静默更新由 [MC-ADR-0016](mc-0016-windows-installer.md) 补充；macOS 自更新方式保持不变。

- 取得 Developer ID 证书后：签名、公证，并恢复应用内自动更新。
- 需要 Intel 或其他平台安装包时扩展脚本。
