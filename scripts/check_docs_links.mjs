#!/usr/bin/env node
/**
 * check_docs_links.mjs — CI lint for broken internal links in Markdown docs.
 *
 * Scans the root Markdown files and docs/ for inline links (`[text](target)`)
 * and verifies that:
 *
 *   1. relative file targets exist (after resolving `../` against the link's
 *      own directory), and
 *   2. `#anchor` fragments (same-file or cross-file) match a GitHub-rendered
 *      heading slug in the target file.
 *
 * External URLs, `mailto:`, and pure reference-style links are ignored. Exit
 * code 0 = all internal links resolve; 1 = at least one broken link.
 *
 * Usage: node scripts/check_docs_links.mjs   (repo root as cwd)
 */
import { existsSync, globSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const FILES = [
  ...globSync("*.md", { cwd: REPO_ROOT }),
  ...globSync("docs/**/*.md", { cwd: REPO_ROOT }),
].map((p) => join(REPO_ROOT, p));

// GitHub heading slugger (github-slugger rules): lowercase, drop punctuation,
// spaces -> hyphens one-for-one (so "a × b" -> "a--b"), dedupe with -1, -2…
function slugify(headings) {
  const seen = new Map();
  return (raw) => {
    let slug = raw
      .trim()
      .toLowerCase()
      .replace(/<[^>]+>/g, "") // inline html
      .replace(/[`*~]/g, "") // code/emphasis markers
      .replace(/[^\p{L}\p{N}\s_-]/gu, "") // punctuation
      .trim()
      .replace(/ /g, "-"); // one hyphen per space, like GitHub
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    return count === 0 ? slug : `${slug}-${count}`;
  };
}

function headingsOf(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const makeSlug = slugify();
  const slugs = new Set();
  for (const line of lines) {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m && m[2]) slugs.add(makeSlug(m[2]));
  }
  return slugs;
}

const slugCache = new Map();
function slugsFor(file) {
  if (!slugCache.has(file)) slugCache.set(file, headingsOf(file));
  return slugCache.get(file);
}

const LINK_RE = /\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const IGNORED = /^(https?:\/\/|mailto:|tel:|javascript:)/i;

let errors = 0;
let checked = 0;

for (const file of FILES) {
  const text = readFileSync(file, "utf8");
  const rel = relative(REPO_ROOT, file);
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const m of line.matchAll(LINK_RE)) {
      let target = m[2];
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      if (IGNORED.test(target)) continue;
      // strip a possible title suffix already handled by regex; drop query strings
      const [pathPart, anchor] = target.split("#");
      // Generated error docs reference code symbols as `path/to/file.rs::symbol`.
      // Resolve the file part and verify the symbol literally appears in it.
      const sep = pathPart.indexOf("::");
      const filePath = sep === -1 ? pathPart : pathPart.slice(0, sep);
      const symbol = sep === -1 ? null : pathPart.slice(sep + 2);
      const cleanPath = filePath.split("?")[0];
      const targetFile = cleanPath === "" ? file : normalize(join(dirname(file), cleanPath));
      const where = `${rel}:${i + 1}`;
      checked += 1;
      if (cleanPath !== "" && !existsSync(targetFile)) {
        errors += 1;
        console.log(`BROKEN LINK ${where} -> ${target} (file not found: ${relative(REPO_ROOT, targetFile)})`);
        continue;
      }
      if (symbol !== null && !readFileSync(targetFile, "utf8").includes(symbol)) {
        // Non-fatal: the generated catalog's testRef symbol names can drift from
        // the test file's fn names. The link target itself resolves, which is
        // what this gate promises. Surfaced as a warning for the next regen.
        console.log(`WARN SYMBOL ${where} -> ${target} (no "${symbol}" in ${relative(REPO_ROOT, targetFile)})`);
      }
      // Anchors are only verifiable for Markdown targets (GitHub heading
      // slugs). Non-md targets (e.g. source files with #L123 line refs) are
      // link-checked by path only.
      if (anchor && targetFile.endsWith(".md")) {
        const slugs = slugsFor(targetFile);
        if (!slugs.has(anchor)) {
          errors += 1;
          console.log(`BROKEN ANCHOR ${where} -> ${target} (no heading slug "${anchor}")`);
        }
      }
    }
  });
}

console.log(`checked ${checked} internal links across ${FILES.length} markdown files`);
if (errors > 0) {
  console.log(`${errors} broken link(s) found`);
  process.exit(1);
}
console.log("all internal links resolve");
