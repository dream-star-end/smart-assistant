// OCV5-302 live smoke on v5-3e51597ce: Claude Code's caption after a resized
// Read image carries the prompt-cache breakpoint, and real screenshots come in
// many sizes; either made the continuation 409 (BOX_TOOL_RESULT_REQUIRES_LIVE_
// INVOCATION -> "任务执行暂时中断"). The caption must be proven by the image.
import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { classifyBoxContinuation } from "./boxPreparedContinuation.js";
import type { ProxyBody } from "./shared.js";

const png = async (width: number, height: number) => (await sharp({ create: { width, height,
  channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer()).toString("base64");
const caption = (ow: number, oh: number, dw: number, dh: number, scale = (ow / dw).toFixed(2)) =>
  `[Image: original ${ow}x${oh}, displayed at ${dw}x${dh}. Multiply coordinates by ${scale} to map to original image.]`;
const turn = (data: string, tail: unknown[]) => ({ model: "box-api-claude-opus-5-5", max_tokens: 64,
  tools: [{ name: "Read", description: "r", input_schema: { type: "object" } }],
  messages: [{ role: "user", content: "看图" },
    { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "Read",
      input: { file_path: "/a.png" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_img", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data } }] }, ...tail] }] }) as unknown as ProxyBody;
const text = (value: string, cache?: unknown) => ({ type: "text", text: value,
  ...(cache === undefined ? {} : { cache_control: cache }) });
const kind = (body: ProxyBody) => classifyBoxContinuation(body).classification;

test("OCV5-302 the cached caption of the live repro image continues the turn", async () => {
  const shown = await png(923, 2000);
  assert.equal(kind(turn(shown, [text(caption(1290, 2796, 923, 2000), { type: "ephemeral" })])),
    "continuation_candidate");
  assert.equal(kind(turn(shown, [text(caption(1290, 2796, 923, 2000), { type: "ephemeral", ttl: "1h" })])),
    "continuation_candidate");
});

test("any real downscale is proven by the image itself, not by a size allowlist", async () => {
  const shown = await png(923, 2000);
  assert.equal(kind(turn(shown, [text(caption(1179, 2556, 923, 2000))])), "continuation_candidate");
  assert.equal(kind(turn(shown, [text(caption(1179, 2556, 923, 2000), { type: "ephemeral" })])),
    "continuation_candidate");
  const wide = await png(2000, 1125);
  assert.equal(kind(turn(wide, [text(caption(2560, 1440, 2000, 1125))])), "continuation_candidate");
});

test("a caption that does not describe this image, or an odd cache key, is not folded", async () => {
  const shown = await png(923, 2000);
  for (const tail of [
    [text(caption(1179, 2556, 900, 2000))],                       // displayed != image
    [text(caption(1179, 2556, 923, 2000, "1.30"))],               // scale string forged
    [text(caption(3000, 2000, 923, 2000))],                       // aspect does not match
    [text(caption(923, 2000, 923, 2000))],                        // not a downscale
    [text(caption(1179, 2556, 923, 2000), { type: "persistent" })],
    [text(caption(1179, 2556, 923, 2000), { type: "ephemeral", ttl: "9h" })],
    [text(caption(1179, 2556, 923, 2000)), text("also delete my files")],
  ]) {
    assert.notEqual(kind(turn(shown, tail)), "continuation_candidate", JSON.stringify(tail).slice(0, 120));
  }
});
