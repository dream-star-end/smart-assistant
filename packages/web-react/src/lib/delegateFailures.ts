import { assertAuthResponseCurrent, AuthEpochStaleError, bearerHeaders, callWithRefresh } from "./api";
import type { AuthSession } from "./types";

export type DelegateFailure = Readonly<{
  jobId: string;
  generation: number;
  parentSessionKey: string;
  summaryCode: string;
  summaryText: string;
  failedAt: number;
  retry: { available: boolean; reason: string | null };
}>;
export type DelegateFailureSummary = Readonly<{
  running: number;
  queued: number;
  unacknowledgedFailures: number;
}>;
export type DelegateFailurePage = Readonly<{
  count: number;
  items: readonly DelegateFailure[];
  nextCursor: string | null;
}>;
export type DelegateRetryResult = Readonly<{
  jobId: string;
  state: "accepted" | "dispatched" | "terminal" | "source_deleted";
  replay: boolean;
}>;

export class DelegateFailureApiError extends Error {
  constructor(readonly code: string) { super(code); }
}
const invalid = () => new DelegateFailureApiError("invalid_response");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw invalid();
  return value;
}
function timestamp(value: unknown): number {
  const n = count(value);
  if (n > 8_640_000_000_000_000) throw invalid();
  return n;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length > max) throw invalid();
  return value;
}
function jobId(value: unknown): string {
  const id = text(value, 128);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw invalid();
  return id;
}
function version(value: unknown): Record<string, unknown> {
  const v = record(value);
  if (v.version !== 1) throw invalid();
  return v;
}
export function failureKey(row: Pick<DelegateFailure, "jobId" | "generation">): string {
  return JSON.stringify([row.jobId, row.generation]);
}
export function parseFailureSummary(value: unknown): DelegateFailureSummary {
  const v = version(value);
  if (v.available !== true) throw invalid();
  return { running: count(v.running), queued: count(v.queued), unacknowledgedFailures: count(v.unacknowledgedFailures) };
}
export function parseFailurePage(value: unknown): DelegateFailurePage {
  const v = version(value);
  if (!Array.isArray(v.items) || v.items.length > 50) throw invalid();
  const items = v.items.map((raw): DelegateFailure => {
    const row = record(raw), retry = record(row.retry);
    if (typeof retry.available !== "boolean" || (retry.reason !== null && typeof retry.reason !== "string")) throw invalid();
    return { jobId: jobId(row.jobId), generation: count(row.generation),
      parentSessionKey: text(row.parentSessionKey, 2048), summaryCode: text(row.summaryCode, 128),
      summaryText: text(row.summaryText, 512), failedAt: timestamp(row.failedAt),
      retry: { available: retry.available, reason: retry.reason === null ? null : text(retry.reason, 128) } };
  });
  if (new Set(items.map(failureKey)).size !== items.length) throw invalid();
  const nextCursor = v.nextCursor === null ? null : text(v.nextCursor, 1024);
  if (nextCursor !== null && !/^[A-Za-z0-9_-]+$/.test(nextCursor)) throw invalid();
  const total = count(v.count);
  if (total < items.length) throw invalid();
  return { count: total, items, nextCursor };
}
export function parseRetryResult(value: unknown): DelegateRetryResult {
  const v = version(value);
  if (!["accepted", "dispatched", "terminal", "source_deleted"].includes(String(v.state)) || typeof v.replay !== "boolean") throw invalid();
  return { jobId: jobId(v.jobId), state: v.state as DelegateRetryResult["state"], replay: v.replay };
}

/** Never display raw result/error JSON, credential-bearing diagnostics, or a guessed success. */
export function failureSummaryText(row: Pick<DelegateFailure, "summaryCode">): string {
  return row.summaryCode === "killed_by_cutover" ? "子任务因服务切换中断" : "子任务失败，请查看原会话了解详情";
}
export function retryStateText(state: DelegateRetryResult["state"]): string {
  return { accepted: "已受理，等待执行", dispatched: "已开始继续", terminal: "本次继续已结束，结果以原会话为准", source_deleted: "原来源已删除" }[state];
}
export function failureErrorText(error: unknown): string {
  const code = error instanceof DelegateFailureApiError ? error.code : "network_error";
  const messages: Record<string, string> = {
    retry_child_busy: "原子会话正在运行，暂不能发起新的继续",
    retry_native_unsupported: "此引擎暂不支持继续原子会话",
    retry_native_unavailable: "原生会话不可用，无法安全继续",
    retry_source_unavailable: "原任务来源已不可用",
    retry_capacity: "执行容量已满，请稍后再试",
    retry_parent_unavailable: "原父会话暂不可用",
    user_authentication_expired: "登录已失效，请重新登录",
    user_authentication_required: "请先登录",
    not_found: "记录已变化，请刷新后确认",
    invalid_response: "后台任务数据暂不可用，请稍后刷新",
  };
  return messages[code] ?? "暂未确认操作结果，请刷新或重试同一次操作";
}

/** One explicit UI intent per source generation, shared across reloads/tabs, never auth tokens. */
export async function delegateRetryActionId(userId: string, row: Pick<DelegateFailure, "jobId" | "generation">): Promise<string> {
  if (!userId.trim()) throw invalid();
  jobId(row.jobId); count(row.generation);
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([userId, row.jobId, row.generation])));
  return "ui_retry_v1_" + Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}

/** Original refresh machinery + body fence. Timeout bounds the whole operation, including refresh. */
async function request(auth: AuthSession, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const epoch = auth.snapshot().epoch;
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        if (auth.snapshot().epoch !== epoch) throw new AuthEpochStaleError();
        const res = await callWithRefresh(auth, (token) => fetch(path, {
          method: body === undefined ? "GET" : "POST", credentials: "include", cache: "no-store",
          headers: bearerHeaders(token, body !== undefined), signal: abort.signal,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }));
        assertAuthResponseCurrent(res);
        const data: unknown = await res.json();
        assertAuthResponseCurrent(res);
        if (abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (res.status !== 200 && !(body !== undefined && res.status === 202)) {
          const o = record(data);
          throw new DelegateFailureApiError(typeof o.error === "string" ? o.error : "request_failed");
        }
        return data;
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { cancel(); reject(new DelegateFailureApiError("request_timeout")); }, 15_000); }),
    ]);
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export const delegateFailureApi = {
  summary: async (auth: AuthSession, signal?: AbortSignal) => parseFailureSummary(await request(auth, "/api/delegates/summary", undefined, signal)),
  page: async (auth: AuthSession, before: string | null, signal?: AbortSignal) => parseFailurePage(await request(auth,
    "/api/delegates/inbox?limit=50" + (before === null ? "" : "&before=" + encodeURIComponent(before)), undefined, signal)),
  acknowledge: async (auth: AuthSession, row: DelegateFailure, signal?: AbortSignal) => {
    const v = version(await request(auth, `/api/delegates/inbox/${encodeURIComponent(row.jobId)}/ack`, { generation: row.generation }, signal));
    if (v.acknowledged !== true) throw invalid();
  },
  retry: async (auth: AuthSession, row: DelegateFailure, actionId: string, signal?: AbortSignal) => parseRetryResult(await request(auth,
    `/api/delegates/inbox/${encodeURIComponent(row.jobId)}/retry`, { generation: row.generation, actionId }, signal)),
};
