// 凭证解析 low-level helpers —— 把 "从 req 拿 token" 这件事拆成两个语义清晰
// 的函数,让上游策略层可以自由组合(bearer-first / cookie-first / 双 verify)。
//
// 历史:`router.ts:extractTokenFromReq` 一直是 "bearer 优先,cookie 兜底" 的
// hardcoded 策略,给 maintenanceMode / WS auth 用没问题。但 v1.0.159
// `/api/media-sign` 改造时需要 **cookie-first**(boss 拍板把 HttpOnly oc_session
// 设为浏览器会话权威源,Bearer 是补丁通道),如果硬塞进 extractTokenFromReq
// 就把策略漂移耦合到通用 helper 里。
//
// 解法:把"读 Bearer"和"读 oc_session"拆开,各 endpoint 按自身需求组合。
// extractTokenFromReq 内部改用这两个 helper,**保留** bearer-first 语义,
// 不破坏现有 caller。
//
// 不做 JWT 验签;仅字符串解析。验签由调用方走 verifyCommercialJwtSync*。

import type { IncomingMessage } from "node:http";

/**
 * 从 `Authorization: Bearer <token>` 头抽 token。
 *
 * 形态 mismatch / 空 token / 无 header → 返 "" (不 throw)。
 * 上游按"非空字符串"做有效性判定。trim 处理尾空白(curl `-H "Authorization: Bearer xxx "`)。
 */
export function getBearerToken(req: IncomingMessage): string {
  const raw = req.headers.authorization ?? "";
  const m = raw.match(/^Bearer\s+(.+)$/);
  if (!m) return "";
  return m[1]!.trim();
}

/**
 * 从 `Cookie:` 头抽 `oc_session` 的值。
 *
 * 解析约束:单 cookie 命名 `oc_session=<value>`(value 内含 `=` 时按 split-join
 * 保留,跟 router.ts:extractTokenFromReq 现有解析行为对齐)。
 * 未找到 / 空值 → 返 ""。
 *
 * 仅做字面量提取,不验签。
 */
export function getSessionCookieToken(req: IncomingMessage): string {
  const raw = req.headers.cookie ?? "";
  if (!raw) return "";
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k === "oc_session") {
      return part.slice(eq + 1);
    }
  }
  return "";
}
