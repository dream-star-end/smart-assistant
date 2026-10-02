/** OCV5-301: wait out a briefly held Box capacity instead of rejecting.
 *
 * The usual holder is the same session's previous turn, still settling (a
 * stop proof, an unknown observation, the remote cleanup) after the client
 * already saw that turn end. Rejecting at once surfaces as "消息未开始处理";
 * native Claude Code simply runs the next message once the previous one is
 * done. A capacity rejection happens before any Box command or paid launch
 * and the admission transaction rolls back, so each retry is clean. After the
 * bounded window the original rejection is returned unchanged. */
export const BOX_CAPACITY_WAIT_MS = 45_000;
const CAPACITY_CODES = new Set(["BOX_CAPACITY_HELD", "BOX_SESSION_BUSY",
  "BOX_USER_CAPACITY_FULL", "BOX_ACCOUNT_CAPACITY_FULL"]);

export function isBoxCapacityRejection(error: unknown): boolean {
  return error instanceof Error && CAPACITY_CODES.has(error.message);
}

export async function waitingForBoxCapacity<T>(attempt: () => T | Promise<T>,
  signal: AbortSignal, options: { maxWaitMs?: number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
    now?: () => number } = {}): Promise<T> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const deadline = now() + (options.maxWaitMs ?? BOX_CAPACITY_WAIT_MS);
  let delay = 250;
  for (;;) {
    let rejection: unknown;
    try {
      return await attempt();
    } catch (error) {
      if (!isBoxCapacityRejection(error) || signal.aborted || now() + delay > deadline) throw error;
      rejection = error;
    }
    await sleep(delay, signal);
    // A caller that left while we slept must never get a late admission.
    if (signal.aborted) throw rejection;
    delay = Math.min(delay * 2, 2_000);
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}
