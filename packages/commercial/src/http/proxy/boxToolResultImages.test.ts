import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { BOX_CLI_IMAGE_MAX_DIM, normalizeBoxCliImage,
  normalizeBoxResultImagesForCli } from "./boxToolResultImages.js";

const png = async (width: number, height: number) => (await sharp({ create: { width, height,
  channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer()).toString("base64");
const dims = async (data: string) => {
  const meta = await sharp(Buffer.from(data, "base64")).metadata();
  return [meta.format, meta.width, meta.height];
};

test("OCV5-302 a phone screenshot is fitted inside the CLI limits like Claude Code does", async () => {
  const data = await png(1290, 2796);
  const out = await normalizeBoxCliImage({ type: "image", data, mimeType: "image/png" });
  assert.deepEqual(await dims(out.data), ["png", 923, BOX_CLI_IMAGE_MAX_DIM]);
  assert.equal(out.mimeType, "image/png");
  // idempotent: what the CLI receives now passes through unchanged
  assert.equal(await normalizeBoxCliImage(out), out);
});

test("in-limit images keep their bytes; only a wrong media type is corrected", async () => {
  const data = await png(800, 600);
  const same = { type: "image" as const, data, mimeType: "image/png" };
  assert.equal(await normalizeBoxCliImage(same), same);
  const relabeled = await normalizeBoxCliImage({ type: "image", data, mimeType: "image/jpeg" });
  assert.equal(relabeled.data, data);
  assert.equal(relabeled.mimeType, "image/png");
  const broken = { type: "image" as const, data: Buffer.from("not an image").toString("base64"),
    mimeType: "image/png" };
  assert.equal(await normalizeBoxCliImage(broken), broken, "undecodable bytes are left alone");
});

test("matched results get the normalized image and a recomputed content hash", async () => {
  const text = { type: "text" as const, text: "caption" };
  const image = { type: "image" as const, data: await png(2400, 1000), mimeType: "image/png" };
  const hash = (content: unknown, isError: boolean) => createHash("sha256")
    .update(JSON.stringify({ content, isError })).digest("hex");
  const original = { modelToolUseId: "toolu_img", isError: false,
    content: [text, image], contentHash: hash([text, image], false) };
  const plain = { modelToolUseId: "toolu_txt", isError: false, content: [text],
    contentHash: hash([text], false) };
  const [normalized, untouched] = await normalizeBoxResultImagesForCli([original, plain]);
  assert.equal(untouched, plain);
  assert.equal(normalized!.content[0], text);
  assert.deepEqual(await dims((normalized!.content[1] as { data: string }).data),
    ["png", BOX_CLI_IMAGE_MAX_DIM, 833]);
  assert.equal(normalized!.contentHash, hash(normalized!.content, false));
  assert.notEqual(normalized!.contentHash, original.contentHash);
});
