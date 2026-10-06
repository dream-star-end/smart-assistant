import test from "node:test";
import assert from "node:assert/strict";
import { BoxProfileHealth } from "./boxProfileHealth.js";
import { scopeBoxExecToProfile } from "./boxProfileExec.js";

const REJECTED = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4000000000,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":4000000000}}}}\n';
const NOT_LOGGED_IN = '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in \u00b7 Please run /login"}]}}\n';
const launch = { command: "/p", args: [], cwd: "/tmp", environment: { CLAUDE_CODE_MAX_RETRIES: "0" } };
const opts = { timeoutMs: 1000, maxResponseBytes: 1024 };

/** Behaves like BoxExecTransport: every stdout event goes to onStdout, and a non-zero exit throws. */
function transport(chunks: string[], seen: Array<Record<string, string>> = [], exit = 0) {
  return { run: async (request: { environment: Record<string, string> }, o: { onStdout?: (c: string) => void }) => {
    seen.push(request.environment);
    for (const chunk of chunks) o.onStdout?.(chunk);
    if (exit !== 0) throw Object.assign(new Error("BOX_EXEC_REMOTE_EXIT"), { remoteExitCode: exit });
    return { stdout: chunks.join(""), stderrBytes: 0, exitCode: 0 as const };
  } };
}

test("launches run under the login's config dir, count as load, and a streamed rejection benches it", async () => {
  const seen: Array<Record<string, string>> = [];
  const health = new BoxProfileHealth();
  const exec = scopeBoxExecToProfile(transport([REJECTED], seen) as never, { key: "7:b", profile: "b", health });
  const chunks: string[] = [];
  await exec.run(launch, { ...opts, onStdout: (c) => chunks.push(c) });
  assert.equal(seen[0]!.CLAUDE_CONFIG_DIR, "/home/box/.claude-b");
  assert.equal(health.recentLaunches("7:b"), 1);
  assert.equal(health.cooldownActive("7:b"), true);
  assert.deepEqual(chunks, [REJECTED], "the caller still sees every chunk");
});

test("a failing run (exit 1) still teaches the scheduler what the stream said", async () => {
  const health = new BoxProfileHealth();
  const exec = scopeBoxExecToProfile(transport([REJECTED], [], 1) as never, { key: "7:b", profile: "b", health });
  await assert.rejects(exec.run(launch, opts), /BOX_EXEC_REMOTE_EXIT/);
  assert.equal(health.cooldownActive("7:b"), true);
});

test("a signal split across stdout events at any byte position is still read", async () => {
  for (const line of [REJECTED, NOT_LOGGED_IN]) {
    for (let cut = 1; cut < line.length - 1; cut += 7) {
      const health = new BoxProfileHealth();
      const exec = scopeBoxExecToProfile(transport([line.slice(0, cut), line.slice(cut)]) as never,
        { key: "k", profile: "b", health });
      await exec.run(launch, opts);
      assert.equal(health.cooldownActive("k"), true, `cut at ${cut}`);
    }
  }
  const health = new BoxProfileHealth();   // an unterminated last line is read when the call ends
  await scopeBoxExecToProfile(transport([REJECTED.trimEnd()]) as never, { key: "k", profile: "b", health }).run(launch, opts);
  assert.equal(health.cooldownActive("k"), true);
});

test("non-launch requests are untouched and are not load; the default login passes launches through unchanged", async () => {
  const seen: Array<Record<string, string>> = [];
  const health = new BoxProfileHealth();
  await scopeBoxExecToProfile(transport([], seen) as never, { key: "7:b", profile: "b", health })
    .run({ command: "/p", args: [], cwd: "/tmp", environment: { PATH: "/usr/bin" } }, opts);
  assert.deepEqual(seen[0], { PATH: "/usr/bin" });
  assert.equal(health.recentLaunches("7:b"), 0);
  await scopeBoxExecToProfile(transport([], seen) as never, { key: "7:default", profile: "default", health }).run(launch, opts);
  assert.deepEqual(seen[1], { CLAUDE_CODE_MAX_RETRIES: "0" });
});

test("an endless line without a newline cannot grow the buffer without bound", async () => {
  const health = new BoxProfileHealth();
  const exec = scopeBoxExecToProfile(transport(Array.from({ length: 40 }, () => "x".repeat(8192))) as never, { key: "k", profile: "b", health });
  await exec.run(launch, opts);
  assert.equal(health.cooldownActive("k"), false);
});
