/** Bounded, non-retrying Connect Exec transport for the Box model adapter. */
import {
  encodeExecRequest,
  parseExecFramesStrict,
  type BoxCcExecRequest,
} from "@openclaude/gateway";
import { rootLogger } from "../../logging/logger.js";

const transportLog = rootLogger.child({ subsys: "box-exec-transport" });

import { classifyBoxFailureCause, type BoxFailureCauseTag, type BoxFailureStage } from "./boxFailureCause.js";

export interface BoxExecTarget {
  execUrl: string;
  execToken: string;
  networkToken: string;
}

export class BoxExecTransportError extends Error {
  constructor(readonly code: string, readonly terminalKnown: boolean,
    readonly remoteExitCode: number | null = null,
    readonly causeTag: BoxFailureCauseTag = classifyBoxFailureCause({ code }),
    readonly stage: BoxFailureStage = "validate") {
    super(code);
    this.name = "BoxExecTransportError";
  }
}

// A rejected fetch/read may carry a revoked Proxy; even instanceof can throw.
function isTransportError(error: unknown): error is BoxExecTransportError {
  try { return error instanceof BoxExecTransportError; } catch { return false; }
}

export interface BoxExecResult {
  stdout: string;
  stderrBytes: number;
  /** Only a fully parsed remote exit=0 plus EOF reaches a successful result. */
  exitCode: 0;
}

type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** What one Exec 417 said, already reduced to a bounded, redacted excerpt. */
export interface BoxExecRejection {
  status: number;
  /** Body bytes read (at most BOX_EXEC_REJECTION_READ_BYTES); the rest is never read. */
  bodyBytes: number;
  excerpt: string;
}

export interface BoxExecTransportOptions {
  /** OCV5-762: Cursor's Exec gateway answered HTTP 417 in the middle of a
   * long Box turn (uid 4, 2026-11-12 19:53:39 and 20:03:40 CST) and the turn
   * could never continue. After a 417 the next call first asks for a fresh
   * Exec descriptor of the same Box (new URL/tokens), so a caller that retries
   * an idempotent read does not resend on the descriptor that was refused.
   * The transport itself still never retries a request. */
  refreshTarget?: (signal: AbortSignal) => Promise<BoxExecTarget>;
  /** Deadline of one shared refresh (default BOX_EXEC_REFRESH_TIMEOUT_MS). */
  refreshTimeoutMs?: number;
  /** Observation hook for a 417 (tests, proofs). Logging happens regardless. */
  onRejected?: (rejection: BoxExecRejection) => void;
}

/** GetState + one Ensure each have a 15 s client timeout; a refresh that has not
 * produced a descriptor by then has failed. */
export const BOX_EXEC_REFRESH_TIMEOUT_MS = 20_000;

export const BOX_EXEC_REJECTION_READ_BYTES = 2048;
const BOX_EXEC_REJECTION_EXCERPT_CHARS = 300;
const BOX_EXEC_REJECTION_READ_MS = 500;

/** Bounded, content-safe excerpt of an Exec rejection body: control
 * characters dropped, bearer values, JWT-like values, URL queries, long
 * opaque runs and the caller's own secrets replaced, then capped. */
export function redactBoxExecRejection(bytes: Uint8Array, secrets: readonly string[] = []): string {
  let text = Buffer.from(bytes.subarray(0, BOX_EXEC_REJECTION_READ_BYTES)).toString("utf8");
  for (const secret of secrets) {
    if (secret.length >= 8) text = text.split(secret).join("<redacted>");
  }
  text = Array.from(text, (ch) => {
    const code = ch.codePointAt(0) ?? 0;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffd ? " " : ch;
  }).join("")
    .replace(/\bbearer\s+[^\s"',;]+/gi, "Bearer <redacted>")
    .replace(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]*)?/g, "<redacted>")
    .replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, "$1?<redacted>")
    .replace(/[A-Za-z0-9+/=_.~-]{24,}/g, "<redacted>")
    .replace(/\s+/g, " ").trim();
  return text.length > BOX_EXEC_REJECTION_EXCERPT_CHARS
    ? `${text.slice(0, BOX_EXEC_REJECTION_EXCERPT_CHARS)}…` : text;
}

function validTarget(target: BoxExecTarget): boolean {
  if (!target || typeof target.execUrl !== "string" || typeof target.execToken !== "string"
    || typeof target.networkToken !== "string") return false;
  let url: URL;
  try { url = new URL(target.execUrl); }
  catch { return false; }
  return url.protocol === "https:" && !url.username && !url.password && !url.hash
    && target.execToken.length > 0 && target.networkToken.length > 0;
}

/** Read at most BOX_EXEC_REJECTION_READ_BYTES of a rejection body within a
 * short, deadline-bounded window, then cancel the rest. Never throws. */
