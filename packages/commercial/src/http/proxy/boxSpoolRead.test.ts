import test from "node:test";
import assert from "node:assert/strict";
import { parseBoxSpoolChunk, readBoxSpoolChunk } from "./boxSpoolRead.js";
import type { BoxExecTransport } from "./boxExecTransport.js";

test("spool byte cursor accepts only the exact requested offset and canonical base64", () => {
  const raw = JSON.stringify({ offset: 5, data: Buffer.from("hello").toString("base64") }) + "\n";
  const parsed = parseBoxSpoolChunk(raw, 0, 16);
  assert.equal(parsed.bytes.toString(), "hello");
  assert.equal(parsed.nextOffset, 5);
  assert.throws(() => parseBoxSpoolChunk(raw, 1, 16), /BOX_SPOOL_FRAME_INVALID/);
  assert.throws(() => parseBoxSpoolChunk(JSON.stringify({ offset: 5,
    data: "aGVsbG8=", paid: true }), 0, 16), /BOX_SPOOL_FRAME_INVALID/);
  assert.throws(() => parseBoxSpoolChunk(JSON.stringify({ offset: 5,
    data: "aGVsbG8" }), 0, 16), /BOX_SPOOL_FRAME_INVALID/);
});

test("read uses a bounded read-only Exec and returns bytes without auto-ACK", async () => {
  let calls = 0;
  const request = { command: "/usr/bin/python3", args: ["runner", "--read", "run", "4", "16"],
    cwd: "/tmp", environment: {} };
  const run: BoxExecTransport["run"] = async (sent, opts) => {
    calls++;
    assert.equal(sent, request);
    assert.equal(opts.timeoutMs, 20_000);
    return { stdout: JSON.stringify({ offset: 9,
      data: Buffer.from("world").toString("base64") }), stderrBytes: 0, exitCode: 0 };
  };
  const result = await readBoxSpoolChunk({ offset: 4, limit: 16,
    plan: { readSpool: (offset: number, limit?: number) => {
      assert.deepEqual([offset, limit], [4, 16]); return request;
    } },
    exec: { run } });
  assert.equal(calls, 1);
  assert.equal(result.bytes.toString(), "world");
  assert.equal(result.nextOffset, 9);
});
