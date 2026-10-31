import type { McReleaseNotes } from "./mc-changelog-types.js";

/**
 * English mirror of mc-changelog-zh-CN.ts (zh-CN is the source of truth).
 * Optional per version: a missing version falls back to the zh-CN entry.
 * When present, each category must have the same number of lines as zh-CN.
 * Plain release-note English: one line per change, what the user gets.
 * Type-only imports only (the release check runs this file with Node directly).
 */
export const mcEnEntries: McReleaseNotes[] = [
  {
    version: "1.0.40",
    date: "2026-10-31",
    features: [
      "Use the lightning button next to the model name to request Fast mode on supported models. Your choice is saved for each provider and model; enabling it may increase cost or quota usage.",
    ],
  },
  {
    version: "1.0.39",
    date: "2026-10-31",
    improvements: [
      "Settings, scheduled tasks, and plugins remain accessible from the left rail without taking up top tabs.",
      "Delegated tasks, agent messages, completion reports, and background command notices appear as collapsible cards with formatted content, source links, and original messages.",
    ],
    fixes: [
      "After compacting a conversation, switching models, or changing the context limit, the composer context indicator matches the statistics in the side panel.",
    ],
  },
  {
    version: "1.0.38",
    date: "2026-10-31",
    improvements: [
      "The tab context menu lets you rename or pin conversations, move tabs, and close other tabs, tabs to the right, or all tabs.",
      "Images in the composer now show thumbnails without hovering. Click to enlarge, remove individual images, or retry failed previews.",
    ],
  },
  {
    version: "1.0.37",
    date: "2026-10-31",
    fixes: [
      "After switching models, changing the context limit, or compacting a conversation, context statistics no longer show stale usage or conflicting totals and category breakdowns.",
    ],
  },
  {
    version: "1.0.36",
    date: "2026-10-30",
    fixes: [
      "With some Responses or Codex gateways, a nearly full context no longer skips compaction because cached input was left out of usage, so the next request no longer overflows.",
      "When a very long conversation is compacted in chunks, the first chunk no longer exceeds the model's context window.",
      "The read and modified file lists in a compaction summary no longer miss files used in the most recent stretch of work.",
    ],
  },
  {
    version: "1.0.35",
    date: "2026-10-30",
    improvements: [
      "After compaction, the agent can look up the original earlier messages to recover code, error text, or your exact wording the summary left out.",
      "After compaction, the agent gets back the contents of a few files it recently read or changed, so it does not have to read them again. Files that would need approval are skipped without a prompt.",
    ],
    fixes: [
      "On models with a small output limit, compaction no longer loses the whole earlier history when the summary runs too long; a cut-off summary is retried once in a shorter form.",
      "When compaction retries, the attempt count in its progress no longer starts at 3.",
    ],
  },
  {
    version: "1.0.34",
    date: "2026-10-30",
    improvements: [
      "After viewing, waiting for, or stopping a subagent, the result list can open that subagent's detail. Finished tasks no longer say they are still coordinating.",
    ],
    fixes: [
      "After paging or reopening a long conversation, subagent cards still connect to earlier creation records.",
      "Sending a follow-up while a run is active no longer auto-hides working subagent cards; manual collapse choices stay.",
    ],
  },
  {
    version: "1.0.33",
    date: "2026-10-30",
    features: [
      "Optional questions can continue with the recommended answer after a configurable 10–300 second wait. This is off by default, and question cards remain available for a later answer.",
    ],
    improvements: [
      "Conversation compaction prioritizes goals, constraints, key decisions, and unfinished work while reducing repeated summary content. It now shows progress and elapsed time, with safeguards for stalled requests and cancellation.",
      "Model and reasoning changes now show whether they will apply after the current turn, are being applied, or have not taken effect. Rapid changes no longer let older results overwrite your latest selection.",
    ],
    fixes: [
      "Auto mode no longer requests Bash approval merely because search text contains dangerous command names or a Docker command uses --rm.",
      "Project memories, creative assets, generated results, and saved scripts no longer retain broken paths after moving the data directory or renaming the resources directory.",
      "Fixed lost drafts for project goals and directory descriptions, and updates overwriting each other when saving project memories concurrently or changing settings quickly.",
      "Late startup results no longer mark finished tasks or exited runtime processes as running again, preventing subsequent messages from getting stuck.",
      "Hermes imports no longer truncate or omit structured messages with special prefixes.",
    ],
  },
  {
    version: "1.0.32",
    date: "2026-10-29",
    fixes: [
      "Codex import no longer stops at the newest 250 session files. Older conversations and earlier continuation segments are included instead of being missed or imported only in part.",
      "On Windows, ordinary and extended paths and case differences for the same directory now share one import project, keeping its conversations together.",
    ],
  },
  {
    version: "1.0.31",
    date: "2026-10-28",
    fixes: [
      "Importing from Codex now lists every Codex conversation on this computer, including the Codex projects in the ChatGPT desktop app; after newer Codex builds moved older chats into their database, only a dozen or so showed up. Guardian reviews and sub-agent runs no longer appear in the list.",
    ],
  },
  {
    version: "1.0.30",
    date: "2026-10-28",
    fixes: [
      "Links to a folder in a conversation now open that folder in the File Manager, and right-click copies its full and relative path; they used to report \"no matching file\".",
    ],
  },
  {
    version: "1.0.29",
    date: "2026-10-28",
    fixes: [
      "After the Grok subscription's weekly quota resets, the quota chip in the composer no longer disappears; it shows \"Week 100%\".",
    ],
  },
  {
    version: "1.0.28",
    date: "2026-10-28",
    features: [
      "Settings → System prompts has new Append prompts: their text is added after the existing system prompt and never replaces a template or the default; turn each on or off and reorder them, and they apply to every conversation.",
    ],
  },
  {
    version: "1.0.27",
    date: "2026-10-28",
    features: [
      "The session work panel has a new Canvas: ask the Agent to draw prototypes, screens, or side-by-side options, and click through the boards directly.",
      "Select an element on a board or leave a comment for the Agent, and it knows exactly which button or text you mean; it replies in the comment when done.",
      "Restore a board the Agent changed to its previous version in one click; when a board breaks, click \"Ask the agent to fix\".",
      "Export a canvas as one HTML file that others can open in a browser, with boards still clickable.",
    ],
    improvements: [
      "The Codex tab of the import dialog explains that only sessions stored on this computer can be imported; cloud chats and ChatGPT projects from ChatGPT on the web or the desktop app's Chat / Work are not local. It also says when only the newest Codex sessions were scanned.",
    ],
    fixes: [
      "Importing from Codex no longer misses conversations started in the Codex desktop app or IDE extension: their messages carry editor context first and were skipped as injected text, so sessions without a title disappeared. The real request after \"My request for Codex\" is now used for the title and content.",
      "Importing from Codex also lists archived sessions (~/.codex/archived_sessions) and honors a Codex folder set with CODEX_HOME.",
    ],
  },
  {
    version: "1.0.26",
    date: "2026-10-27",
    improvements: [
      "In a project with several folders, the sidebar \"+\" asks whether the new task starts in the resource folder or a workspace, with the last choice selected.",
      "The project workbench's task list lets you pick the folder tasks run in; a folder picked in the workbench is also used by the \"New task\" button and the project menu.",
    ],
    fixes: [
      "In a question card, after choosing \"Enter another answer\", Enter submits (or moves to the next question) and Shift+Enter adds a line; confirming an input-method candidate no longer submits.",
      "With an MCP server connected, the session info panel no longer shows 0 MCP tools.",
    ],
  },
  {
    version: "1.0.25",
    date: "2026-10-27",
    features: [
      "Import conversations from Hermes Agent, including every Hermes profile, with text and tool history; a conversation Hermes continued after compressing its context imports as one.",
    ],
  },
  {
    version: "1.0.23",
    date: "2026-10-26",
    features: [
      "With a Grok subscription signed in through your xAI account, the composer shows the week's remaining quota (for example \"Week 94%\"); hover for the reset time.",
    ],
    improvements: [
      "Release notes are grouped into New / Improved / Fixed, in shorter plain sentences.",
    ],
  },
  {
    version: "1.0.22",
    date: "2026-10-26",
    fixes: ["A window closed while maximized now reopens maximized, and restores to its previous size."],
  },
  {
    version: "1.0.21",
    date: "2026-10-26",
    features: ["See what changed on the first launch after an update. All versions are in Settings → About → Release notes."],
    fixes: ["The window reopens at its last size and position instead of shrinking to the right half when closed with the work panel open."],
  },
  {
    version: "1.0.20",
    date: "2026-10-26",
    features: [
      "Voice input: hold ⌘⇧Space (Ctrl+Shift+Space on Windows) to talk; your words are typed into the composer, not sent. Change or turn it off in Settings → Shortcuts.",
      "With a subscription account (ChatGPT/Codex, Claude, GitHub Copilot, Kimi, GLM, MiniMax), the composer shows your remaining quota. Hover for reset times.",
      "Project memory: the agent remembers your preferences, corrections and project rules for later conversations. Entries marked “AI” in the memory panel can be edited or deleted.",
      "Hooks (Settings → Agent → Hooks): run commands before or after tool calls or before the agent finishes, e.g. a format check after edits or tests before finishing.",
      "Subagents can start with the current conversation's context.",
    ],
    improvements: [
      "When a background command finishes, the agent picks up the result on its own.",
      "In Full auto mode, force-pushes, pushes to the main branch, merging PRs, releases, publishing packages, deleting files outside the project and sudo still ask first.",
    ],
    fixes: ["Remaining “PI-Desktop” labels now say “mc-agent”."],
  },
];
