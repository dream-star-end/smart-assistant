/**
 * 通用 HTTP helpers — 无框架依赖,只用 node:http 原生类型。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { isIP } from "node:net";

export const REQUEST_ID_HEADER = "x-request-id";
export const MAX_BODY_BYTES = 64 * 1024; // 64 KiB,auth 入参不会大,挡 DoS

/**
 * 生成或透传 request id。前端/CDN 传了就用,没传就生成。
 * 16 bytes hex → 32 字符,够了。
 */
export function ensureRequestId(req: IncomingMessage): string {
  const fromHeader = req.headers[REQUEST_ID_HEADER];
  if (typeof fromHeader === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(fromHeader)) {
    return fromHeader;
  }
  return randomBytes(16).toString("hex");
}

/**
 * 客户端 IP 提取。
 *
 * v3 架构:CF → Caddy:443 → gateway:127.0.0.1:18789。gateway 只监听 loopback
 * + 172.30.0.1(容器内部代理),绝不暴露公网。所以:
 *   - 当 socket.remoteAddress 是 loopback(Caddy 在本机反代过来)→ 信任 CF 注入的
 *     CF-Connecting-IP,回退 X-Forwarded-For 首个段;这两个都是 Caddy 层透传,
 *     攻击者在公网直连 gateway 根本不可达,所以不存在"XFF 伪造"。
 *   - 当 socket.remoteAddress 是 172.30.x(容器来的 internal proxy 流量)→ 直接
 *     用 socket IP;这个路径不是 auth/rate-limit 链路,clientIp 也只做审计用。
 *   - 其他(不应发生)→ 用 socket IP,失败安全。
 *
 * 2026-04-22 Codex R1 IMPORTANT#3 修复:此前 refresh race fingerprint 和 rate
 * limit 都拿 socket.remoteAddress,Caddy 后面 gateway 看到的都是 127.0.0.1
 * → sameIp=true 永远成立,同 IP 桶 = 全站共享桶,高峰时 refresh/logout 限流相
 * 互误伤。修后真实客户端 IP 才进 fingerprint/rate limit。
 */
// IPv4 loopback、IPv6 loopback、IPv6-mapped IPv4 loopback
const LOOPBACK_RE = /^(127\.|::1$|::ffff:127\.)/;

/**
 * 2026-04-22 Codex R2 IMPORTANT#3:header 里的 IP 必须严格解析。
 *
 * 旧 IP_FORMAT_RE `/^[0-9a-fA-F:.]{3,45}$/` 会放过 `::::`、`dead:beef`、
 * `0.0.0.0`、`::`、以及纯字符串 `aaa...` 这种既非真实 IP 又能进 rate-limit key
 * 的垃圾。`0.0.0.0` 尤其危险 —— 攻击者在允许 XFF 伪造的路径上所有请求都能共享
 * 到"0.0.0.0"这个桶,除非 rate-limit 专门跳过,否则会全站踩同一 key。
 *
 * 解决:node:net.isIP() 真正校验格式,并显式拒绝 "通配符 / 保留" 值。任何不干净
 * 的值返回 null,调用方 fallback 回 socketIp。
 */
function cleanClientIp(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const ip = v.trim();
  if (!isIP(ip)) return null;
  if (ip === "0.0.0.0" || ip === "::") return null;
  return ip;
}

/**
 * 2026-04-22 Codex R3 IMPORTANT:CF-RAY 可被攻击者直连 Caddy 时伪造,单靠 header
 * 判断是否"来自 CF"不构成信任根。真正的信任根必须是"上一跳 TCP peer 是 Cloudflare"。
 *
 * 架构:CF → Caddy(公网 :443) → gateway(127.0.0.1:18789)。Caddyfile 里 XFF 被
 * `header_up X-Forwarded-For {remote_host}` **覆盖**,所以 gateway 看到的 XFF 单段
 * = Caddy 的直接 TCP peer IP:
 *   - 走 CF:该值 ∈ Cloudflare edge IP 段
 *   - 攻击者直连:该值 = 攻击者真实 IP(无法伪造,因为 TCP 三次握手)
 *
 * 只有当 XFF 是 CF IP 时,才信任 CF-Connecting-IP;否则 XFF 本身已经是最可信的客户端
 * IP(攻击者真实 IP)—— 直接用作 rate-limit key。
 *
 * 运维层根治方案(本代码之外):把 Caddy 80/443 限制到 CF IP 段(UFW 白名单)。
 */

