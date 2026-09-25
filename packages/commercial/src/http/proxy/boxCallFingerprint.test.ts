import test from "node:test";
import assert from "node:assert/strict";
import type { ProxyBody } from "./shared.js";
import { BoxCallFingerprintError, deriveBoxCallFingerprint,
  deriveBoxContextHash, hashBoxAssistantContent,
  hashBoxAssistantEchoContent } from "./boxCallFingerprint.js";

test("CCB omitted thinking matches only the original text and tool echo", () => {
  const text = { type: "text", text: "synthetic pre-tool text" };
  const tool = { type: "tool_use", id: "toolu_echo", name: "local_echo", input: {} };
  const full = [{ type: "thinking", thinking: "synthetic", signature: "sig" }, text, tool];
  assert.equal(hashBoxAssistantEchoContent(full), hashBoxAssistantContent([text, tool]));
  assert.notEqual(hashBoxAssistantEchoContent(full), hashBoxAssistantContent([tool]));
  assert.notEqual(hashBoxAssistantEchoContent(full),
    hashBoxAssistantContent([{ ...text, text: "rewritten" }, tool]));
});

function body(turnKey = "a".repeat(64)): ProxyBody {
  return { model: "claude-opus-5-5", max_tokens: 128, stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "synthetic" }] }],
    tools: [{ name: "Bash", description: "Synthetic", input_schema: {
      type: "object", properties: { command: { type: "string" } } } }],
    metadata: { session_id: "synthetic-session-289", user_id:
      JSON.stringify({ device_id: "device-a", oc_turn_key: turnKey }) } };
}
function rejects(value: ProxyBody, code: string): void {
  assert.throws(() => deriveBoxCallFingerprint(3n, value),
    (error: unknown) => error instanceof BoxCallFingerprintError && error.code === code);
}

test("canonical body and per-turn metadata yield stable secondary replay fence", () => {
  const first = body();
  const a = deriveBoxCallFingerprint(3n, first);
  const reordered = body();
  reordered.messages = [{ content: [{ text: "synthetic", type: "text" }], role: "user" }];
  reordered.metadata!.user_id = JSON.stringify({ oc_turn_key: "a".repeat(64),
    device_id: "rotated-tracking-only" });
  const b = deriveBoxCallFingerprint(3n, reordered);
  assert.equal(a.requestHash, b.requestHash);
  assert.equal(a.replayFingerprint, b.replayFingerprint);
  assert.match(a.requestHash, /^[a-f0-9]{64}$/);
  assert.equal(a.sessionId, "synthetic-session-289");
});

test("new user turn, uid or changed tool result makes a distinct fingerprint", () => {
  const original = deriveBoxCallFingerprint(3n, body());
  assert.notEqual(original.replayFingerprint,
    deriveBoxCallFingerprint(3n, body("b".repeat(64))).replayFingerprint);
  assert.notEqual(original.replayFingerprint,
    deriveBoxCallFingerprint(4n, body()).replayFingerprint);
  const next = body();
  next.messages.push({ role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_synthetic", content: "local-result" }] });
  assert.notEqual(original.replayFingerprint,
    deriveBoxCallFingerprint(3n, next).replayFingerprint);
});

test("same-turn identical independent call remains deliberately ambiguous", () => {
  const a = deriveBoxCallFingerprint(3n, body());
  const b = deriveBoxCallFingerprint(3n, body());
  assert.equal(a.replayFingerprint, b.replayFingerprint,
    "this must not be advertised as a unique logical-call ID");
});

test("tool continuation binds the complete prior CLI context without storing text", () => {
  const first = body();
  const prior = deriveBoxContextHash(first);
  const resumed = body("b".repeat(64));
  resumed.messages.push({ role: "assistant", content: [{ type: "tool_use",
    id: "toolu_1", name: "Bash", input: { command: "echo synthetic" } }] });
  resumed.messages.push({ role: "user", content: [{ type: "tool_result",
    tool_use_id: "toolu_1", content: "local-result" }] });
  assert.equal(deriveBoxContextHash(resumed, true), prior);
  assert.notEqual(deriveBoxContextHash(resumed), prior);
  const changed = { ...resumed, system: "changed-system" } as ProxyBody;
  assert.notEqual(deriveBoxContextHash(changed, true), prior);
  const changedHistory = { ...resumed, messages: [
    { role: "user", content: "changed-history" }, ...resumed.messages.slice(1)] } as ProxyBody;
  assert.notEqual(deriveBoxContextHash(changedHistory, true), prior);
  assert.notEqual(deriveBoxContextHash({ ...resumed, max_tokens: 256 }, true), prior);
});

test("assistant and context hashes reject sparse arrays", () => {
  const sparse = [{ type: "text", text: "visible" }] as Array<unknown>;
  sparse.length = 2;
  assert.throws(() => hashBoxAssistantContent(sparse), BoxCallFingerprintError);
  const value = body();
  value.messages = sparse as ProxyBody["messages"];
  assert.throws(() => deriveBoxContextHash(value), BoxCallFingerprintError);
});

test("real official CC inner session ID is accepted; conflicting outer ID fails", () => {
  const innerOnly = body();
  delete innerOnly.metadata!.session_id;
  innerOnly.metadata!.user_id = JSON.stringify({ oc_turn_key: "a".repeat(64),
    session_id: "official-cc-session-289" });
  assert.equal(deriveBoxCallFingerprint(3n, innerOnly).sessionId,
    "official-cc-session-289");
  const conflict = body();
  conflict.metadata!.user_id = JSON.stringify({ oc_turn_key: "a".repeat(64),
    session_id: "different-session" });
  rejects(conflict, "BOX_CALL_SESSION_CONFLICT");
  const emptyConflict = body();
  emptyConflict.metadata!.user_id = JSON.stringify({ oc_turn_key: "a".repeat(64),
    session_id: "" });
  rejects(emptyConflict, "BOX_CALL_SESSION_CONFLICT");
});

test("streaming canonical hash accepts model body above old 8MiB cutoff", () => {
  const large = body();
  large.messages = [{ role: "user", content: "x".repeat(8_400_000) }];
  assert.match(deriveBoxCallFingerprint(3n, large).requestHash, /^[a-f0-9]{64}$/);
});

test("missing identity, malformed metadata and excessive nesting fail closed", () => {
  const missing = body(); delete missing.metadata!.session_id;
  rejects(missing, "BOX_CALL_IDENTITY_MISSING");
  const malformed = body(); malformed.metadata!.user_id = "not-json";
  rejects(malformed, "BOX_CALL_IDENTITY_INVALID");
  const absent = body(); absent.metadata!.user_id = JSON.stringify({ device_id: "x" });
  rejects(absent, "BOX_CALL_TURN_KEY_MISSING");
  const deep = body();
  let value: unknown = "leaf";
  for (let i = 0; i < 70; i++) value = [value];
  deep.messages = [{ role: "user", content: value }];
  rejects(deep, "BOX_CALL_BODY_TOO_DEEP");
});
