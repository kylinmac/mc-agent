import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findLiteralSurfaceColors } from "../../../scripts/style-surface-tokens.mjs";
import { changedStyleLines, designTokens, styleTokenIssues } from "../../../scripts/check-style-tokens.mjs";

test("spacing comparison includes branch commits, staged, unstaged and new CSS", (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "mc-style-diff-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  const commit = () => git("-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");
  const dir = "apps/desktop/src/styles";
  const file = dir + "/test space.css";
  const write = (name, css) => writeFileSync(join(cwd, name), css);
  git("init", "-q", "-b", "main");
  mkdirSync(join(cwd, dir), { recursive: true });
  write(file, ".old { gap: 8px }\n");
  git("add", "--", file);
  commit();
  git("switch", "-qc", "branch");
  write(file, ".old { gap: 8px }\n.committed { gap: 4px }\n");
  git("add", "--", file);
  commit();
  const staged = dir + "/added.css", untracked = dir + "/new.css";
  write(staged, ".staged { margin: 8px }\n");
  git("add", "--", staged);
  write(file, ".old { gap: 8px }\n.committed { gap: 4px }\n.pending { padding: 2px }\n");
  write(untracked, ".new { margin: 8px }\n");
  const component = "apps/desktop/src/Example.tsx";
  write(component, "const view = <div style={{ gap: 8 }} />;\n");
  const changed = changedStyleLines(cwd, "main");
  assert.equal(changed(file, 1), false);
  for (const [path, line] of [[file, 2], [file, 3], [staged, 1], [untracked, 1], [component, 1]]) {
    assert.equal(changed(path, line), true, path + ":" + line);
  }
});

test("renderer styles resolve design tokens in all themes and compact rules use the type scale", () => {
  const tokens = designTokens(':root, :root[data-theme="dark"] { --ds-ink: black; }\n:root[data-theme="light"] { --ds-typo: red; }\n@theme { --text-base: 14px; }');
  const css = [
    "/* color: var(--ds-example); */",
    "@font-face { font-weight: 100 900; }",
    ".item { color: var(--ds-ink); font-size: var(--text-base); border-radius: 4px; font-weight: 650 }",
    ".item:hover { color: var(--ds-typo, var(--ds-ink)); }",
  ].join("\n");
  const issues = styleTokenIssues(css, ".css", tokens);
  assert.deepEqual(issues.map(({ line }) => line).sort(), [3, 3, 4]);
  assert(issues.some(({ message }) => message.includes("--ds-typo")));
  assert.deepEqual(styleTokenIssues('const ink = "var(--ds-ink)";', ".ts", tokens), []);
  assert.equal(styleTokenIssues('<span className="text-[11px]" style={{ color: "var(--ds-missing)" }} />', ".tsx", tokens).length, 2);
});

test("shared scale names, literal fallbacks, and fixed spacing are checked in declarations", () => {
  const names = designTokens(`
    :root { --ds-space-8: 8px; } @theme { --text-base: 14px; --radius-xs: 2px; }
    @media print { :root { --ds-print-only: red; } }
  `);
  const css = [
    ".a { font-size: var(--text-bsae); border-radius: var(--radius-typo); }",
    ".b { font-size: var(--text-base, 14px); gap: 8px; padding-inline: 0 8px; margin-block-start: 8px; }",
    ".c { width: 8px; left: 8px; margin: auto; padding: calc(8px + 1vw); gap: var(--ds-space-8); }",
    ".d { color: var(--ds-print-only); border-radius: var(--radius-xs, var(--radius-xs)); }",
    ".e { content: 'font-size: 14px;'; }",
  ].join("\n");
  assert.deepEqual(styleTokenIssues(css, ".css", names).map(({ line }) => line).sort(),
    [1, 1, 2, 2, 2, 2, 4]);
  assert.equal(styleTokenIssues(".a { font-size: var(--text-deleted); }", ".css", new Set()).length, 1);
  const tsx = [
    '// Example: var(--ds-deleted) and text-[11px]',
    'const url = "https://example.test"; // var(--text-obsolete)',
    'const item = <div style={{ color: "var(--ds-missing)" }} />;',
    'const radius = `var(--radius-typo)`;',
    'const form = <div style={{ gap: 8, fontSize: "var(--text-base, 14px)", width: 8 }} />;',
    'const chart = <div style={{ marginLeft: depth * 8 }} />;',
  ].join("\n");
  assert.deepEqual(styleTokenIssues(tsx, ".tsx", names).map(({ line }) => line), [3, 4, 5, 5]);
});

