/**
 * T-12 — Cloudflare Turnstile server-side 校验。
 *
 * 规约(05-SEC §15):注册/登录/密码重置 3 处强校验。
 *
 * 接口:
 *   - `verifyTurnstile(token, secret, opts?)` → boolean | throws
 *
 * Bypass:测试环境/CI 没法获得真实 turnstile token,允许通过 env
 * `TURNSTILE_TEST_BYPASS=1` 接受任意 token(或缺失 secret 时也 bypass)。
 *
 * 网络调用走 native fetch(Node 20+)。失败/超时 → 抛 TurnstileError,
 * 调用方应当返回 ERR_VALIDATION,不暗示哪部分失败。
 */

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const TURNSTILE_TIMEOUT_MS = 5_000;

export class TurnstileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TurnstileError";
  }
}

export interface VerifyTurnstileOptions {
  /** 用户 IP(穿透代理),传给 CF 帮助风控 */
  remoteIp?: string;
  /** 测试 bypass:跳过实际网络请求,token 非空就 true */
  bypass?: boolean;
  /** 测试可注入 fetch */
  fetchImpl?: typeof fetch;
  /** 总超时,默认 5s */
  timeoutMs?: number;
}

export async function verifyTurnstile(
  token: string,
  secret: string | undefined,
  opts: VerifyTurnstileOptions = {},
): Promise<boolean> {
  if (typeof token !== "string" || token.length === 0) {
    return false;
  }
  // bypass 路径:在测试或 dev 环境用,生产严禁开启
  if (opts.bypass) return true;
  if (!secret || secret.length === 0) {
    throw new TurnstileError("TURNSTILE_SECRET is not configured");
  }

  const fetchFn = opts.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? TURNSTILE_TIMEOUT_MS);

  try {
    const body = new URLSearchParams({
      secret,
      response: token,
    });
    if (opts.remoteIp) body.set("remoteip", opts.remoteIp);

    const res = await fetchFn(TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new TurnstileError(`turnstile verify HTTP ${res.status}`);
    }
    const json = (await res.json()) as { success?: boolean };
    return json.success === true;
  } catch (err) {
    if (err instanceof TurnstileError) throw err;
    throw new TurnstileError("turnstile verify failed", { cause: err });
  } finally {
    clearTimeout(timer);
  }
}
