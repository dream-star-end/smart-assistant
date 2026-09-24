import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync, truncateSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { makeBoxStageFiles, BoxStageError } from "./boxStageFiles.js";
import type { BoxCcExecRequest } from "@openclaude/gateway";

function sha(raw: Buffer): string { return createHash("sha256").update(raw).digest("hex"); }
function execute(step: BoxCcExecRequest) {
  assert.ok(step.args.every((arg) => Buffer.byteLength(arg) < 70_000), "no Linux per-arg E2BIG");
  assert.ok(step.args.reduce((n, arg) => n + Buffer.byteLength(arg) + 1, 0) < 300_000,
    "whole argv leaves ample room under ARG_MAX");
  return spawnSync(step.command, step.args, {
    cwd: step.cwd, env: step.environment, encoding: "utf8", maxBuffer: 128 * 1024, timeout: 5000,
  });
}

for (const length of [100 * 1024, 1024 * 1024]) {
  test(`stages ${length} synthetic bytes through bounded real Python argv`, () => {
    const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
    const path = `${cwd}/stdin.jsonl`;
    const raw = Buffer.alloc(length, 0x61);
    const plan = makeBoxStageFiles({ cwd, project: "", files: [{ path, raw, hash: sha(raw) }] });
    assert.ok(plan.requests.length >= 3);
    try {
      for (const step of plan.requests) {
        const result = execute(step);
        assert.equal(result.status, 0, result.stderr);
      }
      assert.deepEqual(readFileSync(path), raw);
      assert.equal(statSync(path).mode & 0o777, 0o600);
    } finally {
      const cleanup = execute(plan.cleanup);
      assert.equal(cleanup.status, 0, cleanup.stderr);
    }
  });
}

test("offset replay and altered final hash cannot publish a partial file", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  const path = `${cwd}/system.txt`;
  const raw = Buffer.alloc(100 * 1024, 0x62);
  const plan = makeBoxStageFiles({ cwd, project: "", files: [{ path, raw, hash: sha(raw) }] });
  try {
    assert.equal(execute(plan.requests[0]!).status, 0);
    assert.equal(execute(plan.requests[1]!).status, 0);
    assert.notEqual(execute(plan.requests[1]!).status, 0, "duplicate offset must fail");
    const finish = plan.requests.at(-1)!;
    assert.notEqual(execute({ ...finish, args: [...finish.args.slice(0, -1), "0".repeat(64)] }).status, 0);
    assert.throws(() => statSync(path));
    truncateSync(path + ".part", 1);
    assert.notEqual(execute(finish).status, 0, "truncated part must not publish");
    assert.throws(() => statSync(path));
  } finally {
    const cleanup = execute(plan.cleanup);
    assert.equal(cleanup.status, 0, cleanup.stderr);
  }
});

test("builder rejects unowned path and wrong digest before any Exec", () => {
  const cwd = `/tmp/ocv5-289-run-${randomBytes(12).toString("hex")}`;
  const raw = Buffer.from("x");
  assert.throws(() => makeBoxStageFiles({ cwd, project: "", files: [
    { path: "/tmp/other-user/stdin.jsonl", raw, hash: sha(raw) },
  ] }), (error: unknown) => error instanceof BoxStageError && error.code === "BOX_STAGE_FILE_INVALID");
  assert.throws(() => makeBoxStageFiles({ cwd, project: "", files: [
    { path: `${cwd}/stdin.jsonl`, raw, hash: "0".repeat(64) },
  ] }), (error: unknown) => error instanceof BoxStageError && error.code === "BOX_STAGE_FILE_INVALID");
});
