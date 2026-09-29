/** Independent negatives for the formal continuation gate.
 * Runs that gate; it does not accept a fault flag. Import and loader failures
 * are not business evidence. */
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("..", import.meta.url));
const SHA = "a".repeat(40);
const PROXY_FILES = [
  "boxRequestGate.ts", "boxCacheAnnotations.ts", "boxToolResultMatcher.ts", "boxCallFingerprint.ts",
  "boxMessagesMapper.ts", "boxToolCatalog.ts", "boxToolInputHash.ts", "boxCliToolHandoff.ts", "shared.ts",
  "boxToolResultPlan.ts", "boxToolResultEcho.ts", "boxStageFiles.ts", "boxToolInputEcho.ts",
  "boxPreparedContinuation.ts",
];
const SCRIPT_FILES = [
  "scripts/check-v5-box-continuation.ts",
  "scripts/check-v5-box-continuation-fixture.ts",
  "scripts/check-v5-box-continuation-resolve.mjs",
];
const FIXTURE_FILES = [
  "scripts/check-v5-box-continuation-859.png",
  "scripts/check-v5-box-continuation-859.oracle.json",
];
const BUSINESS = /PROGRESS_COUNT_|HISTORICAL_BUDGET_KEPT|BUDGET_RETAINED|GATE_NOT_NULL|C2_GATE|C2_DRIFT|CONTEXT_|HOOK_COUNT_|HOOK_CURRENT_|WRAPPED_|UNKNOWN_|CONTINUATION_|OPENING_|REWRITE_|EXPECTED_|BOX_TOOL_ECHO_|IMAGE_PUBLISH_|IMAGE_PUBLISHED_|IMAGE_MATCH_|IMAGE_FIXTURE_|IMAGE_ORACLE_|IMAGE_OWNER|IMAGE_NOT_LAST|IMAGE_COUNTS|IMAGE_GATE|IMAGE_RAW|IMAGE_IDEMPOTENT|IMAGE_BUDGET|IMAGE_DROPPED|IMAGE_ONE_BYTE|IMAGE_BYTE|WRONG_ROUTE|AUTHORITY_BYPASS|DUPLICATE_PUBLISH/;
const LOADER = /Cannot find module|ERR_MODULE|ERR_UNSUPPORTED|UNRESOLVED|DEP_ESCAPE|SyntaxError|RUNTIME_MODULES_/;

function loader(): { cmd: string; args: string[] } {
  if (process.execArgv.includes("--experimental-transform-types")) {
    return { cmd: process.execPath, args: ["--experimental-transform-types"] };
  }
  const pinned = join(SOURCE, "node_modules/tsx/dist/cli.mjs");
  if (existsSync(pinned)) return { cmd: process.execPath, args: [pinned] };
  return { cmd: "/usr/bin/tsx", args: [] };
}
function stage(mutate?: (source: string) => string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocv5-b1-archive-"));
  for (const name of readdirSync(join(SOURCE, "packages/commercial/src/http/proxy"))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const rel = join("packages/commercial/src/http/proxy", name);
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(SOURCE, rel), join(dir, rel));
  }
  const modules = join(dir, "node_modules/@openclaude");
  mkdirSync(modules, { recursive: true });
  const linked = join(SOURCE, "node_modules/@openclaude");
  if (existsSync(linked)) {
    for (const name of readdirSync(linked)) {
      const target = join(linked, name);
      symlinkSync(lstatSync(target).isSymbolicLink() ? realpathSync(target) : target, join(modules, name));
    }
  }
  for (const rel of [...SCRIPT_FILES, ...FIXTURE_FILES]) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    copyFileSync(join(SOURCE, rel), join(dir, rel));
  }
  // Publisher imports upstream, which imports commercial siblings. Symlink
  // those real files; copied proxy sources stay the staged mutations.
  const linkUnder = (rel: string): void => {
    const source = join(SOURCE, rel);
    const dest = join(dir, rel);
    if (!existsSync(source) || existsSync(dest)) {
      if (existsSync(source) && existsSync(dest) && lstatSync(source).isDirectory()
        && !lstatSync(dest).isSymbolicLink()) {
        for (const name of readdirSync(source)) linkUnder(join(rel, name));
      }
      return;
    }
    mkdirSync(dirname(dest), { recursive: true });
    symlinkSync(source, dest);
  };
  linkUnder("packages/commercial/src");
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


