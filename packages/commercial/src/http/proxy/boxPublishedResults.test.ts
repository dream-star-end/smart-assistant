import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { withPublishedBoxResults } from "./boxPublishedResults.js";

const cwd = "/tmp/ocv5-289-run-" + "a".repeat(24);
const content = [{ type: "image", data: "x".repeat(1_500_000), mimeType: "image/png" }];
const hash = createHash("sha256").update(JSON.stringify({ content, isError: false })).digest("hex");
const expected = { modelToolUseId: "toolu_pub", contentHash: hash, isError: false };
function exec(file: Buffer | null) {
  const calls: string[][] = [];
  return { calls, run: async (request: { args: string[] }) => {
    calls.push(request.args);
    if (!file) throw new Error("missing");
    const off = Number(request.args.at(-1));
    return { stdout: JSON.stringify({ size: file.length,
      b64: file.subarray(off, off + 700_000).toString("base64") }) };
  } };
}
const fileOf = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");

test("OCV5-302 recovery reads the published result in chunks when it hashes to the journal", async () => {
  const e = exec(fileOf({ version: 1, modelToolUseId: "toolu_pub", mcpRequestId: 3, content, isError: false }));
  const [out] = await withPublishedBoxResults(e as never, cwd, [expected]);
  assert.deepEqual(out!.content, content);
  assert.ok(e.calls.length >= 3, "an over-1MB file is read in bounded chunks");
});

test("a missing, foreign or altered published file adds no evidence", async () => {
  for (const file of [null,
    fileOf({ modelToolUseId: "toolu_other", content, isError: false }),
    fileOf({ modelToolUseId: "toolu_pub", content: [{ type: "text", text: "x" }], isError: false }),
    fileOf({ modelToolUseId: "toolu_pub", content, isError: true })]) {
    const [out] = await withPublishedBoxResults(exec(file) as never, cwd, [expected]);
    assert.equal(out, expected);
  }
  const [bad] = await withPublishedBoxResults(exec(null) as never, "/tmp/elsewhere", [expected]);
  assert.equal(bad, expected);
});
