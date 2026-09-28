/** Independent negatives for the formal continuation gate.
 * Runs that gate; it does not accept a fault flag. Import and loader failures
 * are not business evidence. */
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);
const PROXY_FILES = [
  "boxRequestGate.ts", "boxCacheAnnotations.ts", "boxToolResultMatcher.ts", "boxCallFingerprint.ts",
  "boxMessagesMapper.ts", "boxToolCatalog.ts", "boxToolInputHash.ts", "boxCliToolHandoff.ts", "shared.ts",
];
const SCRIPT_FILES = [
  "scripts/check-v5-box-continuation.ts",
  "scripts/check-v5-box-continuation-fixture.ts",
  "scripts/check-v5-box-continuation-resolve.mjs",
];
const BUSINESS = /PROGRESS_COUNT_|HISTORICAL_BUDGET_KEPT|BUDGET_RETAINED|GATE_NOT_NULL|C2_GATE|C2_DRIFT|CONTEXT_|HOOK_COUNT_|WRAPPED_|UNKNOWN_|MATCH_|FINGERPRINT|NOT_IDEMPOTENT|RAW_MUTATED|REWRITE_|EXPECTED_/;
const LOADER = /Cannot find module|ERR_MODULE|ERR_UNSUPPORTED|UNRESOLVED|DEP_ESCAPE|SyntaxError|RUNTIME_MODULES_/;

