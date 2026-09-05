#!/usr/bin/env node
/**
 * known-failures admission policy (OCV5-119 / R8' phase 1).
 *
 * Every non-comment entry must be preceded by:
 *   # issue=OCV5-<n> approved-by=<token> expires=YYYY-MM-DD
 * Expired entries fail. Entries whose suite is in core-contract-suites.txt fail.
 * Does not edit known-failures files.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(HERE, "..", "known-failures");
const HEADER_RE = /^# issue=(OCV5-\d+) approved-by=(\S+) expires=(\d{4}-\d{2}-\d{2})\s*$/;

export function parseCoreSuites(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    out.push(t);
  }
  return out;
}

export function isCoreEntry(entry, coreSuites) {
  for (const core of coreSuites) {
    if (entry === core || entry.startsWith(`${core} `)) return true;
  }
  return false;
}

export function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function checkFile(path, text, coreSuites, today) {
  const lines = String(text).split(/\r?\n/);
  const problems = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const prev = i > 0 ? lines[i - 1] : "";
    const hm = HEADER_RE.exec(prev);
    if (!hm) {
      problems.push({
        file: path,
        line: i + 1,
        kind: "missing-header",
        message: `entry has no admission header on the previous line: ${trimmed}`,
      });
      continue;
    }
    const expires = hm[3];
    if (expires < today) {
      problems.push({
        file: path,
        line: i + 1,
        kind: "expired",
        message: `entry expired ${expires}: ${trimmed}`,
      });
    }
    if (isCoreEntry(trimmed, coreSuites)) {
      problems.push({
        file: path,
        line: i + 1,
        kind: "core-contract",
        message: `core-contract suite cannot be a known-failure: ${trimmed}`,
      });
    }
  }
  return problems;
}

export function listPolicyTargets(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".txt") && n !== "core-contract-suites.txt")
    .map((n) => join(dir, n))
    .sort();
}

export function checkDir(dir, opts = {}) {
  const today = opts.today || todayUTC();
  const corePath = join(dir, "core-contract-suites.txt");
  const coreSuites = existsSync(corePath) ? parseCoreSuites(readFileSync(corePath, "utf8")) : [];
  const problems = [];
  for (const file of listPolicyTargets(dir)) {
    problems.push(...checkFile(file, readFileSync(file, "utf8"), coreSuites, today));
  }
  return { problems, coreSuites, today };
}

export function main(argv = process.argv.slice(2)) {
  const dirFlag = argv.findIndex((a) => a === "--dir");
  const dir = dirFlag >= 0 ? argv[dirFlag + 1] : process.env.KNOWN_FAILURES_DIR || DEFAULT_DIR;
  const { problems } = checkDir(dir);
  if (problems.length === 0) {
    console.log(`[known-failures-policy] OK — 0 entries violated admission rules under ${dir}`);
    return 0;
  }
  console.error(`[known-failures-policy] FAIL — ${problems.length} problem(s):`);
  for (const p of problems) {
    console.error(`  [${p.kind}] ${p.file}:${p.line}: ${p.message}`);
  }
  return 1;
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirect) process.exit(main());
