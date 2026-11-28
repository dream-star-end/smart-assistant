import { type Dispatch, type RefObject, type SetStateAction, useCallback, useEffect, useRef, useState } from "react";
import { api, AuthEpochStaleError } from "../lib/api";
import type { PrefsView } from "../lib/modelPreferences";
import { type ResolvedIdentity, identityIsCurrent } from "../lib/resolvedIdentity";
import {
  readDefaultSwarmMode,
  subscribeDefaultSwarmMode,
  writeDefaultSwarmMode,
} from "../lib/sessionSwarmMode";
import type { AuthSession } from "../lib/types";

type PendingSwarmPatch = {
  value: boolean;
  seq: number;
};

/**
 * Single-writer persistence queue scoped to `(auth, userId, epoch)`.
 * Separates the account-session write serialization lifetime from short-lived
 * `ResolvedIdentity` credentials so same-account token refreshes (`old -> null -> new`)
 * never spawn a second concurrent PATCH or lose the latest unconfirmed user intent.
 */
type AccountSwarmSyncQueue = {
  auth: AuthSession;
  userId: string;
  epoch: number;
  inFlight: boolean;
  pending: PendingSwarmPatch | null;
  credential: ResolvedIdentity | null;
  disposed: boolean;
};

function isQueueValid(
  q: AccountSwarmSyncQueue,
  demo: boolean,
  auth: AuthSession | null,
  authRef: RefObject<AuthSession>,
  resolvedIdentity: ResolvedIdentity | null,
): boolean {
  if (q.disposed || demo || !auth || auth !== q.auth || authRef.current !== q.auth) return false;
  const snap = auth.snapshot();
  if (snap.epoch !== q.epoch || !snap.token) return false;
  if (resolvedIdentity) {
    return resolvedIdentity.userId === q.userId && resolvedIdentity.epoch === q.epoch;
  }
  return true;
}

function disposeQueue(q: AccountSwarmSyncQueue | null): void {
  if (!q) return;
  q.disposed = true;
  q.pending = null;
}

async function drainSwarmPatchQueue(
  q: AccountSwarmSyncQueue,
  authRef: RefObject<AuthSession>,
): Promise<void> {
  try {
    while (!q.disposed && q.pending !== null) {
      const cred = q.credential;
      if (!cred || authRef.current !== q.auth || !identityIsCurrent(cred, q.auth, q.userId)) {
        break;
      }
      const next = q.pending;
      try {
        await api.patchPreferences(q.auth, { default_swarm_mode: next.value }, cred);
        if (!q.disposed && q.pending?.seq === next.seq) {
          q.pending = null;
        }
      } catch (err) {
        if (q.disposed) break;
        const credentialInvalidated =
          err instanceof AuthEpochStaleError ||
          q.credential !== cred ||
          authRef.current !== q.auth ||
          !identityIsCurrent(cred, q.auth, q.userId);
        if (credentialInvalidated) {
          if (!q.credential || q.credential === cred || !identityIsCurrent(q.credential, q.auth, q.userId)) {
            break;
          }
          continue;
        }
        // Best-effort: non-auth error (e.g. HTTP 400 on legacy backend) while credential is still
        // current. Account-scoped localStorage already persisted; settle this exact intent so a
        // later unrelated token refresh does not replay it.
        if (q.pending?.seq === next.seq) {
          q.pending = null;
        }
      }
    }
  } finally {
    q.inFlight = false;
  }
}

function pumpSwarmPatchQueue(q: AccountSwarmSyncQueue | null, authRef: RefObject<AuthSession>): void {
  if (!q || q.disposed || q.inFlight || q.pending === null) return;
  if (!q.credential || authRef.current !== q.auth || !identityIsCurrent(q.credential, q.auth, q.userId)) return;
  q.inFlight = true;
  void drainSwarmPatchQueue(q, authRef);
}

/**
 * OCV5-927: Serialized single-writer server sync for `user_preferences.default_swarm_mode`.
 * Updates local `modelPrefs` immediately and coalesces rapid toggles into strictly serial
 * single-flight PATCHes per `(auth, userId, epoch)`. Same-account token refreshes preserve both
 * the in-flight barrier and the latest unconfirmed intent; explicit logout, session expiry,
 * account switch, AuthSession replacement, or unmount dispose the queue immediately.
 */
