import test from "node:test";
import assert from "node:assert/strict";
import { isBoxExecRejectedError, isTransientBoxSpoolReadError, pollBoxSpoolLines } from "./boxSpoolPoller.js";
import { BoxExecTransportError } from "./boxExecTransport.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";

const access = makeBoxDetachedRunAccess({ runNonce: "a".repeat(24),
  detachedRunnerHash: "b".repeat(64) });
const encoded = (bytes: Buffer, offset: number) => JSON.stringify({
  data: bytes.toString("base64"), offset: offset + bytes.length });

test("read-only poll frames partial UTF-8 by exact byte offset and never re-launches", async () => {
  const raw = Buffer.from('{"type":"assistant","text":"你好"}\n', "utf8");
  const parts = [raw.subarray(0, 27), raw.subarray(27)];
  const seen: string[] = [];
  const exec = { run: async (req: { args: string[] }) => {
    seen.push(req.args[5]!);
    const offset = Number(req.args[7]);
    const bytes = parts.shift() ?? Buffer.alloc(0);
    return { stdout: encoded(bytes, offset), stderrBytes: 0, exitCode: 0 as const };
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 0,
    deadlineMs: 1000, pollIntervalMs: 1 });
  const first = await iter.next();
  assert.equal(first.done, false);
  assert.equal(first.value?.text, raw.toString("utf8"));
  assert.equal(first.value?.endOffset, raw.length);
  await iter.return(undefined);
  assert.deepEqual(seen, ["--read", "--read"]);
});

test("empty spool times out without starting or replaying model", async () => {
  let calls = 0;
  const exec = { run: async (req: { args: string[] }) => {
    calls++;
    assert.equal(req.args[5], "--read");
    const offset = Number(req.args[7]);
    return { stdout: encoded(Buffer.alloc(0), offset), stderrBytes: 0,
      exitCode: 0 as const };
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 42,
    deadlineMs: 30, pollIntervalMs: 1000 });
  await assert.rejects(() => iter.next(), /BOX_SPOOL_POLL_TIMEOUT/);
  assert.ok(calls >= 1);
});

test("OCV5-306: a dropped exec exchange re-reads the same offset instead of failing the turn", async () => {
  const raw = Buffer.from('{"type":"assistant"}\n', "utf8");
  const offsets: number[] = [];
  let calls = 0;
  const exec = { run: async (req: { args: string[] }) => {
    calls++;
    const offset = Number(req.args[7]);
    offsets.push(offset);
    if (calls === 1) throw new BoxExecTransportError("BOX_EXEC_TRANSPORT_UNKNOWN", false);
    if (calls === 2) throw new BoxExecTransportError("BOX_EXEC_HTTP_502", false);
    return { stdout: encoded(calls === 3 ? raw : Buffer.alloc(0), offset),
      stderrBytes: 0, exitCode: 0 as const };
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 7,
    deadlineMs: 1000, pollIntervalMs: 1, retryDelaysMs: [1, 1] });
  const first = await iter.next();
  assert.equal(first.value?.text, raw.toString("utf8"));
  assert.equal(first.value?.endOffset, 7 + raw.length);
  await iter.return(undefined);
  assert.deepEqual(offsets, [7, 7, 7]);
});

test("OCV5-306: transient retries are bounded and reset only after a successful read", async () => {
  let calls = 0;
  const exec = { run: async (req: { args: string[] }) => {
    calls++;
    if (calls === 3) {
      return { stdout: encoded(Buffer.alloc(0), Number(req.args[7])), stderrBytes: 0,
        exitCode: 0 as const };
    }
    throw new BoxExecTransportError("BOX_EXEC_STREAM_UNKNOWN", false);
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 0,
    deadlineMs: 1000, pollIntervalMs: 1, retryDelaysMs: [1, 1] });
  await assert.rejects(() => iter.next(), /BOX_EXEC_STREAM_UNKNOWN/);
  // 2 failures, success (reset), then 2 retried failures + the 3rd surfaces.
  assert.equal(calls, 6);
});

