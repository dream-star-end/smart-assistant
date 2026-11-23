import {
  type ComponentProps,
  type ComponentType,
  createElement,
  lazy,
  type LazyExoticComponent,
} from "react";

export type RetryableLazyComponent<T extends ComponentType<any>> = ((
  props: ComponentProps<T>,
) => ReturnType<typeof createElement>) & {
  preload: () => Promise<{ default: T }>;
  reset: () => void;
};

/**
 * Create a rebuildable `React.lazy` wrapper.
 *
 * Plain `React.lazy` permanently caches a rejected promise on the lazy object,
 * leaving ErrorBoundary retries stuck forever after a transient network drop or
 * stale chunk 404. This wrapper clears the in-flight promise and replaces the
 * inner `React.lazy` instance on rejection so the next render / retry genuinely
 * re-fetches, while keeping the inner lazy instance stable once resolved (no
 * remounting) and resolving synchronously via a thenable once preloaded.
 */
export function createRetryableLazy<T extends ComponentType<any>>(
  loader: () => Promise<{ default: T }>,
): RetryableLazyComponent<T> {
  let loaded: { default: T } | null = null;
  let pending: Promise<{ default: T }> | null = null;
  let inner: LazyExoticComponent<T> = makeInner();

  function load(): Promise<{ default: T }> {
    if (loaded) return Promise.resolve(loaded);
    if (!pending) {
      pending = loader().then(
        (mod) => {
          loaded = mod;
          return mod;
        },
        (err: unknown) => {
          pending = null;
          inner = makeInner();
          throw err;
        },
      );
    }
    return pending;
  }

  function makeInner(): LazyExoticComponent<T> {
    return lazy(() => {
      if (loaded) {
        const ready = loaded;
        return {
          // biome-ignore lint/suspicious/noThenProperty: synchronous thenable for React.lazy once preloaded
          then(resolve: (value: { default: T }) => void) {
            resolve(ready);
          },
        } as unknown as Promise<{ default: T }>;
      }
      return load();
    });
  }

  function RetryableLazy(props: ComponentProps<T>) {
    return createElement(inner, props);
  }

  RetryableLazy.preload = load;
  RetryableLazy.reset = () => {
    loaded = null;
    pending = null;
    inner = makeInner();
  };

  return RetryableLazy;
}
