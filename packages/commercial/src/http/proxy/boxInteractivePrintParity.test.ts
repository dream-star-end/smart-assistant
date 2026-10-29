/** OCV5-378: the interactive Box runner (box-bridge-mod host.py in print mode) feeds the Box model
 * route the same stream-json as `claude -p`. The oc-bridge mod's print mode (StreamJson.printStep)
 * is driven with the chunk and row sequences recorded from an interactive Claude Code on the Box
 * (CLI 2.1.296, Haiku 5.5, 2026-10-12), and its lines go through the route's own decoders.
 *
 * Run: npx tsx --test packages/commercial/src/http/proxy/boxInteractivePrintParity.test.ts */
import test from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBoxCliSseDecoder } from "./boxCliSse.js";
import { BoxCliToolHandoffDecoder } from "./boxCliToolHandoff.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { readBoxProfileSignals } from "./boxProfileSignals.js";

const FRAMES = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)),
  "../../../../gateway/box-bridge-mod/oc-bridge/hooks/frames.ts")).href;
const MODEL = "claude-haiku-5-5";

async function session(): Promise<any> {
  const { StreamJson } = await import(FRAMES);
  const sj = new StreamJson();
  sj.sessionId = "2ad14851-bc87-4916-8d5a-36de6f0c04ce";
  sj.model = MODEL;
  sj.cwd = "/tmp/ocv5-289-run-0123456789abcdef01234567";
  sj.plugins = ["oc-bridge"];
  return sj;
}

const row = (uuid: string, content: unknown[]) => ({ door: "response", uuid,
  message: { type: "assistant", role: "assistant", content } });

/** One text turn with thinking, as recorded: thinking text is not exposed, its signature is. */
async function textTurn(): Promise<string[]> {
  const sj = await session();
  const usage = { input_tokens: 2, output_tokens: 49, cache_read_input_tokens: 0, cache_creation_input_tokens: 773 };
  sj.turnStart();
  const lines = [sj.printInit([], [])];
  lines.push(...sj.printStep({ turnId: "1120d00a-c0ee-4266-843e-fdf5fa8b6816", index: 0, model: MODEL,
    chunks: [{ kind: "engine", ref: 1 }, { kind: "thinking", index: 0, text: "", ref: 3 },
      { kind: "text", index: 1, text: "17 ×", ref: 8 }, { kind: "text", index: 1, text: " 23 = 391", ref: 9 }],
    rows: [row("3abe1967-f7da-4ff9-b080-87e5aa1dfcdd", [{ type: "thinking", thinking: "", signature: "CAQSggUKEAgS" }]),
      row("125afc80-8600-4959-ae8f-1fc2e27f6f06", [{ type: "text", text: "17 × 23 = 391" }])] },
  { stopReason: "end_turn", usage }));
  lines.push(sj.result({ reason: "answer", answer: "17 × 23 = 391", durationMs: 1352, usage }, "end_turn"));
  return lines;
}

test("print mode orders a step exactly as claude -p does", async () => {
  const kinds = (await textTurn()).map((line) => {
    const record = JSON.parse(line);
    if (record.type !== "stream_event") return record.subtype ? `${record.type}:${record.subtype}` : record.type;
    const delta = record.event.delta?.type;
    return `${record.event.type}${record.event.index !== undefined ? `:${record.event.index}` : ""}${delta ? `:${delta}` : ""}`;
  });
  // Recorded from `claude -p --output-format stream-json --include-partial-messages` (same CLI, same turn shape).
  assert.deepEqual(kinds, ["system:init", "message_start", "content_block_start:0",
    "content_block_delta:0:thinking_delta", "content_block_delta:0:signature_delta", "assistant", "content_block_stop:0",
    "content_block_start:1", "content_block_delta:1:text_delta", "content_block_delta:1:text_delta", "assistant",
    "content_block_stop:1", "message_delta", "message_stop", "result:success"]);
});

test("a text turn decodes on the Box model route with its real usage", async () => {
  const decoder = createBoxCliSseDecoder(MODEL);
  let sse = "";
  for (const line of await textTurn()) sse += decoder.push(`${line}\n`);
  const done = decoder.finish();
  sse += done.tailSse;
  assert.deepEqual([done.inputTokens, done.outputTokens, done.cacheReadTokens, done.cacheWriteTokens], [2, 49, 0, 773]);
  assert.ok(sse.includes("17 ×"));
  assert.ok(sse.includes('"signature":"CAQSggUKEAgS"'), "the thinking block keeps its signature");
  const message = decoder.completedMessage() as { content: { type: string }[] };
  assert.deepEqual(message.content.map((block) => block.type), ["thinking", "text"]);
});

