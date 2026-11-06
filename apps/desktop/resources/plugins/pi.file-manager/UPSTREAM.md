# Vendored upstream

Repository: https://github.com/Tioit-Wang/pi-desktop-plugin-file-manager

Base tag: `v0.9.0`; commit: `92ccff9b7c1102d1664915c44ae1e5f3bb5c56a6`.
Bundled version: `0.9.1-mc.1`. License: MIT; PDF dependencies retain their licenses in `views/assets/pdfjs-LICENSES.txt`.

## Local changes

The base matches the marketplace version installed by mc-agent users. This avoids replacing their PDF, git diff and file watching features with the older bundled 0.5.2 view. Main is unchanged from 0.9.0; permissions and save contracts are unchanged. Newer marketplace releases still win version comparison.

Source changes are retained in `patches/file-manager-split.patch`: a Markdown-only split tab, live deferred draft preview, independent equal-width panes, and search contrast styles. Split selection is kept for this panel's lifetime; existing edit/preview preferences remain unchanged. The plugin's en/zh split labels match `packages/i18n`.

Rebuild: clone the pinned tag, apply the patch with `git apply`, install `views-src/pnpm-lock.yaml` dependencies, then run the view's typecheck and build. Copy `views/`, unchanged main/README, and update the manifest version/license/changelog and hashes below. Keep the added CommonJS `package.json` marker: the host loads main.js with require.

Host overrides remain in `electron/main/mc-file-search-contrast.ts` and `electron/main/mc-file-preview-links.ts`; verify both against rebuilt views.

## Shipped SHA-256

| File | SHA-256 |
| --- | --- |
| `main.js` | `2dcaa89d4cb2470e09c969b00a80270f0b80136432733dc3ebd0e21d3dd6a6af` |
| `README.md` | `e34f3a13b1ed2cdbb84c5ac7d7c984e42632297bd94126b597f91002ad0a1e11` |
| `manifest.json` | `b54eb235d4d8e7a4801b9fcaeeb1823c0398c2c752f35ceef2c00a4017aff4e5` |
| `views/index.html` | `771fd3d8afdea7fca75ed1f1918c1ce93ad1c87babdb321cfb85e910465cd2c1` |
| `views/assets/index.js` | `fb1fbdac62e4c44c11b138a82d6117f53c7315e297f2747992780a58185ce048` |
| `views/assets/pdfjs-LICENSES.txt` | `a8b04e2e9022721482079ee5c85b9f05ae129e6a2cfd59ea67f2629a3fc23640` |
