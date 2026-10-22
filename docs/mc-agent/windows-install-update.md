# Windows 安装与更新（R15 / P10 / V50）

## 使用方式

| 文件或入口 | 用途 |
|---|---|
| `mc-agent-Setup-<版本>.exe` | 推荐首次安装：暗色单页，选择位置，安装完成后打开 |
| 应用内“重启并更新” | 后台下载已校验的新版本，静默更新原安装目录并重新打开 |
| `mc-agent-Update-<版本>.exe` / `.blockmap` / `latest.yml` | 更新器使用的载荷和元数据，无需用户手动操作 |
| `mc-agent-Portable-<版本>.exe` / `.zip` | 可选便携版，默认手动更新；不会因默认设置自动转成安装版 |

旧版本自身的更新交互不会被远程改写。便携版用户需主动安装一次 Setup；旧安装版升级到本次代码对应的版本后，后续更新使用静默重启流程。

## 设计

- 主背景 `gray-900 #181818`、卡片 `gray-800 #212121`、浮起控件 `gray-750 #282828`、次要文字 `gray-300 #afafaf`、主按钮白底深色文字。与桌面 `tokens.css` 对齐。
- 28px 标题、14px 正文、12px 辅助信息；12px 卡片圆角、8px 按钮圆角；Segoe UI 与中文系统字体。
- 主操作只有安装／打开；路径是次要信息，可通过系统目录选择器更改。安装中显示不定进度，不编造完成百分比；安装进程成功退出且目标程序存在后才显示完成。
- 文案在 `packages/i18n/windows-installer/`，支持英文、简体中文；中文系统优先中文，其他系统用英文。
- 参考了 Docker Desktop 安装／完成页的信息收敛，以及本机 Codex 的应用包形态；没有声称复现 Codex 的首次安装画面。参考：[Docker 官方 Windows 安装说明](https://docs.docker.com/desktop/setup/install/windows-install/)。

## 构建

`scripts/build-desktop-release.mjs win` 先构建 NSIS 更新载荷，再调用 `scripts/build-windows-installer.mjs` 校验 feed 并生成内嵌载荷的 Setup，最后构建独立便携产物。Windows workflow 同时保留和上传 Setup、Update、blockmap、ZIP、便携 EXE 与 feed。

## 验证记录

- 已通过：21 项更新相关 Node 测试；桌面 typecheck；`pnpm lint`；608 页文档检查；专项真实 NSIS 测试使用自建程序验证中文及空格路径、原目录复用、静默更新、自动启动、独立数据哨兵保留、卸载调用；非法根目录和错误校验和均被拒绝。
- 新界面已通过 C# 编译；中英文初始／安装中／完成／错误页面通过真实 WPF 离屏渲染检查。测试包的界面控制器实际完成了首次安装并打开测试程序。
- 未验证：完整 mc-agent 安装与从已发布版本更新、全机器安装的 UAC 提权、多显示器混合 DPI、断电恢复。离屏 2 倍渲染不等同于真实混合 DPI 验收。
- 当前机器完整 `pnpm install` 在 `node-pty` 本机编译步骤失败；工作区 JS 依赖构建及 typecheck 可通过。额外运行的历史更新缓存／macOS 脚本测试有 3 项因 POSIX 路径断言或缺少 `/bin/sh` 在 Windows 失败，本次未修改这些测试。
- 本文不代表已发布；PR 合并与 Release 发布分开。
