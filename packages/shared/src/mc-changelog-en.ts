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
    version: "1.0.70",
    date: "2026-11-11",
    features: [
      "When tabs no longer fit, they group by project. Open a project to switch conversations or close one with ×; individual tabs return when space allows.",
    ],
    improvements: [
      "When the agent reads several files or runs several searches at once, they run at the same time instead of one after another.",
      "In long conversations, older large command outputs and file contents are dropped from the agent's context first, so full context compaction happens later; the conversation transcript keeps the originals.",
      "When the agent keeps calling the same tool with the same arguments and gets the same result, it is first told to try something else; after five repeats the turn stops and explains why, and you can tell it to continue.",
      "Settings that cost extra usage or loosen safety limits show their explanation next to the switch instead of behind a question mark.",
    ],
    fixes: [
      "After opening many tabs and scrolling across them, hidden tabs no longer block dragging or double-clicking the left title bar.",
      "Session hover cards and tab menus are no longer covered by the native file panel.",

      "After switching projects, clicking the same relative link again in the file panel's Markdown preview no longer opens a path from the previous project.",
    ],
  },
  {
    version: "1.0.69",
    date: "2026-11-11",
    improvements: [
      "When the agent reads several files or runs several searches at once, they run at the same time instead of one after another.",
      "In long conversations, older large command outputs and file contents are dropped from the agent's context first, so full context compaction happens later; the conversation transcript keeps the originals.",
      "When the agent keeps calling the same tool with the same arguments and gets the same result, it is first told to try something else; after five repeats the turn stops and explains why, and you can tell it to continue.",
      "When there are more tabs than fit, a menu at the right of the title bar lists every open tab so you can switch to it.",
      "Settings that cost extra usage or loosen safety limits show their explanation next to the switch instead of behind a question mark.",
    ],
    fixes: [
      "After switching projects, clicking the same relative link again in the file panel's Markdown preview no longer opens a path from the previous project.",
    ],
  },
  {
    version: "1.0.68",
    date: "2026-11-11",
    features: [
      "Settings can prepare context compaction in the background: when the context is nearly full, the summary is written while the agent keeps working, so compaction no longer waits. Off by default; if the conversation changes before it is used, the summary is discarded and its usage is still billed.",
    ],
    fixes: [
      "Clicking a file link in chat expands the file panel when it is collapsed.",
      "Clicking the same file link again always opens it; before, it could do nothing after you browsed other files in the panel or switched projects.",
      "Switching to a conversation in another project and back shows that conversation's file in the file panel again instead of the project root.",
    ],
  },
  {
    version: "1.0.67",
    date: "2026-11-10",
    improvements: [
      "In Markdown split view, scrolling either pane makes the other follow the same content, with row and line alignment for tables and code where possible.",
    ],
  },
  {
    version: "1.0.66",
    date: "2026-11-10",
    fixes: [
      "When a reply is cut off by the model's output limit, a notice appears under it with a Continue button; it used to look like a normal finish.",
      "Each reply's stop reason is saved and logged, so a reply that stops midway shows whether the model ended it or it was cut off.",
    ],
  },
  {
    version: "1.0.65",
    date: "2026-11-09",
    fixes: [
      "Links to local files in a conversation now open in the app on a modifier click or middle click too, instead of doing nothing.",
      "When a local file link cannot be opened, a message says why, and the log records which file and why it was not found.",
    ],
  },
  {
    version: "1.0.64",
    date: "2026-11-09",
    fixes: [
      "In the file panel's Markdown preview, relative, absolute and file: links now open the file in the file panel instead of showing \"link (not opened)\".",
      "#heading links in the preview jump to that heading, and www. addresses open in the browser.",
    ],
  },
  {
    version: "1.0.63",
    date: "2026-11-08",
    features: [
      "Ask the agent in a conversation to view, create and edit the current project's tasks; the task board shows the changes.",
      "The agent can look up project resources, read the project goal, and register project files or links as draft resources.",
    ],
    improvements: [
      "The agent cannot start, accept or cancel tasks, or confirm or deprecate resources; those stay with you in the workbench.",
    ],
  },
  {
    version: "1.0.62",
    date: "2026-11-08",
    features: [
      "Review can show past changes turn by turn, with the lines added and removed in each turn.",
      "A finished reply lists the files that turn changed; click a file to jump to it in Review.",
      "Files in Review can be opened in the file panel, opened with the system app, or shown in Finder.",
    ],
    improvements: [
      "Loading earlier messages in a long conversation keeps your reading position in place.",
      "\"Back to latest\" scrolls smoothly to the bottom and keeps the earlier messages you already loaded.",
      "When a reply finishes, its prompt scrolls to the top so you read the answer from the start; nothing moves while you are scrolled up.",
    ],
    fixes: [
      "After a conversation is restored, a reply that is still running keeps showing as running.",
    ],
  },
  {
    version: "1.0.61",
    date: "2026-11-08",
    features: [
      "The context usage panel shows the cost of the latest turn and the whole conversation; subscription accounts show \"Subscription\" with the API-price equivalent.",
    ],
    improvements: [
      "The conversation minimap on the left marks only your own messages, so earlier questions are easier to find.",
    ],
    fixes: [
      "Large generated images are no longer lost to a client-side validation error.",
      "A very tall full-page screenshot no longer makes every later request in the conversation fail.",
      "File names with Chinese, accented characters or emoji no longer turn garbled or go missing from search.",
      "Exhausted quota, an invalid key or an oversized context no longer trigger repeated useless requests.",
      "Typing a slash with a Chinese input method no longer inserts a duplicate character.",
      "After you cancel quitting, scheduled tasks and voice input keep working.",
    ],
  },
  {
    version: "1.0.60",
    date: "2026-11-08",
    fixes: [
      "On macOS, Ctrl+C in the terminal interrupts the running program even with text selected; use ⌘C to copy.",
      "When the agent works in the side panel, it no longer opens browser or mail links for you; it tells you the address instead.",
      "The creative folder no longer shows up in the resource list while the storage folder is not yet allowed.",
    ],
  },
  {
    version: "1.0.59",
    date: "2026-11-06",
    features: [
      "Use Ctrl+F / ⌘F in Markdown previews to search text, see match counts, and jump between results.",
    ],
  },
  {
    version: "1.0.58",
    date: "2026-11-06",
    features: [
      "Edit Markdown on the left and see a live preview on the right with the new Split mode.",
    ],
  },
  {
    version: "1.0.57",
    date: "2026-11-06",
    fixes: [
      "Web and email links in the file panel's Markdown preview now open directly instead of only showing \"Link (not opened)\".",
    ],
  },
  {
    version: "1.0.56",
    date: "2026-11-05",
    features: [
      "The agent can read terminal errors, browser console messages and editor content in the side panel, and operate the corresponding panels.",
    ],
    improvements: [
      "The terminal supports select all, clear scrollback and scroll shortcuts, with a shortcut guide in the toolbar.",
    ],
    fixes: [
      "Ctrl+Shift+C and Ctrl+C now copy selected terminal text. Without a selection, Ctrl+C still interrupts the command.",
    ],
  },
  {
    version: "1.0.55",
    date: "2026-11-05",
    fixes: [
      "macOS folder, microphone and other system permissions no longer reset with each update. Allow them once more in this version; later updates keep them.",
      "The creative studio now tells \"the system denies access\" apart from \"the folder is gone\". When access is denied you can open System Settings directly, and the app recovers when you come back.",
    ],
  },
  {
    version: "1.0.53",
    date: "2026-11-04",
    improvements: [
      "Background command notices now take one line, with the status at the far right.",
    ],
  },
  {
    version: "1.0.52",
    date: "2026-11-04",
    fixes: [
      "Prevent repeated update restarts from damaging the macOS app. Installation is serialized, verifies the complete replacement, and preserves or restores the old app on failure.",
    ],
  },
  {
    version: "1.0.51",
    date: "2026-11-03",
    features: [
      "Task accepts a thinkingLevel for each subagent run, including fork and resume. Unsupported levels are reported instead of silently raised.",
    ],
    fixes: [
      "Find and replace fields and buttons in the file panel use black text on white backgrounds, including newer installed plugin versions.",
    ],
  },
  {
    version: "1.0.50",
    date: "2026-11-03",
    features: [
      "AI can find and read other conversations in the same project when organizing requirements, designs and validation records.",
    ],
    fixes: [
      "Temporary runtime updates no longer dismiss pending plans. Approving a plan switches to Agent and continues execution automatically.",
      "When plan approval blocks a mode change, the actual mode and approval controls are restored instead of showing a successful switch.",
    ],
  },
  {
    version: "1.0.49",
    date: "2026-11-03",
    fixes: [
      "“Restart to update” checks again first and installs the newest release, instead of an older one downloaded earlier.",
    ],
  },
  {
    version: "1.0.48",
    date: "2026-11-03",
    improvements: [
      "AI resource organization discusses goals, scope and categories in the interface language, then waits for approval of the file list before making changes.",
      "Organization excludes bulk upstream manuals by default and leaves empty categories empty. Existing documents awaiting confirmation are labeled Unconfirmed.",
    ],
    fixes: [
      "A file found both in the resource folder and an index appears once, preserving its existing confirmation state.",
    ],
  },
  {
    version: "1.0.47",
    date: "2026-11-03",
    features: [
      "Settings → General → Work panel chooses whether the work panel is always on the right, always at the bottom, or automatic, and how narrow the conversation gets before Auto moves it down.",
    ],
  },
  {
    version: "1.0.46",
    date: "2026-11-03",
    features: [
      "In a portrait or narrow window, the work panel moves under the conversation with a draggable divider, and returns to the right side when the window widens.",
    ],
  },
  {
    version: "1.0.45",
    date: "2026-11-02",
    improvements: [
      "When restored context has missing or out-of-order messages, the app tries full-history recovery, reports unrecoverable errors, and records diagnostics without message content.",
    ],
    fixes: [
      "Reopening a conversation no longer accepts a compaction checkpoint whose boundary message cannot be restored.",
      "Failed conversation-history reads no longer silently start an empty conversation.",
    ],
  },
  {
    version: "1.0.44",
    date: "2026-11-02",
    fixes: [
      "Reopening a compacted conversation no longer drops later messages and test results because of an invalid old checkpoint. Affected conversations recover from their saved history.",
    ],
  },
  {
    version: "1.0.43",
    date: "2026-11-01",
    fixes: [
      "The conversation width grip now sits beside the right edge of the input box, so it no longer overlaps the work panel's resize edge and still works with the panel open. Double-click it to restore the default width.",
    ],
  },
  {
    version: "1.0.42",
    date: "2026-11-01",
    fixes: [
      "When creating a template project, the template name and folders no longer crowd onto one cut-off line, the menu arrow no longer covers the text, and the hint below is no longer hidden; the folders the template creates are listed below instead.",
    ],
  },
  {
    version: "1.0.41",
    date: "2026-10-31",
    features: [
      "Open the read-only Built-in default entry in system prompt templates to view the original identity, general runtime rules, and mode rules. Its content cannot be edited or deleted.",
    ],
  },
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
