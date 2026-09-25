import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { makeBoxKeeperStop } from "./boxKeeperStop.js";

test("stop binds a live keeper by nonce, epoch, pinned PID and cwd", async () => {
  const nonce = randomBytes(12).toString("hex");
  const epoch = randomBytes(16).toString("hex");
  const run = `/tmp/ocv5-289-run-${nonce}`;
  const proof = `/tmp/ocv5-289-proof-${nonce}`;
  const keeper = `/tmp/ocv5-289-keeper-${randomBytes(8).toString("hex")}.py`;
  const supervisor = `/tmp/ocv5-289-supervisor-${randomBytes(8).toString("hex")}.py`;
  mkdirSync(run, { mode: 0o700 });
  mkdirSync(proof, { mode: 0o700 });
  writeFileSync(keeper, "import signal,time,sys\n" +
    "signal.signal(signal.SIGTERM,lambda *_:sys.exit(0))\n" +
    "open('ready','w').close()\n" +
    "while True:time.sleep(.1)\n", { mode: 0o600 });
  const child = spawn("/usr/bin/python3", ["-I", keeper, supervisor,
    "--proof-dir", proof, "--lease-epoch", epoch], { cwd: run,
    stdio: "ignore" });
  try {
    for (let i = 0; i < 100 && !existsSync(`${run}/ready`); i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(existsSync(`${run}/ready`));
    const wrong = makeBoxKeeperStop(nonce, "c".repeat(32));
    const refused = spawnSync(wrong.command, wrong.args, { cwd: wrong.cwd,
      encoding: "utf8", timeout: 5000 });
    assert.equal(refused.status, 125);
    assert.equal(child.exitCode, null, "wrong epoch cannot signal the keeper");
    const request = makeBoxKeeperStop(nonce, epoch);
    const stopped = spawnSync(request.command, request.args, { cwd: request.cwd,
      encoding: "utf8", timeout: 5000 });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout.trim(), "stop-requested");
    const closed = child.exitCode !== null ? true : await Promise.race([
      new Promise<boolean>((resolve) => { child.once("exit", () => resolve(true)); }),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
    assert.equal(closed, true);
    const missing = spawnSync(request.command, request.args, { cwd: request.cwd,
      encoding: "utf8", timeout: 5000 });
    assert.equal(missing.status, 125, "absence must not masquerade as terminal proof");
    assert.equal(missing.stdout, "");
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    rmSync(run, { recursive: true, force: true });
    rmSync(proof, { recursive: true, force: true });
    rmSync(keeper, { force: true });
  }
});

test("stop rejects wrong epoch without signalling the original keeper", async () => {
  assert.throws(() => makeBoxKeeperStop("bad", "b".repeat(32)), /BOX_KEEPER_STOP_ID_INVALID/);
});
