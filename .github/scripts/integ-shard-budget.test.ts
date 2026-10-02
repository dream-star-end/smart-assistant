import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CLEANUP_MARGIN_MS,
  DEFAULT_FILE_TIMEOUT_MS,
  DEFAULT_MUTEX_TIMEOUT_SECONDS,
  INSTALL_MARGIN_SECONDS,
  parseShardBudget,
  workflowBudgetDrift,
} from "./integ-shard-budget.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TIERS = join(ROOT, ".github/integ-tiers");

function manifest(name: string): string {
  return readFileSync(join(TIERS, name), "utf8");
}

function gate(args: string[], env: NodeJS.ProcessEnv = {}): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [".github/scripts/commercial-integ-gate.sh", ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

test("old pr-1 keeps 180000/3600 and its own max-minutes", () => {
  const budget = parseShardBudget(manifest("pr-1.txt"), {});
  assert.equal(budget.fileTimeoutMs, DEFAULT_FILE_TIMEOUT_MS);
  assert.equal(budget.mutexTimeoutSeconds, DEFAULT_MUTEX_TIMEOUT_SECONDS);
  assert.equal(budget.maxMinutes, 30);
  assert.equal(budget.minTests, 270);
  assert.equal(budget.declaredNewFields, false);
});

test("pr-4..7 budgets cover serial files plus cleanup and leave install room", () => {
  const expect: Record<string, { file: number; mutex: number; job: number; files: number; min: number }> = {
    "pr-4.txt": { file: 180_000, mutex: 900, job: 20, files: 4, min: 4 },
    "pr-5.txt": { file: 3_000_000, mutex: 3300, job: 70, files: 1, min: 5 },
    "pr-6.txt": { file: 1_200_000, mutex: 1500, job: 40, files: 1, min: 1 },
    "pr-7.txt": { file: 3_600_000, mutex: 3900, job: 90, files: 1, min: 1 },
  };
  for (const [name, row] of Object.entries(expect)) {
    const budget = parseShardBudget(manifest(name), {});
    assert.equal(budget.fileTimeoutMs, row.file, name);
    assert.equal(budget.mutexTimeoutSeconds, row.mutex, name);
    assert.equal(budget.maxMinutes, row.job, name);
    assert.equal(budget.minTests, row.min, name);
    assert.equal(budget.files.length, row.files, name);
    assert.ok(budget.files.length * budget.fileTimeoutMs + CLEANUP_MARGIN_MS <= budget.mutexTimeoutSeconds * 1000);
    assert.ok(budget.mutexTimeoutSeconds + INSTALL_MARGIN_SECONDS <= budget.maxMinutes * 60);
  }
});

test("nightly without the new fields keeps the old defaults", () => {
  const budget = parseShardBudget(manifest("nightly-1.txt"), {});
  assert.equal(budget.fileTimeoutMs, 180_000);
  assert.equal(budget.mutexTimeoutSeconds, 3600);
  assert.equal(budget.declaredNewFields, false);
});

test("legal env override on an old shard, illegal values rejected", () => {
  const old = manifest("pr-2.txt");
  assert.equal(parseShardBudget(old, { OC_INTEG_TEST_TIMEOUT_MS: "200000" }).fileTimeoutMs, 200_000);
  assert.equal(parseShardBudget(old, { OC_TEST_MUTEX_TIMEOUT: "4000" }).mutexTimeoutSeconds, 4000);
  for (const raw of ["", "0", "-1", "1.5", "NaN", "Infinity", "01", "1e3"]) {
    assert.throws(() => parseShardBudget(old, { OC_INTEG_TEST_TIMEOUT_MS: raw }), /正整数|越界/, raw);
  }
});

test("declared shard rejects a conflicting override and a missing twin field", () => {
  const text = manifest("pr-5.txt");
  assert.throws(() => parseShardBudget(text, { OC_INTEG_TEST_TIMEOUT_MS: "180000" }), /冲突/);
  assert.equal(parseShardBudget(text, { OC_INTEG_TEST_TIMEOUT_MS: "3000000" }).fileTimeoutMs, 3_000_000);
  assert.throws(() => parseShardBudget("# min-tests: 1\n# max-minutes: 70\n# file-timeout-ms: 1000\nfile.ts\n"), /必须同时声明/);
});

test("mutex/job margin conflicts are red", () => {
  const tightMutex = "# min-tests: 1\n# max-minutes: 70\n# file-timeout-ms: 3000000\n# mutex-timeout-seconds: 3000\nfile.ts\n";
  assert.throws(() => parseShardBudget(tightMutex), /超过 mutex/);
  const tightJob = "# min-tests: 1\n# max-minutes: 20\n# file-timeout-ms: 180000\n# mutex-timeout-seconds: 1200\nfile.ts\n";
  assert.throws(() => parseShardBudget(tightJob), /超过 job/);
});

test("workflow job ceilings match manifest max-minutes", () => {
  const yaml = readFileSync(join(ROOT, ".github/workflows/v5-ci.yml"), "utf8");
  assert.deepEqual(workflowBudgetDrift(yaml, TIERS), []);
});

test("gate print-budget matches the parser and does not claim an integ pass", () => {
  const printed = gate(["--print-budget", "pr-5"]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /shard=pr-5 file_timeout_ms=3000000 mutex_timeout_seconds=3300 max_minutes=70 files=1/);
  assert.doesNotMatch(printed.stdout, /G1|PASS:/);
});

test("aggregate does not string a parent timeout onto every shard", () => {
  const printed = gate(["--print-budget", "pr"], { OC_INTEG_TEST_TIMEOUT_MS: "111" });
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /shard=pr-1 file_timeout_ms=180000 /);
  assert.match(printed.stdout, /shard=pr-5 file_timeout_ms=3000000 /);
  assert.match(printed.stdout, /shard=pr-7 file_timeout_ms=3600000 /);
  assert.doesNotMatch(printed.stdout, /file_timeout_ms=111/);
});

test("a conflicting override on one shard is red", () => {
  const printed = gate(["--print-budget", "pr-7"], { OC_TEST_MUTEX_TIMEOUT: "3600" });
  assert.notEqual(printed.status, 0);
  assert.match(printed.stderr, /冲突/);
});
