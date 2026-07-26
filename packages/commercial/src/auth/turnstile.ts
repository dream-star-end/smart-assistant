/**
 * T-12 — Cloudflare Turnstile server-side 校验。
 *
 * 规约(05-SEC §15):注册/登录/密码重置 3 处强校验。
 *
 * 接口:
 *   - `verifyTurnstile(token, secret, opts?)` → boolean | throws
 *
 * Bypass 两档(2026-07-26 安全审计整改,见 resolveTurnstileBypass):
 *   - 全局旁路 `TURNSTILE_TEST_BYPASS=1`:整站人机验证失效,**仅** dev/CI 可用。
 *     生产开这个键会被 config.ts 的危险开关扫描直接拒绝启动(fail-closed)。
 *   - 账号级白名单 `TURNSTILE_BYPASS_ACCOUNTS`:只对逗号分隔的邮箱生效,
 *     生产用来给 e2e/smoke/评测这类自动化留合法通道,真实用户仍走真 widget。
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

/** 规范化一个邮箱用于白名单比对:trim + 小写。非字符串 → 空串(必不命中)。 */
function normalizeAccount(v: string | null | undefined): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export interface ResolveTurnstileBypassArgs {
  /** env TURNSTILE_TEST_BYPASS —— 全局旁路,仅 dev/CI。 */
  globalBypass?: boolean;
  /** env TURNSTILE_BYPASS_ACCOUNTS 解析后的邮箱白名单(config.ts 已规范化)。 */
  bypassAccounts?: readonly string[];
  /** 本次请求声称的账号邮箱(login/register 取 input.email,重置取入参 email)。 */
  accountEmail?: string | null;
  /** 留痕用的路由标识,如 `POST /api/auth/login`。 */
  route?: string;
}

/**
 * turnstile 旁路的**单一权威判定**。register / login / requestPasswordReset
 * 三个入口一律先调它,再把结果塞进 `verifyTurnstile` 的 `opts.bypass`——
 * 判定逻辑只此一份,避免三处各写一遍再各自漂移。
 *
 * 语义(短路顺序即优先级):
 *   1. `globalBypass` 为真 → true。这是 dev/CI 的整站旁路,生产不可达
 *      (config.ts 在 NODE_ENV=production 下扫到该键就拒绝启动)。
 *   2. `accountEmail` 规范化后命中 `bypassAccounts` → true。生产唯一合法旁路,
 *      给 e2e-journey-canary / smoke-turn-canary / 技能评测这类自动化账号用。
 *   3. 其余 → false,走真实 Cloudflare 校验。
 *
 * 留痕(命中白名单必须可审计):这里写一行结构化日志。**没有**写 security_events,
 * 原因有二:(a) 事件类型注册表在 admin/securityEvents.ts,本模块是 auth 层的纯
 * 同步校验器,拉进 db/queries + alertOutbox 会让"判个布尔"背上 DB 与告警依赖;
 * (b) 三个调用点都在 DB lookup 之前,写库会给未认证公开端点引入额外 IO。
 * 后续若要升级为 security_events,需先在 SECURITY_EVENT_TYPES 注册
 * `turnstile_account_bypass`,再由三个 handler 在业务事务外 fire-and-forget。
 * 日志只记 email + route,**绝不记 token**。
 */
export function resolveTurnstileBypass(args: ResolveTurnstileBypassArgs): boolean {
  if (args.globalBypass === true) return true;
  const accounts = args.bypassAccounts;
  if (!accounts || accounts.length === 0) return false;
  const email = normalizeAccount(args.accountEmail);
  if (email.length === 0) return false;
  // config.ts 已把白名单规范化过;这里再 normalize 一遍是为了防止绕过 config
  // 直接构造 deps 的调用方(测试/内部工具)因大小写不一致而静默失配。
  if (!accounts.some((a) => normalizeAccount(a) === email)) return false;
  console.warn(
    `[turnstile-account-bypass] ${JSON.stringify({ route: args.route ?? "unknown", email })}`,
  );
  return true;
}

export interface VerifyTurnstileOptions {
  /** 用户 IP(穿透代理),传给 CF 帮助风控 */
  remoteIp?: string;
  /** 旁路:跳过实际网络请求,token 非空就 true。取值一律来自 resolveTurnstileBypass */
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
  // bypass 路径:全局旁路(dev/CI)或账号白名单命中(生产自动化),判定见
  // resolveTurnstileBypass —— 调用方不得自行拼这个布尔
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
