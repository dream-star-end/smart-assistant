/**
 * OCV5-557: selfhost release Box gates stop failing on load and on the shared test database.
 * Runs the production shell functions extracted from scripts/v5-selfhost-master-release-lib.sh
 * (never the deploy top level) against fixture load/lock/proc dirs, plus the two helpers.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { boxBridgeFailed, boxBridgeOutcome } from "../lib/boxBridgeFailureProof.js";
import { gateLoadScale, scaledMs } from "../lib/gateLoadScale.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const lib = readFileSync(path.join(root, "scripts/v5-selfhost-master-release-lib.sh"), "utf8");
const summaryLib = readFileSync(path.join(root, "scripts/lib/v5-selfhost-train-summary.sh"), "utf8");

function fn(name: string): string {
  const match = lib.match(new RegExp(`^${name}\\(\\) \\{[^\\n]*\\n[\\s\\S]*?^\\}`, "m"));
  assert.ok(match, name);
  return match[0];
}
const vars = (() => {
  const a = lib.indexOf("MASTER_BOX_GATE_LOAD_MAX=8");
  const b = lib.indexOf('MASTER_GATE_DB_STAGING=""', a);
  assert.ok(a > 0 && b > a);
  return lib.slice(a, b + 'MASTER_GATE_DB_STAGING=""'.length);
})();
const fns = ["master_gate_base_dsn", "master_gate_load1", "master_gate_load_scale", "master_gate_busy_reason",
  "master_gate_wait_host_idle", "master_gate_attempt_log", "master_gate_flaky_signature", "master_gate_first_failure",
  "master_gate_retryable"]
  .map(fn).join("\n");

type Fx = { dir: string; loadavg: string; locks: string; proc: string; trains: string };
function fixture(t: { after(f: () => void): void }): Fx {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-box-gate-flaky-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fx = { dir, loadavg: path.join(dir, "loadavg"), locks: path.join(dir, "lock"), proc: path.join(dir, "proc"),
    trains: path.join(dir, "trains") };
  for (const d of [fx.locks, fx.proc, fx.trains]) mkdirSync(d);
  setLoad(fx, "2.00");
  return fx;
}
const setLoad = (fx: Fx, load1: string) => writeFileSync(fx.loadavg, `${load1} 1.00 1.00 1/100 1234\n`);
type ProcStatOpts = {
  state?: string;
  ppid?: number;
  utime?: number;
  stime?: number;
  cutime?: number;
  cstime?: number;
  numThreads?: number;
  starttime?: number;
  comm?: string;
};
function writeProcStat(fx: Fx, pid: number, opts: ProcStatOpts = {}): void {
  const {
    state = "R",
    ppid = 1,
    utime = 12,
    stime = 3,
    cutime = 0,
    cstime = 0,
    numThreads = 1,
    starttime = 10_000 + pid,
    comm = "node",
  } = opts;
  const tail = [
    state, ppid, pid, pid, 0, -1, 0,
    0, 0, 0, 0, utime, stime, cutime, cstime, 20, 0, numThreads, 0, starttime,
    0, 0,
  ].join(" ");
  const dir = path.join(fx.proc, String(pid));
  mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.stat.${process.pid}.tmp`);
  writeFileSync(tmp, `${pid} (${comm}) ${tail}\n`);
  renameSync(tmp, path.join(dir, "stat"));
}
function proc(fx: Fx, pid: number, argv: string[], opts: ProcStatOpts = {}): void {
  mkdirSync(path.join(fx.proc, String(pid)), { recursive: true });
  writeFileSync(path.join(fx.proc, String(pid), "cmdline"), `${argv.join("\0")}\0`);
  writeProcStat(fx, pid, { comm: path.basename(argv[0] ?? "proc"), ...opts });
}

function buildScript(fx: Fx, body: string): string {
  return [
    'mlog() { echo "$*" >&2; }',
    `MASTER_GATE_LOADAVG=${JSON.stringify(fx.loadavg)}`,
    `MASTER_GATE_TEST_LOCK_DIR=${JSON.stringify(fx.locks)}`,
    `MASTER_GATE_PROC_ROOT=${JSON.stringify(fx.proc)}`,
    vars, summaryLib, fns, body,
  ].join("\n");
}
function run(fx: Fx, body: string, env: Record<string, string> = {}) {
  return spawnSync("bash", ["-eu", "-o", "pipefail", "-c", buildScript(fx, body)], {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: fx.dir, OC_V5_TRAIN_SUMMARY_DIR: fx.trains,
      MASTER_GATE_IDLE_POLL_S: "1", ...env },
  });
}
function runAsync(fx: Fx, body: string, env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["-eu", "-o", "pipefail", "-c", buildScript(fx, body)], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: fx.dir, OC_V5_TRAIN_SUMMARY_DIR: fx.trains,
        MASTER_GATE_IDLE_POLL_S: "1", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}
const TID = "tr-20261021T000000Z-0123456789ab";
const summary = (fx: Fx) => JSON.parse(readFileSync(path.join(fx.trains, `${TID}.summary.json`), "utf8")) as
  { notes: Record<string, string> };

describe("load scale (OCV5-557 item 5)", () => {
  test("clamp(load1/8, 1, 3) with two decimals; unreadable load reads as 1", (t) => {
    const fx = fixture(t);
    for (const [load, want] of [["2.00", "1.00"], ["8.00", "1.00"], ["12.00", "1.50"], ["17.80", "2.23"],
      ["43.70", "3.00"]] as const) {
      setLoad(fx, load);
      assert.equal(run(fx, "master_gate_load_scale").stdout, want, load);
    }
    rmSync(fx.loadavg);
    assert.equal(run(fx, "master_gate_load_scale").stdout, "1.00");
  });

  test("the gates read the scale from env: numbers in [1, 3] only, waits only", () => {
    assert.equal(gateLoadScale({}), 1);
    for (const raw of ["", "abc", "-2", "0.5", "1e3", "NaN", "2 "]) assert.equal(gateLoadScale({ OC_V5_GATE_LOAD_SCALE: raw }), 1, raw);
    assert.equal(gateLoadScale({ OC_V5_GATE_LOAD_SCALE: "1.75" }), 1.75);
    assert.equal(gateLoadScale({ OC_V5_GATE_LOAD_SCALE: "9" }), 3);
    assert.equal(scaledMs(15_000, { OC_V5_GATE_LOAD_SCALE: "2.5" }), 37_500);
    assert.equal(scaledMs(15_000, { OC_V5_GATE_LOAD_SCALE: "40" }), 45_000);
  });
});

describe("host idle before the Box gates (OCV5-557 item 3)", () => {
  test("idle host: no reason", (t) => {
    const fx = fixture(t);
    writeFileSync(path.join(fx.locks, "oc-test-commercial.lock"), "");
    proc(fx, 4242, ["node", "/usr/bin/npm", "run", "build", "--workspace", "packages/web-react"]);
    proc(fx, 4243, ["node", "--test", "x.test.ts"]);
    const r = run(fx, 'r="$(master_gate_busy_reason)"; echo "[$r]"');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "[]");
  });

  test("load1 >= 8, a held test-mutex lock, or an npm test run is busy", async (t) => {
    const fx = fixture(t);
    setLoad(fx, "8.00");
    assert.match(run(fx, "master_gate_busy_reason").stdout, /load1=8\.00>=8/);
    setLoad(fx, "3.00");
    const lock = path.join(fx.locks, "oc-test-gateway.lock");
    writeFileSync(lock, "");
    // its own process group: the sleep inherits the locked fd, so both must go
    const holder = spawn("flock", [lock, "sleep", "20"], { stdio: "ignore", detached: true });
    const release = () => { try { process.kill(-holder.pid!, "SIGKILL"); } catch { /* gone */ } };
    t.after(release);
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(run(fx, "master_gate_busy_reason").stdout, /test-mutex:gateway/);
    release();
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", lock, "true"]).status !== 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(run(fx, "master_gate_busy_reason").stdout, "");
    // pid5150: npm parent sleeping while its descendant test runner actively executes
    proc(fx, 5150, ["npm", "run", "test:gateway"], { state: "S", utime: 0, stime: 0 });
    proc(fx, 51501, ["node", "vitest"], { ppid: 5150, state: "R", utime: 45, stime: 8 });
    assert.match(run(fx, "master_gate_busy_reason").stdout, /pid5150: npm run test:gateway/);
    rmSync(path.join(fx.proc, "5150"), { recursive: true });
    rmSync(path.join(fx.proc, "51501"), { recursive: true });
    proc(fx, 5151, ["node", "/usr/lib/node_modules/npm/bin/npm-cli.js", "run", "check:v5"], { state: "R" });
    assert.match(run(fx, "master_gate_busy_reason").stdout, /pid5151:/);
    rmSync(path.join(fx.proc, "5151"), { recursive: true });
    proc(fx, 5152, ["npm", "test"], { state: "D" });
    assert.match(run(fx, "master_gate_busy_reason").stdout, /pid5152:/);
    // no lock file is created by looking
    assert.deepEqual(readdirSync(fx.locks), ["oc-test-gateway.lock"]);
  });

  test("cmdline candidate blocked in wait-for-trains/sleep is idle; subtree CPU tick growth is busy", async (t) => {
    const fx = fixture(t);
    // Incident shape (tr-20261029T195927Z): rf-heavy wrapper carries `npm run test` in argv while sleeping on train
    proc(fx, 924355, ["bash", "/opt/rf-heavy.sh", "npm", "run", "test"], { state: "S", utime: 2, stime: 1 });
    proc(fx, 924356, ["bash", "/opt/wait-for-trains.sh", "--no-lock", "--every", "30"],
      { ppid: 924355, state: "S", utime: 4, stime: 2, comm: "wait (trains)" });
    proc(fx, 924357, ["sleep", "30"], { ppid: 924356, state: "S", utime: 0, stime: 0 });
    const idle = run(fx, 'fn_err="$(master_gate_busy_reason 2>&1 >/dev/null)"; printf "[%s][%s]" "$(master_gate_busy_reason)" "$fn_err"');
    assert.equal(idle.status, 0, idle.stderr);
    assert.equal(idle.stdout, "[][]");

    // Subtree all in state S at snapshots (async IO gap), but child utime+stime advances within sampling window -> busy
    proc(fx, 924360, ["node", "vitest"], { ppid: 924355, state: "S", utime: 10, stime: 3, starttime: 77_777 });
    let utime = 10;
    const ticker = setInterval(() => {
      utime += 2;
      writeProcStat(fx, 924360, { ppid: 924355, state: "S", utime, stime: 3, starttime: 77_777, comm: "node" });
    }, 25);
    t.after(() => clearInterval(ticker));
    const busy = await runAsync(fx, "master_gate_busy_reason");
    clearInterval(ticker);
    assert.equal(busy.status, 0, busy.stderr);
    assert.match(busy.stdout, /pid924355: npm run test/);

    // Mixed: sleeping pid924355 is omitted while active pid5150 is reported
    rmSync(path.join(fx.proc, "924360"), { recursive: true });
    proc(fx, 5150, ["npm", "run", "test:gateway"], { state: "S", utime: 0, stime: 0 });
    proc(fx, 51501, ["node", "vitest"], { ppid: 5150, state: "R", utime: 20, stime: 4 });
    const mixed = run(fx, "master_gate_busy_reason");
    assert.equal(mixed.status, 0, mixed.stderr);
    assert.equal(mixed.stdout.trim(), "pid5150: npm run test:gateway");

    // Self-process exclusion ($$ / BASHPID) remains intact
    for (const entry of readdirSync(fx.proc)) rmSync(path.join(fx.proc, entry), { recursive: true, force: true });
    const selfCheck = run(fx, [
      'mkdir -p "$MASTER_GATE_PROC_ROOT/$$"',
      'printf "%s\\0" npm run test > "$MASTER_GATE_PROC_ROOT/$$/cmdline"',
      'printf "%s (bash) R 1 %s %s 0 -1 0 0 0 0 0 50 10 0 0 20 0 1 0 99999 0 0\\n" "$$" "$$" "$$" > "$MASTER_GATE_PROC_ROOT/$$/stat"',
      'master_gate_busy_reason',
    ].join("\n"));
    assert.equal(selfCheck.status, 0, selfCheck.stderr);
    assert.equal(selfCheck.stdout, "");
  });

  test("real /proc process trees: flock-blocked wrapper is idle; CPU-active descendant is busy", async (t) => {
    const fx = fixture(t);
    const killGroup = (pid: number | undefined) => {
      if (pid) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* gone */ }
      }
    };
    const readKernelStat = (pid: number): { state: string; ppid: number } | null => {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const rparen = raw.lastIndexOf(") ");
        if (rparen < 0) return null;
        const fields = raw.slice(rparen + 2).trim().split(/\s+/);
        return { state: fields[0] ?? "", ppid: Number(fields[1] ?? 0) };
      } catch {
        return null;
      }
    };
    const kernelChildrenOf = (ppid: number): number[] => {
      const out: number[] = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const st = readKernelStat(pid);
        if (st && st.ppid === ppid) out.push(pid);
      }
      return out;
    };

    // 1. Real wrapper with `npm run test:gateway` in argv, blocked waiting on flock -> not busy
    const rfLock = path.join(fx.dir, "rf-heavy.lock");
    writeFileSync(rfLock, "");
    const holder = spawn("flock", [rfLock, "sleep", "30"], { stdio: "ignore", detached: true });
    t.after(() => killGroup(holder.pid));
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", rfLock, "true"]).status === 0; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    const waiterReady = path.join(fx.dir, "waiter.ready");
    const waiter = spawn(
      "bash",
      ["-c", 'echo "$$" > "$2"; flock "$1" sleep 30; :', "rf-heavy.sh", rfLock, waiterReady, "npm", "run", "test:gateway"],
      { stdio: "ignore", detached: true },
    );
    t.after(() => killGroup(waiter.pid));
    let waiterTree: number[] = [];
    for (let i = 0; i < 60; i++) {
      if (existsSync(waiterReady) && waiter.pid) {
        const kids = kernelChildrenOf(waiter.pid);
        const tree = [waiter.pid, ...kids];
        if (kids.length > 0 && tree.every((p) => readKernelStat(p)?.state === "S")) {
          waiterTree = tree;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(waiterTree.length >= 2, "expected bash wrapper and blocked flock child in state S");
    for (const p of waiterTree) symlinkSync(`/proc/${p}`, path.join(fx.proc, String(p)));
    const waitingRes = run(fx, "master_gate_busy_reason");
    for (const p of waiterTree) unlinkSync(path.join(fx.proc, String(p)));
    killGroup(waiter.pid);
    killGroup(holder.pid);
    assert.equal(waitingRes.status, 0, waitingRes.stderr);
    assert.equal(waitingRes.stdout, "");

    // 2. Real wrapper with `npm run test:gateway` in argv, parent bash sleeping while child node burns CPU -> busy
    const runnerReady = path.join(fx.dir, "runner.ready");
    const cpuScript = [
      'const fs = require("node:fs");',
      'const out = process.argv[1];',
      'fs.writeFileSync(out + ".tmp", String(process.pid));',
      'fs.renameSync(out + ".tmp", out);',
      'const end = Date.now() + 10000;',
      'let acc = 0;',
      'while (Date.now() < end) { for (let i = 0; i < 100000; i++) acc = (acc + i) | 0; }',
      'if (acc === 42) process.stderr.write("");',
    ].join(" ");
    const runner = spawn(
      "bash",
      ["-c", 'node -e "$1" "$2"; :', "rf-heavy.sh", cpuScript, runnerReady, "npm", "run", "test:gateway"],
      { stdio: "ignore", detached: true },
    );
    t.after(() => killGroup(runner.pid));
    for (let i = 0; i < 60 && !existsSync(runnerReady); i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(runner.pid && existsSync(runnerReady), "expected active CPU child to signal readiness");
    const workerPid = Number(readFileSync(runnerReady, "utf8").trim());
    assert.ok(Number.isInteger(workerPid) && workerPid > 0);
    symlinkSync(`/proc/${runner.pid}`, path.join(fx.proc, String(runner.pid)));
    symlinkSync(`/proc/${workerPid}`, path.join(fx.proc, String(workerPid)));
    const activeRes = run(fx, "master_gate_busy_reason");
    unlinkSync(path.join(fx.proc, String(runner.pid)));
    unlinkSync(path.join(fx.proc, String(workerPid)));
    killGroup(runner.pid);
    assert.equal(activeRes.status, 0, activeRes.stderr);
    assert.match(activeRes.stdout, new RegExp(`pid${runner.pid}: npm run test:gateway`));
  });

  test("bash -c heredoc that writes web-checks.sh then blocks is idle", async (t) => {
    const fx = fixture(t);
    const killGroup = (pid: number | undefined) => {
      if (!pid) return;
      try {
        process.kill(-pid, "SIGKILL");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw err;
      }
    };
    const readKernelStat = (pid: number): { state: string; ppid: number } | null => {
      try {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
        const rparen = raw.lastIndexOf(") ");
        if (rparen < 0) return null;
        const fields = raw.slice(rparen + 2).trim().split(/\s+/);
        return { state: fields[0] ?? "", ppid: Number(fields[1] ?? 0) };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return null;
        throw err;
      }
    };
    const kernelChildrenOf = (ppid: number): number[] => {
      const out: number[] = [];
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        const pid = Number(name);
        const st = readKernelStat(pid);
        if (st && st.ppid === ppid) out.push(pid);
      }
      return out;
    };
    const unlinkProc = (link: string) => {
      try {
        unlinkSync(link);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") throw err;
      }
    };

    // Incident shape (tr-20261030T013148Z pid510429): bash -c carries
    // `cat > web-checks.sh <<'EOF' … npm run test … EOF` and then blocks.
    // The same argv is a candidate, so a running descendant must still count as busy.
    const heredocArgv = [
      "bash", "-c",
      "cat > web-checks.sh <<'EOF'\n#!/usr/bin/env bash\nnpm run test\nEOF\nflock web-checks.lock sleep 30\n",
    ];
    proc(fx, 510429, heredocArgv, { state: "S", utime: 2, stime: 1, comm: "bash" });
    proc(fx, 510430, ["sleep", "30"], { ppid: 510429, state: "S", utime: 0, stime: 0, comm: "sleep" });
    const idle = run(fx, "master_gate_busy_reason");
    assert.equal(idle.status, 0, idle.stderr);
    assert.equal(idle.stdout, "");

    rmSync(path.join(fx.proc, "510430"), { recursive: true });
    proc(fx, 510431, ["node", "vitest"], { ppid: 510429, state: "R", utime: 4, stime: 1 });
    const active = run(fx, "master_gate_busy_reason");
    assert.equal(active.status, 0, active.stderr);
    assert.match(active.stdout, /pid510429: npm run test/);

    for (const entry of readdirSync(fx.proc)) rmSync(path.join(fx.proc, entry), { recursive: true, force: true });

    const blockLock = path.join(fx.dir, "heredoc.lock");
    writeFileSync(blockLock, "");
    const holder = spawn("flock", [blockLock, "sleep", "40"], { stdio: "ignore", detached: true });
    t.after(() => killGroup(holder.pid));
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", blockLock, "true"]).status === 0; i++) {
      await new Promise((r) => setTimeout(r, 30));
    }
    const ready = path.join(fx.dir, "heredoc.ready");
    const body = [
      "cat > web-checks.sh <<'EOF'",
      "#!/usr/bin/env bash",
      "npm run test",
      "EOF",
      "echo $$ > \"$1\"",
      "flock \"$2\" sleep 30",
      // Trailing builtin keeps bash from exec'ing flock, so the heredoc stays in cmdline.
      ":",
    ].join("\n");
    const writer = spawn("bash", ["-c", body, "bash", ready, blockLock], {
      cwd: fx.dir, stdio: "ignore", detached: true,
    });
    t.after(() => killGroup(writer.pid));
    const linked: string[] = [];
    t.after(() => {
      for (const link of linked) unlinkProc(link);
    });
    let writerTree: number[] = [];
    for (let i = 0; i < 100; i++) {
      if (writer.pid && existsSync(ready)) {
        const walk = (pid: number): number[] => [pid, ...kernelChildrenOf(pid).flatMap(walk)];
        const tree = walk(writer.pid);
        if (tree.length >= 2 && tree.every((pid) => readKernelStat(pid)?.state === "S")) {
          writerTree = tree;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(writer.pid, "heredoc bash did not start");
    const cmdline = existsSync(`/proc/${writer.pid}/cmdline`)
      ? readFileSync(`/proc/${writer.pid}/cmdline`, "utf8").split("\0").join(" ")
      : "";
    assert.ok(
      writerTree.length >= 2,
      `expected blocked flock child in state S, tree=${writerTree.join(",")} cmdline=${JSON.stringify(cmdline)}`,
    );
    assert.match(cmdline, /cat > web-checks\.sh <<'EOF'/);
    assert.match(cmdline, /npm run test/);
    assert.match(readFileSync(path.join(fx.dir, "web-checks.sh"), "utf8"), /^npm run test$/m);
    for (const pid of writerTree) {
      const link = path.join(fx.proc, String(pid));
      symlinkSync(`/proc/${pid}`, link);
      linked.push(link);
    }
    const waitingRes = run(fx, "master_gate_busy_reason");
    for (const link of linked) unlinkProc(link);
    linked.length = 0;
    killGroup(writer.pid);
    killGroup(holder.pid);
    assert.equal(waitingRes.status, 0, waitingRes.stderr);
    assert.equal(
      waitingRes.stdout,
      "",
      `blocked heredoc writer was reported busy: [${waitingRes.stdout}]`,
    );
  });

  test("waits while busy, then goes; gives up after the limit with the reason", (t) => {
    const fx = fixture(t);
    setLoad(fx, "20.00");
    const late = spawn("bash", ["-c", `sleep 1.5; echo '2.00 1 1 1/1 1' > ${JSON.stringify(fx.loadavg)}`], { stdio: "ignore" });
    t.after(() => late.kill("SIGKILL"));
    const ok = run(fx, `LEASE_TRAIN_ID=${TID}; tsum_init; master_gate_wait_host_idle box-gates; echo rc=$?; tsum_finish 0`,
      { MASTER_GATE_IDLE_TIMEOUT_S: "20" });
    assert.match(ok.stdout, /rc=0/, ok.stderr);
    assert.match(ok.stderr, /主机繁忙,box-gates 暂不发车.*load1=20\.00>=8/);
    assert.ok(Number(summary(fx).notes["hostIdle.box-gates.waitSec"]) >= 1);
    setLoad(fx, "30.00");
    const timeout = run(fx, `LEASE_TRAIN_ID=${TID}; tsum_init; rc=0; master_gate_wait_host_idle box-gates || rc=$?; echo rc=$rc; tsum_finish 1`,
      { MASTER_GATE_IDLE_TIMEOUT_S: "1" });
    assert.match(timeout.stdout, /rc=1/);
    assert.match(timeout.stderr, /主机持续繁忙 \d+s\(上限 1s\),box-gates 不发车:load1=30\.00>=8/);
    assert.equal(summary(fx).notes["hostIdle.box-gates.timeout"], "load1=30.00_=8");
  });
});

describe("known-flake retry, once (OCV5-557 item 6)", () => {
  const sig = (fx: Fx, lines: string[]) => {
    const log = path.join(fx.dir, "attempt.log");
    writeFileSync(log, `${lines.join("\n")}\n`);
    const r = run(fx, `master_gate_flaky_signature ${JSON.stringify(log)} && echo " KNOWN" || echo UNKNOWN`);
    return r.stdout.trim();
  };

  test("whitelisted [gate-failure] lines are known flakes", (t) => {
    const fx = fixture(t);
    for (const line of ["Query read timeout", 'relation "agent_containers" does not exist', "BOX_SUCCESS_GATE_DEADLINE",
      "[box-incident-proofs] LARGE_LINE_CLOSE_still-running", "[box-incident-proofs] LARGE_LINE_REFUSED_HOST_LEFT_RUNNING",
      "[box-incident-proofs] CONFIG_PARKED_TURN_NOT_STOPPED_/internal/box/idle-proof,/internal/box/idle-proof",
      "[box-incident-proofs] CONFIG_PARKED_TURN_NOT_STOPPED_", "SEARCH_CLI_PROCESS_FAILED exit=null"]) {
      assert.equal(sig(fx, ['{"level":"info"}', `[gate-failure] ${line}`]), `${line} KNOWN`, line);
    }
    // success recovery: the worker's reason plus the supervisor's wrapper line
    assert.equal(sig(fx, ["[gate-failure] Query read timeout", "[gate-failure] BOX_SUCCESS_GATE_WORKER code=1 signal=none"]),
      "Query read timeout KNOWN");
  });

  test("anything else is a real failure: other reasons, a second stop, a failed cleanup, no marker", (t) => {
    const fx = fixture(t);
    for (const lines of [
      ["[gate-failure] [box-incident-proofs] CONFIG_PARKED_TURN_NOT_STOPPED_/internal/box/idle-proof,/internal/box/stop,/internal/box/stop"],
      ["[gate-failure] [box-incident-proofs] CONFIG_ROW_handoff"],
      ["[gate-failure] [box-incident-proofs] deadline exceeded"],
      ["[gate-failure] BOX_SUCCESS_GATE_WORKER code=1 signal=none"],
      ["[gate-failure] BOX_SUCCESS_GATE_KILL_GROUP 123"],
      ["[gate-failure] [box-incident-proofs] REJECT_ROW_handoff", "[gate-failure] cleanup Query read timeout"],
      ["[gate-failure] Query read timeout", "[gate-failure] cleanup Error: rm failed"],
      ["Query read timeout"],
      ["[gate-failure] Query read timeout extra"],
      [],
    ]) assert.equal(sig(fx, lines), "UNKNOWN", lines.join(" | "));
  });

  const gate = (fails: string[]) => `fake_gate() {
  local n; n=$(( $(cat "$TMPDIR/n" 2>/dev/null || echo 0) + 1 )); echo "$n" >"$TMPDIR/n"
  echo "fake gate run $n scale=$MASTER_GATE_LOAD_SCALE"
  case "$n" in
${fails.map((line, i) => `    ${i + 1}) echo '{"level":"info"}'; echo ${JSON.stringify(`[gate-failure] ${line}`)} >&2; return 1 ;;`).join("\n")}
  esac
  echo PASS
}`;

  test("a known flake reruns once after the host is idle; both logs kept; scale and retry in the summary", (t) => {
    const fx = fixture(t);
    setLoad(fx, "12.00");
    const r = run(fx, `${gate(["[box-incident-proofs] LARGE_LINE_CLOSE_still-running"])}
LEASE_TRAIN_ID=${TID}; tsum_init; MASTER_GATE_TMPDIR="$TMPDIR"
(sleep 1; echo '3.00 1 1 1/1 1' > "$MASTER_GATE_LOADAVG") &
rc=0; master_gate_retryable box-incident-proofs fake_gate || rc=$?; echo rc=$rc; tsum_finish 0`, { MASTER_GATE_IDLE_TIMEOUT_S: "20" });
    assert.match(r.stdout, /rc=0/, r.stderr);
    const a1 = path.join(fx.trains, `${TID}.box-incident-proofs.attempt1.log`);
    const a2 = path.join(fx.trains, `${TID}.box-incident-proofs.attempt2.log`);
    assert.match(readFileSync(a1, "utf8"), /run 1 scale=1\.50[\s\S]*LARGE_LINE_CLOSE_still-running/);
    assert.match(readFileSync(a2, "utf8"), /run 2 scale=1\.00\nPASS/);
    const notes = summary(fx).notes;
    assert.equal(notes["loadScale.box-incident-proofs"], "1.50");
    assert.equal(notes["loadScale.box-incident-proofs.retry"], "1.00");
    assert.equal(notes["retry.box-incident-proofs"], "_box-incident-proofs__LARGE_LINE_CLOSE_still-running");
    assert.equal(notes["retry.box-incident-proofs.attempt1Log"], a1);
    assert.equal(notes["retry.box-incident-proofs.result"], "passed");
    assert.match(r.stderr, /已知假失败「\[box-incident-proofs\] LARGE_LINE_CLOSE_still-running」→ 等主机空闲后重跑一次/);
    assert.match(r.stderr, /主机繁忙,retry\.box-incident-proofs 暂不发车/);
  });

  test("the same flake twice is a hard failure; never a third run", (t) => {
    const fx = fixture(t);
    const r = run(fx, `${gate(["Query read timeout", "Query read timeout"])}
LEASE_TRAIN_ID=${TID}; tsum_init; MASTER_GATE_TMPDIR="$TMPDIR"
rc=0; master_gate_retryable box-success-recovery fake_gate || rc=$?; echo rc=$rc runs=$(cat "$TMPDIR/n"); tsum_finish 1`);
    assert.match(r.stdout, /rc=1 runs=2/, r.stderr);
    assert.equal(summary(fx).notes["retry.box-success-recovery.result"], "failed");
    assert.ok(existsSync(path.join(fx.trains, `${TID}.box-success-recovery.attempt2.log`)));
  });

  test("an unknown failure is not rerun; a pass is a pass", (t) => {
    const fx = fixture(t);
    const r = run(fx, `${gate(["[box-incident-proofs] CONFIG_ROW_handoff"])}
LEASE_TRAIN_ID=${TID}; tsum_init; MASTER_GATE_TMPDIR="$TMPDIR"
rc=0; master_gate_retryable box-incident-proofs fake_gate || rc=$?; echo rc=$rc runs=$(cat "$TMPDIR/n")
fake_gate() { echo PASS; }; rc=0; master_gate_retryable ccb-mcp fake_gate || rc=$?; echo pass-rc=$rc; tsum_finish 1`);
    assert.match(r.stdout, /^rc=1 runs=1\npass-rc=0$/m, r.stderr);
    assert.match(r.stderr, /不在已知假失败白名单里 → 不重跑/);
    const notes = summary(fx).notes;
    assert.equal(notes["retry.box-incident-proofs"], undefined);
    assert.equal(notes["retry.ccb-mcp"], undefined);
    assert.equal(notes["loadScale.ccb-mcp"], "1.00");
  });

  test("each failed attempt's first error is in the summary, first run and rerun apart (OCV5-583)", (t) => {
    const fx = fixture(t);
    const r = run(fx, `${gate(["[box-incident-proofs] CONFIG_ROW_handoff"])}
LEASE_TRAIN_ID=${TID}; tsum_init; MASTER_GATE_TMPDIR="$TMPDIR"
rc=0; master_gate_retryable box-incident-proofs fake_gate || rc=$?; echo rc=$rc
rm -f "$TMPDIR/n"; ${gate(["Query read timeout", "Query read timeout"])}
rc=0; master_gate_retryable box-success-recovery fake_gate || rc=$?; echo rc=$rc
fake_gate() { echo no marker; return 3; }; rc=0; master_gate_retryable ccb-mcp fake_gate || rc=$?; echo rc=$rc
rm -f "$TMPDIR/n"; ${gate(["Query read timeout"])}
rc=0; master_gate_retryable cron fake_gate || rc=$?; echo rc=$rc; tsum_finish 1`, { MASTER_GATE_IDLE_TIMEOUT_S: "5" });
    assert.match(r.stdout, /^rc=1\nrc=1\nrc=1\nrc=0$/m, r.stderr); // a failure that is not rerun returns 1, not the gate's rc
    const notes = summary(fx).notes;
    assert.match(notes["gateFailure.box-incident-proofs.attempt1"]!, /box-incident-proofs.*CONFIG_ROW_handoff$/);
    assert.equal(notes["gateFailure.box-incident-proofs.attempt2"], undefined, "an unknown failure is not rerun");
    assert.match(notes["gateFailure.box-success-recovery.attempt1"]!, /Query.read.timeout$/);
    assert.match(notes["gateFailure.box-success-recovery.attempt2"]!, /Query.read.timeout$/);
    assert.match(notes["gateFailure.ccb-mcp.attempt1"]!, /^rc=3.*no.*gate-failure.*line/);
    // a flake that passes on the rerun keeps its first error; the pass adds nothing
    assert.match(notes["gateFailure.cron.attempt1"]!, /Query.read.timeout$/);
    assert.equal(notes["gateFailure.cron.attempt2"], undefined);
  });

  test("admission: the host-idle wait runs before the candidate is built (OCV5-583)", () => {
    const body = fn("build_master_release");
    const dry = body.indexOf('if [[ "${DRY:-0}" == 1 ]]; then');
    const admission = body.indexOf("master_gate_wait_host_idle admission");
    const staging = body.indexOf('mkdir -p -- "$staging"');
    const boxGates = body.indexOf("master_gate_wait_host_idle box-gates");
    assert.ok(dry > 0 && admission > dry, "after the dry-run return: a dry run never waits");
    assert.ok(staging > admission, "before the staging tree, the archive and the dependencies");
    assert.ok(boxGates > staging, "the Box-gate wait stays: the host can turn busy during the build");
    assert.match(body.slice(admission, admission + 200), /\|\| die /, "still busy after the limit: give up, nothing built");
    // OCV5-648 (P2): the train's own runtime build starts only after admission, so admission never waits on it.
    const bg = body.indexOf('start_runtime_release_bg "$full_sha"');
    assert.ok(bg > admission && bg < staging, "runtime bg build starts between admission and the candidate");
  });

  test("without a train id the attempt logs still land on disk", (t) => {
    const fx = fixture(t);
    const r = run(fx, `${gate(["Query read timeout"])}
MASTER_GATE_TMPDIR="$TMPDIR"; MASTER_GATE_ATTEMPT_DIR="$TMPDIR/attempts"
rc=0; master_gate_retryable box-success-recovery fake_gate || rc=$?; echo rc=$rc`, { MASTER_GATE_IDLE_TIMEOUT_S: "5" });
    assert.match(r.stdout, /rc=0/, r.stderr);
    const logs = readdirSync(path.join(fx.dir, "attempts")).sort();
    assert.equal(logs.length, 2);
    assert.match(logs[0]!, /^manual-\d+-\d{8}T\d{6}Z\.box-success-recovery\.attempt1\.log$/);
    assert.equal(logs[1], logs[0]!.replace("attempt1", "attempt2"));
  });
});

