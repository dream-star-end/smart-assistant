/**
 * Bounded range-streaming & client-cancellation helpers for `nodeAgentClient.streamFileTo` (`OCV5-928` B2-b).
 */
import type { ClientRequest, IncomingMessage, OutgoingHttpHeaders } from "node:http";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface NodeAgentByteRange {
  readonly start: number;
  readonly end: number;
}

export function buildNodeAgentGetPathAndHeaders(
  remotePath: string,
  headers: OutgoingHttpHeaders,
  range?: NodeAgentByteRange,
): string {
  const basePath = `/files?path=${encodeURIComponent(remotePath)}`;
  if (!range) return basePath;
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    throw new Error("NODE_AGENT_RANGE_INVALID");
  }
  const length = range.end - range.start + 1;
  headers.range = `bytes=${range.start}-${range.end}`;
  return `${basePath}&offset=${range.start}&length=${length}`;
}

export function bindStreamClientCancelCleanup(
  dest: NodeJS.WritableStream,
  req: ClientRequest,
): () => void {
  const onCancel = () => {
    if (!req.destroyed) req.destroy();
  };
  dest.once("close", onCancel);
  return () => {
    dest.removeListener("close", onCancel);
  };
}

function createWindowSliceTransform(
  skipBytes: number,
  maxBytes: number,
  onWindowComplete: () => void,
): { readonly transform: Transform; readonly isWindowComplete: () => boolean } {
  let skipped = 0;
  let emitted = 0;
  let completed = false;
  const transform = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (completed) {
        cb();
        return;
      }
      let buf = chunk;
      if (skipped < skipBytes) {
        const toSkip = Math.min(buf.length, skipBytes - skipped);
        skipped += toSkip;
        buf = buf.subarray(toSkip);
      }
      if (buf.length === 0) {
        cb();
        return;
      }
      const remaining = maxBytes - emitted;
      const toPush = buf.length > remaining ? buf.subarray(0, remaining) : buf;
      emitted += toPush.length;
      this.push(toPush);
      if (emitted >= maxBytes) {
        completed = true;
        this.push(null);
        cb();
        queueMicrotask(onWindowComplete);
        return;
      }
      cb();
    },
  });
  return { transform, isWindowComplete: () => completed };
}

export function pipeNodeAgentGetResponse(
  res: IncomingMessage,
  dest: NodeJS.WritableStream,
  range: NodeAgentByteRange | undefined,
  finish: (err: Error | null, value?: "ok") => void,
): void {
  const isPartialUpstream =
    res.statusCode === 206 || typeof res.headers["content-range"] === "string";
  const slicer = range
    ? createWindowSliceTransform(
        isPartialUpstream ? 0 : range.start,
        range.end - range.start + 1,
        () => {
          if (!res.destroyed) res.destroy();
        },
      )
    : undefined;
  const streamPromise = slicer ? pipeline(res, slicer.transform, dest) : pipeline(res, dest);
  res.resume();
  streamPromise.then(
    () => finish(null, "ok"),
    (err: unknown) => {
      if (slicer?.isWindowComplete()) {
        (dest as { end?: () => void }).end?.();
        finish(null, "ok");
        return;
      }
      finish(err instanceof Error ? err : new Error(String(err)));
    },
  );
}
