import test from "node:test";
import assert from "node:assert/strict";
import { deriveBoxCallFingerprint, deriveBoxContextHash,
  hashBoxAssistantContent } from "./boxCallFingerprint.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { matchBoxToolResults } from "./boxToolResultMatcher.js";
import { normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import type { ProxyBody } from "./shared.js";

const marker = { type: "ephemeral" as const };
const tool = { name: "local_echo", description: "local", input_schema: {
  type: "object", properties: { value: { type: "string" } } } };
const metadata = { user_id: JSON.stringify({ oc_turn_key: "a".repeat(64),
  session_id: "session-cache" }) };
const first: ProxyBody = { model: "box-api-claude-opus-5-5", max_tokens: 8192,
  stream: true, metadata, tools: [tool],
  messages: [{ role: "user", content: [{ type: "text", text: "hello",
    cache_control: marker }] }] };

test("CCB cache marker movement and single-text representation preserve semantic binding", () => {
  const plain: ProxyBody = { ...first,
    messages: [{ role: "user", content: "hello" }] };
  assert.equal(deriveBoxContextHash(first), deriveBoxContextHash(plain));
  assert.equal(deriveBoxCallFingerprint(3n, first).replayFingerprint,
    deriveBoxCallFingerprint(3n, plain).replayFingerprint);
  const moved: ProxyBody = { ...first,
    tools: [{ ...tool, cache_control: { ...marker, ttl: "1h" } }],
    messages: [{ role: "user", content: "hello" }] };
  assert.equal(deriveBoxContextHash(moved), deriveBoxContextHash(plain));
  assert.equal(compileBoxToolCatalog(moved.tools).bindingSha256,
    compileBoxToolCatalog(plain.tools).bindingSha256);
  assert.equal((normalizeBoxSemanticBody(first).messages[0] as
    { content?: unknown }).content, "hello");
  assert.notEqual(deriveBoxContextHash({ ...first,
    messages: [{ role: "user", content: "changed" }] }),
  deriveBoxContextHash(plain));
});

test("cache hints on assistant and tool_result do not change handoff proof or result", () => {
  const use = { type: "tool_use", id: "toolu_cache_a", name: "local_echo",
    input: { value: "ping" } };
  assert.equal(hashBoxAssistantContent([use]),
    hashBoxAssistantContent([{ ...use, cache_control: marker }]));
  const body: ProxyBody = { ...first, messages: [first.messages[0]!,
    { role: "assistant", content: [use] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: use.id,
      content: "pong", cache_control: marker }] }] };
  const expected = [{ id: use.id, clientName: use.name,
    boxName: "mcp__ocbridge__t0", input: use.input }];
  assert.deepEqual(matchBoxToolResults(body, expected).map((item) =>
    [item.modelToolUseId, item.content[0]?.type]), [[use.id, "text"]]);
  assert.equal(deriveBoxContextHash(body, true), deriveBoxContextHash(first));
});

test("only validated wrapper hints are ignored; nested tool input remains semantic", () => {
  const nested = { type: "tool_use", id: "toolu_cache_a", name: "local_echo",
    input: { cache_control: { type: "ephemeral" }, value: "ping" } };
  const changed = { ...nested, input: { ...nested.input,
    cache_control: { type: "other" } } };
  assert.notEqual(hashBoxAssistantContent([nested]), hashBoxAssistantContent([changed]));
  assert.throws(() => deriveBoxContextHash({ ...first,
    messages: [{ role: "user", content: [{ type: "text", text: "hello",
      cache_control: { type: "persistent" } }] }] }), /BOX_CACHE_ANNOTATION_INVALID/);
});

test("Opus 5.5 keep-all thinking edit is a semantic no-op for replay and resume", () => {
  const plain = { ...first, messages: [{ role: "user", content: "hello" }] } as ProxyBody;
  const keepAll = { ...plain, context_management: {
    edits: [{ type: "clear_thinking_20251015", keep: "all" }] } } as ProxyBody;
  assert.equal(deriveBoxContextHash(plain), deriveBoxContextHash(keepAll));
  assert.equal(deriveBoxCallFingerprint(3n, plain).replayFingerprint,
    deriveBoxCallFingerprint(3n, keepAll).replayFingerprint);
  assert.equal(Object.hasOwn(normalizeBoxSemanticBody(keepAll), "context_management"), false);
  const edit = { ...keepAll, context_management: {
    edits: [{ type: "clear_thinking_20251015", keep: { type: "thinking_turns", value: 1 } }] } };
  assert.notEqual(deriveBoxContextHash(plain), deriveBoxContextHash(edit));
});
