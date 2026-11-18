import test from "node:test";
import assert from "node:assert/strict";
import { BoxExecTransportError, type BoxExecTransport } from "./boxExecTransport.js";
import { makeBoxDetachedRunAccess } from "./boxDetachedRunAccess.js";
import { BoxSpoolPollError, BoxSpoolTerminalError,
  pollBoxSpoolLines } from "./boxSpoolPoller.js";
import type { BoxTerminalProof } from "./boxTerminalProof.js";

type Exec = Pick<BoxExecTransport, "run">;
type Request = Parameters<Exec["run"]>[0];
type Options = Parameters<Exec["run"]>[1];
type Result = Awaited<ReturnType<Exec["run"]>>;
type Input = Parameters<typeof pollBoxSpoolLines>[0];
const terminal = { accountId: 20n, expectedAccountId: 20n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) };
const access = makeBoxDetachedRunAccess({ runNonce: terminal.runNonce,
  detachedRunnerHash: "c".repeat(64) });
const result = (stdout: string): Result => ({ stdout, stderrBytes: 0, exitCode: 0 });
const isSpool = (request: Request) => request.args[5] === "--read";
const offsetOf = (request: Request) => Number(request.args[7]);
const chunk = (request: Request, bytes = Buffer.alloc(0)) => result(JSON.stringify({
  offset: offsetOf(request) + bytes.length, data: bytes.toString("base64") }));
const proof = (reason: BoxTerminalProof["reason"]): BoxTerminalProof => ({
  runNonce: terminal.runNonce, leaseEpoch: terminal.leaseEpoch, keeperPid: 101,
  cliPid: 102, ...(reason === "worker_failed"
    ? { reason, revision: 2 as const, workerExitCode: 1 }
    : { reason, revision: 1 as const }) });
const proved = (reason: BoxTerminalProof["reason"]) => result(`${JSON.stringify(proof(reason))}\n`);
const fake = (handler: (request: Request, options: Options) => Result | Promise<Result>): Exec => ({
  run: async (request, options) => handler(request, options) });
const poll = (exec: Exec, overrides: Partial<Input> = {}) => pollBoxSpoolLines({
  exec, access, startOffset: 0, deadlineMs: 2000, pollIntervalMs: 1,
  terminal, ...overrides });
function waitForAbort(signal?: AbortSignal): Promise<never> {
  assert.ok(signal);
  return new Promise((_, reject) => {
    const cancelled = () => reject(new BoxExecTransportError("BOX_EXEC_ABORTED", false));
    signal.addEventListener("abort", cancelled, { once: true });
    if (signal.aborted) cancelled();
  });
}

for (const [reason, code] of [
  ["worker_failed", "BOX_SPOOL_WORKER_FAILED"],
  ["keeper_stopped", "BOX_SPOOL_KEEPER_STOPPED"],
  ["worker_complete", "BOX_SPOOL_TERMINAL_INCOMPLETE"],
] as const) {
  test(`strict ${reason} proof ends an empty spool only after a confirming same-offset read`, async () => {
    const calls: string[] = [];
    const exec = fake((request) => {
      calls.push(isSpool(request) ? `spool:${offsetOf(request)}` : "proof");
      return isSpool(request) ? chunk(request) : proved(reason);
    });
    await assert.rejects(poll(exec).next(), (error: unknown) => {
      assert.ok(error instanceof BoxSpoolTerminalError);
      assert.equal(error.code, code);
      assert.deepEqual(error.proof, proof(reason));
      assert.equal(error.accountId, 20n);
      return true;
    });
    assert.deepEqual(calls, ["spool:0", "proof", "spool:0"]);
  });
}

test("a final appended between empty read and proof is drained from the unchanged offset", async () => {
  const bytes = Buffer.from('{"type":"result","subtype":"success"}\n');
  let reads = 0;
  const offsets: number[] = [];
  const exec = fake((request) => {
    if (!isSpool(request)) return proved("worker_complete");
    offsets.push(offsetOf(request));
    return chunk(request, ++reads === 1 ? Buffer.alloc(0) : bytes);
  });
  const iter = poll(exec, { startOffset: 42 });
  try {
    const first = await iter.next();
    assert.equal(first.done, false);
    assert.equal(first.value?.text, bytes.toString());
    assert.equal(first.value?.endOffset, 42 + bytes.length);
    assert.deepEqual(first.value?.terminalProof, proof("worker_complete"));
    assert.deepEqual(offsets, [42, 42]);
  } finally { await iter.return(undefined); }
});

test("terminal draining preserves split UTF-8 and fails a trailing partial line rather than ending normally", async () => {
  const complete = Buffer.from(`${JSON.stringify({ text: `${"x".repeat(65_500)}你好` })}\n`);
  const split = complete.indexOf(Buffer.from("你")) + 1;
  const pieces = [complete.subarray(0, split),
    Buffer.concat([complete.subarray(split), Buffer.from('{"partial":')])];
  const offsets: number[] = [];
  let reads = 0;
  const exec = fake((request) => {
    if (!isSpool(request)) return proved("worker_complete");
    offsets.push(offsetOf(request));
    return chunk(request, ++reads === 1 ? Buffer.alloc(0) : pieces.shift() ?? Buffer.alloc(0));
  });
  const iter = poll(exec);
  const first = await iter.next();
  assert.equal(first.value?.text, complete.toString());
  assert.equal(first.value?.endOffset, complete.length);
  assert.deepEqual(first.value?.terminalProof, proof("worker_complete"));
  await assert.rejects(iter.next(), (error: unknown) => error instanceof BoxSpoolTerminalError
    && error.code === "BOX_SPOOL_TERMINAL_INCOMPLETE");
  assert.deepEqual(offsets, [0, 0, split, complete.length + Buffer.byteLength('{"partial":')]);
});

