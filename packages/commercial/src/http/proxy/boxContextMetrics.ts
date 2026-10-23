/** Content-free diagnostics. Never traverse arbitrary tool input fields. */
import { createHash } from "node:crypto";
import type { ProxyBody } from "./shared.js";

export function boxContextSummary(body: ProxyBody): {
  imageCount: number; uniqueImageCount: number; documentCount: number;
  mediaBase64Bytes: number; textBytes: number; toolInputBytes: number;
  thinkingBytes: number; summaryComplete: boolean;
} {
  const result = { imageCount: 0, uniqueImageCount: 0, documentCount: 0,
    mediaBase64Bytes: 0, textBytes: 0, toolInputBytes: 0, thinkingBytes: 0,
    summaryComplete: true };
  const images = new Set<string>();
  const stack: unknown[] = [];
  let visited = 0;
  const enqueue = (content: unknown[]) => {
    for (const block of content) {
      if (stack.length + visited >= 10_000) { result.summaryComplete = false; break; }
      stack.push(block);
    }
  };
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") result.textBytes += Buffer.byteLength(content);
    else if (Array.isArray(content)) enqueue(content);
  }
  while (stack.length) {
    if (++visited > 10_000) { result.summaryComplete = false; break; }
    const item = stack.pop();
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const block = item as Record<string, unknown>;
    if (block.type === "image" || block.type === "document") {
      if (block.type === "image") result.imageCount++; else result.documentCount++;
      const source = block.source as { type?: unknown; data?: unknown; media_type?: unknown } | undefined;
      if (source?.type === "base64" && typeof source.data === "string") {
        result.mediaBase64Bytes += Buffer.byteLength(source.data);
        if (block.type === "image") images.add((typeof source.media_type === "string" ? source.media_type : "") + ":" +
          createHash("sha256").update(source.data).digest("hex"));
      }
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") result.textBytes += Buffer.byteLength(block.content);
      else if (Array.isArray(block.content)) enqueue(block.content);
    } else if (block.type === "tool_use") {
      if (block.input !== undefined) result.toolInputBytes += Buffer.byteLength(JSON.stringify(block.input));
    } else if (block.type === "text" && typeof block.text === "string") {
      result.textBytes += Buffer.byteLength(block.text);
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      result.thinkingBytes += Buffer.byteLength(block.thinking);
    }
  }
  result.uniqueImageCount = images.size;
  return result;
}

