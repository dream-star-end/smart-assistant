import test from "node:test";
import assert from "node:assert/strict";
import { pollBoxSpoolLines } from "./boxSpoolPoller.js";
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
    seen.push(req.args[4]!);
    const offset = Number(req.args[6]);
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
    assert.equal(req.args[4], "--read");
    const offset = Number(req.args[6]);
    return { stdout: encoded(Buffer.alloc(0), offset), stderrBytes: 0,
      exitCode: 0 as const };
  } };
  const iter = pollBoxSpoolLines({ exec: exec as never, access, startOffset: 42,
    deadlineMs: 30, pollIntervalMs: 1000 });
  await assert.rejects(() => iter.next(), /BOX_SPOOL_POLL_TIMEOUT/);
  assert.ok(calls >= 1);
});
