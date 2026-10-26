#!/usr/bin/env node
/**
 * mc-agent 更新说明检查（MC-ADR-0017；docs/mc-agent/release-notes.md）。
 *
 * Usage:
 *   node scripts/check-mc-changelog.mjs                      # 只校验已有条目的格式
 *   node scripts/check-mc-changelog.mjs --require 1.0.20     # 发布门禁：该版本必须有条目
 *   node scripts/check-mc-changelog.mjs --root <dir> --require <version>
 *                                                            # 校验另一份检出（发布时是标签的 worktree）
 *
 * 校验 packages/shared/src/mc-changelog-zh-CN.ts（源语言）和 mc-changelog-en.ts：
 *   - 版本为 x.y.z 且 >= 1.0.0（上游 0.x 写在 changelog-*.ts，不在这里），不重复、新版本在前；
 *   - date 可选，格式 YYYY-MM-DD；
 *   - 按 features（新功能）/ improvements（优化）/ fixes（修复）分组，每组是非空字符串数组；
 *     三组都没有表示本版无用户可见变化。不再接受扁平的 highlights；
 *   - 每行不带项目符号或「新功能：」这类前缀（界面按组显示标题），不含「进一步优化体验」这类空话；
 *   - 英文条目可缺，有则版本必须在中文里存在、每组条数一致。
 * `--require` 只对 REQUIRED_FROM 及之后的版本生效：此前的标签发布时还没有这套流程，
 * 重跑旧版本的发布草稿不因此失败。
 *
 * 数据文件只能有 `import type`，本脚本用 Node 自带的 TypeScript 类型擦除直接导入（Node >= 22.18）。
 * 与上游的 scripts/check-release-docs.mjs 互不影响：那个脚本只读 changelog*.ts 与 APP_VERSION。
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 第一个必须带更新说明的 mc-agent 版本（v1.0.19 是本流程之前的最后一个标签）。 */
export const REQUIRED_FROM = "1.0.20";

const SOURCES = {
  "zh-CN": { file: "packages/shared/src/mc-changelog-zh-CN.ts", exportName: "mcZhCNEntries" },
  en: { file: "packages/shared/src/mc-changelog-en.ts", exportName: "mcEnEntries" },
};

/**
 * v1.0.20–v1.0.22 的标签里还是扁平的 highlights。重跑这些版本的发布草稿时，
 * 门禁读的是标签里的旧文件，所以这几个版本仍接受 highlights（只查格式，不查措辞）。
 */
export const FLAT_HIGHLIGHTS_UNTIL = "1.0.22";

/** 分组，与 packages/shared/src/mc-changelog-types.ts 的 MC_CHANGE_KINDS 一致。 */
export const KINDS = ["features", "improvements", "fixes"];