describe("one throwaway test database per train (OCV5-557 item 1)", () => {
  const helper = path.join(root, "scripts/lib/gateTestDb.mjs");
  const db = (args: string[], env: Record<string, string>) => spawnSync(process.execPath, [helper, ...args], {
    cwd: root, encoding: "utf8", timeout: 60_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env } });

  test("refuses a base DSN that is not a loopback *_test database, and names it never created", (t) => {
    const fx = fixture(t);
    const reg = { OC_V5_GATE_DB_REGISTRY: path.join(fx.dir, "reg") };
    for (const dsn of ["", "postgres://u:p@10.0.0.1:5432/x_test", "postgres://u:p@127.0.0.1:5432/openclaude",
      "postgres://u:p@127.0.0.1:5432/x_test?sslmode=disable", "mysql://u:p@127.0.0.1/x_test"]) {
      const r = db(["create", "123"], { ...reg, OC_V5_GATE_BASE_DSN: dsn });
      assert.equal(r.status, 2, dsn);
      assert.doesNotMatch(r.stderr + r.stdout, /u:p@/, "the DSN is never printed");
    }
    assert.equal(db(["create", "abc"], { ...reg, OC_V5_GATE_BASE_DSN: "postgres://u:p@127.0.0.1:1/x_test" }).status, 2);
  });

  // CI's v5-ops job has a throwaway Postgres service; locally this runs when TEST_DATABASE_URL is set.
  const base = process.env.TEST_DATABASE_URL;
  test("create → a new empty *_test database; only its registered owner can drop it; the base is never touched",
    { skip: !base && "TEST_DATABASE_URL not set" }, (t) => {
      const fx = fixture(t);
      const env = { OC_V5_GATE_BASE_DSN: base!, OC_V5_GATE_DB_REGISTRY: path.join(fx.dir, "reg") };
      const baseName = new URL(base!).pathname.slice(1);
      const created = db(["create", String(process.pid)], env);
      assert.equal(created.status, 0, created.stderr);
      const name = new URL(created.stdout.trim()).pathname.slice(1);
      assert.match(name, new RegExp(`^ocv5_gate_${process.pid}_[0-9a-f]{12}_test$`));
      t.after(() => { db(["drop", name], env); });
      // a name this registry never created, and the base database itself, are refused
      for (const other of [baseName, `ocv5_gate_${process.pid}_000000000000_test`, "openclaude_test"]) {
        const r = db(["drop", other], env);
        assert.equal(r.status, 2, other);
        assert.match(r.stderr, /refusing to drop/);
      }
      // sweep leaves a database whose owner pid is alive
      assert.equal(db(["sweep"], env).status, 0);
      assert.ok(existsSync(path.join(env.OC_V5_GATE_DB_REGISTRY, `${name}.json`)));
      // a record that does not match the database comment is not enough to drop it
      const record = path.join(env.OC_V5_GATE_DB_REGISTRY, `${name}.json`);
      const saved = readFileSync(record, "utf8");
      writeFileSync(record, saved.replace(/"token":"[0-9a-f]{32}"/, `"token":"${"0".repeat(32)}"`));
      assert.equal(db(["drop", name], env).status, 2);
      writeFileSync(record, saved);
      assert.equal(db(["drop", name], env).status, 0);
      assert.equal(existsSync(record), false);
      // a train killed outright: its owner pid is gone, so the next sweep drops what it left
      const dead = spawnSync("true").pid;
      assert.ok(dead && !existsSync(`/proc/${dead}`));
      const left = db(["create", String(dead)], env);
      assert.equal(left.status, 0, left.stderr);
      const leftover = new URL(left.stdout.trim()).pathname.slice(1);
      const swept = db(["sweep"], env);
      assert.equal(swept.status, 0, swept.stderr);
      assert.match(swept.stderr, new RegExp(`dropped leftover ${leftover}`));
      assert.equal(existsSync(path.join(env.OC_V5_GATE_DB_REGISTRY, `${leftover}.json`)), false);
    });
});

// OCV5-609: keep the write-refusal proof fail-closed for the bridge's two failure forms.
test("Box refusal proof rejects successful, invalid, and timed-out bridge outcomes", () => {
  assert.equal(boxBridgeFailed({ kind: "rejected" }), true);
  for (const code of [1, 143, 255]) assert.equal(boxBridgeFailed({ kind: "resolved", code }), true);
  for (const code of [0, -0, -1, 256, 512, 2 ** 32, 2 ** 53, undefined, null, "1", Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
    assert.equal(boxBridgeFailed({ kind: "resolved", code }), false, String(code));
  }
  assert.equal(boxBridgeFailed({ kind: "timeout" }), false);
});

test("Box refusal proof distinguishes actual bridge settlement from its timeout", async () => {
  const pending = new Promise<never>(() => {});
  for (const [bridge, failed] of [[Promise.resolve(0), false], [Promise.resolve(1), true],
    [Promise.reject(new Error("refused write")), true]] as const) {
    assert.equal(boxBridgeFailed(await boxBridgeOutcome(bridge, pending)), failed);
  }
  assert.equal(boxBridgeFailed(await boxBridgeOutcome(pending, Promise.resolve())), false);
});
