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
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

  if (checkMode && totalChanged > 0) {
    console.error("FAIL: files drifted from target token");
    process.exit(1);
  }
}

main();