/** 不说清用户得到了什么的套话；写具体变化。 */
export const FILLER = /进一步|全面提升|全新升级|更加(清晰|流畅|顺滑|便捷|稳定|友好)|(优化|提升)(了)?(用户)?体验|更紧凑清晰|improved? (the )?(overall )?experience|enhanced? (the )?experience|seamless/i;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function compareVersions(a, b) {
  const left = SEMVER.exec(a).slice(1).map(Number);
  const right = SEMVER.exec(b).slice(1).map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/** Validate one locale's entries; returns failure strings. */
export function validateEntries(label, entries) {
  const failures = [];
  if (!Array.isArray(entries)) return [`${label}: must export an array`];
  const seen = new Set();
  let previous;
  entries.forEach((entry, index) => {
    const where = `${label}[${index}]`;
    if (!entry || typeof entry !== "object") {
      failures.push(`${where}: must be an object`);
      return;
    }
    const { version, date, highlights } = entry;
    if (typeof version !== "string" || !SEMVER.test(version)) {
      failures.push(`${where}: version ${JSON.stringify(version)} must be x.y.z without "v"`);
      return;
    }
    if (compareVersions(version, "1.0.0") < 0) {
      failures.push(`${where}: ${version} is an upstream 0.x version; put it in changelog-*.ts`);
    }
    if (seen.has(version)) failures.push(`${where}: duplicate version ${version}`);
    seen.add(version);
    if (previous && compareVersions(version, previous) >= 0) {
      failures.push(`${where}: ${version} must be older than the entry before it (${previous}); newest first`);
    }
    previous = version;
    if (date !== undefined && (typeof date !== "string" || !validDate(date))) {
      failures.push(`${where}: date ${JSON.stringify(date)} must be YYYY-MM-DD`);
    }
    if (highlights !== undefined) {
      if (compareVersions(version, FLAT_HIGHLIGHTS_UNTIL) > 0 || KINDS.some((kind) => entry[kind] !== undefined)) {
        failures.push(`${where}: use features / improvements / fixes instead of highlights (见 docs/mc-agent/release-notes.md)`);
      } else if (!Array.isArray(highlights)) {
        failures.push(`${where}: highlights must be an array`);
      } else {
        highlights.forEach((line, lineIndex) => {
          if (typeof line !== "string" || line.trim() === "" || line !== line.trim()) {
            failures.push(`${where}.highlights[${lineIndex}]: must be a non-empty trimmed string`);
          }
        });
      }
    }
    for (const key of Object.keys(entry)) {
      if (!["version", "date", "highlights", ...KINDS].includes(key)) {
        failures.push(`${where}: unknown key ${key}; categories are ${KINDS.join(" / ")}`);
      }
    }
    for (const kind of KINDS) {
      const lines = entry[kind];
      if (lines === undefined) continue;
      if (!Array.isArray(lines)) {
        failures.push(`${where}.${kind}: must be an array of strings`);
        continue;
      }
      lines.forEach((line, lineIndex) => {
        const at = `${where}.${kind}[${lineIndex}]`;
        if (typeof line !== "string" || line.trim() === "" || line !== line.trim()) {
          failures.push(`${at}: must be a non-empty trimmed string`);
        } else if (/^[-*•]\s/.test(line)) {
          failures.push(`${at}: drop the bullet prefix; the UI adds it`);
        } else if (/^(新功能|功能|优化|修复|bug|new|improved|fixed)\s*[:：·]/i.test(line)) {
          failures.push(`${at}: drop the category prefix; the UI shows the group title`);
        } else if (FILLER.test(line)) {
          failures.push(`${at}: say what the user gets instead of filler (${line.match(FILLER)[0]})`);
        }
      });
    }
  });
  return failures;
}

/** Cross-locale and release-gate checks. */
export function validateCatalog({ zh, en }, { require } = {}) {
  const failures = [...validateEntries("zh-CN", zh), ...validateEntries("en", en)];
  if (failures.length) return failures;
  const zhByVersion = new Map(zh.map((entry) => [entry.version, entry]));
  for (const entry of en) {
    const source = zhByVersion.get(entry.version);
    if (!source) {
      failures.push(`en: ${entry.version} has no zh-CN entry (zh-CN is the source)`);
    } else {
      for (const kind of [...KINDS, "highlights"]) {
        const zhCount = source[kind]?.length ?? 0;
        const enCount = entry[kind]?.length ?? 0;
        if (zhCount !== enCount) {
          failures.push(`en: ${entry.version} has ${enCount} ${kind}, zh-CN has ${zhCount}`);
        }
      }
    }
  }
  if (require && compareVersions(require, REQUIRED_FROM) >= 0) {
    if (!zhByVersion.has(require)) {
      failures.push(
        `zh-CN: no entry for ${require}. 发布前在 mc-changelog-zh-CN.ts 加一条（无用户可见变化只写 version 和 date）`,
      );
    }
    const newer = zh.filter((entry) => compareVersions(entry.version, require) > 0);
    if (newer.length) {
      failures.push(`zh-CN: ${newer.map((e) => e.version).join(", ")} is newer than the release ${require}`);
    }
  }
  return failures;
}

function parseArgs(argv) {
  const options = { root: fileURLToPath(new URL("..", import.meta.url)) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") options.root = path.resolve(argv[++index] ?? "");
    else if (arg === "--require") options.require = String(argv[++index] ?? "").replace(/^v/, "");
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (options.require !== undefined && !SEMVER.test(options.require)) {
    throw new Error(`--require needs x.y.z, got ${JSON.stringify(options.require)}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const gated = options.require && compareVersions(options.require, REQUIRED_FROM) >= 0;
  const zhFile = path.join(options.root, SOURCES["zh-CN"].file);
  if (!existsSync(zhFile)) {
    if (gated) {
      console.error(`check-mc-changelog: ${SOURCES["zh-CN"].file} is missing in ${options.root}`);
      process.exit(1);
    }
    console.log(`check-mc-changelog: no mc changelog in ${options.root}; skipped (before ${REQUIRED_FROM})`);
    return;
  }
  if (!process.features?.typescript) {
    console.error("check-mc-changelog: needs Node >= 22.18 (built-in TypeScript type stripping)");
    process.exit(1);
  }
  const load = async (locale) => {
    const { file, exportName } = SOURCES[locale];
    const fullPath = path.join(options.root, file);
    if (!existsSync(fullPath)) return [];
    const module = await import(pathToFileURL(fullPath).href);
    return module[exportName];
  };
  const catalog = { zh: await load("zh-CN"), en: await load("en") };
  const failures = validateCatalog(catalog, { require: options.require });
  if (failures.length) {
    for (const failure of failures) console.error(`  ✗ ${failure}`);
    console.error(`check-mc-changelog: ${failures.length} problem(s). See docs/mc-agent/release-notes.md`);
    process.exit(1);
  }
  const scope = options.require
    ? gated
      ? `; ${options.require} has an entry`
      : `; ${options.require} is before ${REQUIRED_FROM}, entry not required`
    : "";
  console.log(`check-mc-changelog: ${catalog.zh.length} zh-CN / ${catalog.en.length} en entries OK${scope}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`check-mc-changelog: ${error.message}`);
    process.exit(1);
  });
}
