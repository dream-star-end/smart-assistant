/** Bounded read-only Box stdout spool cursor. Reads may be repeated safely,
 * but a model/tool-result write or an ambiguous SSE delivery is never replayed. */
import type { BoxExecTransport } from "./boxExecTransport.js";
import type { BoxDetachedToolPlan } from "./boxDetachedToolPlan.js";

export class BoxSpoolReadError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxSpoolReadError"; }
}
export interface BoxSpoolChunk { bytes: Buffer; nextOffset: number }
export function parseBoxSpoolChunk(raw: string, offset: number,
  limit: number): BoxSpoolChunk {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * 1024 * 1024
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 65536
    || Buffer.byteLength(raw) > 131072) {
    throw new BoxSpoolReadError("BOX_SPOOL_FRAME_INVALID");
  }
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new BoxSpoolReadError("BOX_SPOOL_FRAME_INVALID"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BoxSpoolReadError("BOX_SPOOL_FRAME_INVALID");
  }
  const x = value as Record<string, unknown>;
  if (Object.keys(x).sort().join(",") !== "data,offset"
    || typeof x.data !== "string" || !Number.isSafeInteger(x.offset)) {
    throw new BoxSpoolReadError("BOX_SPOOL_FRAME_INVALID");
  }
  const bytes = Buffer.from(x.data, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== x.data
    || x.offset !== offset + bytes.length || x.offset > 8 * 1024 * 1024) {
    throw new BoxSpoolReadError("BOX_SPOOL_FRAME_INVALID");
  }
  return { bytes, nextOffset: x.offset as number };
}

export async function readBoxSpoolChunk(input: {
  exec: Pick<BoxExecTransport, "run">;
  plan: Pick<BoxDetachedToolPlan, "readSpool">;
  offset: number;
  limit?: number;
  signal?: AbortSignal;
}): Promise<BoxSpoolChunk> {
  const limit = input.limit ?? 65536;
  const request = input.plan.readSpool(input.offset, limit);
  const result = await input.exec.run(request, { timeoutMs: 20_000,
    maxResponseBytes: 131072, signal: input.signal });
  return parseBoxSpoolChunk(result.stdout, input.offset, limit);
}
