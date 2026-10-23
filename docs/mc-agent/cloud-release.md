# 云端发布（R16；P12；V52）

已确定（2026-10-23）：macOS arm64 与 Windows x64 都由 GitHub Actions 从同一个版本标签构建。macOS 沿用 ad-hoc 签名和应用内自更新；Windows 沿用 Setup 与 NSIS 静默更新。不得把旧版本包复制进新版本。

P12：Actions 中运行 `mc-agent Release`，填写版本号（不含 v）。标签须已存在且属于 main 历史。流程准备草稿、并行构建两端、验证产物与更新源，最后一次性公开；任何构建失败都不发布。已公开的版本不可覆盖。工作区版本号不随 fork 发版修改。

V52：验证非法版本、缺失文件、版本错配与 SHA-512 错配会失败；验证两端真实云端构建、macOS 签名与 helper、Windows 安装升级测试，以及最终草稿发布。首次运行结果另行记录，不把工作流存在当作验证通过。

发布操作：先让代码通过 PR 检查并合入 main，创建并推送 `v<版本>`，再运行 `gh workflow run mc-release.yml -f version=<版本>`。如已有草稿，可重跑；仅草稿允许替换同名产物。旧 `mc-windows.yml` 保留独立调试入口，统一发布流程复用其构建任务但关闭直接上传。

当前支持与既有正式包一致：macOS Apple Silicon、Windows x64。Intel Mac、Linux 不属于本次扩展。macOS 没有 Developer ID 公证，首次安装的系统提示和更新后权限行为保持现状。
