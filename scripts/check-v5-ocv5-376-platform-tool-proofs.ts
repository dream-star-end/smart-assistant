#!/usr/bin/env tsx
/**
 * Deploy-gate proofs for the two OCV5-376 historical fixes whose Incident:none
 * waivers expired 2026-11-08. Runs the original behavior tests on the pinned tree.
 * Exact SHA+trailer → INC mapping is separate; this only proves the behaviors.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();

function fail(message: string): never {
  throw new Error(`[ocv5-376-platform-tool-proofs] ${message}`);
}

function escapeReg(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const tap = run.stdout ?? "";
  const out: string[] = [];
  for (const name of cases) {
    const ok = new RegExp(`^\\s*ok \\d+ - ${escapeReg(name)}\\s*$`, "m").test(tap);
    const notOk = new RegExp(`^\\s*not ok \\d+ - ${escapeReg(name)}\\b`, "m").test(tap);
    if (notOk || !ok) fail(`${file}: case failed or missing — ${name}\n${tap.slice(-1500)}`);
    out.push(`[ocv5-376-platform-tool-proofs] PASS — ${name}`);
  }
  if (run.status !== 0) fail(`${file}: exit ${run.status}`);
  return out;
}

function runVitest(file: string, cases: string[]): string[] {
  const abs = join(ROOT, file);
  if (!existsSync(abs)) fail(`missing ${file}`);
  const rel = file.replace(/^packages\/web-react\//, "");
  const run = spawnSync(
    "npm",
    ["run", "--workspace", "@openclaude/web-react", "test", "--", "--reporter=verbose", rel],
    { cwd: ROOT, encoding: "utf8", timeout: 300_000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, CI: "1" } },
  );
  const stdout = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const out: string[] = [];
  for (const name of cases) {
    const passed = stdout.includes(name)
      && !new RegExp(`✗\\s+.*${escapeReg(name)}`).test(stdout)
      && !new RegExp(`FAIL[^\\n]*${escapeReg(name)}`).test(stdout);
    if (!passed) fail(`${file}: case failed or missing — ${name}\n---\n${stdout.slice(-2500)}`);
    out.push(`[ocv5-376-platform-tool-proofs] PASS — ${name}`);
  }
  if (run.status !== 0) fail(`${file}: vitest exit ${run.status}\n${stdout.slice(-1500)}`);
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
