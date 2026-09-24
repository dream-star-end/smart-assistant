import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { makeBoxDetachedProbePlan } from "./boxDetachedProbePlan.js";

test("detached non-model child advances across separate Exec processes and stops by file", () => {
  const plan = makeBoxDetachedProbePlan(randomBytes(12).toString("hex"));
  const run = (request: typeof plan.launch) => spawnSync(request.command,
    request.args, { cwd: request.cwd, env: { ...process.env, ...request.environment },
      encoding: "utf8", timeout: 10_000 });
  const launch = run(plan.launch);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout.trim(), "started");
  try {
    const observed = run(plan.observe);
    assert.equal(observed.status, 0, observed.stderr);
    const counts = JSON.parse(observed.stdout) as { first: number; second: number };
    assert.ok(counts.second >= counts.first + 2,
      "child must remain live after launch Exec has exited");
  } finally {
    const stopped = run(plan.stop);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(stopped.stdout.trim(), "stopped");
  }
  assert.throws(() => makeBoxDetachedProbePlan("../bad"), /BOX_DETACHED_NONCE_INVALID/);
});
