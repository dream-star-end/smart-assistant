/**
 * Shared JS-deadline wrapper for on-demand read-only PG work (OCV5-180 C I3).
 *
 * statement_timeout only applies after a session exists; pool.connect() and
 * hanging queries are therefore bounded here. Late connect/query results are
 * consumed and the client is released/destroyed exactly once so they cannot
 * keep reading or leak unhandled rejections.
 */
export type BoundedReadKind = "timeout" | "connect" | "query";

export class BoundedReadError extends Error {
  readonly kind: BoundedReadKind;
  constructor(kind: BoundedReadKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BoundedReadError";
    this.kind = kind;
  }
}

export function isBoundedReadTimeout(err: unknown): boolean {
  if (err instanceof BoundedReadError) return err.kind === "timeout";
  const e = err as { code?: string; message?: string };
  return e.code === "57014" || /statement timeout/i.test(String(e.message ?? ""));
}

export type BoundedReadClient = {
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ) => PromiseLike<{ rows: T[] }>;
  release?: (err?: Error | boolean) => void;
};

export type BoundedReadPool = {
  connect: () => PromiseLike<BoundedReadClient> | BoundedReadClient;
};

function swallow(promise: PromiseLike<unknown>): void {
  void Promise.resolve(promise).then(
    () => undefined,
    () => undefined,
  );
}

function releaseClient(client: BoundedReadClient, destroy: boolean, err?: Error): void {
  try {
    client.release?.(destroy ? (err ?? true) : undefined);
  } catch {
    /* already released */
  }
}

/**
 * Run `fn` inside `BEGIN READ ONLY` with a hard JS deadline covering connect
 * and queries. Does not use SET default_transaction_read_only (that only
 * affects later transactions). On timeout the client is destroyed rather than
 * returned to the pool.
 */
export async function withBoundedReadOnly<T>(
  pool: BoundedReadPool,
  timeoutMs: number,
  fn: (client: BoundedReadClient) => Promise<T>,
): Promise<T> {
  const budget = Math.max(1, Math.floor(timeoutMs));
  const startedAt = Date.now();
  const leftoverMs = (): number => Math.max(1, budget - (Date.now() - startedAt));
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let abandoned = false;
  let handedOff = false;
  let disposed = false;
  let client: BoundedReadClient | null = null;
  let work: Promise<T> | null = null;

  const dispose = (destroy: boolean, err?: Error): void => {
    if (disposed) return;
    disposed = true;
    const held = client;
    client = null;
    if (held) releaseClient(held, destroy, err);
  };

  const timeoutError = (): BoundedReadError =>
    new BoundedReadError("timeout", "bounded read deadline exceeded");

  const timeoutP = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      abandoned = true;
      dispose(true, new Error("bounded read deadline exceeded"));
      reject(timeoutError());
    }, budget);
    timers.add(timer);
  });
  swallow(timeoutP);

  const connectP = Promise.resolve().then(() => pool.connect());
  swallow(
    Promise.resolve(connectP).then(
      (acquired) => {
        if (handedOff) return;
        if (abandoned) releaseClient(acquired, true, new Error("late connect after deadline"));
      },
      () => undefined,
    ),
  );

  try {
    const acquired = await Promise.race([connectP, timeoutP]);
    if (abandoned) throw timeoutError();
    handedOff = true;
    client = acquired;
    if (Date.now() >= startedAt + budget) {
      abandoned = true;
      throw timeoutError();
    }

    work = (async () => {
      await acquired.query("BEGIN READ ONLY");
      if (abandoned) throw timeoutError();
      await acquired.query(`SET LOCAL statement_timeout = ${leftoverMs()}`);
      if (abandoned) throw timeoutError();
      const value = await fn(acquired);
      if (abandoned) throw timeoutError();
      await acquired.query("COMMIT");
      return value;
    })();
    swallow(work);

    const value = await Promise.race([work, timeoutP]);
    if (abandoned) throw timeoutError();
    return value;
  } catch (err) {
    abandoned = true;
    if (work) swallow(work);
    dispose(true, err instanceof Error ? err : new Error(String(err)));
    if (err instanceof BoundedReadError) throw err;
    const kind: BoundedReadKind = isBoundedReadTimeout(err)
      ? "timeout"
      : handedOff
        ? "query"
        : "connect";
    throw new BoundedReadError(kind, (err as Error)?.message ?? String(err), { cause: err });
  } finally {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    if (!disposed) dispose(false);
  }
}
