import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { DelegateFailureController, EMPTY_FAILURE_INBOX } from "../lib/delegateFailureController";
import type { AuthSession } from "../lib/types";

const empty = () => EMPTY_FAILURE_INBOX;
const noopSubscribe = () => () => {};

/** App/account scoped: intentionally has no active-session dependency. */
export function useDelegateFailures(auth: AuthSession | null, userId: string | null, enabled: boolean) {
  const epoch = auth?.snapshot().epoch;
  const scope = useRef({ auth, userId, enabled, epoch });
  scope.current = { auth, userId, enabled, epoch };
  const controller = useMemo(() => auth && userId && enabled ? new DelegateFailureController(auth, userId, () =>
    scope.current.auth === auth && scope.current.userId === userId && scope.current.enabled && scope.current.epoch === epoch,
  ) : null, [auth, userId, enabled, epoch]);
  const state = useSyncExternalStore(controller?.subscribe ?? noopSubscribe, controller?.getSnapshot ?? empty, empty);
  useEffect(() => {
    if (!controller) return;
    controller.start();
    const refresh = () => { if (document.visibilityState === "visible") void controller.refresh(); };
    const timer = window.setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); controller.stop(); };
  }, [controller]);
  return { state, controller };
}
