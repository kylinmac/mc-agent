---
name: new-project
description: Create a new mc-agent project from the conversation — pick its folder and a resource template (or draft a new one) and set it up after the user confirms on a card. Use when the user wants to start, create, or set up a new project.
---

# New project

The user describes a project they want to start. Set it up with the desktop's
`ProjectTemplates` and `CreateProject` tools. If ToolSearch is available and
they are not loaded, find them there first. They exist only in Agent mode on
this computer; otherwise tell the user to switch to Agent mode.

## Flow

1. Understand what the project is. If its purpose or name is unclear, ask one
   short question in the conversation. Do not ask about anything the cards
   below will settle.
2. Call `ProjectTemplates`. It lists the resource-folder templates (folders and
   what belongs in each), system prompt templates, and suggested parent folders.
3. Choose the location. Use the folder the user named; otherwise, when
   `userLocations` is set (the user's folders from Settings, each with what
   goes there), the one whose note fits this project, else its first entry;
   without it, the first suggested parent. Pick a short folder name: lowercase, `-` between words,
   English or pinyin for a non-English name (for example `ledger-miniapp`).
   The user can still change both on the card.
4. Rank templates by how well their folders fit the project:
   - One clearly fits: pass just that one.
   - Several could: pass up to three, best first.
   - None fits: pass `draft` instead. Draft 3–8 top-level folders in the order
     the work happens, English folder names, nested folders only where they
     help, a one-line note per folder in the user's language, and optional
     `systemPrompt` rules specific to this kind of project. It is used for this
     project only unless the user saves it.
   Pick a system prompt template only when one obviously matches.
5. Call `CreateProject` with a one-line `note` explaining your pick. It shows a
   card and waits; do not describe the plan in text beforehand.
6. Act on the outcome:
   - `created`: reply with one or two sentences — the project is set up and
     appears in the sidebar; the user can continue in it from the card. Do not
     write requirement documents or other files unless asked.
   - `draft-requested`: draft a template as in step 4 (use the user's
     `request` if any) and call `CreateProject` again with the confirmed name
     and location and the `draft`.
   - `revise`: ask what to change, or apply the user's `request`, then call
     `CreateProject` again.
   - `failed`: say which step failed and the message; suggest the fix.

Never create the folders yourself with Bash or Write; the card is the user's
confirmation.
