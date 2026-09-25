import test from "node:test";
import assert from "node:assert/strict";
import { BoxSpoolJsonlFramer } from "./boxSpoolJsonlFramer.js";
import { BOX_TOOL_SPOOL_MAX_BYTES, BoxToolCapacityError,
  reserveBoxToolEcho } from "./boxToolCapacity.js";

const message = (content: unknown) => ({ role: "user", content: [
  { type: "tool_result", tool_use_id: "toolu_large", content },
] });

test("a 1.1 MB text result is admitted before publication and its full echo frames", () => {
  const result = "x".repeat(1_100_000);
  const bound = reserveBoxToolEcho(1_000_000, message(result));
  assert.ok(bound > result.length);
  const echo = Buffer.from(JSON.stringify({ type: "user", message: message(result) }) + "\n");
  assert.ok(echo.length > 1_048_576, "this reproduced the former 1 MiB failure");
  const framer = new BoxSpoolJsonlFramer(1_000_000);
  let offset = 1_000_000;
  let observed = "";
  for (let start = 0; start < echo.length; start += 65536) {
    const chunk = echo.subarray(start, start + 65536);
    const lines = framer.push(chunk, offset);
    offset += chunk.length;
    for (const line of lines) {
      observed = line.text;
      assert.equal(line.endOffset, offset);
    }
  }
  assert.equal(observed, echo.toString("utf8"));
});

test("image and multi-round results have a bounded prepublication spool budget", () => {
  const image = { type: "image", source: { type: "base64",
    media_type: "image/png", data: Buffer.alloc(850_000).toString("base64") } };
  const imageBound = reserveBoxToolEcho(1_000_000, message([image]));
  assert.ok(imageBound > 1_100_000);
  const result = message("r".repeat(1_100_000));
  let offset = 1_000_000, admitted = 0;
  while (offset < BOX_TOOL_SPOOL_MAX_BYTES) {
    let bound: number;
    try { bound = reserveBoxToolEcho(offset, result); }
    catch (error) {
      assert.ok(error instanceof BoxToolCapacityError);
      assert.equal(error.code, "BOX_TOOL_SPOOL_CAPACITY_EXCEEDED");
      break;
    }
    admitted++;
    offset += bound + 1_000_000; // one bounded model response after each echo
  }
  assert.ok(admitted >= 2 && admitted < 20);
  assert.throws(() => reserveBoxToolEcho(BOX_TOOL_SPOOL_MAX_BYTES - 1_000_000,
    message("last")), /BOX_TOOL_SPOOL_CAPACITY_EXCEEDED/);
});
