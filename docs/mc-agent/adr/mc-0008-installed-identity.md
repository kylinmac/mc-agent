# MC-ADR-0008: 安装版使用独立身份

**Status:** Accepted
**Date:** 2026-10-19
**Deciders:** 产品负责人

## 背景

要出阶段性安装包。打包配置一直沿用上游身份：应用名 `PI-Desktop`、`appId` `net.aiuo.pi-desktop`、数据目录 `~/.pi-desktop`、Electron `userData` `~/Library/Application Support/PI-Desktop`。用户机器上已经装着上游 PI-Desktop 并在用，装 mc-agent 会替换 `/Applications/PI-Desktop.app`，和它争单实例锁，并直接改它的数据库（mc-agent 的新表结构可能让原版打不开这份数据）。开发版早已分开（`PI-Desktop Dev`、`~/.pi-desktop-dev`，上游 ADR 0094）。

## 决定

1. **安装版是独立应用 mc-agent。** `productName` `mc-agent`，`appId` `com.kylinmac.mc-agent`（`@pi-desktop/shared` 的 `APP_ID` 同步），安装包名 `mc-agent-<版本>-<架构>`。
2. **数据分开。** 安装版数据目录 `~/.mc-agent`；主进程在安装版里把应用名设为 `mc-agent`，`userData`（单实例锁、渲染进程存储）和 safeStorage 钥匙串条目随之独立。首次打开是空的，不复制 PI-Desktop 的数据。开发版不变。`PI_DESKTOP_DATA_DIR` 仍可覆盖。
3. **更新源指向 fork。** `publish` 与 `resources/app-update.yml` 改为 `kylinmac/mc-agent`。
4. **签名。** 目前没有开发者证书，macOS 包为临时签名、未公证，首次打开需右键“打开”或在“隐私与安全性”里放行。

## 影响

- 改动上游：`apps/desktop/package.json`（打包身份）、`electron/main/data-paths.ts`、`electron/main/installation.ts`、`packages/shared/src/protocol.ts`（`APP_ID`）、`resources/app-update.yml`；上游身份相关测试相应调整（`auto-update`、`ci-workflow`、`development-profile`）。
- 界面文案、Windows/Linux 包名和远程主机上的 `~/.pi-desktop/pi-host` 仍是上游名称，暂不改。
- 已有数据要用时需手动迁移；以后需要可加一次性导入。

## 重访条件

- 有了开发者证书后改为签名并公证。
- 需要从 PI-Desktop 导入数据时，加导入功能。

## 修订（2026-10-22）

开发版的 bundle 改名为 `mc-agent Dev`、`com.kylinmac.mc-agent.dev`（`scripts/dev-electron.mjs`），系统设置和 Dock 不再显示上游的 PI-Desktop。只改 bundle：数据目录 `~/.pi-desktop-dev` 和 Electron 的 userData 名由代码设定，不变；改名后开发版需要重新授权一次，钥匙串可能询问一次访问。见 [MC-ADR-0015](mc-0015-macos-permissions.md)。

## 修订（2026-10-24）：窗口显示名称

修复既有安装版身份的遗漏：主窗口原生标题与 HTML 文档标题统一为 `mc-agent`，语音浮窗原生标题使用 `mc-agent Live Voice`。开发版同样显示该产品名，避免 Windows 任务栏预览仍显示 PI-Desktop。沿用现有账号、数据目录、userData 和协议名称，不迁移数据。

源码回归检查覆盖原生窗口标题、HTML 标题与打包产品名的一致性；系统任务栏显示需在更新版本后人工确认。