test("a cleaned empty stdout beyond the old cursor stops on its strict failure proof", async () => {
  const offsets: number[] = [];
  const exec = fake((request) => {
    if (!isSpool(request)) return proved("worker_failed");
    offsets.push(offsetOf(request));
    return chunk(request);
  });
  await assert.rejects(poll(exec, { startOffset: 1_322_381 }).next(),
    (error: unknown) => error instanceof BoxSpoolTerminalError
      && error.code === "BOX_SPOOL_WORKER_FAILED");
  assert.deepEqual(offsets, [1_322_381, 1_322_381]);
});

for (const [name, unknown] of [
  ["missing", new BoxExecTransportError("BOX_EXEC_REMOTE_EXIT", true, 1)],
  ["malformed", "{not-json}\n"],
  ["wrong nonce", `${JSON.stringify({ ...proof("worker_failed"), runNonce: "d".repeat(24) })}\n`],
  ["wrong epoch", `${JSON.stringify({ ...proof("worker_failed"), leaseEpoch: "d".repeat(32) })}\n`],
] as const) {
  test(`${name} terminal evidence stays unknown and does not discard later live data`, async () => {
    const bytes = Buffer.from('{"type":"tool_handoff","synthetic":true}\n');
    let reads = 0;
    let probes = 0;
    const exec = fake((request) => {
      if (isSpool(request)) return chunk(request, ++reads < 3 ? Buffer.alloc(0) : bytes);
      probes++;
      if (unknown instanceof Error) throw unknown;
      return result(unknown);
    });
    const iter = poll(exec, { terminalProbeIntervalMs: 60_000 });
    try {
      const first = await iter.next();
      assert.equal(first.value?.text, bytes.toString());
      assert.equal(first.value?.terminalProof, undefined);
      assert.equal(probes, 1);
      assert.equal(reads, 3);
    } finally { await iter.return(undefined); }
  });
}

test("a mismatched account binding is rejected before any remote read", async () => {
  let calls = 0;
  const exec = fake(() => { calls++; throw new Error("unexpected remote read"); });
  await assert.rejects(poll(exec, { terminal: { ...terminal, expectedAccountId: 21n } }).next(),
    (error: unknown) => error instanceof BoxSpoolPollError
      && error.code === "BOX_TERMINAL_IDENTITY_INVALID");
  assert.equal(calls, 0);
});

for (const code of ["BOX_EXEC_ACCOUNT_GUARD_FAILED", "BOX_EXEC_HTTP_401", "BOX_EXEC_HTTP_403"]) {
  test(`${code} from a terminal probe remains loud`, async () => {
    const failure = new BoxExecTransportError(code, false);
    let probes = 0;
    const exec = fake((request) => {
      if (isSpool(request)) return chunk(request);
      probes++; throw failure;
    });
    await assert.rejects(poll(exec).next(), (error: unknown) => error === failure);
    assert.equal(probes, 1);
  });
}

test("caller abort during a proof read keeps the poll abort classification", async () => {
  const abort = new AbortController();
  let entered!: () => void;
  const probing = new Promise<void>((resolve) => { entered = resolve; });
  const exec = fake((request, options) => {
    if (isSpool(request)) return chunk(request);
    entered(); return waitForAbort(options.signal);
  });
  const pending = poll(exec, { signal: abort.signal }).next();
  const rejected = assert.rejects(pending, (error: unknown) => error instanceof BoxSpoolPollError
    && error.code === "BOX_SPOOL_POLL_ABORTED");
  await probing;
  abort.abort();
  await rejected;
});

test("the total deadline during a proof read remains a poll timeout", async () => {
  let probes = 0;
  const exec = fake((request, options) => {
    if (isSpool(request)) return chunk(request);
    probes++; return waitForAbort(options.signal);
  });
  await assert.rejects(poll(exec, { deadlineMs: 80 }).next(),
    (error: unknown) => error instanceof BoxSpoolPollError
      && error.code === "BOX_SPOOL_POLL_TIMEOUT");
  assert.equal(probes, 1);
});

test("caller abort wins if the confirming empty read resolves after a terminal proof", async () => {
  const abort = new AbortController();
  let reads = 0;
  const exec = fake((request) => {
    if (!isSpool(request)) return proved("worker_failed");
    if (++reads === 2) abort.abort();
    return chunk(request);
  });
  await assert.rejects(poll(exec, { signal: abort.signal }).next(),
    (error: unknown) => error instanceof BoxSpoolPollError
      && error.code === "BOX_SPOOL_POLL_ABORTED");
  assert.equal(reads, 2);
});
