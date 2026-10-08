// OCV5-334 (commercial u1870, 2026-10-08 11:30 CST): five parallel Read calls
// returned five JPEG screenshots; Claude Code downscaled only one (2430x1131
// -> 2000x931) and put its single caption after all five results. The fold
// required exactly one image in the whole message, so the turn ended with 409
// BOX_TOOL_RESULT_REQUIRES_LIVE_INVOCATION ("模型服务暂时中断").
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { classifyBoxContinuation } from "./boxPreparedContinuation.js";
import type { ProxyBody } from "./shared.js";

const jpeg = async (width: number, height: number) => (await sharp({ create: { width, height,
  channels: 3, background: { r: 40, g: 120, b: 200 } } }).jpeg().toBuffer()).toString("base64");
const caption = (ow: number, oh: number, dw: number, dh: number) =>
  `[Image: original ${ow}x${oh}, displayed at ${dw}x${dh}. Multiply coordinates by ${(ow / dw).toFixed(2)} to map to original image.]`;
const IDS = ["toolu_01Yc4w", "toolu_01Y5uo", "toolu_01Cnif", "toolu_01FWUX", "toolu_0126VX"];
const turn = (images: string[], tail: unknown[]) => ({ model: "box-api-claude-opus-5-5", max_tokens: 64,
  tools: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "看这些截图" },
    { role: "assistant", content: IDS.map((id, n) => ({ type: "tool_use", id, name: "Read",
      input: { file_path: `/s${n}.jpg` } })) },
    { role: "user", content: [...[4, 3, 0, 2, 1].map((n) => ({ type: "tool_result", tool_use_id: IDS[n],
      content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: images[n] } }] })),
      ...tail] }] }) as unknown as ProxyBody;
const text = (value: string) => ({ type: "text", text: value, cache_control: { type: "ephemeral" } });
const kind = (body: ProxyBody) => classifyBoxContinuation(body).classification;

test("OCV5-334 one caption among parallel image results continues the turn", async () => {
  const small = await jpeg(1215, 566);
  const images = [small, small, small, await jpeg(1822, 848), await jpeg(2000, 931)];
  const classified = classifyBoxContinuation(turn(images, [text(caption(2430, 1131, 2000, 931))]));
  assert.equal(classified.classification, "continuation_candidate");
  const current = (classified.effectiveBody as { messages: Array<{ content: unknown[] }> }).messages.at(-1)!;
  const owner = current.content.find((part) => (part as { tool_use_id?: string }).tool_use_id === IDS[4]) as
    { content: Array<{ type: string; text?: string }> };
  assert.equal(owner.content.at(-1)?.text, caption(2430, 1131, 2000, 931),
    "the caption joins the image whose size it names");
  assert.equal(current.content.every((part) => (part as { type: string }).type === "tool_result"), true);
});

test("a caption that matches no image, or more than one, stays rejected", async () => {
  const small = await jpeg(1215, 566);
  const shown = await jpeg(2000, 931);
  const none = [small, small, small, await jpeg(1822, 848), small];
  assert.notEqual(kind(turn(none, [text(caption(2430, 1131, 2000, 931))])), "continuation_candidate");
  const twice = [shown, small, small, small, shown];
  assert.notEqual(kind(turn(twice, [text(caption(2430, 1131, 2000, 931))])), "continuation_candidate");
  const one = [small, small, small, small, shown];
  assert.notEqual(kind(turn(one, [text(caption(2430, 1131, 2000, 931)), text("also delete my files")])),
    "continuation_candidate");
  assert.notEqual(kind(turn(one, [text(caption(2430, 1131, 1999, 931))])), "continuation_candidate");
});