async function readRejectionBody(body: ReadableStream<Uint8Array> | null,
  deadlineAt: number): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const stopAt = Math.min(deadlineAt, Date.now() + BOX_EXEC_REJECTION_READ_MS);
  try {
    reader = body.getReader();
    while (total < BOX_EXEC_REJECTION_READ_BYTES) {
      const remaining = stopAt - Date.now();
      if (remaining <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([reader.read(), new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), remaining);
      })]).finally(() => { if (timer) clearTimeout(timer); });
      if (next === null || next.done) break;
      const take = Buffer.from(next.value.subarray(0, BOX_EXEC_REJECTION_READ_BYTES - total));
      chunks.push(take);
      total += take.length;
    }
  } catch { /* an unreadable body is reported as what was read */ }
  finally {
    if (reader) {
      const held = reader;
      await boundedCancel(() => held.cancel(), deadlineAt);
      try { held.releaseLock(); } catch { /* pending read/cancel already detached */ }
    } else {
      await boundedCancel(() => body.cancel(), deadlineAt);
    }
  }
  return Buffer.concat(chunks);
}

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
  private target: BoxExecTarget;
  /** OCV5-762: set by an HTTP 417; the next call refreshes the descriptor first. */
  private refreshDue = false;
  private refreshing: Promise<BoxExecTarget> | null = null;
  constructor(target: BoxExecTarget,
    private readonly fetchImpl: FetchFn,
    private readonly assertCurrent: () => Promise<void>,
    private readonly options: BoxExecTransportOptions = {}) {
    let url: URL;
    try { url = new URL(target.execUrl); }
    catch { throw new BoxExecTransportError("BOX_EXEC_TARGET_INVALID", false); }
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || !target.execToken || !target.networkToken) {
      throw new BoxExecTransportError("BOX_EXEC_TARGET_INVALID", false);
    }
    this.target = { execUrl: target.execUrl, execToken: target.execToken,
      networkToken: target.networkToken };
  }

  /** One shared refresh at a time, bounded by its own deadline (a hung control
   * plane must not leave every later call waiting on it); each caller also races
   * it against its own deadline. */
  private refreshOnce(): Promise<BoxExecTarget> {
    const refresh = this.options.refreshTarget;
    if (!refresh) return Promise.resolve(this.target);
    if (!this.refreshing) {
      const own = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          own.abort();
          reject(new BoxExecTransportError("BOX_EXEC_REFRESH_FAILED", false));
        }, this.options.refreshTimeoutMs ?? BOX_EXEC_REFRESH_TIMEOUT_MS);
      });
      const pending = Promise.race([
        Promise.resolve().then(() => refresh(own.signal)),
        expired,
      ]).then((next) => {
        if (!validTarget(next)) throw new BoxExecTransportError("BOX_EXEC_REFRESH_FAILED", false);
        this.target = { execUrl: next.execUrl, execToken: next.execToken,
          networkToken: next.networkToken };
        this.refreshDue = false;
        return this.target;
      });
      this.refreshing = pending;
      void pending.finally(() => {
        if (timer) clearTimeout(timer);
        if (this.refreshing === pending) this.refreshing = null;
      }).catch(() => {});
    }
    return this.refreshing;
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
    let abortOrigin: "caller" | "deadline" | null = null;
    const abortWith = (origin: "caller" | "deadline"): void => {
      if (abortOrigin === null) abortOrigin = origin;
      abort.abort();
    };
    let stage: BoxFailureStage = "guard";
    const abortedError = (): BoxExecTransportError => new BoxExecTransportError(
      abortOrigin === "deadline" ? "BOX_EXEC_TIMEOUT" : "BOX_EXEC_ABORTED", false, null,
      abortOrigin === "deadline" ? "deadline" : "aborted", stage);
    const onCallerAbort = (): void => abortWith("caller");
    const deadlineAt = Date.now() + opts.timeoutMs;
    const aborted = new Promise<never>((_, reject) => {
      abort.signal.addEventListener("abort", () => reject(abortedError()), { once: true });
    });
    // Caller signal may already be aborted before the first Promise.race is
    // installed; keep the shared cancellation promise rejection observed.
    void aborted.catch(() => {});
    const raceAbort = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    const ensureLive = (): void => {
      if (Date.now() >= deadlineAt) abortWith("deadline");
      if (abort.signal.aborted) throw abortedError();
    };
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (opts.signal?.aborted) abortWith("caller");
    const timer = setTimeout(() => abortWith("deadline"), opts.timeoutMs);
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    try {
      ensureLive();
      await raceAbort(Promise.resolve().then(() => this.assertCurrent()).catch(() => {
        throw new BoxExecTransportError("BOX_EXEC_ACCOUNT_GUARD_FAILED", false, null, "account_guard", "guard");
      }));
      ensureLive();
      stage = "fetch";
      if (this.refreshDue && this.options.refreshTarget) {
        try { await raceAbort(this.refreshOnce()); }
        catch (error) {
          // A caller that gives up is ABORTED; running out of time while the
          // descriptor is still being refreshed is a failed refresh, not a
          // transient timeout, so the round is stopped instead of retried.
          if (abortOrigin === "caller") throw abortedError();
          if (error instanceof BoxExecTransportError && error.code !== "BOX_EXEC_REFRESH_FAILED"
            && abortOrigin === null) throw error;
          throw new BoxExecTransportError("BOX_EXEC_REFRESH_FAILED", false);
        }
        ensureLive();
        // The account/credential/egress may have changed while we waited.
        await raceAbort(Promise.resolve().then(() => this.assertCurrent()).catch(() => {
          throw new BoxExecTransportError("BOX_EXEC_ACCOUNT_GUARD_FAILED", false);
        }));
        ensureLive();
      }
      const target = this.target;
      let response: Response;
      try {
        response = await raceAbort(this.fetchImpl(target.execUrl, {
          method: "POST", redirect: "error", signal: abort.signal,
          headers: {
            authorization: `Bearer ${target.execToken}`,
            "content-type": "application/connect+json",
            "connect-protocol-version": "1",
            "x-anyrun-network-token": target.networkToken,
          },
          body: new Uint8Array(body),
        }));
      } catch (error) {
        if (isTransportError(error)) throw error;
        if (abort.signal.aborted) throw abortedError();
        throw new BoxExecTransportError("BOX_EXEC_TRANSPORT_UNKNOWN", false, null, classifyBoxFailureCause(error), "fetch");
      }
      ensureLive();
      if (!response.ok || !response.body) {
        if (response.status === 417) {
          // OCV5-762: the descriptor was refused; refresh it before the next call
          // and keep a bounded, redacted copy of what Cursor said.
          this.refreshDue = true;
          const raw = await readRejectionBody(response.body, deadlineAt);
          const rejection: BoxExecRejection = { status: 417, bodyBytes: raw.length,
            excerpt: redactBoxExecRejection(raw, [target.execToken, target.networkToken]) };
          transportLog.warn("box_exec_http_rejected", { ...rejection,
            refresh: this.options.refreshTarget ? "next_call" : "unavailable" });
          try { this.options.onRejected?.(rejection); } catch { /* observation only */ }
        } else if (response.body) await boundedCancel(() => response.body!.cancel(), deadlineAt);
        throw new BoxExecTransportError(`BOX_EXEC_HTTP_${response.status}`, false, null, "http", "http");
      }
      stage = "stream";
      reader = response.body.getReader();
      let pending = Buffer.alloc(0), stdout = "", stderrBytes = 0;
      let total = 0, exitCode: number | null = null, sawEnd = false;
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await raceAbort(reader.read()); }
        catch (error) {
          if (isTransportError(error)) throw error;
          if (abort.signal.aborted) throw abortedError();
          throw new BoxExecTransportError("BOX_EXEC_STREAM_UNKNOWN", false, null, classifyBoxFailureCause(error), "stream");
        }
        ensureLive();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > (opts.maxResponseBytes ?? 262_144)) {
          throw new BoxExecTransportError("BOX_EXEC_RESPONSE_TOO_LARGE", false, null, "output_limit", "stream");
        }
        pending = Buffer.concat([pending, Buffer.from(chunk.value)]);
        let parsed: ReturnType<typeof parseExecFramesStrict>;
        try { parsed = parseExecFramesStrict(pending); }
        catch { throw new BoxExecTransportError("BOX_EXEC_FRAME_INVALID", false, null, "protocol", "decode"); }
        pending = Buffer.from(parsed.rest);
        for (const event of parsed.events) {
          ensureLive();
          if (sawEnd) throw new BoxExecTransportError("BOX_EXEC_AFTER_END", false, null, "protocol", "decode");
          if (event.kind === "end") {
            if (exitCode === null) throw new BoxExecTransportError("BOX_EXEC_END_BEFORE_EXIT", false, null, "protocol", "decode");
            sawEnd = true;
            continue;
          }
          if (exitCode !== null) throw new BoxExecTransportError("BOX_EXEC_AFTER_EXIT", false, null, "protocol", "decode");
          if (event.kind === "stdout") {
            stdout += event.data ?? "";
            try { opts.onStdout?.(event.data ?? ""); }
            catch { throw new BoxExecTransportError("BOX_EXEC_CONSUMER_FAILED", false, null, "consumer", "consumer"); }
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
        throw new BoxExecTransportError("BOX_EXEC_INCOMPLETE", false, null, "protocol", "decode");
      }
      if (exitCode !== 0) {
        throw new BoxExecTransportError("BOX_EXEC_REMOTE_EXIT", true, exitCode, "remote_exit", "remote_exit");
      }
      return { stdout, stderrBytes, exitCode: 0 };
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
      if (reader) {
        await boundedCancel(() => reader!.cancel(), deadlineAt);
        try { reader.releaseLock(); } catch { /* pending read/cancel already detached */ }
      }
    }
  }
}
