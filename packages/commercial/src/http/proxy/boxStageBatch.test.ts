import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import type { BoxCcExecRequest } from "@openclaude/gateway";
import { makeBoxStageFiles } from "./boxStageFiles.js";
import { makeBoxStageBatch } from "./boxStageBatch.js";
import { guardBoxPrivateStage, makeBoxPrelaunchBootstrap,
  makeBoxPrelaunchInit, parseBoxPrelaunchBootstrap } from "./boxPrelaunchControl.js";

const sha = (raw: Buffer) => createHash("sha256").update(raw).digest("hex");
function execute(request: BoxCcExecRequest) {
  assert.ok(request.args.every((arg) => Buffer.byteLength(arg) < 70_000));
  return spawnSync(request.command, request.args, { cwd: request.cwd,
    env: request.environment, encoding: "utf8", timeout: 20_000 });
}

test("small private files stage in one Exec with the existing file hash checks", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  const stdin = Buffer.from('{"type":"user","message":"synthetic"}\n');
  const system = Buffer.from("synthetic system");
  const plan = makeBoxStageFiles({ cwd, project: "", files: [
    { path: `${cwd}/stdin.jsonl`, raw: stdin, hash: sha(stdin) },
    { path: `${cwd}/system.txt`, raw: system, hash: sha(system) },
  ] });
  try {
    const batch = makeBoxStageBatch(plan.requests);
    assert.ok(batch, "small files should fit the single-argv budget");
    const result = execute(batch.request);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), batch.expected);
    assert.deepEqual(readFileSync(`${cwd}/stdin.jsonl`), stdin);
    assert.deepEqual(readFileSync(`${cwd}/system.txt`), system);
  } finally {
    assert.equal(execute(plan.cleanup).status, 0);
  }
});

test("wrong final hash fails the batch without a success manifest", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  const raw = Buffer.from("synthetic private content");
  const plan = makeBoxStageFiles({ cwd, project: "", files: [
    { path: `${cwd}/system.txt`, raw, hash: sha(raw) },
  ] });
  try {
    const steps = [...plan.requests];
    const finish = steps.at(-1)!;
    steps[steps.length - 1] = { ...finish,
      args: [...finish.args.slice(0, -1), "0".repeat(64)] };
    const batch = makeBoxStageBatch(steps);
    assert.ok(batch);
    const result = execute(batch.request);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
  } finally {
    assert.equal(execute(plan.cleanup).status, 0);
  }
});

test("guarded batch uses the same prelaunch receipt for every private stage", () => {
  const runNonce = randomBytes(12).toString("hex");
  const identity = { runNonce, leaseEpoch: randomBytes(16).toString("hex"),
    controlId: randomBytes(16).toString("hex"), accountId: "20" };
  const cwd = `/tmp/ocv5-289-run-${runNonce}`;
  const controlDir = `/tmp/ocv5-289-stage-${runNonce}`;
  const raw = Buffer.from("synthetic guarded input\n");
  const plan = makeBoxStageFiles({ cwd, project: "", files: [
    { path: `${cwd}/stdin.jsonl`, raw, hash: sha(raw) },
  ] });
  try {
    const bootstrap = execute(makeBoxPrelaunchBootstrap(identity));
    assert.equal(bootstrap.status, 0, bootstrap.stderr);
    const receipt = parseBoxPrelaunchBootstrap(bootstrap.stdout, identity);
    const steps = plan.requests.map((step, i) => i === 0
      ? makeBoxPrelaunchInit(receipt, "") : guardBoxPrivateStage(step, receipt));
    const batch = makeBoxStageBatch(steps);
    assert.ok(batch);
    const result = execute(batch.request);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), batch.expected);
    assert.deepEqual(readFileSync(`${cwd}/stdin.jsonl`), raw);
  } finally {
    assert.equal(execute(plan.cleanup).status, 0);
    rmSync(controlDir, { recursive: true, force: true });
  }
});

test("oversize argv and non-staging command fall back before remote dispatch", () => {
  const step: BoxCcExecRequest = { command: "/usr/bin/python3",
    args: ["-I", "-c", "print('ok')", "x".repeat(40_000)], cwd: "/tmp",
    environment: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" } };
  assert.equal(makeBoxStageBatch([step, step]), null);
  assert.equal(makeBoxStageBatch([{ ...step, command: "/home/box/.local/bin/claude" }, step]), null);
});