test("a tool step decodes as one handoff before the tool returns", async () => {
  const catalog = compileBoxToolCatalog([{ name: "Bash", description: "Synthetic local tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
  const boxName = catalog.boxNameByClientName.get("Bash")!;
  const sj = await session();
  sj.turnStart();
  const usage = { input_tokens: 2, output_tokens: 58, cache_read_input_tokens: 745, cache_creation_input_tokens: 494 };
  const id = "toolu_01J7Ebw2dvSaLNYNoUdAKmD5";
  const lines = [sj.printInit([boxName], [{ name: "ocbridge", status: "connected" }]),
    ...sj.printStep({ turnId: "8e5384db-6d0d-4f2f-9643-97ece0f1467d", index: 0, model: MODEL,
      chunks: [{ kind: "tool", index: 0, id, name: boxName, ref: 2 }, { kind: "input", index: 0, json: "", ref: 3 },
        { kind: "input", index: 0, json: '{"value": "sa', ref: 4 }, { kind: "input", index: 0, json: 'me"}', ref: 5 }],
      rows: [row("c1", [{ type: "tool_use", id, name: boxName, input: { value: "same" }, caller: { type: "direct" } }])] },
    { stopReason: "tool_use", usage })];
  const decoder = new BoxCliToolHandoffDecoder(MODEL, catalog);
  for (const line of lines) decoder.push(`${line}\n`);
  const candidate = decoder.push("").candidate;
  assert.ok(candidate, "one complete handoff");
  assert.deepEqual(candidate.toolUses.map((use) => [use.id, use.input]), [[id, { value: "same" }]]);
  // The tool decoder takes the step's usage from message_delta too, and refuses a zero start without it.
  const missing = lines.map((line) => {
    const record = JSON.parse(line);
    if (record.type === "stream_event" && record.event.type === "message_delta") Reflect.deleteProperty(record.event.usage, "input_tokens");
    return JSON.stringify(record);
  });
  const refuses = new BoxCliToolHandoffDecoder(MODEL, catalog);
  assert.throws(() => { for (const line of missing) refuses.push(`${line}\n`); }, /BOX_TOOL_USAGE_MISMATCH/);
});

// ---- streamed print mode (OCV5-378: the client must learn the model is working, as on -p) ----

const kindOf = (line: string): string => {
  const record = JSON.parse(line);
  if (record.type !== "stream_event") return record.type;
  return `${record.event.type}${record.event.index !== undefined ? `:${record.event.index}` : ""}${record.event.delta?.type ? `:${record.event.delta.type}` : ""}`;
};

test("streamed print mode: message_start at once, thinking opens on its first chunk, later blocks wait for the row", async () => {
  const sj = await session();
  sj.turnStart();
  assert.deepEqual(sj.printStart({ turnId: "t1", index: 0, model: MODEL }).map(kindOf), ["message_start"]);
  // Recorded order on the Box (cc2): thinking chunks, then the thinking row, then text chunks, text row, stop.
  assert.deepEqual(sj.printChunk({ kind: "thinking", index: 0, text: "" }).map(kindOf),
    ["content_block_start:0", "content_block_delta:0:thinking_delta"]);
  // A text chunk before the thinking row waits (the thinking block is still open).
  assert.deepEqual(sj.printChunk({ kind: "text", index: 1, text: "37" }), []);
  assert.deepEqual(sj.printRow(row("r1", [{ type: "thinking", thinking: "", signature: "SIG" }])).map(kindOf),
    ["content_block_delta:0:signature_delta", "assistant", "content_block_stop:0",
      "content_block_start:1", "content_block_delta:1:text_delta"]);
  assert.deepEqual(sj.printChunk({ kind: "text", index: 1, text: "8" }).map(kindOf), ["content_block_delta:1:text_delta"]);
  assert.deepEqual(sj.printRow(row("r2", [{ type: "text", text: "378" }])).map(kindOf), ["assistant", "content_block_stop:1"]);
  const stop = sj.printStop({ stopReason: "end_turn", usage: { input_tokens: 2, output_tokens: 49,
    cache_read_input_tokens: 0, cache_creation_input_tokens: 773 } });
  assert.deepEqual(stop.map(kindOf), ["message_delta", "message_stop"]);
  assert.deepEqual(JSON.parse(stop[0]!).event.usage, { input_tokens: 2, cache_creation_input_tokens: 773,
    cache_read_input_tokens: 0, output_tokens: 49 });
});

test("streamed print mode: a tool_use block opens with its stored fields once its row arrives", async () => {
  const sj = await session();
  sj.turnStart();
  sj.printStart({ turnId: "t2", index: 0, model: MODEL });
  assert.deepEqual(sj.printChunk({ kind: "tool", index: 0, id: "toolu_1", name: "mcp__ocbridge__Bash" }), []);
  assert.deepEqual(sj.printChunk({ kind: "input", index: 0, json: '{"value":"x"}' }), []);
  const closed = sj.printRow(row("r3", [{ type: "tool_use", id: "toolu_1", name: "mcp__ocbridge__Bash",
    input: { value: "x" }, caller: { type: "direct" } }]));
  assert.deepEqual(closed.map(kindOf), ["content_block_start:0", "content_block_delta:0:input_json_delta", "assistant", "content_block_stop:0"]);
  assert.deepEqual(JSON.parse(closed[0]!).event.content_block, { type: "tool_use", id: "toolu_1",
    name: "mcp__ocbridge__Bash", input: {}, caller: { type: "direct" } });
});

test("usage at stop: the forwarded SSE bills the real usage; a zero start without usage at stop is refused", async () => {
  const { _UsageObserver } = await import("./shared.js");
  const decoder = createBoxCliSseDecoder(MODEL);
  const observer = new _UsageObserver();
  let sse = "";
  for (const line of await textTurn()) sse += decoder.push(`${line}\n`);
  sse += decoder.finish().tailSse;
  observer.push(sse);
  observer.flush();
  const result = observer.result();
  assert.equal(result.kind, "final");
  assert.deepEqual(result.usage, { input_tokens: 2n, output_tokens: 49n, cache_read_tokens: 0n, cache_write_tokens: 773n });
  // An all-zero start whose message_delta does not carry the input usage is not accepted (SSE and tool decoders).
  const lines = (await textTurn()).map((line) => {
    const record = JSON.parse(line);
    if (record.type === "stream_event" && record.event.type === "message_delta") Reflect.deleteProperty(record.event.usage, "input_tokens");
    return JSON.stringify(record);
  });
  const bad = createBoxCliSseDecoder(MODEL);
  assert.throws(() => { for (const line of lines) bad.push(`${line}\n`); }, /BOX_CLI_USAGE_MISMATCH/);
  // A -p start (non-zero usage) still has to agree with its message_delta exactly.
  const strict = (await textTurn()).map((line) => {
    const record = JSON.parse(line);
    if (record.type === "stream_event" && record.event.type === "message_start") record.event.message.usage.input_tokens = 2;
    if (record.type === "stream_event" && record.event.type === "message_delta") record.event.usage.input_tokens = 3;
    return JSON.stringify(record);
  });
  const p = createBoxCliSseDecoder(MODEL);
  assert.throws(() => { for (const line of strict) p.push(`${line}\n`); }, /BOX_CLI_USAGE_MISMATCH/);
});

// ---- an API error stand-in (2026-10-29: the Box default login's refresh failed) ----

/** As the interactive runner ran it on the Box (CLI 2.1.312, a login whose refresh failed): the
 * engine's stand-in row comes in with origin model `<synthetic>` and the step ends without a stop. */
async function apiErrorTurn(tools: string[], servers: { name: string; status: string }[],
  origin: { kind: string; model?: string }): Promise<string[]> {
  const sj = await session();
  sj.turnStart();
  return [sj.printInit(tools, servers),
    ...sj.printStep({ turnId: "e8f0f6f2-3c4f-4f0e-9a51-0c6c4f6b2d10", index: 0, model: MODEL, chunks: [],
      rows: [{ door: "response", uuid: "c7c846e6-1787-4b04-a29f-d800698c1e4a", origin,
        message: { type: "assistant", content: [{ type: "text", text: "Login expired · Please run /login" }] } }] },
    { stopReason: null, usage: null }),
    sj.result({ reason: "error", answer: "", durationMs: 150 }, null)];
}

test("an API error stand-in is the named upstream refusal on both decoders and a login signal, as on -p", async () => {
  const lines = await apiErrorTurn([], [], { kind: "model", model: "<synthetic>" });
  const record = lines.map((line) => JSON.parse(line)).find((item) => item.type === "assistant");
  assert.equal(record.message.model, "<synthetic>");
  assert.equal(record.is_api_error_message, true);
  const sse = createBoxCliSseDecoder(MODEL);
  assert.throws(() => { for (const line of lines) sse.push(`${line}\n`); }, /BOX_CLI_UPSTREAM_REFUSED/);
  assert.deepEqual(readBoxProfileSignals(`${lines.join("\n")}\n`), [{ kind: "login_required" }]);
  const catalog = compileBoxToolCatalog([{ name: "Bash", description: "Synthetic local tool",
    input_schema: { type: "object", properties: { value: { type: "string" } } } }]);
  const tool = await apiErrorTurn([catalog.boxNameByClientName.get("Bash")!],
    [{ name: "ocbridge", status: "connected" }], { kind: "model", model: "<synthetic>" });
  const decoder = new BoxCliToolHandoffDecoder(MODEL, catalog);
  assert.throws(() => { for (const line of tool) decoder.push(`${line}\n`); }, /BOX_CLI_UPSTREAM_REFUSED/);
});

test("the model's own answer stays an answer even when it reads like a login notice", async () => {
  const sj = await session();
  sj.turnStart();
  const text = "Login expired · Please run /login";
  const usage = { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  const lines = [sj.printInit([], []),
    ...sj.printStep({ turnId: "0d7f6f8e-8a43-4c55-9d3e-6d7b2f1e4a21", index: 0, model: MODEL,
      chunks: [{ kind: "text", index: 0, text }],
      rows: [{ ...row("a1", [{ type: "text", text }]), origin: { kind: "model", model: MODEL } }] },
    { stopReason: "end_turn", usage }),
    sj.result({ reason: "answer", answer: text, durationMs: 900, usage }, "end_turn")];
  const decoder = createBoxCliSseDecoder(MODEL);
  for (const line of lines) decoder.push(`${line}\n`);
  assert.equal(decoder.finish().outputTokens, 9);
  assert.deepEqual(readBoxProfileSignals(`${lines.join("\n")}\n`), []);
});
