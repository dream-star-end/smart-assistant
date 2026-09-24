/** Bounded, non-retrying Connect Exec transport for the Box model adapter. */
import {
  encodeExecRequest,
  parseExecFramesStrict,
  type BoxCcExecRequest,
} from "@openclaude/gateway";

export interface BoxExecTarget {
  execUrl: string;
  execToken: string;
  networkToken: string;
}

export class BoxExecTransportError extends Error {
  constructor(readonly code: string, readonly terminalKnown: boolean,
    readonly remoteExitCode: number | null = null) {
    super(code);
    this.name = "BoxExecTransportError";
  }
}

export interface BoxExecResult {
  stdout: string;
  stderrBytes: number;
  /** Only a fully parsed remote exit=0 plus EOF reaches a successful result. */
  exitCode: 0;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** A tee'd or broken stream can keep cancel() pending forever. Cancellation is
 * best-effort cleanup, never a second unbounded phase after the call deadline.
 */
async function boundedCancel(cancel: () => Promise<unknown>, deadlineAt: number): Promise<void> {
  let pending: Promise<unknown>;
  try { pending = Promise.resolve(cancel()); }
  catch { return; }
  const observed = pending.then(() => {}, () => {});
  const remaining = Math.min(200, Math.max(0, deadlineAt - Date.now()));
  if (remaining === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([observed, new Promise<void>((resolve) => {
      timer = setTimeout(resolve, remaining);
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BoxExecTransport {
  constructor(private readonly target: BoxExecTarget,
    private readonly fetchImpl: FetchFn,
    private readonly assertCurrent: () => Promise<void>) {
    let url: URL;
    try { url = new URL(target.execUrl); }
    catch { throw new BoxExecTransportError("BOX_EXEC_TARGET_INVALID", false); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || !target.execToken || !target.networkToken) {
      throw new BoxExecTransportError("BOX_EXEC_TARGET_INVALID", false);
    }
  }

  async run(request: BoxCcExecRequest, opts: {
    timeoutMs: number;
    maxResponseBytes?: number;
    signal?: AbortSignal;
    onStdout?: (chunk: string) => void;
  }): Promise<BoxExecResult> {
    if (!Number.isSafeInteger(opts.timeoutMs) || opts.timeoutMs < 1000 || opts.timeoutMs > 120_000
      || !Number.isSafeInteger(opts.maxResponseBytes ?? 262_144)
      || (opts.maxResponseBytes ?? 262_144) < 1024
      || (opts.maxResponseBytes ?? 262_144) > 1_048_576
      || typeof request.command !== "string" || !request.command.startsWith("/")
      || request.command.includes("\0") || typeof request.cwd !== "string"
      || !request.cwd.startsWith("/") || request.cwd.includes("\0")
      || !Array.isArray(request.args) || request.args.some((arg) => typeof arg !== "string")
      || !request.environment || typeof request.environment !== "object") {
      throw new BoxExecTransportError("BOX_EXEC_REQUEST_INVALID", false);
    }
    const body = encodeExecRequest(request);
    if (body.byteLength > 8 * 1024 * 1024) {
      throw new BoxExecTransportError("BOX_EXEC_REQUEST_TOO_LARGE", false);
    }
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    const deadlineAt = Date.now() + opts.timeoutMs;
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(
        new BoxExecTransportError("BOX_EXEC_ABORTED", false)), { once: true });
    });
    // Caller signal may already be aborted before the first Promise.race is
    // installed; keep the shared cancellation promise rejection observed.
    void aborted.catch(() => {});
    const raceAbort = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    const ensureLive = (): void => {
      if (Date.now() >= deadlineAt) onAbort();
      if (abort.signal.aborted) throw new BoxExecTransportError("BOX_EXEC_ABORTED", false);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    if (opts.signal?.aborted) abort.abort();
    const timer = setTimeout(onAbort, opts.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      ensureLive();
      await raceAbort(Promise.resolve().then(() => this.assertCurrent()).catch(() => {
        throw new BoxExecTransportError("BOX_EXEC_ACCOUNT_GUARD_FAILED", false);
      }));
      ensureLive();
      let response: Response;
      try {
        response = await raceAbort(this.fetchImpl(this.target.execUrl, {
          method: "POST", redirect: "error", signal: abort.signal,
          headers: {
            authorization: `Bearer ${this.target.execToken}`,
            "content-type": "application/connect+json",
            "connect-protocol-version": "1",
            "x-anyrun-network-token": this.target.networkToken,
          },
          body: new Uint8Array(body),
        }));
      } catch (error) {
        if (error instanceof BoxExecTransportError) throw error;
        throw new BoxExecTransportError("BOX_EXEC_TRANSPORT_UNKNOWN", false);
      }
      ensureLive();
      if (!response.ok || !response.body) {
        if (response.body) await boundedCancel(() => response.body!.cancel(), deadlineAt);
        throw new BoxExecTransportError(`BOX_EXEC_HTTP_${response.status}`, false);
      }
      reader = response.body.getReader();
      let pending = Buffer.alloc(0), stdout = "", stderrBytes = 0;
      let total = 0, exitCode: number | null = null, sawEnd = false;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await raceAbort(reader.read()); }
        catch (error) {
          if (error instanceof BoxExecTransportError) throw error;
          throw new BoxExecTransportError("BOX_EXEC_STREAM_UNKNOWN", false);
        }
        ensureLive();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > (opts.maxResponseBytes ?? 262_144)) {
          throw new BoxExecTransportError("BOX_EXEC_RESPONSE_TOO_LARGE", false);
        }
        pending = Buffer.concat([pending, Buffer.from(chunk.value)]);
        let parsed: ReturnType<typeof parseExecFramesStrict>;
        try { parsed = parseExecFramesStrict(pending); }
        catch { throw new BoxExecTransportError("BOX_EXEC_FRAME_INVALID", false); }
        pending = Buffer.from(parsed.rest);
        for (const event of parsed.events) {
          ensureLive();
          if (sawEnd) throw new BoxExecTransportError("BOX_EXEC_AFTER_END", false);
          if (event.kind === "end") {
            if (exitCode === null) throw new BoxExecTransportError("BOX_EXEC_END_BEFORE_EXIT", false);
            sawEnd = true;
            continue;
          }
          if (exitCode !== null) throw new BoxExecTransportError("BOX_EXEC_AFTER_EXIT", false);
          if (event.kind === "stdout") {
            stdout += event.data ?? "";
            try { opts.onStdout?.(event.data ?? ""); }
            catch { throw new BoxExecTransportError("BOX_EXEC_CONSUMER_FAILED", false); }
            ensureLive();
          } else if (event.kind === "stderr") {
            stderrBytes += Buffer.byteLength(event.data ?? "");
          } else {
            exitCode = event.code ?? null;
          }
        }
      }
      ensureLive();
      if (pending.length !== 0 || exitCode === null || !sawEnd) {
        throw new BoxExecTransportError("BOX_EXEC_INCOMPLETE", false);
      }
      if (exitCode !== 0) {
        throw new BoxExecTransportError("BOX_EXEC_REMOTE_EXIT", true, exitCode);
      }
      return { stdout, stderrBytes, exitCode: 0 };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (reader) {
        await boundedCancel(() => reader!.cancel(), deadlineAt);
        try { reader.releaseLock(); } catch { /* pending read/cancel already detached */ }
      }
    }
  }
}
