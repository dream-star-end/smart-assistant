import test from "node:test";
import assert from "node:assert/strict";
import { BoxProfileHealth } from "./boxProfileHealth.js";
import { scopeBoxExecToProfile } from "./boxProfileExec.js";

const REJECTED = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":4000000000,"unifiedWindows":{"five_hour":{"utilization":1.04,"resetsAt":4000000000}}}}\n';
const NOT_LOGGED_IN = '{"type":"assistant","message":{"model":"<synthetic>","content":[{"type":"text","text":"Not logged in \u00b7 Please run /login"}]}}\n';
const launch = { command: "/p", args: [], cwd: "/tmp", environment: { CLAUDE_CODE_MAX_RETRIES: "0" } };
const opts = { timeoutMs: 1000, maxResponseBytes: 1024 };
const cwdOf = (nonce: string) => `/tmp/ocv5-289-run-${nonce}`;
const NONCE_A = "a".repeat(24);
const NONCE_B = "b".repeat(24);
const readReq = (nonce: string) => ({ command: "/p", args: ["--read", cwdOf(nonce), "0", "65536"], cwd: "/tmp", environment: {} });

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

const spool = (text: string, offset: number) => {
  const bytes = Buffer.from(text, "utf8");
  return JSON.stringify({ offset: offset + bytes.length, data: bytes.toString("base64") });   // the runner prints offset first
};

test("detached runs: the CLI lines inside spool read envelopes are read, also across two reads", async () => {
  const replies = [spool(REJECTED.slice(0, 90), 0), spool(REJECTED.slice(90), Buffer.byteLength(REJECTED.slice(0, 90)))];
  const health = new BoxProfileHealth();
  health.noteRun(NONCE_A, "k");
  const exec = scopeBoxExecToProfile({ run: async () => ({ stdout: replies.shift()!, stderrBytes: 0, exitCode: 0 as const }) } as never,
    { key: "k", profile: "b", health });
  const read = { ...readReq(NONCE_A), environment: { PATH: "/usr/bin" } };
  await exec.run(read, opts);
  assert.equal(health.cooldownActive("k"), false, "half a line is not yet a signal");
  await exec.run(read, opts);
  assert.equal(health.cooldownActive("k"), true);
});

test("detached runs: a logged-out stream in the spool benches the login; non-contiguous reads never glue lines", async () => {
  const health = new BoxProfileHealth();
  health.noteRun(NONCE_A, "k");
  const exec = scopeBoxExecToProfile({ run: async (r: { args: string[] }) => ({ stdout: r.args[0] === "1" ? spool(NOT_LOGGED_IN, 0)
    : spool(REJECTED.slice(40), 5000), stderrBytes: 0, exitCode: 0 as const }) } as never, { key: "k", profile: "b", health });
  await exec.run({ ...readReq(NONCE_A), args: ["1", cwdOf(NONCE_A)] }, opts);
  assert.equal(health.get("k")!.lastReason, "login_required");
  const other = new BoxProfileHealth();
  other.noteRun(NONCE_A, "k");
  const exec2 = scopeBoxExecToProfile({ run: async (r: { args: string[] }) => ({ stdout: r.args[0] === "1" ? spool(REJECTED.slice(0, 40), 0)
    : spool(REJECTED.slice(40), 9000), stderrBytes: 0, exitCode: 0 as const }) } as never, { key: "k", profile: "b", health: other });
  await exec2.run({ ...readReq(NONCE_A), args: ["1", cwdOf(NONCE_A)] }, opts);
  await exec2.run({ ...readReq(NONCE_A), args: ["2", cwdOf(NONCE_A)] }, opts);
  assert.equal(other.cooldownActive("k"), false);
});

test("an ordinary spool read and junk that only looks like one are ignored", async () => {
  const health = new BoxProfileHealth();
  health.noteRun(NONCE_A, "k");
  const outs = [spool('{"type":"assistant","message":{"model":"claude-opus-5-5","content":[]}}\n', 0), '{"offset":2,"data":"!!"}', '{"offset":0,"data":"","x":1}'];
  const exec = scopeBoxExecToProfile({ run: async () => ({ stdout: outs.shift()!, stderrBytes: 0, exitCode: 0 as const }) } as never,
    { key: "k", profile: "b", health });
  for (let i = 0; i < 3; i++) await exec.run(readReq(NONCE_A), opts);
  assert.equal(health.get("k"), undefined);
});

const spoolBytes = (bytes: Buffer, start: number) => JSON.stringify({ offset: start + bytes.length, data: bytes.toString("base64") });

test("a read that ends inside a multi-byte character neither corrupts positions nor drops the line", async () => {
  const line = Buffer.from(NOT_LOGGED_IN, "utf8");
  const cut = line.indexOf(Buffer.from("\u00b7")) + 1;                     // between the two bytes of the middle dot
  const replies = [spoolBytes(line.subarray(0, cut), 0), spoolBytes(line.subarray(cut), cut)];
  const health = new BoxProfileHealth();
  health.noteRun(NONCE_A, "k");
  const exec = scopeBoxExecToProfile({ run: async () => ({ stdout: replies.shift()!, stderrBytes: 0, exitCode: 0 as const }) } as never,
    { key: "k", profile: "b", health });
  await exec.run(readReq(NONCE_A), opts);
  await exec.run(readReq(NONCE_A), opts);
  assert.equal(health.get("k")!.lastReason, "login_required");
});

