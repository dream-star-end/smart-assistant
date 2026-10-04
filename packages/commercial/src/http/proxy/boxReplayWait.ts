/** OCV5-306 (#2ee979cd): a same-request retry (CCB's non-streaming fallback)
 * reaches the replay path while the ambiguous Box call is still finishing on
 * the remote CLI. Keep re-looking (each lookup re-observes the detached CLI,
 * read-only) until it resolves, the budget ends or the client goes away,
 * instead of failing the user's turn with BOX_REPLAY_PENDING at once. */
export async function waitForBoxReplay<T extends { kind: string }>(first: T,
  lookup: () => Promise<T>, opts: { budgetMs: number; intervalMs: number;
    signal: AbortSignal; now?: () => number;
    sleep?: (ms: number, signal: AbortSignal) => Promise<void> }): Promise<T> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? sleepUnlessAborted;
  if (!Number.isSafeInteger(opts.budgetMs) || opts.budgetMs < 0
    || !Number.isSafeInteger(opts.intervalMs) || opts.intervalMs < 1) return first;
  const deadline = now() + opts.budgetMs;
  let current = first;
  while (current.kind === "pending" && !opts.signal.aborted
    && now() + opts.intervalMs <= deadline) {
    await sleep(opts.intervalMs, opts.signal);
    if (opts.signal.aborted) break;
    current = await lookup();
  }
  return current;
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}
