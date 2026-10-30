/** Shared immutable runtime-batch validation for history and waiver evidence. */
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { LOSSLESS_TURN_TAPE_SHA256_RE } from "@openclaude/protocol";
import type { MessageLike } from "@openclaude/storage";

type RuntimeBatchRow = { tape_id: string; msg_id: string; ordinal: number; tape_sha256: string };
function sha256Bytes(bytes: Buffer): string { return createHash("sha256").update(bytes).digest("hex"); }

export type HydratedRuntimeBatchDescriptor = {
  batchId: string;
  logicalCount: number;
  manifestSha256: string;
};

export function expandHydratedRuntimeBatch(
  hydrated: MessageLike,
  row: RuntimeBatchRow,
  anchor: MessageLike,
): { messages: MessageLike[]; descriptor?: HydratedRuntimeBatchDescriptor } {
  const rawBatch = hydrated._runtimeEventBatch;
  if (rawBatch === undefined) return { messages: [hydrated] };
  if (!rawBatch || typeof rawBatch !== "object" || Array.isArray(rawBatch)) {
    throw new Error(`[pgSessions] lossless runtime batch malformed: ${row.tape_id}\0${row.msg_id}`);
  }
  const batch = rawBatch as Record<string, unknown>;
  const manifest = batch.manifest;
  const logicalCount = batch.logicalCount;
  const uncompressedBytes = batch.uncompressedBytes;
  const compressedBytes = batch.compressedBytes;
  const manifestSha256 = batch.manifestSha256;
  const data = batch.data;
  if (
    batch.version !== 1 ||
    batch.encoding !== "gzip+base64" ||
    !Array.isArray(manifest) ||
    typeof logicalCount !== "number" || !Number.isSafeInteger(logicalCount) || logicalCount < 1 ||
    manifest.length !== logicalCount ||
    typeof uncompressedBytes !== "number" || !Number.isSafeInteger(uncompressedBytes) || uncompressedBytes < 0 ||
    typeof compressedBytes !== "number" || !Number.isSafeInteger(compressedBytes) || compressedBytes < 0 ||
    typeof manifestSha256 !== "string" || !LOSSLESS_TURN_TAPE_SHA256_RE.test(manifestSha256) ||
    typeof data !== "string" || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    throw new Error(`[pgSessions] lossless runtime batch header invalid: ${row.tape_id}\0${row.msg_id}`);
  }
  if (sha256Bytes(Buffer.from(JSON.stringify(manifest), "utf8")) !== manifestSha256) {
    throw new Error(`[pgSessions] lossless runtime batch manifest hash mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  const compressed = Buffer.from(data, "base64");
  if (compressed.length !== compressedBytes) {
    throw new Error(`[pgSessions] lossless runtime batch compressed length mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  let raw: Buffer;
  try {
    raw = gunzipSync(compressed);
  } catch (err) {
    throw new Error(
      `[pgSessions] lossless runtime batch gzip invalid: ${row.tape_id}\0${row.msg_id}: ${(err as Error).message}`,
    );
  }
  if (raw.length !== uncompressedBytes) {
    throw new Error(`[pgSessions] lossless runtime batch raw length mismatch: ${row.tape_id}\0${row.msg_id}`);
  }

  const messages: MessageLike[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < manifest.length; index++) {
    const value = manifest[index];
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`[pgSessions] lossless runtime batch manifest entry invalid: ${row.tape_id}\0${row.msg_id}\0${index}`);
    }
    const entry = value as Record<string, unknown>;
    const id = entry.id;
    const eventOrdinal = entry.eventOrdinal;
    const ts = entry.ts;
    const source = entry.source;
    const offset = entry.offset;
    const length = entry.length;
    const payloadSha256 = entry.payloadSha256;
    if (
      typeof id !== "string" || id.length === 0 ||
      typeof eventOrdinal !== "number" || !Number.isSafeInteger(eventOrdinal) || eventOrdinal < 0 ||
      typeof ts !== "number" || !Number.isSafeInteger(ts) || ts < 0 ||
      (source !== "ccb" && source !== "codex-jsonrpc" && source !== "gateway") ||
      typeof offset !== "number" || !Number.isSafeInteger(offset) || offset !== expectedOffset ||
      typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
      typeof payloadSha256 !== "string" || !LOSSLESS_TURN_TAPE_SHA256_RE.test(payloadSha256) ||
      offset + length > raw.length
    ) {
      throw new Error(`[pgSessions] lossless runtime batch manifest entry invalid: ${row.tape_id}\0${row.msg_id}\0${index}`);
    }
    const payloadBytes = raw.subarray(offset, offset + length);
    expectedOffset += length;
    if (sha256Bytes(payloadBytes) !== payloadSha256) {
      throw new Error(`[pgSessions] lossless runtime batch record hash mismatch: ${row.tape_id}\0${id}`);
    }
    let payload: MessageLike;
    try {
      const parsed = JSON.parse(payloadBytes.toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed as MessageLike;
    } catch (err) {
      throw new Error(
        `[pgSessions] lossless runtime batch record malformed: ${row.tape_id}\0${id}: ${(err as Error).message}`,
      );
    }
    if (
      payload.id !== id || payload.role !== "runtime-event" || payload.ts !== ts ||
      payload._ocEventOrdinal !== eventOrdinal || payload._runtimeSource !== source
    ) {
      throw new Error(`[pgSessions] lossless runtime batch record identity mismatch: ${row.tape_id}\0${id}`);
    }
    messages.push({
      ...payload,
      _source: "server",
      _turnTapeId: row.tape_id,
      _turnTapeMsgId: id,
      _turnTapePhysicalMsgId: row.msg_id,
      _turnTapeOrdinal: row.ordinal,
      _turnTapeSha256: row.tape_sha256,
      _turnTapeExpanded: true,
      ...(typeof anchor._seq === "number" ? { _seq: anchor._seq } : {}),
      ...(typeof anchor._orderSeq === "number" ? { _orderSeq: anchor._orderSeq } : {}),
    });
  }
  if (expectedOffset !== raw.length) {
    throw new Error(`[pgSessions] lossless runtime batch manifest coverage mismatch: ${row.tape_id}\0${row.msg_id}`);
  }
  const batchUsage = hydrated.usage && typeof hydrated.usage === "object"
    ? hydrated.usage
    : undefined;
  if (batchUsage && messages.length > 0) messages.at(-1)!.usage = batchUsage;
  return {
    messages,
    descriptor: { batchId: row.msg_id, logicalCount, manifestSha256 },
  };
}