test("surface guard catches literal fills on base, theme, and focus rules", () => {
  const violations = findLiteralSurfaceColors(`
.settings-search { background: #fff; }
:root[data-theme="dark"] .composer-shell { background-color: rgba(33, 33, 33, .96); }
@media (min-width: 600px) {
  :root[data-theme="light"] .plugins-search:focus-visible {
    background: color-mix(in oklab, var(--ds-text-primary) 5%, white);
  }
}`);
  assert.deepEqual(violations.map(({ line }) => line), [2, 3, 6]);
});

test("surface guard preserves tokens and the enumerated exemptions", () => {
  assert.deepEqual(
    findLiteralSurfaceColors(`
:root { --ds-settings-field-bg: #fff; }
/* .settings-search { background: #fff; } */
.settings-search { background: var(--ds-settings-field-bg); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); }
.plugins-search:focus-visible { background: color-mix(in oklab, var(--ds-text-primary) 7%, transparent); }
.settings-search-clear { background: #fff; }
.search-overlay { background: color-mix(in oklab, #000 45%, transparent); }
.code-block-lang { color: color-mix(in oklab, #383a42 62%, transparent); }
.prose { background: rgb(255, 255, 255); }
`),
    [],
  );
});

test("surface guard holds every theme override to the token contract", () => {
  /*
    Issue #341: a literal inside a :root[data-theme] rule raises specificity
    above the base token rule and does not read a variable, so that surface drops
    out of every contributed theme's reach. The Shiki syntax palette, a
    black-alpha shadow, and the token blocks themselves stay exempt.
  */
  const violations = findLiteralSurfaceColors(`
:root[data-theme="light"] .prose-chat h5 { color: color-mix(in oklab, #1a1c1f 62%, transparent); }
:root[data-theme="light"] .prose-chat pre { background: #fafafa; color: #383a42; }
:root[data-theme="dark"] .overlay { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.22); }
:root[data-theme="dark"] .toast { box-shadow: 0 1px 2px rgba(20, 20, 20, 0.22); }
:root[data-theme="light"] .code-block { --code-block-bg: #1a1c1f; }
:root[data-theme="light"] { --ds-bg-primary: #ffffff; }
:root[data-theme="light"] .plugins-search { background: var(--ds-field-inset-bg); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "color"],
      [5, "box-shadow"],
      [6, "--code-block-bg"],
    ],
  );
});

test("surface guard covers the tokenized families and every opaque colour form", () => {
  /*
    The migrated families are a fixed list that includes the code-card and
    Mermaid variants tokenized in issue #341, and the checked property set spans
    shorthand borders, background images, text shadows and filters — so a literal
    cannot slip back in through a property nobody listed.
  */
  const violations = findLiteralSurfaceColors(`
.code-block-head { background: #123456; }
.mermaid-block-body { background: rgb(255, 255, 255); }
.search-overlay .search-dialog { border: 1px solid #000; }
.overlay { background-image: linear-gradient(#fff, #000); }
.tool-row-content { text-shadow: 0 1px 2px #101010; }
:root[data-theme="dark"] .prose-chat kbd { filter: drop-shadow(#336699 0 1px 2px); }
:root[data-theme="dark"] .toast { box-shadow: 0 0 0 1px #ffffff; }
.plugins-modal-backdrop { background: var(--ds-modal-veil); }
:root[data-theme="light"] .mermaid-block-body { background: var(--ds-mermaid-canvas); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "background"],
      [3, "background"],
      [4, "border"],
      [5, "background-image"],
      [6, "text-shadow"],
      [7, "filter"],
      [8, "box-shadow"],
    ],
  );
});

test("surface guard rejects static non-token variable references", () => {
  /*
    The gray/accent scales are static root literals and the legacy color-*
    family never existed, so a declaration riding those variables is pinned
    out of every contributed theme's reach. Theme roots (where the scales are
    defined) and the enumerated fixed-palette rules stay exempt.
    the enumerated fixed-palette rules stay exempt.
  */
  const violations = findLiteralSurfaceColors(`
.send-btn { background: var(--gray-0); color: var(--gray-1000); }
:root[data-theme="dark"] .composer-input { color: var(--gray-0); }
.voice-error { color: var(--color-danger, #ef4444); }
:root { --ds-bg-hover: color-mix(in oklab, var(--gray-0) 6%, transparent); }
.composer-image-preview button:hover { background: var(--gray-700); }
.projects-glyph { color: var(--gray-0); }`);
  assert.deepEqual(
    violations.map(({ line, property }) => [line, property]),
    [
      [2, "background"],
      [2, "color"],
      [3, "color"],
      [4, "color"],
    ],
  );
});
