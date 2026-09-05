#!/usr/bin/env tsx
/**
 * Static ban on silent test retries (OCV5-119 / R8' phase 1).
 *
 * Scans vitest/playwright configs, test files, and the e2e tree for silent
 * retries (retry/retries set to 1-9, test.retry, chained retry calls, or a
 * non-zero OC_E2E_RETRIES default).
 *
 * Allow only when the same line or the previous line has:
 *   // oc-retry: transport <reason>
 *
 * OC_TEST_RETRY_ENFORCE=0 yields warnings only (observe). Default enforce=1.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "coverage",
  "claude-code-best",
  ".next",
]);

export interface RetryHit {
  file: string;
  line: number;
  text: string;
  kind: string;
  allowed: boolean;
}

const RETRY_COLON = /(?:^|[^A-Za-z0-9_])retry:\s*[1-9]/;
const RETRIES_COLON = /(?:^|[^A-Za-z0-9_])retries:\s*[1-9]/;
const TEST_RETRY = /test\.retry\(/;
const DOT_RETRY = /\.retry\(/;
const E2E_DEFAULT = /OC_E2E_RETRIES\s*(?:\?\?|\|\|)\s*(?:[1-9]\d*|Number\([^\)]*[1-9])/;
const E2E_ASSIGN = /OC_E2E_RETRIES\s*=\s*['"]?[1-9]/;
const ALLOW = /\/\/\s*oc-retry:\s*transport\b/;

function isTarget(rel: string, base: string): boolean {
  if (base.startsWith("vitest.config") || base.startsWith("playwright.config")) return true;
  if (/\.test\.(ts|tsx|mjs)$/.test(base)) return true;
  if (rel === "e2e" || rel.startsWith("e2e/")) return true;
  return false;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let ents: string[];
    try {
      ents = readdirSync(dir);
    } catch {
      return;
    }
    for (const ent of ents) {
      if (SKIP_DIRS.has(ent)) continue;
      const full = join(dir, ent);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(root, full).replace(/\\/g, "/");
      if (st.isDirectory()) visit(full);
      else if (st.isFile() && isTarget(rel, ent)) out.push(full);
    }
  };
  visit(root);
  return out;
}

function classifyLine(line: string): string | null {
  if (RETRY_COLON.test(line)) return "retry:";
  if (RETRIES_COLON.test(line)) return "retries:";
  if (TEST_RETRY.test(line)) return "test.retry(";
  if (DOT_RETRY.test(line)) return ".retry(";
  if (E2E_DEFAULT.test(line) || E2E_ASSIGN.test(line)) return "OC_E2E_RETRIES-default";
  return null;
}

export function scanText(rel: string, text: string): RetryHit[] {
  const lines = text.split(/\r?\n/);
  const hits: RetryHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const kind = classifyLine(line);
    if (!kind) continue;
    const prev = i > 0 ? lines[i - 1] ?? "" : "";
    const allowed = ALLOW.test(line) || ALLOW.test(prev);
    hits.push({ file: rel, line: i + 1, text: line.trim(), kind, allowed });
  }
  return hits;
}

export function scanRepo(root = REPO_ROOT): RetryHit[] {
  const files = walk(root);
  const hits: RetryHit[] = [];
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    hits.push(...scanText(relative(root, file).replace(/\\/g, "/"), text));
  }
  return hits;
}

function parseRoot(argv: string[], fallback: string): string {
  const i = argv.indexOf("--root");
  if (i >= 0 && argv[i + 1]) return argv[i + 1]!;
  return process.env.OC_TEST_RETRY_ROOT || fallback;
}

export function main(argv = process.argv.slice(2), fallbackRoot = REPO_ROOT): number {
  const root = parseRoot(argv, fallbackRoot);
  const enforce = process.env.OC_TEST_RETRY_ENFORCE !== "0";
  const hits = scanRepo(root);
  const banned = hits.filter((h) => !h.allowed);
  const allowed = hits.filter((h) => h.allowed);
  if (allowed.length > 0) {
    console.log(`[check:test-retries] ${allowed.length} transport-annotated retry(s) allowed:`);
    for (const h of allowed) console.log(`  ALLOW ${h.file}:${h.line} [${h.kind}] ${h.text}`);
  }
  if (banned.length === 0) {
    console.log("[check:test-retries] OK — no silent test retries");
    return 0;
  }
  const tag = enforce ? "FAIL" : "WARN";
  console.error(`[check:test-retries] ${tag} — ${banned.length} silent retry site(s):`);
  for (const h of banned) {
    console.error(`  ${h.file}:${h.line} [${h.kind}] ${h.text}`);
  }
  console.error("  Allow only with `// oc-retry: transport <reason>` on the same or previous line.");
  return enforce ? 1 : 0;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === self) process.exit(main());
