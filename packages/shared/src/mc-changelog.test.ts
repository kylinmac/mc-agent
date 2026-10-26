import { describe, expect, it } from "vitest";
import {
  compareMcVersions,
  getMcChangelogEntry,
  MC_CHANGELOG,
  mcChangeSections,
  mcChangelogEntries,
  mcReleaseNotesSince,
  resolveMcChangelogLocale,
  type McReleaseNotes,
} from "./mc-changelog.js";

const catalog: Record<"zh-CN" | "en", readonly McReleaseNotes[]> = {
  "zh-CN": [
    { version: "1.0.22", features: ["新功能 C"] },
    { version: "1.0.21", fixes: [] },
    { version: "1.0.20", fixes: ["修复 B"], features: ["新功能 A"] },
  ],
  en: [{ version: "1.0.20", features: ["Feature A"], fixes: ["Fix B"] }],
};

describe("mc changelog", () => {
  it("keeps the mc catalogs separate from upstream 0.x notes and newest-first", () => {
    for (const entries of Object.values(MC_CHANGELOG)) {
      for (const entry of entries) expect(compareMcVersions(entry.version, "1.0.0")).toBeGreaterThanOrEqual(0);
      const versions = entries.map((entry) => entry.version);
      expect([...versions].sort((a, b) => compareMcVersions(b, a))).toEqual(versions);
    }
  });

  it("groups lines as features, improvements, fixes and flattens them in that order", () => {
    expect(mcChangeSections({ version: "1.0.30", fixes: ["F"], improvements: [], features: ["N"] })).toEqual([
      { kind: "features", items: ["N"] },
      { kind: "fixes", items: ["F"] },
    ]);
    const [entry] = mcReleaseNotesSince("1.0.19", "1.0.20", { locale: "en", catalog });
    expect(entry.highlights).toEqual(["Feature A", "Fix B"]);
    expect(entry.sections.map((section) => section.kind)).toEqual(["features", "fixes"]);
  });

  it("compares semver numerically", () => {
    expect(compareMcVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareMcVersions("v1.1.0", "1.0.99")).toBeGreaterThan(0);
    expect(compareMcVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("uses zh-CN for Chinese and en for every other language", () => {
    expect(resolveMcChangelogLocale("zh-TW")).toBe("zh-CN");
    expect(resolveMcChangelogLocale(undefined)).toBe("zh-CN");
    expect(resolveMcChangelogLocale("de")).toBe("en");
    expect(resolveMcChangelogLocale("en-US")).toBe("en");
    expect(getMcChangelogEntry("1.0.0")).toBeUndefined();
  });

  it("returns visible notes after the last seen version up to the current one", () => {
    expect(mcReleaseNotesSince("1.0.19", "1.0.22", { locale: "zh-CN", catalog }).map((e) => e.version)).toEqual([
      "1.0.22",
      "1.0.20",
    ]);
    expect(mcReleaseNotesSince("1.0.20", "1.0.21", { locale: "zh-CN", catalog })).toEqual([]);
  });

  it("falls back to zh-CN when the English entry is missing", () => {
    const notes = mcReleaseNotesSince("1.0.19", "1.0.22", { locale: "en", catalog });
    expect(notes.map((e) => e.highlights[0])).toEqual(["新功能 C", "Feature A"]);
  });

  it("falls back to zh-CN for other languages without an English entry", () => {
    const notes = mcReleaseNotesSince("1.0.19", "1.0.22", { locale: "de", catalog });
    expect(notes.map((e) => e.highlights[0])).toEqual(["新功能 C", "Feature A"]);
  });

  it("shows only the current version to an existing install with no record yet", () => {
    expect(mcReleaseNotesSince(null, "1.0.20", { existingInstall: true, catalog }).map((e) => e.version)).toEqual([
      "1.0.20",
    ]);
    expect(mcReleaseNotesSince(null, "1.0.21", { existingInstall: true, catalog })).toEqual([]);
  });

  it("does not pop up on a fresh install, same version or downgrade", () => {
    expect(mcReleaseNotesSince(null, "1.0.22", { locale: "zh-CN", catalog })).toEqual([]);
    expect(mcReleaseNotesSince("1.0.22", "1.0.22", { locale: "zh-CN", catalog })).toEqual([]);
    expect(mcReleaseNotesSince("1.0.22", "1.0.20", { locale: "zh-CN", catalog })).toEqual([]);
  });

  it("lists every version in the reader's language where written", () => {
    expect(mcChangelogEntries("en", catalog).map((e) => e.highlights[0])).toEqual([
      "新功能 C",
      undefined,
      "Feature A",
    ]);
    expect(mcChangelogEntries("zh-CN", catalog).map((e) => e.version)).toEqual(["1.0.22", "1.0.21", "1.0.20"]);
  });
});
