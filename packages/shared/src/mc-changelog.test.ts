import { describe, expect, it } from "vitest";
import type { ChangelogEntry } from "./changelog.js";
import {
  compareMcVersions,
  getMcChangelogEntry,
  MC_CHANGELOG,
  mcReleaseNotesSince,
  resolveMcChangelogLocale,
} from "./mc-changelog.js";

const catalog: Record<"zh-CN" | "en", readonly ChangelogEntry[]> = {
  "zh-CN": [
    { version: "1.0.22", highlights: ["新功能 C"] },
    { version: "1.0.21", highlights: [] },
    { version: "1.0.20", highlights: ["新功能 A", "修复 B"] },
  ],
  en: [{ version: "1.0.20", highlights: ["Feature A", "Fix B"] }],
};

describe("mc changelog", () => {
  it("keeps the mc catalogs separate from upstream 0.x notes and newest-first", () => {
    for (const entries of Object.values(MC_CHANGELOG)) {
      for (const entry of entries) expect(compareMcVersions(entry.version, "1.0.0")).toBeGreaterThanOrEqual(0);
      const versions = entries.map((entry) => entry.version);
      expect([...versions].sort((a, b) => compareMcVersions(b, a))).toEqual(versions);
    }
  });

  it("compares semver numerically", () => {
    expect(compareMcVersions("1.0.10", "1.0.9")).toBeGreaterThan(0);
    expect(compareMcVersions("v1.1.0", "1.0.99")).toBeGreaterThan(0);
    expect(compareMcVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("defaults to zh-CN and only uses en for English locales", () => {
    expect(resolveMcChangelogLocale("zh-TW")).toBe("zh-CN");
    expect(resolveMcChangelogLocale("de")).toBe("zh-CN");
    expect(resolveMcChangelogLocale("en-US")).toBe("en");
    expect(getMcChangelogEntry("1.0.0")).toBeUndefined();
  });

  it("returns visible notes after the last seen version up to the current one", () => {
    expect(mcReleaseNotesSince("1.0.19", "1.0.22", "zh-CN", catalog).map((e) => e.version)).toEqual([
      "1.0.22",
      "1.0.20",
    ]);
    expect(mcReleaseNotesSince("1.0.20", "1.0.21", "zh-CN", catalog)).toEqual([]);
  });

  it("falls back to zh-CN when the English entry is missing", () => {
    const notes = mcReleaseNotesSince("1.0.19", "1.0.22", "en", catalog);
    expect(notes.map((e) => e.highlights[0])).toEqual(["新功能 C", "Feature A"]);
  });

  it("does not pop up on first run, same version or downgrade", () => {
    expect(mcReleaseNotesSince(null, "1.0.22", "zh-CN", catalog)).toEqual([]);
    expect(mcReleaseNotesSince("1.0.22", "1.0.22", "zh-CN", catalog)).toEqual([]);
    expect(mcReleaseNotesSince("1.0.22", "1.0.20", "zh-CN", catalog)).toEqual([]);
  });
});
