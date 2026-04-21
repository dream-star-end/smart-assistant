#!/usr/bin/env bun
// Auto-bump all cache-bust version tokens in packages/web/public/* to a single value.
//
// Why: without this, every deploy requires manually bumping sw.js VERSION +
// every ?v=XX query string across index.html / sw.js / modules/*.js, and a
// single missed bump means stale CF edge caches on claudeai.chat.
//
// Behavior:
//   - Default token = `git rev-parse --short HEAD` (e.g. "bac7543").
//   - Rewrites these patterns in-place:
//       * `VERSION = 'openclaude-<token>'`      (sw.js cache name)
//       * `?v=<token>`                          (query-string cache-bust)
//   - Idempotent: if all files already match the target token, exits 0 with
//     no file writes.
//
// Usage:
//   bun scripts/bump-version.ts          # use git short HEAD
//   bun scripts/bump-version.ts abc1234  # force specific token
//   bun scripts/bump-version.ts --check  # verify files are at HEAD, exit 1 if not

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const PUBLIC_DIR = join(REPO_ROOT, "packages", "web", "public");

// Files to rewrite. Keep this list tight — only files that actually contain
// cache-bust tokens. Adding a file here without a matching token is a no-op.
const TARGETS = [
  "sw.js",
  "index.html",
  "admin.html",
  "modules/main.js",
  "modules/websocket.js",
];

function gitShortHead(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf-8",
  });
  if (r.status !== 0) {
    console.error("git rev-parse failed:", r.stderr);
    process.exit(1);
  }
  return r.stdout.trim();
}

function bumpFile(
  path: string,
  token: string,
  dryRun: boolean,
): { changed: boolean; hits: number } {
  const original = readFileSync(path, "utf-8");
  let out = original;
  let hits = 0;

  // Pattern 1: SW VERSION cache name.
  // Matches: VERSION = 'openclaude-v57'  /  VERSION = 'openclaude-bac7543'
  out = out.replace(
    /(VERSION\s*=\s*['"])openclaude-[\w-]+(['"])/g,
    (_m, pre, post) => {
      hits++;
      return `${pre}openclaude-${token}${post}`;
    },
  );

  // Pattern 2: ?v=<token> cache-bust query strings.
  // Matches: ?v=36  /  ?v=bac7543  /  ?v=auto
  // Does NOT match ?v= without a value (rejected) or ?v={expr} (rejected).
  out = out.replace(/\?v=[A-Za-z0-9_-]+/g, () => {
    hits++;
    return `?v=${token}`;
  });

  const changed = out !== original;
  if (changed && !dryRun) writeFileSync(path, out);
  return { changed, hits };
}

// Walk `public/` and return every file path (relative to PUBLIC_DIR) containing
// a *real* cache-bust reference. Used by --check to flag files that have tokens
// but weren't declared in TARGETS — the classic drift mode where a new module
// file sneaks in with `?v=` imports and silently stays at the first-ever commit
// hash because bump-version doesn't know to touch it.
//
// vendor/ is excluded because mermaid.min.js / qrcode.min.js have incidental
// `?v=` matches inside minified source (regex constants, URL tables) that
// aren't our cache-bust tokens. Other minified output shouldn't exist under
// public/ — if it starts to, extend this skip list.
//
// Codex review IMPORTANT#4: tightened the regex so it only matches tokens
// inside actual URL/specifier strings (`"…/foo.ext?v=token"` shape), not every
// occurrence of `?v=` in the file body. Without this, comments like
//   // ?v=508d7d2 bust: …
// (which we legitimately have in main.js) would get double-counted, and any
// future README containing an example `?v=` would be a CI false positive.
const SCAN_SKIP_DIRS = new Set(["vendor"]);

// Matches: ['"] <anything-no-quote-no-ws> . <ext> ? v = <token>
// - Requires a file extension immediately before `?v=`
// - Requires the whole reference to live inside a quoted string
// This covers: HTML src="…/foo.js?v=xxx", SW '/foo.css?v=xxx' array entries,
// and ESM `from './foo.js?v=xxx'`. It does NOT match naked comments.
const CACHE_BUST_QUOTED_REF_RE = /['"][^'"\s]+\.[A-Za-z0-9]+\?v=[A-Za-z0-9_-]+/;
const VERSION_CONST_RE = /VERSION\s*=\s*['"]openclaude-[\w-]+['"]/;

function scanPublicForCacheBustTokens(): string[] {
  const hits: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const child = join(abs, name);
      let st;
      try {
        st = statSync(child);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(name)) continue;
        walk(child);
        continue;
      }
      // Only scan text-y files. Skip binary / image assets.
      if (!/\.(html?|js|mjs|css|json)$/i.test(name)) continue;
      let body: string;
      try {
        body = readFileSync(child, "utf-8");
      } catch {
        continue;
      }
      if (CACHE_BUST_QUOTED_REF_RE.test(body) || VERSION_CONST_RE.test(body)) {
        hits.push(relative(PUBLIC_DIR, child).split(sep).join("/"));
      }
    }
  };
  walk(PUBLIC_DIR);
  return hits;
}

function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const dryRun = checkMode || args.includes("--dry-run");
  const rest = args.filter((a) => !a.startsWith("--"));

  const token = rest[0] ?? gitShortHead();
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    console.error(`invalid token: ${token}`);
    process.exit(1);
  }

  let totalChanged = 0;
  let totalHits = 0;
  const report: Array<{ file: string; hits: number; changed: boolean }> = [];

  for (const rel of TARGETS) {
    const abs = join(PUBLIC_DIR, rel);
    try {
      const { changed, hits } = bumpFile(abs, token, dryRun);
      report.push({ file: rel, hits, changed });
      if (changed) totalChanged++;
      totalHits += hits;
    } catch (err) {
      console.error(`skip ${rel}: ${(err as Error).message}`);
    }
  }

  console.log(`target token: ${token}${dryRun ? "  (dry-run)" : ""}`);
  for (const r of report) {
    const tag = r.changed ? "BUMP" : r.hits > 0 ? "same" : "none";
    console.log(`  [${tag}] ${r.file}  (${r.hits} token${r.hits === 1 ? "" : "s"})`);
  }
  const verb = dryRun ? "would rewrite" : "rewritten";
  console.log(
    `${totalChanged}/${TARGETS.length} file(s) ${verb}, ${totalHits} token(s) total`,
  );

  // --check collects multiple failure kinds and reports them all before
  // exiting. Running into "fix drift → re-run → orphan fail → re-run → ..." is
  // annoying CI friction; one report per invocation is the principle.
  if (checkMode) {
    let failed = false;

    if (totalChanged > 0) {
      console.error("\nFAIL: files drifted from target token");
      failed = true;
    }

    const scanned = scanPublicForCacheBustTokens();
    const declared = new Set(TARGETS);
    const orphans = scanned.filter((p) => !declared.has(p));
    if (orphans.length > 0) {
      console.error("\nFAIL: cache-bust tokens found outside declared TARGETS:");
      for (const o of orphans) console.error(`  - ${o}`);
      console.error(
        "\nEither add these files to TARGETS in scripts/bump-version.ts,",
      );
      console.error("or remove the ?v= / VERSION pattern from them.");
      failed = true;
    }

    if (failed) process.exit(1);
  }
}

main();
