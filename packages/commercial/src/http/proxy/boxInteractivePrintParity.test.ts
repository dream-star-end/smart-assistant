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
});
