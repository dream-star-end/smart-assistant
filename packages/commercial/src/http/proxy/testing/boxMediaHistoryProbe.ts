import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deriveBoxContextHash } from "../boxCallFingerprint.js";
import { classifyBoxContinuation } from "../boxPreparedContinuation.js";
import type { ProxyBody } from "../shared.js";
import { assertLegacyContextClaim } from "./boxContextTransportClaim.js";

const { prepareRequestMediaItems, stripExcessMediaItems } = await import(new URL(
  "../../../../../../claude-code-best/src/services/api/mediaItems.ts", import.meta.url).href);
const MODEL = "box-api-claude-opus-5-5";
const image = () => ({ type: "image", source: { type: "base64", media_type: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=" } });
const use = (id: string) => ({ type: "tool_use", id, name: "Read", input: { file_path: "/synthetic.png" } });

export function mediaHistoryFixture(oldCount = 100, addedCount = 2): { before: ProxyBody; after: ProxyBody } {
  const metadata = { user_id: JSON.stringify({ session_id: `media-prefix-${randomBytes(8).toString("hex")}`,
    oc_turn_key: "7".repeat(64) }) };
  const before: ProxyBody = { model: MODEL, max_tokens: 128, stream: true, metadata,
    tools: [{ name: "Read", description: "synthetic image read", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "Keep the completed image reads." },
      { role: "assistant", content: [use("toolu_old")] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old",
        content: Array.from({ length: oldCount }, image) }] }] };
  const ids = Array.from({ length: 6 }, (_, i) => `toolu_new_${i}`);
  const after: ProxyBody = { ...before, messages: [...before.messages,
    { role: "assistant", content: ids.map(use) },
    { role: "user", content: ids.map((id, i) => ({ type: "tool_result", tool_use_id: id,
      content: i < addedCount ? [image()] : "completed without media" })) }] };
  return { before, after };
}

/** Use the exact CCB projection and the server's actual semantic hash. */
export function projectMediaHistory(body: ProxyBody, legacy = false): ProxyBody {
  const messages = body.messages.map(message => ({
    type: (message as { role: string }).role, message,
  }));
  const projected = legacy ? stripExcessMediaItems(messages as never, 100)
    : prepareRequestMediaItems(messages as never, 100, body.model);
  return { ...body, messages: projected.map((message: { message: unknown }) => message.message) };
}

export function assertMediaHistoryPrefix(): void {
  for (const [oldCount, addedCount] of [[99, 2], [100, 2], [102, 2], [101, 0]]) {
    const { before, after } = mediaHistoryFixture(oldCount, addedCount);
    assert.equal(deriveBoxContextHash(projectMediaHistory(after), true),
      deriveBoxContextHash(projectMediaHistory(before)), `${oldCount}+${addedCount} preserves the first bound prefix`);
    assert.equal(classifyBoxContinuation(projectMediaHistory(after)).classification, "continuation_candidate");
  }
  const { before, after } = mediaHistoryFixture();
  assert.notEqual(deriveBoxContextHash(projectMediaHistory(after, true), true),
    deriveBoxContextHash(projectMediaHistory(before, true)), "old 100-item projection reproduces the prefix mutation");
  const changed = structuredClone(after);
  (changed.messages[0] as { content: string }).content += " changed";
  assert.notEqual(deriveBoxContextHash(projectMediaHistory(changed), true),
    deriveBoxContextHash(projectMediaHistory(before)), "a real old-prefix edit remains different");
}

/** Reuse the real journal on the existing gate's isolated TEMP billing mirror. */
export async function proveMediaHistoryPrefix(db: { query: (sql: string, params?: unknown[]) => Promise<any> }): Promise<string> {
  assertMediaHistoryPrefix();
  const { before, after } = mediaHistoryFixture();
  await assertLegacyContextClaim(db, projectMediaHistory(after), { imageCount: 102,
    priorContextHash: deriveBoxContextHash(projectMediaHistory(before)), rejectedBody: projectMediaHistory(after, true) });
  return "[box-media-prefix] PASS — 100 historical images plus two new results preserve the original prefix, claim once, reject count-trimmed and duplicate claims, and change no wallet or prior settlement";
}
