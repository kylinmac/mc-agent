# Vendored upstream

Repository: https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager

Base tag: `v0.9.0`; commit: `92ccff9b7c1102d1664915c44ae1e5f3bb5c56a6`.
Bundled version: `0.9.1-mc.2`. License: MIT; PDF dependencies retain their licenses in `views/assets/pdfjs-LICENSES.txt`.

## Local changes

The base matches the marketplace version installed by mc-agent users. This avoids replacing their PDF, git diff and file watching features with the older bundled 0.5.2 view. Main is unchanged from 0.9.0; permissions and save contracts are unchanged. Newer marketplace releases still win version comparison.

Source changes are retained in `patches/file-manager-split.patch`: a Markdown-only split tab, live deferred draft preview, equal-width panes with bidirectional source-position scroll synchronization, and search contrast styles. Split selection is kept for this panel's lifetime; existing edit/preview preferences remain unchanged. The plugin's en/zh split labels match `packages/i18n`.

Rebuild: clone the pinned tag, apply the patch with `git apply`, install `views-src/pnpm-lock.yaml` dependencies, then run the view's typecheck and build. Copy `views/`, unchanged main/README, and update the manifest version/license/changelog and hashes below. Keep the added CommonJS `package.json` marker: the host loads main.js with require.

Scroll anchors cover blocks, nested list items, table rows and code lines. Wrapped paragraphs interpolate between their boundaries; alignment is approximate within a paragraph. The side receiving user input leads, so CodeMirror height corrections cannot cause feedback. Editing and layout changes refresh the mapping; leaving split mode removes listeners and observers.

Preview text search is provided by `electron/main/mc-file-preview-search.ts` (Ctrl/Cmd+F, rendered-text highlights and navigation); it also applies to marketplace copies and leaves the CodeMirror search intact.

Host overrides remain in `electron/main/mc-file-search-contrast.ts` and `electron/main/mc-file-preview-links.ts`; verify both against rebuilt views. The preview-links script opens web links externally, opens file links (relative to the open file, absolute, `file:`) in this view through `ui.revealView`, and scrolls `#heading` links; it reads the open file from the header's copy-path button. Links opened while the agent drives the panel (`electron/main/work-panel-agent/agent-input-gate.ts`) are reported to the agent instead of opened.

## Shipped SHA-256

| File | SHA-256 |
| --- | --- |
| `main.js` | `2dcaa89d4cb2470e09c969b00a80270f0b80136432733dc3ebd0e21d3dd6a6af` |
| `README.md` | `e34f3a13b1ed2cdbb84c5ac7d7c984e42632297bd94126b597f91002ad0a1e11` |
| `manifest.json` | `155f0dc19866394ee4f84a0aa586a55816e6526933ee1b399b59dbf13f3684c5` |
| `views/index.html` | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
| `views/assets/index.js` | `e0a5607fc0de32b2e18f916582e3f8d903a4059e73c27f8cb5f9601e500a5196` |
| `views/assets/pdfjs-LICENSES.txt` | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
