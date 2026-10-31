import { describe, expect, test } from "vitest";
import type { TapeRecordPayload } from "../types";
import { loadTapePayload } from "./loadTapePayload";

const encoder = new TextEncoder();

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferOf(bytes));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

describe("loadTapePayload", () => {
  test("dynamic import parses an exact record the first time it is needed", async () => {
    const record = {
      id: "tool-lazy-1",
      role: "tool",
      text: "",
      ts: 123,
      toolName: "Bash",
      output: "真实过程",
      _completed: true,
    };
    const bytes = encoder.encode(JSON.stringify(record));
    const contentSha256 = await sha256(bytes);
    const payload: TapeRecordPayload = {
      bytes: arrayBufferOf(bytes),
      contentSha256,
      recordId: record.id,
      role: record.role,
    };
    const { parseTapeRecordPayload } = await loadTapePayload();
    await expect(parseTapeRecordPayload(payload, {
      recordId: record.id,
      role: record.role,
      contentSha256,
    })).resolves.toEqual([record]);
  });
});
