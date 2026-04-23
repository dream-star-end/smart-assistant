#!/usr/bin/env bun
// changelog-finalize.ts — Pre-check and replace PENDING markers in changelog.json.
//
// Modes:
//   --count           Print number of PENDING entries in releases[], exit 0.
//   <TAG>             Replace all release entries with version==="PENDING":
//                       - version → TAG
//                       - date (if empty) → UTC today (YYYY-MM-DD)
//                     And replace top-level currentVersion if it is "PENDING".
//                     Writes changelog.json in place. Exit 0 on any successful
//                     rewrite (or 0 PENDING; idempotent no-op).
//
// Exit codes:
//   0 = ok
//   2 = usage error
//   3 = malformed changelog.json
//
// Rationale: keeping this in TypeScript avoids shell quoting hell and matches
// the rest of the deploy toolchain (bump-version.ts is bun too).

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CHANGELOG = join(REPO_ROOT, "changelog.json");

function die(msg: string, code = 3): never {
  console.error(`changelog-finalize: ${msg}`);
  process.exit(code);
}

function load(): { currentVersion: unknown; releases: unknown[] } {
  let raw: string;
  try {
    raw = readFileSync(CHANGELOG, "utf-8");
  } catch {
    die(`cannot read ${CHANGELOG}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    die(`malformed JSON: ${(e as Error).message}`);
  }
  if (!data || typeof data !== "object") die("top-level not an object");
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.releases)) die("missing releases[]");
  return { currentVersion: d.currentVersion, releases: d.releases };
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun scripts/changelog-finalize.ts --count | <TAG>");
  process.exit(2);
}

const { currentVersion, releases } = load();

if (arg === "--count") {
  const pending = releases.filter(
    (r) => r && typeof r === "object" && (r as Record<string, unknown>).version === "PENDING",
  ).length;
  console.log(pending);
  process.exit(0);
}

// Replace mode — arg is the TAG.
const TAG = arg;
if (!/^v3-\d{8}T\d{4}Z-[0-9a-f]+$/.test(TAG)) {
  die(`tag does not match expected format v3-YYYYMMDDTHHMMZ-<hash>: ${TAG}`, 2);
}

const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)

let replaced = 0;
const out = releases.map((r) => {
  if (!r || typeof r !== "object") return r;
  const rr = { ...(r as Record<string, unknown>) };
  if (rr.version === "PENDING") {
    rr.version = TAG;
    if (!rr.date || rr.date === "") rr.date = today;
    replaced++;
  }
  return rr;
});

const finalCurrent = currentVersion === "PENDING" || replaced > 0 ? TAG : currentVersion;

const next = JSON.stringify(
  { currentVersion: finalCurrent, releases: out },
  null,
  2,
);

writeFileSync(CHANGELOG, next + "\n", "utf-8");
console.log(`changelog-finalize: replaced ${replaced} PENDING → ${TAG}`);
