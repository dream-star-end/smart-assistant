/** CCB answers a failed streaming call with a non-streaming retry of the same
 * request. The Box route never launches that retry (a second paid call), so
 * after an upstream refusal (usage window exhausted) the client's last answer
 * was an unrelated "previous Box call not found". This remembers, per logical
 * turn, that the call was refused so the fallback gets the same clear 503.
 * Process-local on purpose: it only shapes an error message, never admission,
 * billing or replay. */
export interface BoxRefusalKey { uid: bigint; sessionId: string; turnKey: string; model: string }

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 512;
const entries = new Map<string, { code: string; atMs: number }>();

const keyOf = (key: BoxRefusalKey): string =>
  `${key.uid}\n${key.sessionId}\n${key.turnKey}\n${key.model}`;

export function rememberBoxRefusal(key: BoxRefusalKey, code: string, nowMs = Date.now()): void {
  const id = keyOf(key);
  entries.delete(id);
  entries.set(id, { code, atMs: nowMs });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
}

export function recentBoxRefusal(key: BoxRefusalKey, nowMs = Date.now()): string | null {
  const id = keyOf(key);
  const found = entries.get(id);
  if (!found) return null;
  if (nowMs - found.atMs > TTL_MS) { entries.delete(id); return null; }
  return found.code;
}

export function _resetBoxRefusalMemoryForTest(): void { entries.clear(); }
