/**
 * Cross-tab exclusive lock around POST /api/auth/refresh.
 *
 * Why: refresh always rotates oc_rt. Two tabs booting together (or one slow
 * BootSplash + another navigation) can reuse the pre-rotate cookie after the
 * server grace window and get theft mass-revoke (OCV5-622). In-tab singleflight
 * already exists in api/http.ts; this serializes the network call across tabs.
 *
 * Prefer Web Locks API (Chrome/Edge). Fallback: BroadcastChannel with a
 * claim/busy/release handshake so late joiners wait for the current holder
 * (BC does not replay history — the holder must answer new claims with busy).
 * If neither is usable (SSR / Vitest default / old engines), run immediately —
 * backend REFRESH_RACE / grace remains the safety net.
 *
 * Never carries tokens or credentials on the wire.
 */

const LOCK_NAME = "oc-auth-refresh";
const CHANNEL_NAME = "oc-auth-refresh-lock";
/** Settle window after posting claim / hold-announce to collect busy / peers. */
const CLAIM_WAIT_MS = 60;
const HOLD_TIMEOUT_MS = 35_000;

type LockMessage = {
  type: "claim" | "busy" | "release";
  clientId: string;
  claimId: string;
  ts: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inVitest(): boolean {
  try {
    return typeof process !== "undefined" && Boolean(process.env?.VITEST);
  } catch {
    return false;
  }
}

function peerWinsRace(
  ourTs: number,
  ourClaimId: string,
  peerTs: number,
  peerClaimId: string,
): boolean {
  return peerTs < ourTs || (peerTs === ourTs && peerClaimId < ourClaimId);
}

function waitForRelease(
  releaseWaiters: Array<() => void>,
  timeoutMs: number,
  /** Snapshot of releaseEpoch when this acquire last observed the lock as held. */
  epochAtStart: number,
  getEpoch: () => number,
): Promise<void> {
  // Holder may have released during our claim settle window before we registered
  // a waiter — do not sleep the full HOLD_TIMEOUT (BootSplash hang, Codex r2 P1).
  if (getEpoch() !== epochAtStart) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    releaseWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * BroadcastChannel fallback. Exported for unit tests (Vitest skips this path
 * in withCrossTabRefreshLock to avoid api.test + fake-timer deadlocks).
 */
export async function withBroadcastClaim<T>(run: () => Promise<T>): Promise<T> {
  if (typeof BroadcastChannel !== "function" || typeof window === "undefined") {
    return run();
  }

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return run();
  }

  // Per-acquire ids (not module-level): same-tab tests / nested calls must not
  // ignore each other's busy/claim because TAB_ID matched.
  const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const claimId = `${clientId}:${Math.random().toString(36).slice(2, 8)}`;
  let ts = Date.now();
  let holding = false;
  let lostOrBusy = false;
  /** Bumps on every peer release (even with zero waiters) so early release is not missed. */
  let releaseEpoch = 0;
  const releaseWaiters: Array<() => void> = [];

  const post = (type: LockMessage["type"], stamp: number) => {
    channel.postMessage({
      type,
      clientId,
      claimId,
      ts: stamp,
    } satisfies LockMessage);
  };

  const onMessage = (event: MessageEvent) => {
    const data = event.data as Partial<LockMessage> | null;
    if (!data || typeof data !== "object") return;
    if (data.clientId === clientId) return;

    if (data.type === "claim") {
      if (holding) {
        // Late joiner: BC has no history — answer busy so they wait for release.
        try {
          post("busy", ts);
        } catch {
          /* ignore */
        }
        return;
      }
      const peerTs = typeof data.ts === "number" ? data.ts : Number.POSITIVE_INFINITY;
      const peerClaim = typeof data.claimId === "string" ? data.claimId : "";
      if (peerWinsRace(ts, claimId, peerTs, peerClaim)) {
        lostOrBusy = true;
      }
    } else if (data.type === "busy") {
      lostOrBusy = true;
    } else if (data.type === "release") {
      releaseEpoch += 1;
      const waiters = releaseWaiters.splice(0, releaseWaiters.length);
      for (const w of waiters) w();
    }
  };

  channel.addEventListener("message", onMessage);
  try {
    for (;;) {
      lostOrBusy = false;
      const epochAtClaim = releaseEpoch;
      ts = Date.now();
      try {
        post("claim", ts);
      } catch {
        return run();
      }
      await sleep(CLAIM_WAIT_MS);
      if (lostOrBusy) {
        await waitForRelease(
          releaseWaiters,
          HOLD_TIMEOUT_MS,
          epochAtClaim,
          () => releaseEpoch,
        );
        continue;
      }

      // Announce hold. Peers that also thought they won (missed our claim
      // because listeners were not ready) see busy and yield; we re-check.
      holding = true;
      lostOrBusy = false;
      const epochAtHold = releaseEpoch;
      try {
        post("busy", ts);
      } catch {
        holding = false;
        return run();
      }
      await sleep(CLAIM_WAIT_MS);
      if (lostOrBusy) {
        holding = false;
        try {
          post("release", Date.now());
        } catch {
          /* ignore */
        }
        await waitForRelease(
          releaseWaiters,
          HOLD_TIMEOUT_MS,
          epochAtHold,
          () => releaseEpoch,
        );
        continue;
      }

      try {
        return await run();
      } finally {
        holding = false;
        try {
          post("release", Date.now());
        } catch {
          /* ignore */
        }
      }
    }
  } finally {
    channel.removeEventListener("message", onMessage);
    try {
      channel.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Run `run` under an exclusive cross-tab refresh lock when the environment
 * supports it. Safe to call from refreshAuth; must not nest token payloads.
 */
export async function withCrossTabRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const locks =
    typeof navigator !== "undefined"
      ? (navigator as Navigator & { locks?: LockManager }).locks
      : undefined;
  if (locks && typeof locks.request === "function") {
    return locks.request(LOCK_NAME, { mode: "exclusive" }, () => run());
  }
  // Vitest/jsdom: BroadcastChannel + real/fake timer mix deadlocks api.test
  // cookie-mutation FIFO. Skip BC there; unit tests cover BC via withBroadcastClaim.
  if (inVitest()) return run();
  return withBroadcastClaim(run);
}

/** Test seam: lock name used by Web Locks / docs. */
export const REFRESH_CROSS_TAB_LOCK_NAME = LOCK_NAME;

/** Test seam: claim settle window. */
export const REFRESH_BC_CLAIM_WAIT_MS = CLAIM_WAIT_MS;
