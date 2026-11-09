#!/usr/bin/env tsx
/**
 * Deploy-gate proofs for OCV5-376 historical fixes (8f8d44fc / 785b3e04).
 * Requires named cases to actually pass — missing, failed, skipped, or todo is a hard fail.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function fail(message: string): never {
  throw new Error(`[ocv5-376-platform-tool-proofs] ${message}`);
}

type Leaf = { name: string; ok: boolean; skip: boolean };

function tapLeaves(tap: string): Leaf[] {
  const leaves: Leaf[] = [];
  for (const line of tap.split("\n")) {
    const m = /^\s*(not )?ok \d+ - (.*?)(\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (m) leaves.push({ name: m[2]!, ok: !m[1], skip: Boolean(m[3]) });
  }
  return leaves;
}

function requireTapCases(file: string, tap: string, status: number | null, cases: string[]): string[] {
  const leaves = tapLeaves(tap);
  const out: string[] = [];
  for (const name of cases) {
    const leaf = leaves.find((item) => item.name === name);
    if (!leaf) fail(`${file}: case missing — ${name}`);
    if (leaf.skip) fail(`${file}: case skipped — ${name}`);
    if (!leaf.ok) fail(`${file}: case failed — ${name}`);
    out.push(`[ocv5-376-platform-tool-proofs] PASS — ${name}`);
  }
  const bad = leaves.filter((item) => !item.ok || item.skip).map((item) => item.name);
  if (bad.length || status !== 0) fail(`${file}: not green (${bad.join("; ") || `exit ${status}`})`);
  return out;
}

function runNodeTest(file: string, cases: string[]): string[] {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) fail(`missing ${file}`);
  const run = spawnSync(
    "npx",
    ["--no-install", "tsx", "--test", "--test-reporter=tap", "--test-concurrency=1", file],
    { cwd: ROOT, encoding: "utf8", timeout: 240_000, maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error) fail(`${file}: ${run.error.message}`);
  return requireTapCases(file, run.stdout ?? "", run.status, cases);
}

function runVitest(file: string, cases: string[]): string[] {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) fail(`missing ${file}`);
  const rel = file.replace(/^packages\/web-react\//, "");
  const run = spawnSync(
    "npm",
    ["run", "--workspace", "@openclaude/web-react", "test", "--", "--reporter=json", "--outputFile=/tmp/g1669-vitest.json", rel],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1" } },
  );
  if (run.error) fail(`${file}: ${run.error.message}`);
  // Prefer json file; fall back to stdout JSON
  let report: any;
  try {
    report = JSON.parse(readFileSync("/tmp/g1669-vitest.json", "utf8"));
  } catch {
    const stdout = run.stdout ?? "";
    const start = stdout.indexOf("{");
    if (start < 0) fail(`${file}: vitest json missing (exit ${run.status})\n${stdout.slice(-1500)}`);
    report = JSON.parse(stdout.slice(start));
  }
  const tests: Array<{ name?: string; fullName?: string; status?: string; result?: string }> = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) { for (const n of node) walk(n); return; }
    if (typeof node.name === "string" && (node.status || node.result || node.mode)) tests.push(node);
    if (Array.isArray(node.assertionResults)) {
      for (const a of node.assertionResults) tests.push(a);
    }
    for (const v of Object.values(node)) walk(v);
  };
  walk(report);
  const out: string[] = [];
  for (const name of cases) {
    const hit = tests.find((t) => t.fullName === name || t.name === name || (t.fullName ?? "").endsWith(name) || (t.name ?? "").includes(name));
    if (!hit) fail(`${file}: case missing — ${name}`);
    const status = String(hit.status ?? hit.result ?? "").toLowerCase();
    if (status.includes("skip") || status === "todo" || status === "pending") fail(`${file}: case skipped — ${name}`);
    if (!(status === "pass" || status === "passed" || status === "success")) {
      fail(`${file}: case failed — ${name} (status=${status || "unknown"})`);
    }
    out.push(`[ocv5-376-platform-tool-proofs] PASS — ${name}`);
  }
  if (run.status !== 0) fail(`${file}: vitest exit ${run.status}`);
  return out;
}

function main(): void {
  const lines: string[] = [];
  lines.push(
    ...runNodeTest("packages/commercial/src/__tests__/seedPlatformAgentHashes.test.ts", [
      "INC-20261011-GENERAL-ASSISTANT-STALE-MODEL: every platform seed agent keeps the artifact hash pinned for its slug@version",
      "INC-20261011-GENERAL-ASSISTANT-STALE-MODEL: general-assistant does not pin a model (auto follows the user)",
    ]),
  );
  lines.push(
    ...runVitest("packages/web-react/src/components/tool/lazyToolBody.test.ts", [
      "INC-20261011-LAZY-TOOL-BODY-REJECT-CACHE: a failed load is not cached: the next call loads again",
      "INC-20261011-LAZY-TOOL-BODY-REJECT-CACHE: the idle prefetch swallows a failed load instead of leaving an unhandled rejection",
    ]),
  );
  for (const line of lines) console.log(line);
  console.log(`[ocv5-376-platform-tool-proofs] PASS ${lines.length} cases`);
}

main();
