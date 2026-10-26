import type { ChangelogEntry } from "./changelog.js";

/**
 * English mirror of mc-changelog-zh-CN.ts (zh-CN is the source of truth).
 * Optional per version: a missing version falls back to the zh-CN entry.
 * When present, an entry must have the same number of highlights as zh-CN.
 * Type-only imports only (the release check runs this file with Node directly).
 */
export const mcEnEntries: ChangelogEntry[] = [];
