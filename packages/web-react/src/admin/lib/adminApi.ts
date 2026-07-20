import {
  ApiError,
  assertAuthResponseCurrent,
  bearerHeaders,
  callWithRefresh,
  jsonOrThrow,
  getExactDeferredPayload,
  throwApi,
} from "../../lib/api";
import { adminSession } from "../auth";

/**
 * 管理后台数据层 —— 极薄封装，**复用** 用户端 lib/api 的鉴权原语：
 *  - callWithRefresh(adminSession, …)：透明 401 刷新 + singleflight（不新建第二套刷新）；
 *  - bearerHeaders：只带 Bearer（身份由 access JWT 决定）；
 *  - jsonOrThrow / throwApi：统一 ApiError 信封解包（status/code/issues/requestId）。
 *
 * 路径约定：
 *  - 传相对路径（`/stats/dau`）→ 自动前缀 `/api/admin` → `/api/admin/stats/dau`（推荐）。
 *  - 传以 `/api` 开头的绝对路径（`/api/me`）→ 原样使用（少数跨域端点）。
 *
 * 错误一律抛 ApiError；页面用 `err instanceof ApiError` + `err.status`/`err.code` 分支，
 * 不去 parse 中文 message。
 */

export { ApiError, apiErrorMessage } from "../../lib/api";

export type AdminParam = string | number | boolean | null | undefined;
export type AdminParams = Record<string, AdminParam>;

/** 相对路径前缀 /api/admin；绝对 /api 路径原样；再拼查询串（跳过空/undefined）。 */
function buildUrl(path: string, params?: AdminParams): string {
  const base = path.startsWith("/api")
    ? path
    : `/api/admin${path.startsWith("/") ? "" : "/"}${path}`;
  if (!params) return base;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    sp.set(k, String(v));
  }
  const qs = sp.toString();
  if (!qs) return base;
  return base.includes("?") ? `${base}&${qs}` : `${base}?${qs}`;
}

/** GET → JSON。 */
export function adminGet<T>(path: string, params?: AdminParams): Promise<T> {
  const url = buildUrl(path, params);
  return jsonOrThrow<T>(
    callWithRefresh(adminSession, (t) =>
      fetch(url, { credentials: "include", headers: bearerHeaders(t) }),
    ),
  );
}

/** Admin-scoped immutable payload loader. Reuses the user surface's exact
 * one-byte metadata Range + 1 MiB chunks + identity contract; only the URL/auth scope differs. */
export function adminGetExactPayload(path: string, params?: AdminParams, signal?: AbortSignal) {
  return getExactDeferredPayload(adminSession, buildUrl(path, params), signal);
}

/**
 * 写操作（POST/PATCH/PUT/DELETE）→ JSON。body 省略时不带 content-type/请求体。
 *
 * 204/空响应体容错:部分写端点(如 compute-hosts expires-at)成功返回 204 No Content,
 * `jsonOrThrow` 无条件 res.json() 会把成功误报为 SyntaxError。这里先行短路:
 * 2xx 且(204 或空体)→ 返回 undefined(调用方 T 自行声明为 void/可选)。
 * 非 2xx 仍走 throwApi 统一 ApiError 信封。
 */
export async function adminSend<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = buildUrl(path);
  const hasBody = body !== undefined;
  const res = await callWithRefresh(adminSession, (t) =>
    fetch(url, {
      method,
      credentials: "include",
      headers: bearerHeaders(t, hasBody),
      body: hasBody ? JSON.stringify(body) : undefined,
    }),
  );
  if (!res.ok) await throwApi(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  assertAuthResponseCurrent(res);
  if (text.trim() === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError({
      status: res.status,
      message: `响应不是合法 JSON(${url})`,
      requestId: res.headers.get("x-request-id") ?? undefined,
    });
  }
}

/** GET → 纯文本（CSV 导出等）。非 2xx 仍抛统一 ApiError。 */
export async function adminText(path: string, params?: AdminParams): Promise<string> {
  const url = buildUrl(path, params);
  const res = await callWithRefresh(adminSession, (t) =>
    fetch(url, {
      credentials: "include",
      headers: { Accept: "text/csv, text/plain, */*", Authorization: `Bearer ${t}` },
    }),
  );
  if (!res.ok) await throwApi(res);
  const text = await res.text();
  assertAuthResponseCurrent(res);
  return text;
}
