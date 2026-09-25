/** Exact byte boundaries for a detached Box CLI JSONL spool. A committed
 * handoff persists a line's endOffset, never an unprocessed chunk-end or raw
 * remainder, so another HTTP request can resume without duplicating bytes. */
import { BOX_TOOL_SPOOL_MAX_BYTES } from "./boxToolCapacity.js";
const MAX_LINE_BYTES = BOX_TOOL_SPOOL_MAX_BYTES;
const MAX_SPOOL_BYTES = BOX_TOOL_SPOOL_MAX_BYTES;
export class BoxSpoolFrameError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxSpoolFrameError"; }
}
export interface BoxSpoolLine { readonly text: string; readonly endOffset: number }

export class BoxSpoolJsonlFramer {
  private pendingChunks: Buffer[] = [];
  private pendingLength = 0;
  private nextReadOffset: number;
  private failed = false;
  constructor(startOffset = 0) {
    if (!Number.isSafeInteger(startOffset) || startOffset < 0 || startOffset > MAX_SPOOL_BYTES) {
      throw new BoxSpoolFrameError("BOX_SPOOL_OFFSET_INVALID");
    }
    this.nextReadOffset = startOffset;
  }
  push(bytes: Buffer, chunkStartOffset: number): readonly BoxSpoolLine[] {
    if (this.failed) throw new BoxSpoolFrameError("BOX_SPOOL_FRAMER_CLOSED");
    try { return this.pushUnsafe(bytes, chunkStartOffset); }
    catch (error) { this.failed = true; throw error; }
  }
  private pushUnsafe(bytes: Buffer, chunkStartOffset: number): readonly BoxSpoolLine[] {
    if (!Buffer.isBuffer(bytes) || bytes.length > 65536
      || chunkStartOffset !== this.nextReadOffset
      || chunkStartOffset + bytes.length > MAX_SPOOL_BYTES) {
      throw new BoxSpoolFrameError("BOX_SPOOL_CHUNK_INVALID");
    }
    this.nextReadOffset += bytes.length;
    const lines: BoxSpoolLine[] = [];
    let cursor = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const part = bytes.subarray(cursor, newline + 1);
      const size = this.pendingLength + part.length;
      if (size > MAX_LINE_BYTES) throw new BoxSpoolFrameError("BOX_SPOOL_LINE_TOO_LARGE");
      const raw = this.pendingLength
        ? Buffer.concat([...this.pendingChunks, part], size) : part;
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
      catch { throw new BoxSpoolFrameError("BOX_SPOOL_UTF8_INVALID"); }
      lines.push({ text, endOffset: chunkStartOffset + newline + 1 });
      this.pendingChunks = []; this.pendingLength = 0;
      cursor = newline + 1;
    }
    if (cursor < bytes.length) {
      const rest = Buffer.from(bytes.subarray(cursor));
      this.pendingChunks.push(rest); this.pendingLength += rest.length;
    }
    if (this.pendingLength > MAX_LINE_BYTES) {
      throw new BoxSpoolFrameError("BOX_SPOOL_LINE_TOO_LARGE");
    }
    return lines;
  }
}
