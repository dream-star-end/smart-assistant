/**
 * Cross-tab exclusive lock around POST /api/auth/refresh.
 *
 * Why: refresh always rotates oc_rt. Two tabs booting together (or one slow
 * BootSplash + another navigation) can reuse the pre-rotate cookie after the
 * server grace window and get theft mass-revoke (OCV5-622). In-tab singleflight
 * already exists in api/http.ts; this serializes the network call across tabs.
 *
 * Prefer Web Locks API (Chrome/Edge). Fallback: BroadcastChannel claim with a
 * short yield. If neither is usable (SSR / Vitest / old engines), run
 * immediately — backend REFRESH_RACE / grace remains the safety net.
 *
 * Never carries tokens or credentials on the wire.
 */

const LOCK_NAME = "oc-auth-refresh";
const CHANNEL_NAME = "oc-auth-refresh-lock";
const CLAIM_WAIT_MS = 40;
const HOLD_TIMEOUT_MS = 35_000;

const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

type ClaimMessage = {
  type: "claim" | "release";
  tabId: string;
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

async function withBroadcastClaim<T>(run: () => Promise<T>): Promise<T> {
  if (typeof BroadcastChannel !== "function" || typeof window === "undefined") {
    return run();
  }

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(CHANNEL_NAME);
  } catch {
    return run();
  }

  const claimId = `${TAB_ID}:${Math.random().toString(36).slice(2, 10)}`;
  const ts = Date.now();
  let peerHolding = false;
  let releaseWaiters: Array<() => void> = [];

  const onMessage = (event: MessageEvent) => {
    const data = event.data as Partial<ClaimMessage> | null;
    if (!data || typeof data !== "object") return;
    if (data.tabId === TAB_ID) return;
    if (data.type === "claim") {
      const peerTs = typeof data.ts === "number" ? data.ts : Number.POSITIVE_INFINITY;
      const peerClaim = typeof data.claimId === "string" ? data.claimId : "";
      if (peerTs < ts || (peerTs === ts && peerClaim < claimId)) {
        peerHolding = true;
      }
    } else if (data.type === "release") {
      peerHolding = false;
      const waiters = releaseWaiters;
      releaseWaiters = [];
      for (const w of waiters) w();
    }
  };

  channel.addEventListener("message", onMessage);
  try {
    channel.postMessage({ type: "claim", tabId: TAB_ID, claimId, ts } satisfies ClaimMessage);
    await sleep(CLAIM_WAIT_MS);
    if (peerHolding) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          peerHolding = false;
          resolve();
        }, HOLD_TIMEOUT_MS);
        releaseWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
      peerHolding = false;
      channel.postMessage({
        type: "claim",
        tabId: TAB_ID,
        claimId,
        ts: Date.now(),
      } satisfies ClaimMessage);
      await sleep(CLAIM_WAIT_MS);
    }
    try {
      return await run();
    } finally {
      try {
        channel.postMessage({
          type: "release",
          tabId: TAB_ID,
          claimId,
          ts: Date.now(),
        } satisfies ClaimMessage);
      } catch {
        /* ignore */
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
  // cookie-mutation FIFO. Skip BC there; unit tests cover locks path explicitly.
  if (inVitest()) return run();
  return withBroadcastClaim(run);
}

/** Test seam: lock name used by Web Locks / docs. */
export const REFRESH_CROSS_TAB_LOCK_NAME = LOCK_NAME;
