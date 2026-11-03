import test from "node:test";
import assert from "node:assert/strict";
import { assertMediaHistoryPrefix, mediaHistoryFixture, projectMediaHistory } from "./testing/boxMediaHistoryProbe.js";
import { deriveBoxContextHash } from "./boxCallFingerprint.js";
import { compileBoxCliSyntheticTurn } from "./boxMessagesMapper.js";

const { prepareRequestMediaItems } = await import(new URL(
  "../../../../../claude-code-best/src/services/api/mediaItems.ts", import.meta.url).href);
const { BOX_NATIVE_CONTEXT_MODELS } = await import(new URL(
  "../../../../../claude-code-best/src/utils/model/boxNativeRemoteContext.ts", import.meta.url).href);

test("Box media history preserves the bound prefix across 100 images", assertMediaHistoryPrefix);

test("every native Box model keeps the full fresh history and ordinary providers keep the original cap", () => {
  const { after } = mediaHistoryFixture();
  const original = structuredClone(after);
  const messages = after.messages.map(message => ({ type: "user", message }));
  for (const model of BOX_NATIVE_CONTEXT_MODELS) {
    assert.equal(prepareRequestMediaItems(messages as never, 100, model), messages);
  }
  for (const model of ["claude-opus-5-5", "gpt-5.5", "box-api-unknown", "BOX-API-CLAUDE-OPUS-5-5"]) {
    assert.notEqual(prepareRequestMediaItems(messages as never, 100, model), messages);
    assert.deepEqual(projectMediaHistory({ ...after, model }), projectMediaHistory({ ...after, model }, true));
  }
  assert.deepEqual(after, original, "provider projection never mutates the caller history");
});

test("fresh Box history over 100 images is staged intact and a real old media edit still changes the hash", () => {
  const { before, after } = mediaHistoryFixture(101);
  const projected = projectMediaHistory(before);
  const staged = compileBoxCliSyntheticTurn({ ...projected, messages: [...projected.messages,
    { role: "assistant", content: "Ready" }, { role: "user", content: "Read the next file" }] },
  { cwd: `/tmp/ocv5-289-run-${"a".repeat(24)}`, cliVersion: "2.1.280" });
  const records = staged.snapshotJsonl.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const result = records.flatMap(record => record.message?.content ?? [])
    .find(block => block.type === "tool_result");
  assert.equal(result.content.filter((block: { type: string }) => block.type === "image").length, 101);
  const changed = structuredClone(after);
  const oldResult = (changed.messages[2] as any).content[0];
  oldResult.content[0].source.data = Buffer.from("different old bytes").toString("base64");
  assert.notEqual(deriveBoxContextHash(projectMediaHistory(changed), true), deriveBoxContextHash(projected));
});
