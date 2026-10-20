/** Process-local numeric write() observations. No IO, timers, or log contents. */
let calls = 0
let bytes = 0
let totalMs = 0
let maxMs = 0
let slowCalls = 0
let failedCalls = 0
export function measureLogWrite(
  write: () => unknown, byteLength: number, now: () => number = () => performance.now(),
): void {
  const start = now()
  let failed = true
  try { write(); failed = false } finally {
    const elapsed = Math.max(0, now() - start)
    calls++; bytes += byteLength; totalMs += elapsed
    maxMs = Math.max(maxMs, elapsed)
    if (elapsed >= 10) slowCalls++
    if (failed) failedCalls++
  }
}
export function takeLogWriteTimingSnapshot(): Record<string, number> {
  const result = { writeCalls: calls, writeBytes: bytes, writeTotalMs: totalMs,
    writeMaxMs: maxMs, slowWriteCalls: slowCalls, failedWriteCalls: failedCalls }
  calls = bytes = totalMs = maxMs = slowCalls = failedCalls = 0
  return result
}
