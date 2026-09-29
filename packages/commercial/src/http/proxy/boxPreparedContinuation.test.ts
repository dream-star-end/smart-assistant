import test from "node:test";
import assert from "node:assert/strict";
import { authoritiesBind, classifyBoxContinuation, decisionMayPublish,
  prepareBoxContinuation, preparedMatchesBody, projectAuthority,
  trustedIdentitiesBind } from "./boxPreparedContinuation.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash } from "./boxCallFingerprint.js";
import type { ProxyBody } from "./shared.js";

const caption = "[Image: original 80x2200, displayed at 73x2000. Multiply coordinates by 1.10 to map to original image.]";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const hook = "<system-reminder>\nPreToolUse:Read hook additional context: keep the figure.\n</system-reminder>";
const tools = [
  { name: "Read", description: "read", input_schema: { type: "object", properties: {} } },
  { name: "Note", description: "note", input_schema: { type: "object", properties: {} } },
];

function body(messages: unknown[], extra: Record<string, unknown> = {}): ProxyBody {
  return { model: "box-api-claude-opus-5-5", stream: true, max_tokens: 128, tools,
    messages, metadata: { user_id: JSON.stringify({ session_id: "sess-a",
      oc_turn_key: "ab".repeat(32) }) }, ...extra } as ProxyBody;
}

const imageTurn = body([
  { role: "user", content: "look" },
  { role: "assistant", content: [
    { type: "tool_use", id: "toolu_img_owner", name: "Read", input: { file_path: "a.png" } },
    { type: "tool_use", id: "toolu_note_last", name: "Note", input: { file_path: "a.md" } },
  ] },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: "toolu_img_owner", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] },
    { type: "tool_result", tool_use_id: "toolu_note_last", content: "note-bytes" },
    { type: "text", text: caption },
    { type: "text", text: hook },
  ] },
  { role: "system", content: [{ type: "text", text: "<total_tokens>14999987 tokens left</total_tokens>",
    cache_control: { type: "ephemeral" } }] },
]);

test("current image and hook tail is a continuation, not a fresh launch", () => {
  const view = classifyBoxContinuation(imageTurn);
  assert.equal(view.classification, "continuation_candidate");
  assert.equal(view.rejectCode, null);
  assert.deepEqual(view.toolIds, ["toolu_img_owner", "toolu_note_last"]);
  assert.equal(view.priorContextHash, deriveBoxContextHash(imageTurn, true));
  assert.equal(view.nextContextHash, deriveBoxContextHash(imageTurn));
  const prepared = prepareBoxContinuation({ uid: 3n, canonicalModel: imageTurn.model,
    rawBody: imageTurn, authorityKind: "bridge_signed", authorityTurnId: "cd".repeat(16) });
  assert.equal(prepared.fingerprint?.replayFingerprint,
    deriveBoxCallFingerprint(3n, imageTurn).replayFingerprint);
  assert.equal(preparedMatchesBody(prepared, imageTurn), true);
  const changed = structuredClone(imageTurn);
  (changed.messages[0] as { content: string }).content = "different";
  assert.equal(preparedMatchesBody(prepared, changed), false);
});

test("a later plain user message stays fresh even when history has tool results", () => {
  const next = body([
    ...(imageTurn.messages as unknown[]),
    { role: "assistant", content: [{ type: "text", text: "done" }] },
    { role: "user", content: "thanks" },
  ]);
  const view = classifyBoxContinuation(next);
  assert.equal(view.classification, "fresh");
  assert.deepEqual(view.toolIds, []);
});

test("unknown current tool text and a missing catalog do not fall through to fresh", () => {
  const unknown = body([
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_img_owner",
      name: "Read", input: { file_path: "a.png" } }] },
    { role: "user", content: [
      { type: "tool_result", tool_use_id: "toolu_img_owner", content: "ok" },
      { type: "text", text: "please also change the plan" },
    ] },
  ]);
  assert.equal(classifyBoxContinuation(unknown).classification, "reject");
  assert.equal(classifyBoxContinuation(unknown).rejectCode, "BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION");
  const bare = { ...imageTurn, tools: [] } as ProxyBody;
  const missing = classifyBoxContinuation(bare);
  assert.equal(missing.classification, "reject");
  assert.equal(missing.rejectCode, "BOX_PREPARED_CATALOG_MISSING");
});

test("signed authority is equal only both ways, and one side cannot downgrade", () => {
  const signed = projectAuthority("bridge_signed", "ab".repeat(16));
  const other = projectAuthority("bridge_signed", "cd".repeat(16));
  const legacy = projectAuthority("local_catalog", null);
  const broken = projectAuthority("bridge_signed", "not-a-turn");
  assert.equal(authoritiesBind(signed, signed).ok, true);
  assert.equal(authoritiesBind(signed, other).ok, false);
  assert.equal(authoritiesBind(signed, legacy).ok, false);
  assert.equal(authoritiesBind(legacy, legacy).ok, true);
  assert.equal(broken.kind, "malformed");
  assert.equal(authoritiesBind(broken, legacy).ok, false);
  const base = { uid: 3n, sessionId: "sess-a", canonicalModel: "box-api-claude-opus-5-5",
    turnKey: "ab".repeat(32), authority: signed };
  assert.equal(trustedIdentitiesBind(base, { ...base, sessionId: "sess-b" }).ok, false);
  assert.equal(trustedIdentitiesBind(base, { ...base, turnKey: "cd".repeat(32) }).ok, false);
  assert.equal(decisionMayPublish({ kind: "new_claim" }), true);
  assert.equal(decisionMayPublish({ kind: "in_progress_or_unknown" }), false);
  assert.equal(decisionMayPublish({ kind: "reject" }), false);
});
