/**
 * Leftover live-frame recover fence (thin WAL, no schema change).
 *
 * Tape commit remains the durable terminal WAL. This filter is the recover
 * half for leftover live frames: keep this turn's frames in monotonic
 * frameSeq order, drop dups / rollbacks, keep unstamped legacy payloads.
 */

export function liveFrameSeq(payload: unknown): number | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const seq = (payload as { frameSeq?: unknown }).frameSeq;
  if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0) return seq;
  return null;
}

export function filterMonotonicLiveFramePayloads(payloads: readonly unknown[]): unknown[] {
  const stamped: Array<{ seq: number; index: number; payload: unknown }> = [];
  const unstamped: unknown[] = [];
  payloads.forEach((payload, index) => {
    const seq = liveFrameSeq(payload);
    if (seq === null) {
      unstamped.push(payload);
      return;
    }
    stamped.push({ seq, index, payload });
  });
  stamped.sort((a, b) => a.seq - b.seq || a.index - b.index);
  const out: unknown[] = [];
  let last = 0;
  for (const item of stamped) {
    if (item.seq <= last) continue;
    last = item.seq;
    out.push(item.payload);
  }
  return unstamped.length === 0 ? out : out.concat(unstamped);
}
