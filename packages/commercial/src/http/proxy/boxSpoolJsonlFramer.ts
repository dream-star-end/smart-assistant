/** Exact byte boundaries for a detached Box CLI JSONL spool. A committed
 * handoff persists a line's endOffset, never an unprocessed chunk-end or raw
 * remainder, so another HTTP request can resume without duplicating bytes. */
const MAX_LINE_BYTES = 1_048_576;
const MAX_SPOOL_BYTES = 8 * 1024 * 1024;
export class BoxSpoolFrameError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxSpoolFrameError"; }
}
export interface BoxSpoolLine { readonly text: string; readonly endOffset: number }

export class BoxSpoolJsonlFramer {
  private pending = Buffer.alloc(0);
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
    const joined = Buffer.concat([this.pending, bytes]);
    const base = this.nextReadOffset - joined.length;
    const lines: BoxSpoolLine[] = [];
    let cursor = 0;
    for (;;) {
      const newline = joined.indexOf(0x0a, cursor);
      if (newline < 0) break;
      const raw = joined.subarray(cursor, newline + 1);
      if (raw.length > MAX_LINE_BYTES) throw new BoxSpoolFrameError("BOX_SPOOL_LINE_TOO_LARGE");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
      catch { throw new BoxSpoolFrameError("BOX_SPOOL_UTF8_INVALID"); }
      lines.push({ text, endOffset: base + newline + 1 });
      cursor = newline + 1;
    }
    this.pending = Buffer.from(joined.subarray(cursor));
    if (this.pending.length > MAX_LINE_BYTES) {
      throw new BoxSpoolFrameError("BOX_SPOOL_LINE_TOO_LARGE");
    }
    return lines;
  }
}