// Cloudflare IPv4 edge ranges(https://www.cloudflare.com/ips-v4 最后校验:2026-04-22)。
// 列表半年以内基本不变;若 CF 新增段,请同步更新。
const CF_IPV4_CIDRS = [
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "108.162.192.0/18",
  "131.0.72.0/22",
  "141.101.64.0/18",
  "162.158.0.0/15",
  "172.64.0.0/13",
  "173.245.48.0/20",
  "188.114.96.0/20",
  "190.93.240.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
] as const;

// Cloudflare IPv6 edge ranges(https://www.cloudflare.com/ips-v6 最后校验:2026-04-22)。
const CF_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
] as const;

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const v = Number(p);
    if (!Number.isInteger(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0; // 转 unsigned
}

/** 展开 IPv6 到 16 byte BigInt;仅在 CIDR 命中检查里用,不追求美观。 */
function ipv6ToBigInt(ip: string): bigint | null {
  // 处理 IPv4-mapped IPv6:`::ffff:1.2.3.4`
  const v4mapMatch = ip.match(/^(.*:)?([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/);
  let normalized = ip;
  if (v4mapMatch) {
    const v4int = ipv4ToInt(v4mapMatch[2] ?? "");
    if (v4int === null) return null;
    const v4hex = v4int.toString(16).padStart(8, "0");
    normalized = `${v4mapMatch[1] ?? ""}${v4hex.slice(0, 4)}:${v4hex.slice(4)}`;
  }
  // 展开 `::` → 中间补零
  let parts: string[];
  if (normalized.includes("::")) {
    const [l, r] = normalized.split("::", 2);
    const lp = l ? l.split(":") : [];
    const rp = r ? r.split(":") : [];
    const missing = 8 - lp.length - rp.length;
    if (missing < 0) return null;
    parts = [...lp, ...Array(missing).fill("0"), ...rp];
  } else {
    parts = normalized.split(":");
  }
  if (parts.length !== 8) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
    n = (n << 16n) | BigInt(Number.parseInt(p, 16));
  }
  return n;
}

function ipInCidrV4(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/", 2);
  const bits = Number(bitsStr);
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base ?? "");
  if (ipInt === null || baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (~((1 << (32 - bits)) - 1)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

function ipInCidrV6(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split("/", 2);
  const bits = Number(bitsStr);
  const ipBig = ipv6ToBigInt(ip);
  const baseBig = ipv6ToBigInt(base ?? "");
  if (ipBig === null || baseBig === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  if (bits === 0) return true;
  const mask = bits === 128 ? ((1n << 128n) - 1n) : (((1n << BigInt(bits)) - 1n) << BigInt(128 - bits));
  return (ipBig & mask) === (baseBig & mask);
}

function isCloudflareIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return CF_IPV4_CIDRS.some((c) => ipInCidrV4(ip, c));
  if (v === 6) {
    // 允许 IPv4-mapped 形式:`::ffff:a.b.c.d` → 按 IPv4 判
    const v4 = ip.match(/^::ffff:([0-9.]+)$/i);
    if (v4) return CF_IPV4_CIDRS.some((c) => ipInCidrV4(v4[1] ?? "", c));
    return CF_IPV6_CIDRS.some((c) => ipInCidrV6(ip, c));
  }
  return false;
}

/** 归一化 IPv4-mapped IPv6(`::ffff:1.2.3.4` → `1.2.3.4`),避免 rate-limit 双桶。 */
function normalizeClientIp(ip: string): string {
  const m = ip.match(/^::ffff:([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$/i);
  return m && m[1] ? m[1] : ip;
}

export function clientIpOf(req: IncomingMessage): string {
  const rawSocketIp = req.socket.remoteAddress ?? "unknown";
  const socketIp = isIP(rawSocketIp) ? normalizeClientIp(rawSocketIp) : rawSocketIp;
  if (!LOOPBACK_RE.test(rawSocketIp)) return socketIp;

  // loopback 来源:Caddy 反代过来。XFF 首段 = Caddy 直接 TCP peer(Caddyfile 里
  // `header_up X-Forwarded-For {remote_host}` 覆盖写入)。
  const xffHeader = req.headers["x-forwarded-for"];
  let caddyPeerIp: string | null = null;
  if (typeof xffHeader === "string") {
    caddyPeerIp = cleanClientIp(xffHeader.split(",")[0]?.trim());
  }

  // 仅当 Caddy peer 确实在 CF edge 范围内,才信任 CF-Connecting-IP 作为客户端 IP。
  if (caddyPeerIp && isCloudflareIp(caddyPeerIp)) {
    const cfIp = cleanClientIp(req.headers["cf-connecting-ip"]);
    if (cfIp) return normalizeClientIp(cfIp);
    // CF peer 但没 CF-Connecting-IP:非常罕见,回退到 CF edge IP 本身(比直接信 XFF 安全)
    return normalizeClientIp(caddyPeerIp);
  }

  // 非 CF peer:不能信 CF-Connecting-IP(可伪造)。此时 Caddy peer 就是攻击者/直连者
  // 真实 IP,用它作为 rate-limit key 是最安全选择(TCP 三次握手无法伪造)。
  if (caddyPeerIp) return normalizeClientIp(caddyPeerIp);
  return socketIp;
}

// 导出给测试用,不是 public API
export const __internal_clientIp = { ipv4ToInt, ipv6ToBigInt, ipInCidrV4, ipInCidrV6, isCloudflareIp, normalizeClientIp };

export function userAgentOf(req: IncomingMessage): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 512) : null;
}

/** 读 raw body(含大小上限)。JSON / form 两个 helper 共用。 */
async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      throw new HttpError(413, "PAYLOAD_TOO_LARGE", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  return total === 0 ? "" : Buffer.concat(chunks).toString("utf8");
}

/** 安全 JSON body 读取,带大小上限。 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const text = await readRawBody(req);
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
  }
}

/**
 * 读 `application/x-www-form-urlencoded` body → 扁平 `{k: string}`。
 *
 * 用于第三方回调(虎皮椒)等非 JSON 场景。同键多值只保留第一个(URLSearchParams 自然行为:
 * `.get()` 取首个;我们这里遍历 `.entries()` 的首次出现)。
 */
export async function readFormBody(req: IncomingMessage): Promise<Record<string, string>> {
  const text = await readRawBody(req);
  const out: Record<string, string> = {};
  if (text.length === 0) return out;
  const sp = new URLSearchParams(text);
  for (const [k, v] of sp.entries()) {
    if (!(k in out)) out[k] = v;
  }
  return out;
}

/**
 * 写纯文本响应(虎皮椒回调要求返回 text "success")。
 * 不走 JSON,不走 no-store cache(POST 幂等回调 ok 即可)。
 */
export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  extraHeaders?: Record<string, string | number>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, String(v));
    }
  }
  res.end(body);
}

