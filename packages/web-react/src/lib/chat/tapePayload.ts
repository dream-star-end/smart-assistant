import type { TapeRecordPayload } from "../types";
import type { ChatMessage } from "./model";
import { decodeTapePayload } from "./tapePayloadCore";

export type TapePayloadExpectation = {
  recordId: string;
  role: string;
  /** Legacy rows obtain this from the payload HEAD handshake. */
  contentSha256?: string;
};

type WorkerReply =
  | { ok: true; contentSha256: string; records: Array<Record<string, unknown>> }
  | { ok: false; error: string };

const WORKER_PARSE_THRESHOLD_BYTES = 256 * 1024;

async function parseOffMainThread(bytes: ArrayBuffer): Promise<WorkerReply> {
  if (typeof Worker === "undefined" || bytes.byteLength < WORKER_PARSE_THRESHOLD_BYTES) {
    try {
      return { ok: true, ...(await decodeTapePayload(bytes)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  return new Promise<WorkerReply>((resolve) => {
    const worker = new Worker(new URL("../../workers/tapePayloadWorker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      resolve({ ok: false, error: event.message || "tape payload worker failed" });
    };
    worker.postMessage({ bytes }, [bytes]);
  });
}

/** Verify response headers, exact payload hash and logical record identities. */
export async function parseTapeRecordPayload(
  payload: TapeRecordPayload,
  expected: TapePayloadExpectation,
): Promise<ChatMessage[]> {
  if (
    payload.recordId !== expected.recordId ||
    payload.role !== expected.role ||
    !/^[a-f0-9]{64}$/.test(payload.contentSha256) ||
    (expected.contentSha256 !== undefined && payload.contentSha256 !== expected.contentSha256)
  ) {
    throw new Error("tape payload response identity mismatch");
  }
  const decoded = await parseOffMainThread(payload.bytes);
  if (!decoded.ok) throw new Error(decoded.error);
  if (
    decoded.contentSha256 !== payload.contentSha256 ||
    (expected.contentSha256 !== undefined && decoded.contentSha256 !== expected.contentSha256)
  ) {
    throw new Error("tape payload content hash mismatch");
  }
  if (decoded.records.length === 0) throw new Error("tape payload contains no logical record");
  if (decoded.records.length === 1) {
    const record = decoded.records[0]!;
    if (record.id !== expected.recordId || record.role !== expected.role) {
      throw new Error("tape payload record identity mismatch");
    }
  }
  return decoded.records as ChatMessage[];
}
