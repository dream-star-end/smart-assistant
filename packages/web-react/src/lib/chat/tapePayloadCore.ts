import { gunzipSync } from "fflate";

type JsonObject = Record<string, unknown>;

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as JsonObject;
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Parse and verify one exact immutable physical record. Runtime-batch
 * containers are expanded to their exact logical events using the persisted
 * manifest; no summary or display substitute is created. */
export async function decodeTapePayload(
  source: ArrayBuffer,
): Promise<{ contentSha256: string; records: JsonObject[] }> {
  const sourceBytes = new Uint8Array(source);
  const contentSha256 = await sha256Hex(sourceBytes);
  const full = asObject(JSON.parse(new TextDecoder().decode(sourceBytes)), "tape record");
  const rawBatch = full._runtimeEventBatch;
  if (rawBatch === undefined) return { contentSha256, records: [full] };

  const batch = asObject(rawBatch, "runtime batch");
  const manifest = batch.manifest;
  const data = batch.data;
  const logicalCount = batch.logicalCount;
  const uncompressedBytes = batch.uncompressedBytes;
  const compressedBytes = batch.compressedBytes;
  const manifestSha256 = batch.manifestSha256;
  if (
    batch.version !== 1 ||
    batch.encoding !== "gzip+base64" ||
    !Array.isArray(manifest) ||
    !Number.isSafeInteger(logicalCount) ||
    logicalCount !== manifest.length ||
    !Number.isSafeInteger(uncompressedBytes) ||
    typeof data !== "string" ||
    typeof manifestSha256 !== "string"
  ) {
    throw new Error("runtime batch header is invalid");
  }
  const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));
  if ((await sha256Hex(manifestBytes)) !== manifestSha256) {
    throw new Error("runtime batch manifest hash mismatch");
  }
  const compressed = fromBase64(data);
  if (Number.isSafeInteger(compressedBytes) && compressed.length !== compressedBytes) {
    throw new Error("runtime batch compressed length mismatch");
  }
  const raw = gunzipSync(compressed);
  if (raw.length !== uncompressedBytes) throw new Error("runtime batch raw length mismatch");

  const records: JsonObject[] = [];
  let expectedOffset = 0;
  for (let index = 0; index < manifest.length; index++) {
    const entry = asObject(manifest[index], `runtime batch manifest ${index}`);
    const offset = entry.offset;
    const length = entry.length;
    if (
      !Number.isSafeInteger(offset) ||
      offset !== expectedOffset ||
      !Number.isSafeInteger(length) ||
      (length as number) < 0 ||
      (offset as number) + (length as number) > raw.length ||
      typeof entry.payloadSha256 !== "string"
    ) {
      throw new Error(`runtime batch manifest entry ${index} is invalid`);
    }
    const part = raw.subarray(offset as number, (offset as number) + (length as number));
    expectedOffset += length as number;
    if ((await sha256Hex(part)) !== entry.payloadSha256) {
      throw new Error(`runtime batch record ${index} hash mismatch`);
    }
    const record = asObject(
      JSON.parse(new TextDecoder().decode(part)),
      `runtime batch record ${index}`,
    );
    if (
      record.id !== entry.id ||
      record.role !== "runtime-event" ||
      record.ts !== entry.ts ||
      record._ocEventOrdinal !== entry.eventOrdinal ||
      record._runtimeSource !== entry.source
    ) {
      throw new Error(`runtime batch record ${index} identity mismatch`);
    }
    records.push(record);
  }
  if (expectedOffset !== raw.length) throw new Error("runtime batch manifest coverage mismatch");
  if (full.usage && records.length > 0) records.at(-1)!.usage = full.usage;
  return { contentSha256, records };
}