test("a replayed or overlapping read adds nothing and never extends a bench", async () => {
  let now = 1_000;
  const health = new BoxProfileHealth(() => now);
  health.noteRun(NONCE_A, "k");
  const bytes = Buffer.from(NOT_LOGGED_IN, "utf8");
  const replies = [spoolBytes(bytes, 0), spoolBytes(bytes, 0), spoolBytes(bytes.subarray(10), 10)];
  const exec = scopeBoxExecToProfile({ run: async () => ({ stdout: replies.shift()!, stderrBytes: 0, exitCode: 0 as const }) } as never,
    { key: "k", profile: "b", health });
  await exec.run(readReq(NONCE_A), opts);
  const until = health.get("k")!.cooldownUntilMs;
  now += 600_000;
  await exec.run(readReq(NONCE_A), opts);
  await exec.run(readReq(NONCE_A), opts);
  assert.equal(health.get("k")!.cooldownUntilMs, until, "same evidence, same bench");
});

test("a resumed run's output is attributed to the login it was launched under, not to the target that reads it", async () => {
  const health = new BoxProfileHealth();
  const runner = (replies: string[]) => ({ run: async () => ({ stdout: replies.shift() ?? "", stderrBytes: 0, exitCode: 0 as const }) } as never);
  const a = scopeBoxExecToProfile(runner([""]), { key: "7:a", profile: "a", health });
  await a.run({ command: "/p", args: [], cwd: cwdOf(NONCE_A), environment: { CLAUDE_CODE_MAX_RETRIES: "0" } }, opts);   // launched under a
  const b = scopeBoxExecToProfile(runner([spoolBytes(Buffer.from(REJECTED), 0)]), { key: "7:b", profile: "b", health });
  await b.run(readReq(NONCE_A), opts);                                                                                   // read through b
  assert.equal(health.cooldownActive("7:a"), true);
  assert.equal(health.cooldownActive("7:b"), false);
  const c = scopeBoxExecToProfile(runner([spoolBytes(Buffer.from(REJECTED), 0)]), { key: "7:b", profile: "b", health });
  await c.run(readReq(NONCE_B), opts);                                                                                   // unknown run: no attribution
  assert.equal(health.get("7:b"), undefined);
});

test("two targets re-reading the same rejection (no usable reset) share one bench and do not extend it", async () => {
  let now = 50_000;
  const health = new BoxProfileHealth(() => now);
  health.noteRun(NONCE_A, "7:b");
  const bare = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}\n';
  const reply = () => ({ run: async () => ({ stdout: spoolBytes(Buffer.from(bare), 0), stderrBytes: 0, exitCode: 0 as const }) } as never);
  await scopeBoxExecToProfile(reply(), { key: "7:b", profile: "b", health }).run(readReq(NONCE_A), opts);
  const until = health.get("7:b")!.cooldownUntilMs;
  now += 120_000;
  await scopeBoxExecToProfile(reply(), { key: "7:b", profile: "b", health }).run(readReq(NONCE_A), opts);   // a resumed run: new target, new reader
  assert.equal(health.get("7:b")!.cooldownUntilMs, until);
});

test("a process restart never attributes a prior run's rejection to the observing login", async () => {
  const priorHealth = new BoxProfileHealth();
  const prior = scopeBoxExecToProfile(transport([""]) as never, { key: "7:a", profile: "a", health: priorHealth });
  await prior.run({ ...launch, cwd: cwdOf(NONCE_A) }, opts);
  assert.equal(priorHealth.runKey(NONCE_A), "7:a");
  for (const profile of ["b", "default"]) {
    const health = new BoxProfileHealth(); // a new egress process has no runOwners
    let launches = 0;
    const response = { stdout: spoolBytes(Buffer.from(REJECTED), 0), stderrBytes: 0, exitCode: 0 as const };
    const request = readReq(NONCE_A);
    const seen: unknown[] = [];
    const exec = scopeBoxExecToProfile({ run: async (r: typeof request) => {
      if (Object.hasOwn(r.environment, "CLAUDE_CODE_MAX_RETRIES")) launches++;
      seen.push(r);
      return response;
    } } as never, { key: `7:${profile}`, profile, health });
    assert.equal(await exec.run(request, opts), response);
    assert.equal(seen[0], request, "the original read and its offset pass through unchanged");
    assert.equal(health.get(`7:${profile}`), undefined);
    assert.equal(health.get("7:a"), undefined);
    assert.equal(launches, 0);
  }
});

test("a spool without a run nonce passes through without teaching the observing login", async () => {
  const health = new BoxProfileHealth();
  const response = { stdout: spoolBytes(Buffer.from(NOT_LOGGED_IN), 0), stderrBytes: 0, exitCode: 0 as const };
  const exec = scopeBoxExecToProfile({ run: async () => response } as never,
    { key: "7:b", profile: "b", health });
  assert.equal(await exec.run({ ...readReq(NONCE_A), args: ["--read", "0", "65536"] }, opts), response);
  assert.equal(health.get("7:b"), undefined);
});

test("non-launch raw stdout never teaches a profile, including a failed exec", async () => {
  for (const exit of [0, 1]) {
    const health = new BoxProfileHealth();
    health.noteRun(NONCE_A, "7:a");
    const chunks: string[] = [];
    const seen: Array<Record<string, string>> = [];
    const exec = scopeBoxExecToProfile(transport([REJECTED, NOT_LOGGED_IN], seen, exit) as never,
      { key: "7:b", profile: "b", health });
    const request = readReq(NONCE_A);
    const result = exec.run(request, { ...opts, onStdout: (chunk) => chunks.push(chunk) });
    if (exit) await assert.rejects(result, /BOX_EXEC_REMOTE_EXIT/);
    else assert.equal((await result).stdout, REJECTED + NOT_LOGGED_IN);
    assert.equal(seen[0], request.environment);
    assert.deepEqual(chunks, [REJECTED, NOT_LOGGED_IN]);
    assert.equal(health.get("7:a"), undefined);
    assert.equal(health.get("7:b"), undefined);
  }
});
