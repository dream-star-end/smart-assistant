import { gzipSync } from "fflate";
import { describe, expect, test } from "vitest";
import type { TapeRecordPayload } from "../types";
import { parseTapeRecordPayload } from "./tapePayload";

const encoder = new TextEncoder();

function bytesOf(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", arrayBufferOf(bytes));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("exact immutable tape payload parsing", () => {
  test("returns the byte-for-byte JSON record after verifying headers and SHA-256", async () => {
    const record = {
      id: "tool-exact-1",
      role: "tool",
      text: "",
      ts: 123,
      toolName: "Bash",
      inputJson: { cmd: "printf '真实过程'" },
      output: "真实过程",
      _completed: true,
    };
    const bytes = bytesOf(record);
    const contentSha256 = await sha256(bytes);
    const payload: TapeRecordPayload = {
      bytes: arrayBufferOf(bytes),
      contentSha256,
      recordId: record.id,
      role: record.role,
    };

    await expect(parseTapeRecordPayload(payload, {
      recordId: record.id,
      role: record.role,
      contentSha256,
    })).resolves.toEqual([record]);
  });

  test("rejects any altered response identity or payload bytes instead of inventing a fallback row", async () => {
    const record = { id: "answer-1", role: "assistant", text: "真实答案", ts: 1 };
    const bytes = bytesOf(record);
    const contentSha256 = await sha256(bytes);
    const payload: TapeRecordPayload = {
      bytes: arrayBufferOf(bytesOf({ ...record, text: "被改过" })),
      contentSha256,
      recordId: record.id,
      role: record.role,
    };

    await expect(parseTapeRecordPayload(payload, {
      recordId: record.id,
      role: record.role,
      contentSha256,
    })).rejects.toThrow("content hash mismatch");
    await expect(parseTapeRecordPayload({ ...payload, role: "tool" }, {
      recordId: record.id,
      role: record.role,
      contentSha256,
    })).rejects.toThrow("response identity mismatch");
  });

  test("expands a persisted gzip runtime batch to every exact logical event", async () => {
    const logical = [0, 1, 2, 3].map((ordinal) => ({
      id: `runtime-${ordinal}`,
      role: "runtime-event",
      text: "",
      ts: 1_000 + ordinal,
      _ocEventOrdinal: ordinal,
      _runtimeSource: "gateway",
      _runtimeEvent: { type: "progress", ordinal, exact: `事件-${ordinal}` },
    }));
    const logicalBytes = logical.map(bytesOf);
    let offset = 0;
    const manifest = [] as Array<Record<string, unknown>>;
    for (let index = 0; index < logical.length; index++) {
      const record = logical[index]!;
      const bytes = logicalBytes[index]!;
      manifest.push({
        id: record.id,
        eventOrdinal: record._ocEventOrdinal,
        ts: record.ts,
        source: record._runtimeSource,
        offset,
        length: bytes.length,
        payloadSha256: await sha256(bytes),
      });
      offset += bytes.length;
    }
    const raw = new Uint8Array(offset);
    let cursor = 0;
    for (const bytes of logicalBytes) {
      raw.set(bytes, cursor);
      cursor += bytes.length;
    }
    const compressed = gzipSync(raw, { level: 6 });
    const batch = {
      id: "runtime-batch-0-3",
      role: "runtime-event",
      text: "",
      ts: 1_000,
      _runtimeEventBatch: {
        version: 1,
        encoding: "gzip+base64",
        logicalCount: manifest.length,
        uncompressedBytes: raw.length,
        compressedBytes: compressed.length,
        manifestSha256: await sha256(bytesOf(manifest)),
        manifest,
        data: base64(compressed),
      },
      usage: { input_tokens: 7 },
    };
    const batchBytes = bytesOf(batch);
    const contentSha256 = await sha256(batchBytes);

    const parsed = await parseTapeRecordPayload({
      bytes: arrayBufferOf(batchBytes),
      contentSha256,
      recordId: batch.id,
      role: batch.role,
    }, {
      recordId: batch.id,
      role: batch.role,
      contentSha256,
    });

    expect(parsed.map((record) => record.id)).toEqual(logical.map((record) => record.id));
    expect(parsed.map((record) => record._runtimeEvent)).toEqual(
      logical.map((record) => record._runtimeEvent),
    );
    expect(parsed.at(-1)?.usage).toEqual(batch.usage);
  });
});
