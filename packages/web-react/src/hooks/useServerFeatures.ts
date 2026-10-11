import {
  SERVER_FEATURES_OFF,
  parseServerFeatures,
  type ServerFeatures,
} from "@openclaude/protocol";
import { useEffect, useState } from "react";
import { bearerHeaders, callWithRefresh, jsonOrThrow } from "../lib/api";
import type { AuthSession } from "../lib/types";

export type { ServerFeatures };
export { SERVER_FEATURES_OFF };

/**
 * Server-side feature flags (GET /api/features, served by the user's container).
 * Read once per login identity: the cache key is the AuthSession plus its epoch,
 * so a logout/account switch reads again. Anything that goes wrong reads as all
 * off, and a failed read is not cached so the next mount can try again.
 */
const cache = new WeakMap<AuthSession, { epoch: number; value: Promise<ServerFeatures> }>();
const settled = new WeakMap<Promise<ServerFeatures>, ServerFeatures>();

export function loadServerFeatures(a: AuthSession): Promise<ServerFeatures> {
  const epoch = a.snapshot().epoch;
  const hit = cache.get(a);
  if (hit && hit.epoch === epoch) return hit.value;
  const value: Promise<ServerFeatures> = jsonOrThrow<unknown>(
    callWithRefresh(a, (t) =>
      fetch("/api/features", { credentials: "include", headers: bearerHeaders(t) }),
    ),
  ).then(
    (body) => {
      const parsed = parseServerFeatures(body);
      settled.set(value, parsed);
      return parsed;
    },
    () => {
      if (cache.get(a)?.value === value) cache.delete(a);
      return SERVER_FEATURES_OFF;
    },
  );
  cache.set(a, { epoch, value });
  return value;
}

export function useServerFeatures(auth: AuthSession | null, demo: boolean): ServerFeatures {
  const epoch = auth?.snapshot().epoch;
  const [state, setState] = useState<{ auth: AuthSession | null; epoch?: number; value: ServerFeatures }>(() => {
    const hit = auth && !demo ? cache.get(auth) : undefined;
    const known = hit && hit.epoch === epoch ? settled.get(hit.value) : undefined;
    return known ? { auth, epoch, value: known } : { auth: null, value: SERVER_FEATURES_OFF };
  });
  useEffect(() => {
    if (!auth || demo) return;
    let alive = true;
    void loadServerFeatures(auth).then((value) => {
      // Identity changed while reading: drop it; the render for the new identity reads again.
      if (alive && auth.snapshot().epoch === epoch) setState({ auth, epoch, value });
    });
    return () => {
      alive = false;
    };
  }, [auth, demo, epoch]);
  if (!auth || demo || state.auth !== auth || state.epoch !== epoch) return SERVER_FEATURES_OFF;
  return state.value;
}
