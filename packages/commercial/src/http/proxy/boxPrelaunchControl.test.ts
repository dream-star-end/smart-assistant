import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync,
  symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import { makeBoxStageFiles } from "./boxStageFiles.js";
import { BoxPrelaunchControlError, guardBoxPrivateStage,
  makeBoxPrelaunchBootstrap, makeBoxPrelaunchCleanup, makeBoxPrelaunchCloseFence,
  makeBoxPrelaunchInit, parseBoxPrelaunchBootstrap } from "./boxPrelaunchControl.js";

function execute(request: BoxCcExecRequest) {
  assert.ok(request.args.every((arg) => Buffer.byteLength(arg) < 70_000));
  assert.ok(request.args.reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0) < 300_000);
  return spawnSync(request.command, request.args, { cwd: request.cwd,
    env: request.environment, encoding: "utf8", timeout: 7000, maxBuffer: 128 * 1024 });
}

test("private stage requires the permanent lock identity and CLOSED rejects late Exec", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const file = `${cwd}/stdin.jsonl`, raw = Buffer.alloc(256 * 1024, 0x71);
  const plan = makeBoxStageFiles({ cwd, project: "", files: [{ path: file, raw,
    hash: createHash("sha256").update(raw).digest("hex") }] });
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    assert.equal(statSync(controlDir).mode & 0o777, 0o700);
    assert.equal(statSync(`${controlDir}/lock`).mode & 0o777, 0o600);
    for (const [index, step] of plan.requests.entries()) {
      const staged = execute(index === 0 ? makeBoxPrelaunchInit(receipt, "")
        : guardBoxPrivateStage(step, receipt));
      assert.equal(staged.status, 0, staged.stderr);
    }
    assert.deepEqual(readFileSync(file), raw);
    const duplicate = execute(makeBoxPrelaunchBootstrap(identity));
    assert.notEqual(duplicate.status, 0, "bootstrap must not reuse an existing control");
    const closed = execute(makeBoxPrelaunchCloseFence(receipt));
    assert.equal(closed.status, 0, closed.stderr);
    assert.equal(closed.stdout.trim(), `closed:${receipt.identityHash}`);
    assert.equal(execute(makeBoxPrelaunchCloseFence(receipt)).status, 0,
      "same CLOSED receipt may be re-observed without reopening writes");
    assert.notEqual(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
    assert.notEqual(execute(guardBoxPrivateStage(plan.requests.at(-1)!, receipt)).status, 0);
    assert.deepEqual(readFileSync(file), raw);
    assert.throws(() => parseBoxPrelaunchBootstrap(boot.stdout, { ...identity,
      accountId: "21" }), (e: unknown) => e instanceof BoxPrelaunchControlError);
  } finally {
    // Test-only cleanup; production controls and CLOSED tombstones are retained.
    if (existsSync(cwd)) {
      const cleaned = execute(plan.cleanup);
      assert.equal(cleaned.status, 0, cleaned.stderr);
    }
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("wrong receipt hash fails before creating a private run directory", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    const stage = makeBoxStageFiles({ cwd, project: "", files: [] }).requests[0]!;
    assert.throws(() => guardBoxPrivateStage({ ...stage,
      args: [...stage.args.slice(0, 3), `/tmp/ocv5-289-run-${"f".repeat(24)}`, ...stage.args.slice(4)] },
      receipt), (e: unknown) => e instanceof BoxPrelaunchControlError);
    assert.notEqual(execute(makeBoxPrelaunchInit(
      { ...receipt, identityHash: "0".repeat(64) }, "")).status, 0);
    assert.equal(existsSync(cwd), false);
  } finally { rmSync(controlDir, { recursive: true, force: true }); }
});