test("OCV5-306: account guard, remote exit and HTTP auth errors are never retried", async () => {
  for (const error of [new BoxExecTransportError("BOX_EXEC_ACCOUNT_GUARD_FAILED", false),
    new BoxExecTransportError("BOX_EXEC_REMOTE_EXIT", true, 2),
    new BoxExecTransportError("BOX_EXEC_HTTP_401", false),
    new BoxExecTransportError("BOX_EXEC_FRAME_INVALID", false)]) {
    let calls = 0;
    const exec = { run: async () => { calls++; throw error; } };
    const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 0,
      deadlineMs: 1000, pollIntervalMs: 1, retryDelaysMs: [1, 1, 1] });
    await assert.rejects(() => iter.next(), (e: unknown) => e === error);
    assert.equal(calls, 1, error.code);
    assert.equal(isTransientBoxSpoolReadError(error), false);
  }
});

test("OCV5-306: a deadline during a retry pause reports poll timeout", async () => {
  const exec = { run: async () => {
    throw new BoxExecTransportError("BOX_EXEC_TRANSPORT_UNKNOWN", false);
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 0,
    deadlineMs: 20, pollIntervalMs: 1, retryDelaysMs: [5000] });
  await assert.rejects(() => iter.next(), /BOX_SPOOL_POLL_TIMEOUT/);
});

test("OCV5-762: an Exec 417 re-reads the same offset once (on the refreshed descriptor)", async () => {
  const raw = Buffer.from('{"type":"assistant"}\n', "utf8");
  const offsets: number[] = [];
  const exec = { run: async (req: { args: string[] }) => {
    const offset = Number(req.args[7]);
    offsets.push(offset);
    if (offsets.length === 1) throw new BoxExecTransportError("BOX_EXEC_HTTP_417", false);
    return { stdout: encoded(offsets.length === 2 ? raw : Buffer.alloc(0), offset),
      stderrBytes: 0, exitCode: 0 as const };
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 9,
    deadlineMs: 1000, pollIntervalMs: 1, retryDelaysMs: [1, 1] });
  const first = await iter.next();
  assert.equal(first.value?.text, raw.toString("utf8"));
  await iter.return(undefined);
  assert.deepEqual(offsets, [9, 9]);
});

test("OCV5-762: a second 417 without progress ends the poll as rejected", async () => {
  const raw = Buffer.from('{"type":"assistant"}\n', "utf8");
  let calls = 0;
  const exec = { run: async (req: { args: string[] }) => {
    calls++;
    // 417, progress (reset), 417 retried, empty read (no progress), 417 surfaces
    if (calls === 1 || calls === 3 || calls === 5) throw new BoxExecTransportError("BOX_EXEC_HTTP_417", false);
    return { stdout: encoded(calls === 2 ? raw : Buffer.alloc(0), Number(req.args[7])),
      stderrBytes: 0, exitCode: 0 as const };
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 0,
    deadlineMs: 1000, pollIntervalMs: 1, retryDelaysMs: [1, 1] });
  assert.equal((await iter.next()).value?.text, raw.toString("utf8"));
  const surfaced = await iter.next().then(() => null, (error: unknown) => error);
  assert.ok(surfaced instanceof BoxExecTransportError && surfaced.code === "BOX_EXEC_HTTP_417");
  assert.equal(calls, 5);
  assert.equal(isBoxExecRejectedError(surfaced), true);
  assert.equal(isBoxExecRejectedError(new BoxExecTransportError("BOX_EXEC_REFRESH_FAILED", false)), true);
  assert.equal(isBoxExecRejectedError(new BoxExecTransportError("BOX_EXEC_HTTP_503", false)), false);
});

test("OCV5-762: a failed descriptor refresh is not retried", async () => {
  let calls = 0;
  const exec = { run: async () => {
    calls++;
    throw new BoxExecTransportError(calls === 1 ? "BOX_EXEC_HTTP_417" : "BOX_EXEC_REFRESH_FAILED", false);
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 0,
    deadlineMs: 1000, pollIntervalMs: 1, retryDelaysMs: [1, 1, 1] });
  await assert.rejects(() => iter.next(), /BOX_EXEC_REFRESH_FAILED/);
  assert.equal(calls, 2);
});
