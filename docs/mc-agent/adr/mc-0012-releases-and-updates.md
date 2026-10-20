# MC-ADR-0012: 发布到 GitHub Releases 与更新提醒

**Status:** Accepted
**Date:** 2026-10-20
**Deciders:** 产品负责人

## 背景

应用内更新沿用上游的 electron-updater：从 `kylinmac/mc-agent` 的 GitHub Releases 读取 `latest-mac.yml`，比较版本后下载。此前 fork 没有发布过 Release，每次打包的版本都是上游的 `0.20.1`，检查更新永远找不到新版本。另外安装包只做 ad-hoc 签名，macOS 的 Squirrel.Mac 要求新版本与正在运行的应用签名身份一致，ad-hoc 签名没有固定身份，应用内替换会被拒绝。

## 决定

1. **发布脚本。** `scripts/mc-release.mjs <版本>`（`pnpm release:mc <版本>`）：检查工作区干净、在 main 且已推送、版本比最新 Release 新；构建并 ad-hoc 签名；核对 `latest-mac.yml`、应用内版本和签名；打 `v<版本>` 标签并推送；以草稿上传 zip、dmg、两个 blockmap 和 `latest-mac.yml`，全部上传完成后才发布为 latest，更新检查不会读到半套文件。`--dry-run` 只构建和核对，`--skip-build` 复用已构建的产物。
2. **独立版本线，只写进安装包。** mc-agent 从 1.0.0 起有自己的版本号（1.0.1、1.1.0…），与上游 0.20.x 分开。 通过 electron-builder `extraMetadata.version` 写入打包后的 `package.json`，工作区各 `package.json`、`Cargo.toml` 保持上游版本，避免同步上游时冲突。
3. **ad-hoc 构建只提醒不替换。** 发布脚本给安装包写入 `mcUpdateDelivery: "notify"`；macOS 上读到它时不支持自动更新，更新方式固定为手动：发现新版本后提示并打开 Release 页面下载。有 Developer ID 签名和公证后去掉这个标记即可恢复应用内更新。
4. **Release 页面链接** 指向本仓库（`updater.ts` 的 `RELEASES_URL`），不再指向上游。

## 影响

- 改动上游：`electron/main/update-policy.ts`、`electron/main/updater.ts`、`test/update-preference.test.mjs`；新增 `scripts/mc-release.mjs`。
- 关于页等处显示的 `APP_VERSION`（`packages/shared/src/protocol.ts`）仍是上游版本，更新检查使用的是安装包版本。
- 不经脚本、直接 `dist:mac` 打出的包没有通知标记，版本也是上游的，只适合本地使用。

## 重访条件

- 取得 Developer ID 证书后：签名、公证，并恢复应用内自动更新。
- 需要 Intel 或其他平台安装包时扩展脚本。
