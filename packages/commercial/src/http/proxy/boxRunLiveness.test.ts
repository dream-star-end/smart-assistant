import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { makeBoxRunLiveness, parseBoxRunLiveness } from "./boxRunLiveness.js";

const BOOT = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

function probe(nonce: string, cliCwd?: string) {
  const request = makeBoxRunLiveness(nonce, cliCwd);
  const out = spawnSync(request.command, request.args, { cwd: request.cwd,
    env: request.environment, encoding: "utf8", timeout: 5000 });
  return { status: out.status, parsed: parseBoxRunLiveness(out.stdout), stdout: out.stdout };
}

async function exited(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => { child.once("exit", () => resolve()); });
}

function runDirs() {
  const nonce = randomBytes(12).toString("hex");
  const run = `/tmp/ocv5-289-run-${nonce}`;
  const proof = `/tmp/ocv5-289-proof-${nonce}`;
  mkdirSync(run, { mode: 0o700 });
  mkdirSync(proof, { mode: 0o700 });
  return { nonce, run, proof, remove: () => {
    rmSync(run, { recursive: true, force: true });
    rmSync(proof, { recursive: true, force: true });
  } };
}

test("OCV5-488 a keeper naming the run is alive; once it is gone the run is absent", async () => {
  const { nonce, proof, remove } = runDirs();
  // the keeper's own command line carries --proof-dir /tmp/ocv5-289-proof-<nonce>
  const keeper = spawn("/usr/bin/python3", ["-I", "-c", "import time\nwhile True:time.sleep(.1)",
    "--proof-dir", proof], { cwd: "/tmp", stdio: "ignore" });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(probe(nonce).parsed, { state: "alive", boot: BOOT });
    keeper.kill("SIGKILL");
    await exited(keeper);
    // the probe's own argv names the nonce too; it never counts itself
    assert.deepEqual(probe(nonce).parsed, { state: "absent", boot: BOOT });
  } finally {
    if (keeper.exitCode === null) keeper.kill("SIGKILL");
    remove();
  }
});

test("OCV5-488 a CLI working in the run directory is alive, also in a native resume cwd", async () => {
  const { nonce, run, remove } = runDirs();
  const other = runDirs();
  const cli = spawn("sleep", ["30"], { cwd: run, stdio: "ignore" });
  const native = spawn("sleep", ["30"], { cwd: other.run, stdio: "ignore" });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.equal(probe(nonce).parsed?.state, "alive");
    cli.kill("SIGKILL");
    await exited(cli);
    assert.equal(probe(nonce).parsed?.state, "absent");
    // a native resume runs its CLI in the transcript run's directory
    assert.equal(probe(nonce, other.run).parsed?.state, "alive");
  } finally {
    for (const child of [cli, native]) if (child.exitCode === null) child.kill("SIGKILL");
    remove();
    other.remove();
  }
});

