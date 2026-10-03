/** OCV5-302: publish client tool-result images the way Claude Code keeps them.
 *
 * The Box CLI re-encodes every MCP image outside its API limits
 * (maybeResizeAndDownsampleImageBuffer: 2000x2000 px, 3.75 MB raw) and labels
 * each image with its real format. A client result such as Read of a phone
 * screenshot (1290x2796) therefore reached the model as a different image than
 * OpenClaude published, the strict echo bind saw other bytes, and the turn
 * failed ("任务执行失败 / 内部错误"). Normalizing first makes the CLI pass the
 * bytes through unchanged; native Claude Code's own Read applies the same
 * limits, so the model sees what it would see locally. */
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { BoxMatchedToolResult } from "./boxToolResultMatcher.js";

export const BOX_CLI_IMAGE_MAX_DIM = 2000;
export const BOX_CLI_IMAGE_MAX_RAW = (5 * 1024 * 1024 * 3) / 4;
const MEDIA: Record<string, string> = { png: "image/png", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp" };
type McpImage = { type: "image"; data: string; mimeType: string };
type McpContent = BoxMatchedToolResult["content"][number];

export async function normalizeBoxCliImage(block: McpImage): Promise<McpImage> {
  const raw = Buffer.from(block.data, "base64");
  let meta: sharp.Metadata;
  try { meta = await sharp(raw).metadata(); } catch { return block; }
  const format = meta.format === ("jpg" as string) ? "jpeg" : String(meta.format ?? "");
  const media = MEDIA[format];
  if (!media || !meta.width || !meta.height) return block;
  if (raw.length <= BOX_CLI_IMAGE_MAX_RAW && meta.width <= BOX_CLI_IMAGE_MAX_DIM
    && meta.height <= BOX_CLI_IMAGE_MAX_DIM) {
    return media === block.mimeType ? block : { type: "image", data: block.data, mimeType: media };
  }
  let width = meta.width, height = meta.height;
  if (width > BOX_CLI_IMAGE_MAX_DIM) {
    height = Math.round((height * BOX_CLI_IMAGE_MAX_DIM) / width);
    width = BOX_CLI_IMAGE_MAX_DIM;
  }
  if (height > BOX_CLI_IMAGE_MAX_DIM) {
    width = Math.round((width * BOX_CLI_IMAGE_MAX_DIM) / height);
    height = BOX_CLI_IMAGE_MAX_DIM;
  }
  for (let scale = 1; scale > 0.1; scale *= 0.75) {
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const base = () => sharp(raw, { pages: 1 }).resize(w, h, { fit: "fill" });
    const candidates: Array<[string, () => Promise<Buffer>]> = format === "jpeg"
      ? [80, 60, 40, 20].map((quality) => ["jpeg", () => base().jpeg({ quality }).toBuffer()])
      : [["png", () => base().png({ compressionLevel: 9 }).toBuffer()],
        ...[80, 60, 40, 20].map((quality) =>
          ["jpeg", () => base().jpeg({ quality }).toBuffer()] as [string, () => Promise<Buffer>])];
    for (const [out, encode] of candidates) {
      let buffer: Buffer;
      try { buffer = await encode(); } catch { return block; }
      if (buffer.length <= BOX_CLI_IMAGE_MAX_RAW) {
        return { type: "image", data: buffer.toString("base64"), mimeType: MEDIA[out]! };
      }
    }
  }
  return block;
}

/** Same matched results with CLI-safe images and the content hash recomputed
 * exactly as boxToolResultMatcher/boxToolResultPlan compute it. */
export async function normalizeBoxResultImagesForCli(
  results: readonly BoxMatchedToolResult[]): Promise<readonly BoxMatchedToolResult[]> {
  return Promise.all(results.map(async (result) => {
    if (!result.content.some((block) => block.type === "image")) return result;
    const content: McpContent[] = await Promise.all(result.content.map((block) =>
      block.type === "image" ? normalizeBoxCliImage(block) : Promise.resolve(block)));
    if (content.every((block, index) => block === result.content[index])) return result;
    const contentHash = createHash("sha256").update(JSON.stringify({
      content, isError: result.isError })).digest("hex");
    return { ...result, content, contentHash };
  }));
}
