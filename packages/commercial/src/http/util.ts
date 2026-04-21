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
 * 安全注意:此函数信任 CF-Connecting-IP / X-Forwarded-For 仅当 socket 是 loopback
 * (即 Caddy 反代过来)。但 Caddy 暴露在公网(:443)且当前 GCP firewall 对 80/443
 * 开放 Anywhere(未白名单 CF IP 段),攻击者可直连 Caddy 并伪造 CF-Connecting-IP。
 *
 * 2026-04-22 Codex R2 IMPORTANT#3 defense-in-depth:
 *   - 信任 CF-Connecting-IP 必须同时看到 CF-RAY header(CF 边缘强制注入的追踪 ID,
 *     格式如 `8a3f2c4e...-HKG`,攻击者无法伪造真实 CF-RAY 但可以伪造看起来像的字符串
 *     —— 因此这只是弱化手段,真正的防御必须在 ops 层);
 *   - CF-RAY 缺失时回退到 XFF first;都没有就用 socket IP。
 *
 * **Ops 必须做的事**(本仓库文档已记录):
 *   (a) Caddy 只接受来自 Cloudflare IP 段的连接(推荐:CF 官方 IP list + UFW/cloud FW),或
 *   (b) Caddy handler 里对非 CF 来源 `request_header -CF-Connecting-IP` 剔除。
 * 代码层只能拦住"拿到的值必须是 IP"+"CF-RAY 作为过关凭证";ops 层 CF-only 访问才是
 * 根治方案。
 */
// CF-RAY 格式:16 字符 hex + `-` + 3 字符 IATA 机场代号(如 `8a3f2c4e1b2d3456-HKG`)。
// 宽松点允许 8-40 hex 容忍未来扩展。
const CF_RAY_RE = /^[0-9a-f]{8,40}-[A-Z]{3}$/;

export function clientIpOf(req: IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? "unknown";
  if (!LOOPBACK_RE.test(socketIp)) return socketIp;
  // loopback socket:信任 Caddy 透传的 CF 边缘 IP,但必须看到 CF-RAY 才信 CF-Connecting-IP
  const cfRayHeader = req.headers["cf-ray"];
  const hasCfRay = typeof cfRayHeader === "string" && CF_RAY_RE.test(cfRayHeader);
  if (hasCfRay) {
    const cfIp = cleanClientIp(req.headers["cf-connecting-ip"]);
    if (cfIp) return cfIp;
  }
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string") {
    const first = xff.split(",")[0]?.trim();
    const firstIp = cleanClientIp(first);
    if (firstIp) return firstIp;
  }
  return socketIp;
}

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
