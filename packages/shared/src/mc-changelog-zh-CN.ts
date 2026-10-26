import type { ChangelogEntry } from "./changelog.js";

/**
 * mc-agent 自己的更新说明（简体中文，源语言）。新版本放最前面。
 *
 * 规则见 docs/mc-agent/release-notes.md：
 * - 一个 mc-agent 版本一条，汇总该版本合入的所有 PR 的「更新说明（用户可见）」。
 * - `highlights: []` 表示「本版没有用户可见变化」，安装后不弹「更新了什么」。
 * - 这里只放 mc-agent 的版本（1.x），上游 0.x 的说明在 changelog-*.ts，不要混写。
 * - 本文件只允许 `import type`：发布检查直接用 Node 运行它，不经过构建。
 *
 * 第一条真实条目随 1.0.20（或之后的第一个版本）发布时补上。
 */
export const mcZhCNEntries: ChangelogEntry[] = [];
