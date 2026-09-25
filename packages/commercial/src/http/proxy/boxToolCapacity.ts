/** One detached CLI lifetime has a finite stdout spool. A result must fit
 * before its sidecar file is published; failure after publication is unknown
 * and cannot be safely replayed. Keep this in sync with the Python runner and
 * supervisor bounds, then verify the actual Box echo format before enabling. */
export const BOX_TOOL_SPOOL_MAX_BYTES = 64 * 1024 * 1024;
export const BOX_TOOL_POST_ECHO_RESERVE_BYTES = 2 * 1024 * 1024;
const ECHO_ENVELOPE_BYTES = 4096;
const ECHO_EXPANSION_FACTOR = 4;

export class BoxToolCapacityError extends Error {
  constructor(readonly code: string) { super(code); this.name = "BoxToolCapacityError"; }
}

/** The multiplier covers CLI user-record wrapping/duplicate fields without
 * trusting that the CLI will emit only our minimal normalized JSON. */
export function reserveBoxToolEcho(spoolOffset: number, lastUserMessage: unknown): number {
  if (!Number.isSafeInteger(spoolOffset) || spoolOffset < 0
    || spoolOffset > BOX_TOOL_SPOOL_MAX_BYTES) {
    throw new BoxToolCapacityError("BOX_TOOL_SPOOL_OFFSET_INVALID");
  }
  let encoded: string | undefined;
  try { encoded = JSON.stringify(lastUserMessage); }
  catch { throw new BoxToolCapacityError("BOX_TOOL_ECHO_SHAPE_INVALID"); }
  if (!encoded) throw new BoxToolCapacityError("BOX_TOOL_ECHO_SHAPE_INVALID");
  const echoUpperBound = Buffer.byteLength(encoded) * ECHO_EXPANSION_FACTOR
    + ECHO_ENVELOPE_BYTES;
  if (spoolOffset + echoUpperBound + BOX_TOOL_POST_ECHO_RESERVE_BYTES
    > BOX_TOOL_SPOOL_MAX_BYTES) {
    throw new BoxToolCapacityError("BOX_TOOL_SPOOL_CAPACITY_EXCEEDED");
  }
  return echoUpperBound;
}