/** 写 JSON 响应 + 标准头。 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string | number>,
): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) {
      res.setHeader(k, String(v));
    }
  }
  res.end(JSON.stringify(body));
}

/**
 * 标准错误响应 schema(04-API):
 *   { error: { code, message, request_id, issues? } }
 *
 * 所有 commercial 接口失败必须走这个。
 */
export interface ErrorBody {
  error: {
    code: string;
    message: string;
    request_id: string;
    issues?: ReadonlyArray<{ path: string; message: string }>;
  };
}

export function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
  issues?: ReadonlyArray<{ path: string; message: string }>,
  extraHeaders?: Record<string, string | number>,
): void {
  const body: ErrorBody = {
    error: { code, message, request_id: requestId, ...(issues ? { issues } : {}) },
  };
  sendJson(res, status, body, extraHeaders);
}

/** 路由处理时抛出的错误,会被 router 捕获翻译成标准错误响应。 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues?: ReadonlyArray<{ path: string; message: string }>;
  readonly extraHeaders?: Record<string, string | number>;
  constructor(
    status: number,
    code: string,
    message: string,
    options?: {
      issues?: ReadonlyArray<{ path: string; message: string }>;
      extraHeaders?: Record<string, string | number>;
    },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.issues = options?.issues;
    this.extraHeaders = options?.extraHeaders;
  }
}

/**
 * 全局安全 headers(05-SEC §6)。
 *
 * gateway/server.ts 已经设了 X-Content-Type-Options/X-Frame-Options 等,
 * 这里补 HSTS + CSP(JSON API 只需 default-src 'none',彻底杜绝任何嵌入)。
 *
 * 调用顺序:在每次 sendJson/sendError 之前调用一次,或在 router 入口统一打。
 */
export function setSecurityHeaders(res: ServerResponse): void {
  // HSTS:1 年 + includeSubDomains;preload 不开(需要单独提交到 Chrome 列表)
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  // CSP:JSON API 不渲染任何东西,锁死
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  // 重复设以确保(即使外层没设也兜底)
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
}
