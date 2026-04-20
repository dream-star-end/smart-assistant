/**
 * Admin-pool Claude OAuth — PKCE start + code exchange。
 *
 * 与 gateway 的 personal-version `handleOAuth*` 区别:
 *   - 这里只生成 PKCE/换 code,**不写任何持久化**
 *   - 拿到 token 后,前端把 token 填进"新建账号"表单,POST /api/admin/accounts
 *     走标准 adminCreateAccount → admin_audit + AEAD 入库
 *
 * pending state 内存 Map(进程级,10 分钟 TTL):
 *   - 同一 admin 浏览器内一次性流程,不需要持久化
 *   - 50 条上限,LRU 驱逐(防内存爆)
 */

import { createHash, randomBytes } from "node:crypto";

// authUrl 用最终域 claude.ai(claude.com 是 307 跳板;部分梯子 only-claude.ai
// 的策略下,跳板域被掐 → ERR_CONNECTION_CLOSED)。
// tokenUrl 由后端调用,走服务器出网,域名维持 platform.claude.com 即可。
const CLAUDE_OAUTH = {
  clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authUrl: "https://claude.ai/oauth/authorize",
  tokenUrl: "https://platform.claude.com/v1/oauth/token",
  redirect: "https://platform.claude.com/oauth/code/callback",
  scopes: "user:profile user:inference user:sessions:claude_code user:mcp_servers",
} as const;

interface PendingState {
  codeVerifier: string;
  createdAt: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;
const PENDING_MAX = 50;
const pending = new Map<string, PendingState>();

function gcPending(): void {
  if (pending.size < PENDING_MAX) return;
  const oldest = pending.keys().next().value;
  if (oldest) pending.delete(oldest);
}

export interface OAuthStartResult {
  authUrl: string;
  state: string;
}

export function startClaudeOAuth(): OAuthStartResult {
  const codeVerifier = randomBytes(32).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  gcPending();
  pending.set(state, { codeVerifier, createdAt: Date.now() });
  // best-effort GC: 单独 timer 自删
  setTimeout(() => pending.delete(state), PENDING_TTL_MS).unref?.();

  const params = new URLSearchParams({
    client_id: CLAUDE_OAUTH.clientId,
    redirect_uri: CLAUDE_OAUTH.redirect,
    response_type: "code",
    scope: CLAUDE_OAUTH.scopes,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });

  return {
    authUrl: `${CLAUDE_OAUTH.authUrl}?${params.toString()}`,
    state,
  };
}

export interface OAuthExchangeResult {
  access_token: string;
  refresh_token: string;
  /** ISO string,server 拿到 expires_in 之后算的;前端可直接填进表单 */
  expires_at: string;
  scope: string;
}

export class OAuthExchangeError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "OAuthExchangeError";
  }
}

export async function exchangeClaudeOAuth(
  code: string,
  state: string,
): Promise<OAuthExchangeResult> {
  const cleanCode = code.includes("#") ? code.split("#")[0]! : code;
  const p = pending.get(state);
  if (!p) throw new OAuthExchangeError(400, "invalid or expired state");
  pending.delete(state);

  const tokenRes = await fetch(CLAUDE_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLAUDE_OAUTH.clientId,
      code: cleanCode,
      code_verifier: p.codeVerifier,
      redirect_uri: CLAUDE_OAUTH.redirect,
      state,
    }),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => "");
    throw new OAuthExchangeError(
      502,
      `token exchange failed: ${tokenRes.status} ${errText.slice(0, 200)}`,
    );
  }

  const tokens = (await tokenRes.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  if (!tokens.access_token) {
    throw new OAuthExchangeError(502, "no access_token in response");
  }

  const expiresInSec = tokens.expires_in ?? 3600;
  const expiresAtMs = Date.now() + expiresInSec * 1000;

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? "",
    expires_at: new Date(expiresAtMs).toISOString(),
    scope: tokens.scope ?? CLAUDE_OAUTH.scopes,
  };
}
