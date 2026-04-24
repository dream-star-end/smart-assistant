/**
 * 2026-04-21 安全审计 HIGH#4 — refresh token 移到 HttpOnly cookie。
 *
 * 旧路径:login 把 refresh_token 放 JSON body → 前端 localStorage → JS 可读
 *   → XSS 一旦得手就拿走 30 天会话;
 * 新路径:login 写 Set-Cookie(HttpOnly + Secure + SameSite=Strict + Path=/api/auth)
 *   → 浏览器自动随后续 /api/auth/refresh /api/auth/logout 携带,JS 永远读不到。
 *
 * CSRF 兜底:SameSite=Strict 让浏览器在跨站请求里**不发**该 cookie,即使攻击
 * 站触发 fetch(POST /api/auth/refresh) 也拿不到 cookie → refresh 失败 → 没法
 * 替用户续期。Path=/api/auth 进一步把 cookie 范围收窄到 auth 端点,主页面
 * 任何业务 API 都不会带它,降攻击面。
 *
 * 迁移期(2 周):/api/auth/{refresh,logout} 同时接受 cookie 和 body
 * (`refresh_token` 字段);旧前端缓存 localStorage 里的 token 还能再用一次
 * 后被 cookie 替代。第二次发版才完全删 body 兼容路径,见 docs/v3/06-MIGRATIONS.md。
 *
 * 这里只提供薄 helper,不引入 cookie 解析三方包(node:http 自己拼 string 够用,
 * 我们只关心一个 cookie name)。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

/** 选短名,降抓包/排查噪音;`oc_rt` = OpenClaude Refresh Token */
export const REFRESH_COOKIE_NAME = "oc_rt";

/**
 * 仅在 `/api/auth/*` 路径下随请求发送。
 * 主页面任何 `/api/me`、`/api/chat` 之类业务 API 都拿不到该 cookie,降低 XSS
 * 时被随业务 API 一起带出去的可能(虽然 HttpOnly 已经挡住读,但 path 收窄
 * 等同于"非 auth 路径根本不带" → 多一道防御)。
 */
export const REFRESH_COOKIE_PATH = "/api/auth";

export interface CookieOptions {
  /**
   * `Secure` 标志。生产 claudeai.chat 全 HTTPS → 必须 true;
   * 单测和本地 dev 是 http://localhost,Secure cookie 不会回传 → 必须 false。
   * 默认 true,测试通过 deps 注入 false。
   */
  secure?: boolean;
  /**
   * 2026-04-24 "记住我" 语义:
   *   - true(默认):持久 cookie,带 `Max-Age`,关浏览器仍保留(30 天)
   *   - false:session cookie,**不**输出 `Max-Age/Expires`,浏览器关闭即清除
   * login 时根据用户是否勾选 "记住我" 决定;refresh 继承 refresh_tokens.remember_me
   * 不在 rotate 时发生漂移。
   */
  persistent?: boolean;
}

/**
 * 把 raw refresh token 写成 Set-Cookie 头。
 * 同一响应里如果已经有 Set-Cookie(比如多 cookie 场景),走 append 而非覆盖。
 */
export function setRefreshCookie(
  res: ServerResponse,
  rawToken: string,
  maxAgeSeconds: number,
  opts: CookieOptions = {},
): void {
  const secure = opts.secure ?? true;
  const persistent = opts.persistent ?? true;
  const parts = [
    `${REFRESH_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  // persistent=false 省略 Max-Age / Expires:浏览器当 session cookie 处理,
  // 关窗口即清。persistent=true 走原逻辑(30 天 Max-Age)。
  if (persistent) {
    parts.splice(1, 0, `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`);
  }
  if (secure) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

/**
 * 清除 refresh cookie。Max-Age=0 + 同样 Path/属性 → 浏览器立即删除。
 *
 * 注意:浏览器删 cookie 必须严格匹配 Path / Secure / SameSite / HttpOnly,
 * 否则会被当作"另一个 cookie"忽略。
 */
export function clearRefreshCookie(res: ServerResponse, opts: CookieOptions = {}): void {
  const secure = opts.secure ?? true;
  const parts = [
    `${REFRESH_COOKIE_NAME}=`,
    "Max-Age=0",
    `Path=${REFRESH_COOKIE_PATH}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (secure) parts.push("Secure");
  appendSetCookie(res, parts.join("; "));
}

/** 从请求 cookie 头里读 refresh token,没有 → null。 */
export function readRefreshCookie(req: IncomingMessage): string | null {
  const header = req.headers.cookie;
  if (typeof header !== "string" || header.length === 0) return null;
  // RFC 6265:cookie 由 `; ` 分隔,key=value 间不允许等号但 value 可以含 =
  // 我们只关心一个 name,简单 split 够用,不引三方包。
  for (const segment of header.split(";")) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = trimmed.slice(0, eqIdx);
    if (name !== REFRESH_COOKIE_NAME) continue;
    const value = trimmed.slice(eqIdx + 1);
    try {
      return decodeURIComponent(value);
    } catch {
      // 损坏 cookie:当作不存在
      return null;
    }
  }
  return null;
}

/**
 * 把一行 Set-Cookie 追加到响应头。
 * res.setHeader("Set-Cookie", ...) 单独调用第二次会**覆盖**第一次,
 * 必须传数组才能多 cookie 共存。
 */
function appendSetCookie(res: ServerResponse, line: string): void {
  const existing = res.getHeader("Set-Cookie");
  if (existing == null) {
    res.setHeader("Set-Cookie", line);
  } else if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, line]);
  } else {
    res.setHeader("Set-Cookie", [String(existing), line]);
  }
}
