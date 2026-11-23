import { AuthEpochStaleError } from "./http";

type AnyAsyncFn = (...args: never[]) => Promise<unknown>;

function isAuthSessionLike(value: unknown): value is { snapshot(): { epoch: number } } {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { snapshot?: unknown }).snapshot === "function"
  );
}

/**
 * Create a lightweight lazy-forwarding object whose enumerable keys match `keys`
 * and whose TypeScript surface matches `T` verbatim.
 *
 * Keeps non-first-screen endpoint strings, payload adapters, and helpers out of
 * the entry static closure while preserving `api.<method>` identity for callers
 * and `vi.spyOn(api, ...)` tests. When the first argument is an `AuthSession`,
 * the auth epoch is captured before chunk load and verified after resolution so
 * an account switch during chunk download fails closed with `AuthEpochStaleError`.
 */
export function createLazyApiDomain<T extends Record<string, AnyAsyncFn>>(
  load: () => Promise<T>,
  keys: readonly (keyof T & string)[],
): T {
  let cached: T | null = null;
  let pending: Promise<T> | null = null;

  const ensureLoaded = (): Promise<T> => {
    if (cached) return Promise.resolve(cached);
    if (!pending) {
      pending = load().then(
        (mod) => {
          cached = mod;
          return mod;
        },
        (err: unknown) => {
          pending = null;
          throw err;
        },
      );
    }
    return pending;
  };

  const out = {} as T;
  for (const key of keys) {
    out[key] = ((...args: unknown[]) => {
      const first = args[0];
      const auth = isAuthSessionLike(first) ? first : null;
      const startEpoch = auth ? auth.snapshot().epoch : null;
      if (cached) {
        return (cached[key] as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args);
      }
      return ensureLoaded().then((mod) => {
        if (auth && auth.snapshot().epoch !== startEpoch) {
          throw new AuthEpochStaleError();
        }
        return (mod[key] as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args);
      });
    }) as unknown as T[typeof key];
  }
  return out;
}