const SERIALIZE_ANCHOR = '  const raw = Buffer.from(JSON.stringify(result), "utf8");';
function holdBeforeSerialize(source: string): string {
  assert.equal(source.includes("PROBE_RUN"), false);
  assert.equal(source.includes(SERIALIZE_ANCHOR), true);
  const inject = "  process.stderr.write(`PROBE_RUN=${input.cwd}\\n`);\n"
    + "  const holdUntil = Date.now() + 120_000;\n"
    + "  while (Date.now() < holdUntil) {}\n";
  return source.replace(SERIALIZE_ANCHOR, inject + SERIALIZE_ANCHOR);
}
function armPublishHold(dir: string, shorten: boolean): void {
  const planPath = join(dir, "packages/commercial/src/http/proxy/boxToolResultPlan.ts");
  const sourcePlan = readFileSync(join(SOURCE, "packages/commercial/src/http/proxy/boxToolResultPlan.ts"), "utf8");
  assert.equal(sourcePlan.includes("PROBE_RUN"), false);
  writeFileSync(planPath, holdBeforeSerialize(readFileSync(planPath, "utf8")));
  const gatePath = join(dir, "scripts/check-v5-box-continuation.ts");
  const sourceGate = readFileSync(join(SOURCE, "scripts/check-v5-box-continuation.ts"), "utf8");
  assert.match(sourceGate, /const LIMIT_MS = 60_000;/);
  assert.doesNotMatch(sourceGate, /--limit-ms/);
  if (!shorten) return;
  const staged = readFileSync(gatePath, "utf8");
  assert.equal(staged.includes("const LIMIT_MS = 60_000;"), true);
  writeFileSync(gatePath, staged.replace("const LIMIT_MS = 60_000;", "const LIMIT_MS = 15_000;"));
}
async function waitPublishHold(run: ReturnType<typeof launched>): Promise<{
  publish: string; scratch: string; worker: number; pgid: number; starttime: string;
}> {
  for (let i = 0; i < 400; i++) {
    const text = run.text();
    const mark = text.stderr.match(/OC_B1_SUPERVISOR worker=(\d+) pgid=(\d+) starttime=(\d+) start=\d+ scratch=(\S+) publish=(\S+)/);
    const probe = text.stderr.match(/PROBE_RUN=(\/tmp\/ocv5-289-run-[0-9a-f]{24})/);
    if (mark && probe && probe[1] === mark[5] && run.child.exitCode === null && existsSync(probe[1] ?? "")) {
      return { publish: probe[1] ?? "", scratch: mark[4] ?? "", worker: Number(mark[1]),
        pgid: Number(mark[2]), starttime: mark[3] ?? "" };
    }
    if (run.child.exitCode !== null) assert.fail(`supervisor exited before the publish hold\n${text.stderr}\n${text.stdout}`);
    await delay(50);
  }
  assert.fail(`publish hold not observed\n${run.text().stderr}\n${run.text().stdout}`);
}
async function publishInterrupt(kind: "deadline" | "signal"): Promise<void> {
  const dir = stage();
  let run: ReturnType<typeof launched> | undefined;
  let leaked: string | null = null;
  try {
    armPublishHold(dir, kind === "deadline");
    const begun = Date.now();
    run = launched(dir, ["--expect-sha", SHA]);
    const seen = await waitPublishHold(run);
    leaked = seen.publish;
    assert.equal(run.child.exitCode, null);
    assert.equal(existsSync(seen.publish), true);
    assert.equal(existsSync(join(seen.scratch, "home")), true);
    if (kind === "signal") run.child.kill("SIGTERM");
    const code = await closed(run.child, kind === "deadline" ? 22_000 : 8_000);
    note({ case: `publish-${kind}`, pid: seen.worker, pgid: seen.pgid, starttime: seen.starttime,
      publish: seen.publish, code, elapsedMs: Date.now() - begun, waitedFullLimit: false,
      limitMs: kind === "deadline" ? 15_000 : 60_000 });
    assert.notEqual(code, 0);
    assert.match(run.text().stderr, kind === "deadline" ? /SUPERVISOR_TIMEOUT/ : /SUPERVISOR_SIGNAL/);
    assert.equal(procInfo(seen.worker), null);
    assert.deepEqual(members(seen.pgid), []);
    assert.equal(existsSync(seen.publish), false);
    assert.equal(existsSync(seen.scratch), false);
    assert.equal(existsSync(join(seen.scratch, "home")), false);
    leaked = null;
  } finally {
    try { run?.child.kill("SIGKILL"); } catch { /* already gone */ }
    if (leaked && existsSync(leaked)) rmSync(leaked, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
}
test("deadline cleans a publish directory while the product holds", async () => {
  await publishInterrupt("deadline");
});
test("SIGTERM cleans a publish directory while the product holds", async () => {
  await publishInterrupt("signal");
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
    assert.equal(body.wired, true);
    assert.equal(body.git, "absent");
    assert.equal(body.expectSha, SHA);
    assert.equal(body.database, false);
    assert.equal(body.homeIsolated, true);
    assert.ok(body.runtimeModules >= 9);
    assert.ok(body.digest.some((item: { path: string }) => item.path.endsWith("check-v5-box-continuation.ts")));
    assert.ok(body.digest.some((item: { path: string }) => item.path.endsWith("check-v5-box-continuation-fixture.ts")));
    assert.equal(body.digest.some((item: { path: string }) => item.path.startsWith("..")), false);
    for (const name of ["boxToolResultPlan.ts", "boxToolResultEcho.ts", "boxStageFiles.ts",
      "check-v5-box-continuation-859.png", "check-v5-box-continuation-859.oracle.json"]) {
      const item = body.digest.find((row: { path: string; realpath?: string; sha256?: string }) => row.path.endsWith(name));
      assert.ok(item, name);
      assert.equal(item.sha256?.length, 64);
      assert.equal(item.realpath?.endsWith(item.path), true);
    }
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
  const expected = kind === "progress" ? /CONTINUATION_|PROGRESS_COUNT_|GATE_NOT_NULL|CONTEXT_/
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

function gitCandidate(root: string): { ok: boolean; head: string; reason: string } {
  if (!existsSync(join(root, ".git"))) return { ok: false, head: "", reason: "no .git at candidate root" };
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) return { ok: false, head: "", reason: "rev-parse --show-toplevel failed" };
  let topPath = (top.stdout ?? "").trim();
  let rootPath = root;
  try { topPath = realpathSync(topPath); rootPath = realpathSync(root); }
  catch { /* compare the strings git printed */ }
  if (topPath !== rootPath) return { ok: false, head: "", reason: `toplevel ${topPath} is not ${rootPath}` };
  const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
  const value = (head.stdout ?? "").trim();
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(value)) return { ok: false, head: "", reason: "HEAD invalid" };
  return { ok: true, head: value, reason: "" };
}
const sourceGit = gitCandidate(SOURCE);
test("an archive nested in a parent repo does not enable git cross-check", () => {
  const nested = mkdtempSync(join("/home/agent/.openclaude/generated", "ocv5-b1-nested-"));
  try {
    const verdict = gitCandidate(nested);
    const walked = spawnSync("git", ["-C", nested, "rev-parse", "HEAD"], { encoding: "utf8" });
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /no \.git/);
    if (walked.status === 0) assert.notEqual(verdict.ok, true);
  } finally {
    rmSync(nested, { recursive: true, force: true });
  }
});
test("a real git tree cross-checks the builder sha", { skip: sourceGit.ok ? false : sourceGit.reason }, () => {
  const mismatch = run(SOURCE, ["--expect-sha", SHA]);
  assert.notEqual(mismatch.code, 0);
  assert.match(mismatch.stderr, /GIT_SHA_MISMATCH/);
  const match = run(SOURCE, ["--expect-sha", sourceGit.head]);
  assert.equal(match.code, 0, match.stderr);
  assert.equal(JSON.parse(match.stdout).git, "match");
});

const PLAN_ANCHOR = '  const raw = Buffer.from(JSON.stringify(result), "utf8");';
function planPatch(kind: "drop" | "text" | "image" | "id", source: string): string {
  const faults: Record<"drop" | "text" | "image" | "id", string> = {
    drop: 'result.content = result.content.filter((part) => part.type !== "text");\n',
    text: 'result.content = result.content.map((part) => part.type === "text" ? { ...part, text: part.text.slice(0, -1) + "X" } : part);\n',
    image: 'result.content = result.content.map((part) => { if (part.type !== "image") return part; const bytes = Buffer.from(part.data, "base64"); bytes[bytes.length - 1] ^= 255; return { ...part, data: bytes.toString("base64") }; });\n',
    id: 'result.modelToolUseId = "toolu_note_b1";\n',
  };
  assert.equal(source.includes(PLAN_ANCHOR), true, "publisher anchor missing");
  return source.replace(PLAN_ANCHOR, faults[kind] + PLAN_ANCHOR);
}
for (const kind of ["drop", "text", "image", "id"] as const) {
  const expected = kind === "id" ? /BOX_TOOL_ECHO_ID_INVALID/ : /BOX_TOOL_ECHO_CONTENT_MISMATCH/;
  test(`publisher ${kind} mutation is business-red at echo`, () => {
    const dir = stage();
    try {
      const green = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(green), "green", green.stderr + "\n" + green.stdout);
      const target = join(dir, "packages/commercial/src/http/proxy/boxToolResultPlan.ts");
      const before = readFileSync(target, "utf8");
      const after = planPatch(kind, before);
      assert.notEqual(after, before);
      writeFileSync(target, after);
      const red = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(red), "business", red.stderr + "\n" + red.stdout);
      assert.match(red.stderr, expected);
      assert.doesNotMatch(red.stderr, LOADER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("wrong route, authority bypass, and duplicate publish are business-red", () => {
  const faults: Array<{ file: string; from: string; to: string; expect: RegExp }> = [
    { file: "boxPreparedContinuation.ts",
      from: 'return { classification: "continuation_candidate", rejectCode: null, effectiveBody: effective,',
      to: 'return { classification: "fresh", rejectCode: null, effectiveBody: effective,',
      expect: /GATE_NOT_NULL|WRONG_ROUTE/ },
    { file: "boxPreparedContinuation.ts",
      from: "  if (left.kind === \"malformed\" || right.kind === \"malformed\") {",
      to: "  return { ok: true };\n  if (left.kind === \"malformed\" || right.kind === \"malformed\") {",
      expect: /AUTHORITY_BYPASS/ },
    { file: "boxToolResumePublish.ts",
      from: "for (let j = 0; j < staged.requests.length; j++) {",
      to: "for (let pass = 0; pass < 2; pass += 1) for (let j = 0; j < staged.requests.length; j++) {",
      expect: /DUPLICATE_PUBLISH/ },
  ];
  for (const fault of faults) {
    const dir = stage();
    try {
      const green = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(green), "green", green.stderr);
      const target = join(dir, "packages/commercial/src/http/proxy", fault.file);
      const before = readFileSync(target, "utf8");
      assert.equal(before.includes(fault.from), true, fault.from);
      writeFileSync(target, before.replace(fault.from, fault.to));
      const red = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(red), "business", `${red.stderr}\n${red.stdout}`);
      assert.match(red.stderr, fault.expect);
      assert.doesNotMatch(red.stderr, LOADER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

const AUDITOR_FAULT = "/home/agent/.openclaude/generated/ocv5-294-b1-gate-audit-hook-byte-negative/packages/commercial/src/http/proxy/boxCacheAnnotations.ts";
function bytePatch(kind: "hook-space" | "wrapped-byte", source: string): string {
  if (kind === "hook-space") {
    const needle = "if (head === PROGRESS_SENTENCE || exactMatch(BARE_HOOK, head)) return head;";
    assert.equal(source.includes(needle), true, "hook-space anchor missing");
    return source.replace(needle,
      "if (head === PROGRESS_SENTENCE || exactMatch(BARE_HOOK, head)) return head === PROGRESS_SENTENCE ? head : head + \" \";");
  }
  const needle = "const hookBytes = wrapped ? part.text as string : bare;";
  assert.equal(source.includes(needle), true, "wrapped-byte anchor missing");
  return source.replace(needle, "const hookBytes = wrapped ? (part.text as string) + \"x\" : bare;");
}
for (const kind of ["hook-space", "wrapped-byte"] as const) {
  const expected = kind === "hook-space" ? /CONTINUATION_4_TEXT_|REWRITE_HIST_toolu_syn_5|HOOK_CURRENT_TEXT/
    : /WRAPPED_TEXT_|WRAPPED_BYTES/;
  test(`${kind} extra byte fails the exact oracle`, () => {
    const dir = stage();
    try {
      const green = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(green), "green", green.stderr);
      const target = join(dir, "packages/commercial/src/http/proxy/boxCacheAnnotations.ts");
      writeFileSync(target, bytePatch(kind, readFileSync(target, "utf8")));
      const red = run(dir, ["--expect-sha", SHA]);
      assert.equal(classify(red), "business", `${red.stderr}\n${red.stdout}`);
      assert.match(red.stderr, expected);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
const auditorSnapshotCurrent = existsSync(AUDITOR_FAULT)
  && readFileSync(AUDITOR_FAULT, "utf8").includes("export function strictBoxImageBlock");
test("auditor hook-space tree is business-red under this gate", {
  skip: auditorSnapshotCurrent ? false : "auditor snapshot predates strictBoxImageBlock; current hook-space case covers it",
}, () => {
  const dir = stage();
  try {
    const green = run(dir, ["--expect-sha", SHA]);
    assert.equal(classify(green), "green", green.stderr);
    copyFileSync(AUDITOR_FAULT, join(dir, "packages/commercial/src/http/proxy/boxCacheAnnotations.ts"));
    const red = run(dir, ["--expect-sha", SHA]);
    assert.equal(classify(red), "business", `${red.stderr}\n${red.stdout}`);
    assert.match(red.stderr, /CONTINUATION_4_TEXT_|REWRITE_HIST_toolu_syn_5|HOOK_CURRENT_TEXT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