export function usePersistDefaultSwarmMode(opts: {
  demo: boolean;
  auth: AuthSession | null;
  authRef: RefObject<AuthSession>;
  resolvedIdentity: ResolvedIdentity | null;
  setModelPrefs: Dispatch<SetStateAction<PrefsView>>;
}): (enabled: boolean) => void {
  const { demo, auth, authRef, resolvedIdentity, setModelPrefs } = opts;
  const queueRef = useRef<AccountSwarmSyncQueue | null>(null);
  const seqRef = useRef(0);

  const syncQueue = useCallback((): AccountSwarmSyncQueue | null => {
    const existing = queueRef.current;
    if (existing && !isQueueValid(existing, demo, auth, authRef, resolvedIdentity)) {
      disposeQueue(existing);
      queueRef.current = null;
    }
    if (queueRef.current) {
      queueRef.current.credential = resolvedIdentity;
      return queueRef.current;
    }
    if (!demo && auth && resolvedIdentity && auth === authRef.current && auth.snapshot().epoch === resolvedIdentity.epoch) {
      queueRef.current = {
        auth,
        userId: resolvedIdentity.userId,
        epoch: resolvedIdentity.epoch,
        inFlight: false,
        pending: null,
        credential: resolvedIdentity,
        disposed: false,
      };
      return queueRef.current;
    }
    return null;
  }, [demo, auth, authRef, resolvedIdentity]);

  syncQueue();

  useEffect(() => {
    pumpSwarmPatchQueue(syncQueue(), authRef);
  }, [syncQueue, authRef]);

  useEffect(() => {
    return () => {
      disposeQueue(queueRef.current);
      queueRef.current = null;
    };
  }, []);

  return useCallback(
    (enabled: boolean) => {
      if (demo) return;
      setModelPrefs((prev) =>
        prev.default_swarm_mode === enabled ? prev : { ...prev, default_swarm_mode: enabled },
      );
      const q = syncQueue();
      if (!q) return;
      q.pending = { value: enabled, seq: ++seqRef.current };
      pumpSwarmPatchQueue(q, authRef);
    },
    [demo, authRef, setModelPrefs, syncQueue],
  );
}

/**
 * OCV5-927: Account-scoped localStorage mirror and cross-tab sync for `default_swarm_mode`.
 * Seeds localStorage from server preferences only when absent so a fresh sibling tab never
 * overwrites an in-flight local toggle with stale server state.
 */
export function useAccountDefaultSwarmSync(accountId: string | undefined, defaultSwarmMode: boolean | undefined) {
  const [defaultMap, setDefaultMap] = useState<Record<string, boolean | null>>({});
  const localDefaultDirtyRef = useRef<{ accountId: string | undefined; dirty: boolean }>({
    accountId: undefined,
    dirty: false,
  });
  if (localDefaultDirtyRef.current.accountId !== accountId) {
    localDefaultDirtyRef.current = { accountId, dirty: false };
  }
  const syncingServerDefaultRef = useRef(false);

  useEffect(() => {
    if (!accountId) return;
    const set = (v: boolean | undefined) => {
      const next = v ?? null;
      setDefaultMap((prev) => (prev[accountId] === next ? prev : { ...prev, [accountId]: next }));
    };
    set(readDefaultSwarmMode(accountId));
    return subscribeDefaultSwarmMode(accountId, (v) => {
      if (!syncingServerDefaultRef.current) {
        localDefaultDirtyRef.current = { accountId, dirty: true };
      }
      set(v);
    });
  }, [accountId]);

  useEffect(() => {
    if (!accountId || typeof defaultSwarmMode !== "boolean" || localDefaultDirtyRef.current.dirty) return;
    if (readDefaultSwarmMode(accountId) === undefined) {
      syncingServerDefaultRef.current = true;
      try {
        writeDefaultSwarmMode(accountId, defaultSwarmMode);
      } finally {
        syncingServerDefaultRef.current = false;
      }
      setDefaultMap((prev) =>
        prev[accountId] === defaultSwarmMode ? prev : { ...prev, [accountId]: defaultSwarmMode },
      );
    }
  }, [accountId, defaultSwarmMode]);

  const localDefaultValue = accountId
    ? accountId in defaultMap
      ? (defaultMap[accountId] ?? undefined)
      : readDefaultSwarmMode(accountId)
    : undefined;
  const resolvedDefault = localDefaultDirtyRef.current.dirty
    ? (localDefaultValue ?? defaultSwarmMode ?? false)
    : typeof defaultSwarmMode === "boolean"
      ? defaultSwarmMode
      : (localDefaultValue ?? false);

  const markLocalDefault = useCallback(
    (next: boolean) => {
      if (!accountId) return;
      localDefaultDirtyRef.current = { accountId, dirty: true };
      writeDefaultSwarmMode(accountId, next);
      setDefaultMap((prev) => ({ ...prev, [accountId]: next }));
    },
    [accountId],
  );

  return { resolvedDefault, markLocalDefault };
}