test("OCV5-488 a child left in the CLI's session keeps the run alive in any cwd", async () => {
  const { nonce, proof, remove } = runDirs();
  // the CLI leads its own session (the supervisor starts it with start_new_session) and leaves a
  // child behind in /tmp before it exits; the child's command line does not name the run
  const leader = spawnSync("setsid", ["/usr/bin/python3", "-c", "import os,subprocess\n"
    + "c=subprocess.Popen(['sleep','30'],cwd='/tmp',stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,"
    + "stderr=subprocess.DEVNULL)\nprint(os.getpid(),c.pid,flush=True)"], { encoding: "utf8", timeout: 5000 });
  const [cliPid, childPid] = leader.stdout.trim().split(" ").map(Number);
  try {
    assert.ok(Number.isSafeInteger(cliPid) && Number.isSafeInteger(childPid), leader.stdout);
    writeFileSync(`${proof}/stop.ready`, `${JSON.stringify({ runNonce: nonce, leaseEpoch: "b".repeat(32),
      keeperPid: cliPid, cliPid, revision: 1 })}\n`, { mode: 0o600 });
    assert.equal(probe(nonce).parsed?.state, "alive");
    process.kill(childPid!, "SIGKILL");
    for (let i = 0; i < 100 && probe(nonce).parsed?.state !== "absent"; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(probe(nonce).parsed?.state, "absent");
  } finally {
    try { if (childPid) process.kill(childPid, "SIGKILL"); } catch { /* already gone */ }
    remove();
  }
});

test("a bad stop.ready handshake does not block the process scan", async () => {
  const NL = String.fromCharCode(10);
  const { nonce, proof, remove } = runDirs();
  const keeper = spawn("/usr/bin/python3", ["-I", "-c", "import time" + NL + "while True:time.sleep(.1)",
    "--proof-dir", proof], { cwd: "/tmp", stdio: "ignore" });
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const bodies = [
      "not json" + NL,
      JSON.stringify({ runNonce: "c".repeat(24), cliPid: 4242 }) + NL,
      JSON.stringify({ runNonce: nonce, cliPid: "4242" }) + NL,
    ];
    for (const body of bodies) {
      writeFileSync(`${proof}/stop.ready`, body, { mode: 0o600 });
      const out = probe(nonce);
      assert.equal(out.status, 0, body);
      assert.deepEqual(out.parsed, { state: "alive", boot: BOOT }, body);
    }
    keeper.kill("SIGKILL");
    await exited(keeper);
    for (const body of ["not json" + NL, JSON.stringify({ runNonce: nonce, cliPid: "4242" }) + NL]) {
      writeFileSync(`${proof}/stop.ready`, body, { mode: 0o600 });
      assert.deepEqual(probe(nonce).parsed, { state: "absent", boot: BOOT }, body);
    }
  } finally {
    if (keeper.exitCode === null) keeper.kill("SIGKILL");
    remove();
  }
});

test("a stat-only terminal.json plus a bad stop.ready does not skip the process scan", async () => {
  const NL = String.fromCharCode(10);
  const { nonce, proof, remove } = runDirs();
  const keeper = spawn("/usr/bin/python3", ["-I", "-c", "import time" + NL + "while True:time.sleep(.1)",
    "--proof-dir", proof], { cwd: "/tmp", stdio: "ignore" });
  try {
    writeFileSync(`${proof}/terminal.json`, "{}" + NL, { mode: 0o644 });
    writeFileSync(`${proof}/stop.ready`, "not json" + NL, { mode: 0o600 });
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(probe(nonce).parsed, { state: "alive", boot: BOOT });
    keeper.kill("SIGKILL");
    await exited(keeper);
    assert.deepEqual(probe(nonce).parsed, { state: "absent", boot: BOOT });
  } finally {
    if (keeper.exitCode === null) keeper.kill("SIGKILL");
    remove();
  }
  // 10-17: the run and proof directories themselves were gone
  assert.deepEqual(probe(nonce).parsed, { state: "absent", boot: BOOT });
});

test("OCV5-488 identities are validated and only the exact line is evidence", () => {
  assert.throws(() => makeBoxRunLiveness("x".repeat(24)), /BOX_RUN_LIVENESS_ID_INVALID/);
  assert.throws(() => makeBoxRunLiveness("a".repeat(24), "/tmp/elsewhere"), /BOX_RUN_LIVENESS_ID_INVALID/);
  const nonce = "a".repeat(24);
  assert.deepEqual(makeBoxRunLiveness(nonce, `/tmp/ocv5-289-run-${nonce}`).args.length, 4);
  assert.equal(parseBoxRunLiveness(`absent ${BOOT}\nextra\n`), null);
  assert.equal(parseBoxRunLiveness(`gone ${BOOT}\n`), null);
  assert.equal(parseBoxRunLiveness("absent not-a-boot-id\n"), null);
  assert.deepEqual(parseBoxRunLiveness(`absent ${BOOT}\n`), { state: "absent", boot: BOOT });
});
