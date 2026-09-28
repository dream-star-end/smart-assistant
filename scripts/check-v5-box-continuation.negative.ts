/** Independent negatives for the formal continuation gate.
 * Runs that gate; it does not accept a fault flag. Import and loader failures
 * are not business evidence. */
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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

const EVIDENCE = "/home/agent/.openclaude/generated/ocv5-294-b1-supervisor-evidence.jsonl";
const OLD = "d8beef1f4051196ced1d880bb5a151144dc41608";
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function procInfo(pid: number): { pid: number; ppid: number; pgrp: number; starttime: number } | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, ppid: Number(rest[1]), pgrp: Number(rest[2]), starttime: Number(rest[19]) };
  } catch { return null; }
}
function members(pgid: number): number[] {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = procInfo(Number(name));
    if (info?.pgrp === pgid) found.push(info.pid);
  }
  return found;
}
function note(row: Record<string, unknown>): void {
  appendFileSync(EVIDENCE, `${JSON.stringify(row)}\n`);
}
function blockNormalize(source: string, hold: boolean): string {
  const needle = "export function normalizeBoxSemanticBody(";
  assert.equal(source.includes(needle), true);
  const prelude = hold ? "import { spawn as __holdSpawn } from \"node:child_process\";\n" : "";
  const call = hold
    ? "__holdSpawn(process.execPath, [\"-e\", \"process.on('SIGTERM',()=>{});setInterval(()=>{},1e9);\"], {stdio:'ignore'});\n  "
    : "";
  return prelude + source.replace(needle,
    "export function normalizeBoxSemanticBody(body: ProxyBody, _options?: { collapseSingleText?: boolean }): ProxyBody {\n  "
    + `${call}const until = Date.now() + 120_000;\n  while (Date.now() < until) {}\n  return body;\n}\nfunction normalizeBoxSemanticBodyUnused(`);
}
function launched(dir: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const bin = loader();
  let stderr = "";
  let stdout = "";
  const child = spawn(bin.cmd, [...bin.args, join(dir, "scripts/check-v5-box-continuation.ts"), ...args], {
    cwd: dir, env, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return { child, text: () => ({ stdout, stderr }) };
}
async function closed(child: ReturnType<typeof spawn>, ms: number): Promise<number> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WAIT_TIMEOUT")), ms);
    child.on("close", (status) => { clearTimeout(timer); resolve(status ?? 1); });
  });
}
const oldFiles = spawnSync("git", ["-C", SOURCE, "cat-file", "-e", `${OLD}:scripts/check-v5-box-continuation.ts`]);

