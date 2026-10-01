// OCV5-302: Claude Code's Read of an image it resized appends an isMeta user
// message with the dimensions. The continuation classifier rejected the turn
// (409 BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION -> "任务执行暂时中断"). Live
// repro on v5-3e51597ce: Read of a 1290x2796 PNG.
import test from "node:test";
import assert from "node:assert/strict";
import { foldBoxCcbImageMetadata, normalizeBoxSemanticBody } from "./boxCacheAnnotations.js";
import { classifyBoxContinuation } from "./boxPreparedContinuation.js";
import type { ProxyBody } from "./shared.js";

const meta = "[Image: original 1290x2796, displayed at 923x2000. Multiply coordinates by 1.40 to map to original image.]";
const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } };
const tools = [{ name: "Read", description: "read", input_schema: { type: "object" } }];
const body = (last: unknown[], extra: unknown[] = []) => ({ model: "box-api-claude-opus-5-5", max_tokens: 64,
  tools, messages: [
    { role: "user", content: "看图" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "Read",
      input: { file_path: "/tmp/a.png" } }] },
    { role: "user", content: last }, ...extra] }) as unknown as ProxyBody;
const result = { type: "tool_result", tool_use_id: "toolu_img", content: [image] };
const foldedResult = { ...result, content: [image, { type: "text", text: meta }] };

test("OCV5-302 the CCB image-dimension meta joins the image tool_result and continues", () => {
  for (const shaped of [body([result, { type: "text", text: meta }]),
    body([result], [{ role: "user", content: [{ type: "text", text: meta }] }])]) {
    const folded = foldBoxCcbImageMetadata(shaped);
    assert.equal(folded.messages.length, 3);
    assert.deepEqual((folded.messages[2] as { content: unknown[] }).content, [foldedResult]);
    const classified = classifyBoxContinuation(shaped);
    assert.equal(classified.classification, "continuation_candidate", String(classified.rejectCode));
    assert.deepEqual(classified.toolIds, ["toolu_img"]);
    // the semantic body (hashes, matcher, history mapping) sees the same fold
    const semantic = normalizeBoxSemanticBody(shaped);
    assert.equal(JSON.stringify(semantic.messages.at(-1)).includes("Multiply coordinates by 1.40"), true);
  }
});

test("anything other than the exact meta after an image result is left for the classifier to reject", () => {
  const cases = [
    body([result, { type: "text", text: meta + " extra" }]),
    body([result, { type: "text", text: "please also do X" }]),
    body([{ type: "tool_result", tool_use_id: "toolu_img", content: "text only" }, { type: "text", text: meta }]),
    body([result], [{ role: "user", content: [{ type: "text", text: "follow-up question" }] }]),
  ];
  for (const shaped of cases) {
    assert.equal(foldBoxCcbImageMetadata(shaped), shaped, "unchanged");
    assert.equal(classifyBoxContinuation(shaped).classification === "continuation_candidate", false);
  }
});
