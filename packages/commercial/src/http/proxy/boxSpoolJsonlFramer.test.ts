import test from "node:test";
import assert from "node:assert/strict";
import { BoxSpoolJsonlFramer } from "./boxSpoolJsonlFramer.js";
import { BoxCliToolHandoffDecoder } from "./boxCliToolHandoff.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";

test("JSONL offsets stay byte-exact across split UTF-8 and a later HTTP request", () => {
  const first = Buffer.from('{"text":"你好"}\n');
  const second = Buffer.from('{"type":"tool_use"}\n');
  const third = Buffer.from('{"type":"after_handoff"}\n');
  const spool = Buffer.concat([first, second, third]);
  const framer = new BoxSpoolJsonlFramer();
  const split = first.indexOf(Buffer.from("你")) + 1;
  assert.deepEqual(framer.push(spool.subarray(0, split), 0), []);
  const rows = framer.push(spool.subarray(split), split);
  assert.deepEqual(rows.map((row) => row.endOffset), [first.length,
    first.length + second.length, spool.length]);
  assert.equal(rows[0]?.text, first.toString("utf8"));
  const handoffOffset = rows[1]!.endOffset;
  const resumed = new BoxSpoolJsonlFramer(handoffOffset);
  assert.deepEqual(resumed.push(spool.subarray(handoffOffset), handoffOffset), [
    { text: third.toString("utf8"), endOffset: spool.length },
  ], "new request re-reads only bytes after the committed handoff line");
});

test("overlap, invalid UTF-8 and oversized unfinished lines fail closed", () => {
  const framer = new BoxSpoolJsonlFramer();
  assert.deepEqual(framer.push(Buffer.from("partial"), 0), []);
  assert.throws(() => framer.push(Buffer.from("x"), 0), /BOX_SPOOL_CHUNK_INVALID/);
  const invalid = new BoxSpoolJsonlFramer();
  assert.throws(() => invalid.push(Buffer.from([0xff, 0x0a]), 0), /BOX_SPOOL_UTF8_INVALID/);
  assert.throws(() => invalid.push(Buffer.from("ok\n"), 2), /BOX_SPOOL_FRAMER_CLOSED/);
  const big = new BoxSpoolJsonlFramer();
  let offset = 0;
  for (let i = 0; i < 16; i++) {
    const chunk = Buffer.alloc(65536, 0x61);
    assert.deepEqual(big.push(chunk, offset), []);
    offset += chunk.length;
  }
  assert.throws(() => big.push(Buffer.from("x"), offset), /BOX_SPOOL_LINE_TOO_LARGE/);
});

test("real handoff decoder commits the message_stop byte boundary, not whole read chunk", () => {
  const boxName = "mcp__ocbridge__t0", id = "toolu_one";
  const catalog = compileBoxToolCatalog([{ name: "local_echo", description: "local",
    input_schema: { type: "object" } }]);
  const event = (value: unknown) => ({ type: "stream_event", event: value });
  const use = { type: "tool_use", id, name: boxName, input: { value: "ping" } };
  const values = [
    { type: "system", subtype: "init", tools: [boxName], mcp_servers: [{}] },
    event({ type: "message_start", message: { id: "msg_one", model: "claude-opus-5-5",
      role: "assistant", content: [], usage: { input_tokens: 2, output_tokens: 0 } } }),
    event({ type: "content_block_start", index: 0,
      content_block: { type: "tool_use", id, name: boxName, input: {} } }),
    event({ type: "content_block_delta", index: 0,
      delta: { type: "input_json_delta", partial_json: '{"value":"ping"}' } }),
    { type: "assistant", message: { id: "msg_one", model: "claude-opus-5-5",
      role: "assistant", content: [use] } },
    event({ type: "content_block_stop", index: 0 }),
    event({ type: "message_delta", delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 3, input_tokens: 2 } }),
    event({ type: "message_stop" }),
    { type: "user", message: { content: "after-handoff" } },
  ];
  const spool = Buffer.from(values.map((value) => JSON.stringify(value) + "\n").join(""));
  const lines = new BoxSpoolJsonlFramer().push(spool, 0);
  const decoder = new BoxCliToolHandoffDecoder("claude-opus-5-5", catalog);
  let boundary = 0;
  for (const line of lines) {
    const next = decoder.push(line.text);
    if (next.candidate) { boundary = line.endOffset; break; }
  }
  assert.ok(boundary > 0 && boundary < spool.length);
  assert.ok(decoder.commitHandoff({ durableRevision: "pg-revision-1",
    journaledToolUseIds: [id], verifiedPendingToolUseIds: [id] }).includes("event: message_stop"));
  const resumed = new BoxSpoolJsonlFramer(boundary).push(spool.subarray(boundary), boundary);
  assert.equal(JSON.parse(resumed[0]!.text).type, "user");
});
