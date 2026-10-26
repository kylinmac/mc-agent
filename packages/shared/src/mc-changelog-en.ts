import type { ChangelogEntry } from "./changelog.js";

/**
 * English mirror of mc-changelog-zh-CN.ts (zh-CN is the source of truth).
 * Optional per version: a missing version falls back to the zh-CN entry.
 * When present, an entry must have the same number of highlights as zh-CN.
 * Type-only imports only (the release check runs this file with Node directly).
 */
export const mcEnEntries: ChangelogEntry[] = [
  {
    version: "1.0.20",
    date: "2026-10-26",
    highlights: [
      "Hold ⌘⇧Space (Ctrl+Shift+Space on Windows) to talk; on release your speech is typed into the composer, not sent. Change or turn off the key in Settings → Shortcuts.",
      "With a subscription account (ChatGPT/Codex, Claude, GitHub Copilot, Kimi, GLM, MiniMax), the composer shows the quota left, only for the windows the service has; hover for reset times.",
      "When a command the agent ran in the background ends, the agent is told and carries on with the result, without you having to nudge it.",
      "The agent saves your preferences, corrections and project constraints to project memory, so later conversations know them; its notes are marked “AI” in the memory panel and can be edited or deleted.",
      "New Settings → Agent → Hooks: shell commands that run before or after tool calls and when the agent would finish, e.g. a format check after edits or tests before finishing.",
      "In Full auto permission mode, force-pushes, pushes to the main branch, merging PRs, releases, publishing packages, deleting outside the project and sudo still ask first.",
      "When the agent delegates, a subagent can start from the current conversation instead of a fresh briefing.",
      "Remaining “PI-Desktop” labels in the app now say “mc-agent”.",
    ],
  },
];