function loader(): { cmd: string; args: string[] } {
  if (process.execArgv.includes("--experimental-transform-types")) {
    return { cmd: process.execPath, args: ["--experimental-transform-types"] };
  }
  return { cmd: "/usr/bin/tsx", args: [] };
}
function stage(mutate?: (source: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-b1-archive-"));
  for (const name of PROXY_FILES) {
    const rel = join("packages/commercial/src/http/proxy", name);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(SOURCE, rel), join(dir, rel));
  }
  for (const rel of SCRIPT_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(SOURCE, rel), join(dir, rel));
  }
  if (mutate) {
    const target = join(dir, "packages/commercial/src/http/proxy/boxCacheAnnotations.ts");
    writeFileSync(target, mutate(readFileSync(target, "utf8")));
  }
  assert.equal(existsSync(join(dir, ".git")), false);
  return dir;
}
function run(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env): { code: number; stdout: string; stderr: string } {
  const bin = loader();
  const result = spawnSync(bin.cmd, [...bin.args, join(dir, "scripts/check-v5-box-continuation.ts"), ...args], {
    cwd: dir, env, encoding: "utf8", timeout: 90_000,
  });
  return {
    code: result.status === null ? 1 : result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
function classify(result: { code: number; stderr: string }): "green" | "business" | "loader" {
  if (result.code === 0) return "green";
  if (LOADER.test(result.stderr)) return "loader";
  if (BUSINESS.test(result.stderr)) return "business";
  return "loader";
}
function patch(kind: string, source: string): string {
  if (kind === "progress") {
    const needle = "function bareHookBeforeBudget(text: string): string | null {\n";
    assert.equal(source.includes(needle), true);
    return source.replace(needle, `${needle}  if (text.startsWith(PROGRESS_SENTENCE)) return null;\n`);
  }
  if (kind === "keep-budget") {
    const needle = "function historicalBudgetString(text: string): boolean {\n  return exactMatch(BARE_BUDGET, text);\n}";
    assert.equal(source.includes(needle), true);
    return source.replace(needle, "function historicalBudgetString(text: string): boolean {\n  return false && exactMatch(BARE_BUDGET, text);\n}");
  }
  const needle = "function rejectIfUnapprovedBoundary(message: Record<string, unknown>): void {\n  if (unapprovedCollapsibleBoundary(message)) {";
  assert.equal(source.includes(needle), true);
  return source.replace(needle, "function rejectIfUnapprovedBoundary(message: Record<string, unknown>): void {\n  return;\n  if (unapprovedCollapsibleBoundary(message)) {");
}

test("archive without git passes only with a strict expect-sha", () => {
  const dir = stage();
  try {
    const missing = run(dir, []);
    assert.notEqual(missing.code, 0);
    assert.match(missing.stderr, /EXPECT_SHA_REQUIRED/);
    const unknown = run(dir, ["--expect-sha", SHA, "--fault", "progress"]);
    assert.notEqual(unknown.code, 0);
    assert.match(unknown.stderr, /UNKNOWN_ARG/);
    assert.doesNotMatch(unknown.stdout, /"ok":true/);
    const env = { ...process.env, DATABASE_URL: "postgres://proof-should-ignore", OPENCLAUDE_HOME: "/tmp/not-the-gate" };
    const ok = run(dir, ["--expect-sha", SHA], env);
    assert.equal(ok.code, 0, `${ok.stderr}\n${ok.stdout}`);
    const body = JSON.parse(ok.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.wired, false);
    assert.equal(body.git, "absent");
    assert.equal(body.expectSha, SHA);
    assert.equal(body.database, false);
    assert.equal(body.homeIsolated, true);
    assert.ok(body.runtimeModules >= 9);
    assert.ok(body.digest.some((item: { path: string }) => item.path.endsWith("check-v5-box-continuation.ts")));
    assert.ok(body.digest.some((item: { path: string }) => item.path.endsWith("check-v5-box-continuation-fixture.ts")));
    assert.equal(body.digest.some((item: { path: string }) => item.path.startsWith("..")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing sibling is a loader failure, not business proof", () => {
  const dir = stage();
  try {
    const green = run(dir, ["--expect-sha", SHA]);
    assert.equal(classify(green), "green", green.stderr);
    rmSync(join(dir, "packages/commercial/src/http/proxy/boxToolInputHash.ts"));
    const broken = run(dir, ["--expect-sha", SHA]);
    assert.equal(classify(broken), "loader", `${broken.stderr}\n${broken.stdout}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const kind of ["progress", "keep-budget", "promote-wrapper"]) {
  const expected = kind === "progress" ? /PROGRESS_COUNT_|GATE_NOT_NULL|CONTEXT_/
    : kind === "keep-budget" ? /HISTORICAL_BUDGET_KEPT|BUDGET_RETAINED|GATE_NOT_NULL/
      : /C2_GATE|C2_DRIFT/;
  test(`${kind} changes only product behavior and fails a business assertion`, () => {
    const dir = stage();
    try {
      const green = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(green), "green", green.stderr);
      const target = join(dir, "packages/commercial/src/http/proxy/boxCacheAnnotations.ts");
      const before = readFileSync(target, "utf8");
      const after = patch(kind, before);
      assert.notEqual(after, before);
      writeFileSync(target, after);
      const red = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(red), "business", red.stderr);
      assert.match(red.stderr, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("SIGTERM is not a successful proof", async () => {
  const dir = stage();
  const bin = loader();
  const child = spawn(bin.cmd, [...bin.args, join(dir, "scripts/check-v5-box-continuation.ts"), "--expect-sha", SHA], {
    cwd: dir, detached: true, stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(child.exitCode, null);
    process.kill(-child.pid!, "SIGTERM");
    const code = await new Promise<number>((resolve) => child.on("close", (status) => resolve(status ?? 1)));
    assert.notEqual(code, 0);
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

const git = spawnSync("git", ["-C", SOURCE, "rev-parse", "HEAD"], { encoding: "utf8" });
const head = git.status === 0 ? (git.stdout ?? "").trim() : "";
if (/^[0-9a-f]{40}$/.test(head)) {
  test("a real git tree cross-checks the builder sha", () => {
    const mismatch = run(SOURCE, ["--expect-sha", SHA]);
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, /GIT_SHA_MISMATCH/);
    const match = run(SOURCE, ["--expect-sha", head]);
    assert.equal(match.code, 0, match.stderr);
    assert.equal(JSON.parse(match.stdout).git, "match");
  });
}