test("d8beef sync normalize is still running when an external guard stops it", { skip: oldFiles.status !== 0 }, async () => {
  const dir = stage((source) => blockNormalize(source, false));
  try {
    for (const rel of SCRIPT_FILES) {
      const shown = spawnSync("git", ["-C", SOURCE, "show", `${OLD}:${rel}`], { encoding: "utf8" });
      assert.equal(shown.status, 0, shown.stderr);
      writeFileSync(join(dir, rel), shown.stdout);
    }
    const bin = loader();
    const child = spawn(bin.cmd, [...bin.args, join(dir, "scripts/check-v5-box-continuation.ts"), "--expect-sha", SHA], {
      cwd: dir, detached: true, stdio: "ignore",
    });
    const info = procInfo(child.pid ?? 0);
    await delay(2_000);
    const later = procInfo(child.pid ?? 0);
    note({ case: "d8beef-hang", pid: child.pid, pgid: info?.pgrp, starttime: info?.starttime,
      aliveAtMs: 2_000, selfExited: later === null, guardMs: 2_000, waitedFullLimit: false });
    assert.notEqual(later, null, "old gate exited by itself inside the 2s external guard");
    assert.equal(info?.starttime, later?.starttime);
    process.kill(-(child.pid ?? 0), "SIGKILL");
    await closed(child, 3_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor reaps a worker blocked in product normalize", async () => {
  const dir = stage((source) => blockNormalize(source, false));
  let run: ReturnType<typeof launched> | undefined;
  try {
    const gate = join(dir, "scripts/check-v5-box-continuation.ts");
    const original = readFileSync(join(SOURCE, "scripts/check-v5-box-continuation.ts"), "utf8");
    assert.match(original, /const LIMIT_MS = 60_000;/);
    assert.doesNotMatch(original, /--limit-ms/);
    writeFileSync(gate, readFileSync(gate, "utf8").replace("const LIMIT_MS = 60_000;", "const LIMIT_MS = 2_500;"));
    const begun = Date.now();
    run = launched(dir, ["--expect-sha", SHA]);
    let mark: RegExpMatchArray | null = null;
    for (let i = 0; i < 160 && !mark; i++) {
      mark = run.text().stderr.match(/OC_B1_SUPERVISOR worker=(\d+) pgid=(\d+) starttime=(\d+) start=\d+ scratch=(\S+)/);
      if (!mark) await delay(50);
    }
    assert.ok(mark, `${run.text().stderr}\n${run.text().stdout}`);
    const worker = Number(mark[1]);
    const live = procInfo(worker);
    assert.equal(live?.pgrp, Number(mark[2]));
    assert.equal(String(live?.starttime), mark[3]);
    const code = await closed(run.child, 12_000);
    const scratch = mark[4] ?? "";
    note({ case: "supervisor-hang", pid: worker, pgid: Number(mark[2]), starttime: live?.starttime,
      code, elapsedMs: Date.now() - begun, waitedFullLimit: false, limitMs: 2_500 });
    assert.notEqual(code, 0);
    assert.match(run.text().stderr, /SUPERVISOR_TIMEOUT/);
    assert.equal(procInfo(worker), null);
    assert.deepEqual(members(Number(mark[2])), []);
    assert.equal(existsSync(scratch), false);
    assert.ok(Date.now() - begun < 12_000);
  } finally {
    try { run?.child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stuck git command is killed inside the worker and leaves nothing", async () => {
  const dir = stage();
  const bin = mkdtempSync(join(tmpdir(), "ocv5-b1-git-"));
  let run: ReturnType<typeof launched> | undefined;
  try {
    writeFileSync(join(bin, "git"), "#!/usr/bin/env node\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1e9);\n");
    chmodSync(join(bin, "git"), 0o755);
    writeFileSync(join(dir, ".git"), "gitdir: /nowhere\n");
    const env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` };
    const begun = Date.now();
    run = launched(dir, ["--expect-sha", SHA], env);
    let mark: RegExpMatchArray | null = null;
    for (let i = 0; i < 160 && !mark; i++) {
      mark = run.text().stderr.match(/OC_B1_SUPERVISOR worker=(\d+) pgid=(\d+) starttime=(\d+) start=\d+ scratch=(\S+)/);
      if (!mark) await delay(50);
    }
    assert.ok(mark, `${run.text().stderr}\n${run.text().stdout}`);
    const code = await closed(run.child, 15_000);
    note({ case: "git-stuck", pid: Number(mark[1]), pgid: Number(mark[2]), starttime: Number(mark[3]),
      code, elapsedMs: Date.now() - begun, waitedFullLimit: false });
    assert.notEqual(code, 0);
    assert.match(run.text().stderr, /GIT_CROSSCHECK_TIMEOUT/);
    assert.equal(procInfo(Number(mark[1])), null);
    assert.deepEqual(members(Number(mark[2])), []);
    assert.equal(existsSync(mark[4] ?? ""), false);
    assert.equal(members(Number(mark[2])).includes(Number(mark[1])), false);
  } finally {
    try { run?.child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("SIGTERM reaps a worker and the descendant that ignores the signal", async () => {
  const dir = stage((source) => blockNormalize(source, true));
  let run: ReturnType<typeof launched> | undefined;
  try {
    run = launched(dir, ["--expect-sha", SHA]);
    let mark: RegExpMatchArray | null = null;
    for (let i = 0; i < 160 && !mark; i++) {
      mark = run.text().stderr.match(/OC_B1_SUPERVISOR worker=(\d+) pgid=(\d+) starttime=(\d+) start=\d+ scratch=(\S+)/);
      if (!mark) await delay(50);
    }
    assert.ok(mark, `${run.text().stderr}\n${run.text().stdout}`);
    const worker = Number(mark[1]);
    let holder: number | null = null;
    for (let i = 0; i < 80 && holder === null; i++) {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const info = procInfo(Number(name));
        if (info?.ppid === worker) holder = info.pid;
      }
      if (holder === null) await delay(50);
    }
    assert.notEqual(holder, null);
    const holderInfo = procInfo(holder ?? 0);
    note({ case: "signal-hold", worker, workerStart: Number(mark[3]), holder, holderStart: holderInfo?.starttime,
      pgid: Number(mark[2]) });
    run.child.kill("SIGTERM");
    const code = await closed(run.child, 8_000);
    assert.notEqual(code, 0);
    assert.match(run.text().stderr, /SUPERVISOR_SIGNAL/);
    assert.equal(procInfo(worker), null);
    assert.equal(procInfo(holder ?? 0), null);
    assert.deepEqual(members(Number(mark[2])), []);
    assert.equal(existsSync(mark[4] ?? ""), false);
  } finally {
    try { run?.child.kill("SIGKILL"); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

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