test("replaced control path cannot authorize staging into a decoy", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const moved = `${controlDir}.moved`, decoy = `${controlDir}.decoy`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    renameSync(controlDir, moved);
    mkdirSync(decoy, { mode: 0o700 });
    symlinkSync(decoy, controlDir);
    assert.notEqual(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
    assert.equal(existsSync(cwd), false);
    rmSync(controlDir);
    renameSync(moved, controlDir);
    assert.equal(execute(makeBoxPrelaunchCloseFence(receipt)).status, 0);
    assert.notEqual(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
  } finally {
    rmSync(controlDir, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
    rmSync(decoy, { recursive: true, force: true });
  }
});

test("cross-process lock holder prevents close from passing an active writer", async () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  let holder: ReturnType<typeof spawn> | undefined;
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    holder = spawn("/usr/bin/python3", ["-u", "-c",
      "import fcntl,os,time,sys; f=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW); fcntl.flock(f,fcntl.LOCK_EX); print('locked',flush=True); time.sleep(10)",
      `${controlDir}/lock`], { stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lock holder did not start")), 2000);
      holder!.stdout!.once("data", (data: Buffer) => {
        clearTimeout(timer);
        data.toString() === "locked\n" ? resolve() : reject(new Error("bad lock handshake"));
      });
      holder!.once("exit", (code) => { clearTimeout(timer);
        reject(new Error(`lock holder exited ${code}`)); });
    });
    const began = Date.now();
    const attempt = execute(makeBoxPrelaunchCloseFence(receipt));
    assert.notEqual(attempt.status, 0, "close must not pass a held writer lock");
    assert.ok(Date.now() - began >= 4500, "close must have contended on flock");
    assert.equal(existsSync(`${controlDir}/CLOSED`), false);
    holder.kill("SIGTERM");
    const after = execute(makeBoxPrelaunchCloseFence(receipt));
    assert.equal(after.status, 0, after.stderr);
  } finally {
    holder?.kill("SIGKILL");
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("prelaunch cleanup closes writes, removes partial private files, and is idempotent", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const raw = Buffer.alloc(100 * 1024, 0x68);
  const plan = makeBoxStageFiles({ cwd, project: "", files: [{ path: `${cwd}/stdin.jsonl`,
    raw, hash: createHash("sha256").update(raw).digest("hex") }] });
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    assert.equal(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
    assert.equal(execute(guardBoxPrivateStage(plan.requests[1]!, receipt)).status, 0);
    assert.equal(existsSync(`${cwd}/stdin.jsonl.part`), true);
    const cleaned = execute(makeBoxPrelaunchCleanup(receipt));
    assert.equal(cleaned.status, 0, cleaned.stderr);
    assert.equal(cleaned.stdout.trim(), `cleaned:${receipt.identityHash}`);
    assert.equal(existsSync(cwd), false);
    assert.equal(execute(makeBoxPrelaunchCleanup(receipt)).status, 0);
    assert.notEqual(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("unknown private file cannot be silently erased or receipt as CLEANED", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    assert.equal(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
    writeFileSync(`${cwd}/unexpected`, "synthetic", { mode: 0o600 });
    assert.notEqual(execute(makeBoxPrelaunchCleanup(receipt)).status, 0);
    assert.equal(existsSync(`${controlDir}/CLOSED`), true);
    assert.equal(existsSync(`${controlDir}/CLEANED`), false);
    assert.equal(existsSync(`${cwd}/unexpected`), true);
    assert.notEqual(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("forged CLEANED marker cannot hide staged private data", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const raw = Buffer.from("synthetic-private-data");
  const plan = makeBoxStageFiles({ cwd, project: "", files: [{ path: `${cwd}/stdin.jsonl`,
    raw, hash: createHash("sha256").update(raw).digest("hex") }] });
  try {
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    assert.equal(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
    for (const step of plan.requests.slice(1)) {
      assert.equal(execute(guardBoxPrivateStage(step, receipt)).status, 0);
    }
    writeFileSync(`${controlDir}/CLEANED`, "", { mode: 0o600, flag: "wx" });
    const clean = execute(makeBoxPrelaunchCleanup(receipt));
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(existsSync(cwd), false, "must recheck postcondition despite marker");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("failed INIT cannot authorize deletion of a preexisting run directory", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  try {
    mkdirSync(cwd, { mode: 0o700 });
    writeFileSync(`${cwd}/stdin.jsonl`, "preexisting", { mode: 0o600 });
    const boot = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(boot.status, 0, boot.stderr);
    const receipt = parseBoxPrelaunchBootstrap(boot.stdout, identity);
    assert.notEqual(execute(makeBoxPrelaunchInit(receipt, "")).status, 0);
    assert.notEqual(execute(makeBoxPrelaunchCleanup(receipt)).status, 0);
    assert.equal(readFileSync(`${cwd}/stdin.jsonl`, "utf8"), "preexisting");
    assert.equal(existsSync(`${controlDir}/CLEANED`), false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(controlDir, { recursive: true, force: true });
  }
});
