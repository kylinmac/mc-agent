import type { ChangelogEntry } from "./changelog.js";
import { normalizeChangelogVersion } from "./changelog-runtime.js";
import { mcEnEntries } from "./mc-changelog-en.js";
import { MC_CHANGE_KINDS, type McChangeKind, type McReleaseNotes } from "./mc-changelog-types.js";
import { mcZhCNEntries } from "./mc-changelog-zh-CN.js";

export { MC_CHANGE_KINDS, type McChangeKind, type McReleaseNotes } from "./mc-changelog-types.js";

/**
 * mc-agent 自己的版本更新说明（MC-ADR-0017）。
 *
 * 与上游 `CHANGELOG`（changelog-*.ts，PI-Desktop 0.x 版本）分开：
 * 上游文件随同步上游原样合入，mc-agent 1.x 版本的说明只写在这里。
 * 简体中文是源语言，英文可选。中文界面读中文，其他界面语言读英文，
 * 缺英文时回落到中文。
 *
 * 每个版本按 新功能 / 优化 / 修复 分组（McReleaseNotes）。对外返回的
 * McChangelogEntry 同时带 `sections`（分组，界面按组显示）和 `highlights`
 * （按组顺序拍平，兼容上游只认 ChangelogEntry 的地方）。
 *
 * 安装版启动时由 apps/desktop 的 McWhatsNew 弹出「更新内容」。
 */

export type McChangelogLocale = "zh-CN" | "en";

export type McChangeSection = { kind: McChangeKind; items: string[] };

/** One version as shown: grouped `sections` plus the same lines flattened into `highlights`. */
export type McChangelogEntry = ChangelogEntry & { sections: McChangeSection[] };

type McCatalog = Record<McChangelogLocale, readonly McReleaseNotes[]>;

/** Locale → newest-first mc-agent release notes. */
export const MC_CHANGELOG: McCatalog = {
  "zh-CN": mcZhCNEntries,
  en: mcEnEntries,
};

/** Non-empty categories in display order (新功能 → 优化 → 修复). */
export function mcChangeSections(notes: McReleaseNotes): McChangeSection[] {
  return MC_CHANGE_KINDS.map((kind) => ({ kind, items: notes[kind] ?? [] })).filter(
    (section) => section.items.length > 0,
  );
}

function toEntry(notes: McReleaseNotes): McChangelogEntry {
  const sections = mcChangeSections(notes);
  return {
    version: notes.version,
    ...(notes.date ? { date: notes.date } : {}),
    sections,
    highlights: sections.flatMap((section) => section.items),
  };
}

export function resolveMcChangelogLocale(input?: string | null): McChangelogLocale {
  const value = (input || "").replaceAll("_", "-").toLowerCase();
  return !value || value === "zh" || value.startsWith("zh-") ? "zh-CN" : "en";
}

/** Compare two `x.y.z` versions (leading `v` allowed). Non-semver sorts first. */
export function compareMcVersions(a: string, b: string): number {
  const parse = (value: string) =>
    /^(\d+)\.(\d+)\.(\d+)$/
      .exec(normalizeChangelogVersion(value))
      ?.slice(1)
      .map(Number);
  const left = parse(a);
  const right = parse(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let index = 0; index < 3; index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function getMcChangelogEntry(
  version: string | null | undefined,
  localeInput?: string | null,
): McChangelogEntry | undefined {
  const key = normalizeChangelogVersion(version);
  if (!key) return undefined;
  const locale = resolveMcChangelogLocale(localeInput);
  const notes =
    MC_CHANGELOG[locale].find((entry) => entry.version === key) ??
    MC_CHANGELOG["zh-CN"].find((entry) => entry.version === key);
  return notes ? toEntry(notes) : undefined;
}

export type McReleaseNotesOptions = {
  locale?: string | null;
  /**
   * 没有 `lastSeen` 记录时，本机是否已经装过（例如已有设置）。第一次带上
   * 这项功能的版本对所有老用户都没有记录，靠它区分升级和新安装。
   */
  existingInstall?: boolean;
  catalog?: McCatalog;
};

/**
 * 计划中的弹窗触发规则（MC-ADR-0017）：返回「上次看过的版本」之后、
 * 到当前版本为止、且有用户可见内容的条目，新版本在前。
 *
 * - `lastSeen` 为空时：新安装返回空（只记录版本，不弹）；已有安装视为
 *   从上一个版本升级，只返回当前版本这一条。
 * - 降级或版本相同时返回空。
 * - 三类都为空的版本（无用户可见变化）跳过。
 */
export function mcReleaseNotesSince(
  lastSeen: string | null | undefined,
  current: string | null | undefined,
  { locale: localeInput, existingInstall = false, catalog = MC_CHANGELOG }: McReleaseNotesOptions = {},
): McChangelogEntry[] {
  const from = normalizeChangelogVersion(lastSeen);
  const to = normalizeChangelogVersion(current);
  if (!to || (!from && !existingInstall) || (from && compareMcVersions(to, from) <= 0)) return [];
  const locale = resolveMcChangelogLocale(localeInput);
  const versions = catalog["zh-CN"]
    .map((entry) => entry.version)
    .filter((version) =>
      from ? compareMcVersions(version, from) > 0 && compareMcVersions(version, to) <= 0 : compareMcVersions(version, to) === 0,
    )
    .sort((a, b) => compareMcVersions(b, a));
  const result: McChangelogEntry[] = [];
  for (const version of versions) {
    const notes =
      catalog[locale].find((item) => item.version === version) ??
      catalog["zh-CN"].find((item) => item.version === version);
    const entry = notes ? toEntry(notes) : undefined;
    if (entry?.highlights.length) result.push(entry);
  }
  return result;
}

/** Every mc-agent version's notes, newest first, in the reader's language where written. */
export function mcChangelogEntries(
  localeInput?: string | null,
  catalog: McCatalog = MC_CHANGELOG,
): McChangelogEntry[] {
  const locale = resolveMcChangelogLocale(localeInput);
  return catalog["zh-CN"].map((entry) =>
    toEntry(catalog[locale].find((item) => item.version === entry.version) ?? entry),
  );
}
