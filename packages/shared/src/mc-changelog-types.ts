/**
 * 一个 mc-agent 版本的更新说明（MC-ADR-0017），按类别写。
 *
 * 三类都没有（或都是 `[]`）表示本版没有用户可见变化，安装后不弹窗。
 * 写法见 docs/mc-agent/release-notes.md：一行一件事，说用户得到了什么。
 */
export type McReleaseNotes = {
  /** x.y.z，不带 v，与标签一致。 */
  version: string;
  /** 可选，YYYY-MM-DD。 */
  date?: string;
  /** 新功能：以前做不到、现在能做的事。 */
  features?: string[];
  /** 优化：已有功能更好用、更少步骤、更安全。 */
  improvements?: string[];
  /** 修复：以前出错的地方，现在不再出错。 */
  fixes?: string[];
};

/** 弹窗和发版日志里的显示顺序。 */
export const MC_CHANGE_KINDS = ["features", "improvements", "fixes"] as const;
export type McChangeKind = (typeof MC_CHANGE_KINDS)[number];
