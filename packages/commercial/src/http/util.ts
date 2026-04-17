/**
 * 通用 HTTP helpers — 无框架依赖,只用 node:http 原生类型。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";

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
 * 客户端 IP。优先用 socket.remoteAddress —— X-Forwarded-For 是客户端可伪造的,
 * 只有在 trustProxy=true 时才看 XFF。MVP 不开 XFF。
 */
export function clientIpOf(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export function userAgentOf(req: IncomingMessage): string | null {
  const ua = req.headers["user-agent"];
  return typeof ua === "string" ? ua.slice(0, 512) : null;
}

/** 安全 JSON body 读取,带大小上限。 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
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
  if (total === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "request body is not valid JSON");
  }
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
