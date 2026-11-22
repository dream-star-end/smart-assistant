/**
 * Egress → master 控制口的透明转发(split 模式下容器的非 LLM 流量通道)。
 *
 * 容器只知道一个地址(172.31.0.1:18892,egress 监听);/v1/messages 之外的
 * 全部内部路径(/internal/v3/* server-authored / turn-waive / minimax / skill
 * embed / marketplace / literature / research …)原样转发 master 控制口,
 * 各 handler 的 verifyContainerIdentity 鉴权在 master 侧照常执行。
 *
 * 安全:
 *   - **deny /internal/v5/***:控制专用路径(cost-event 等)只允许 egress 进程
 *     自己调用,容器伪造经转发面到达 → 403(master 端秘钥头是第二道)。
 *     唯一例外:delegate engine relay route 的 mint/release/renew(grok 与
 *     antigravity,见 protocol internalRoutes.isDelegateRouteForwardException)
 *     精确路径转发给 master(容器身份鉴权在 master 侧,见
 *     internalDelegateGrokRoute.ts);其余 /internal/v5/* 仍全部拒转。
 *   - 剥掉入站的 egress 秘钥头(容器不可能合法携带,防透传)。
 *   - hop-by-hop 头剥除;peer ip 经 x-v5-egress-peer-ip 传递给 master
 *     (master 控制口 listener 用它替代 socket.remoteAddress 做 boundIp 因子)。
 *
 * master 不可达(重启窗口)→ 503 EGRESS_UPSTREAM_DOWN。容器侧调用方
 * (v3MasterSink / turn-lease renew / mmx wrapper …)对 5xx 一律按 transient
 * 重试,恰好覆盖重启的秒级窗口。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";

import { rootLogger, type Logger } from "../logging/logger.js";
import { isDelegateRouteForwardException } from "@openclaude/protocol";
import { EGRESS_SECRET_HEADER } from "../http/internalCostEvent.js";

/** 转发到 master 时传递容器真实 peer ip 的头(master 控制口据此重建 boundIp ctx)。 */
export const EGRESS_PEER_IP_HEADER = "x-v5-egress-peer-ip";

const CONTROL_ONLY_PREFIX = "/internal/v5/";
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export const DEFAULT_FORWARDER_RETRY_BUDGET_MS = 4_000;
export const DEFAULT_FORWARDER_RETRY_DELAYS_MS = [100, 200, 400] as const;
export const DEFAULT_FORWARDER_MAX_RETRY_BODY_BYTES = 2 * 1024 * 1024;

const RETRYABLE_UPSTREAM_ERROR_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "EPIPE"]);
const SAFE_RETRY_METHODS_AFTER_CONNECT = new Set(["GET", "HEAD", "OPTIONS"]);

function isSafeRetryMethodAfterConnect(method: string): boolean {
  return SAFE_RETRY_METHODS_AFTER_CONNECT.has(method);
}

export interface ForwarderOpts {
  /** master 控制口,如 http://127.0.0.1:18894 */
  controlBaseUrl: string;
  logger?: Logger;
  /** 连接阶段瞬断重拨总预算（默认 4000ms）。设为 0 可关闭重试。 */
  retryBudgetMs?: number;
  /** 连接阶段退避序列（默认 [100, 200, 400] ms）。 */
  retryDelaysMs?: readonly number[];
  /** 可缓冲以支持重拨的最大请求体字节数（默认 2 MiB，超限自动透传不缓冲）。 */
  maxRetryBodyBytes?: number;
}

export type Forwarder = (req: IncomingMessage, res: ServerResponse, peerIp: string) => void;

function isRetryableUpstreamError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && RETRYABLE_UPSTREAM_ERROR_CODES.has(code);
}

export function makeForwarder(opts: ForwarderOpts): Forwarder {
  const log = (opts.logger ?? rootLogger).child({ subsys: "egressForwarder" });
  const base = new URL(opts.controlBaseUrl);
  const retryBudgetMs = Math.max(0, opts.retryBudgetMs ?? DEFAULT_FORWARDER_RETRY_BUDGET_MS);
  const retryDelaysMs =
    opts.retryDelaysMs && opts.retryDelaysMs.length > 0
      ? opts.retryDelaysMs
      : DEFAULT_FORWARDER_RETRY_DELAYS_MS;
  const maxRetryBodyBytes = Math.max(
    0,
    opts.maxRetryBodyBytes ?? DEFAULT_FORWARDER_MAX_RETRY_BODY_BYTES,
  );

  return function forward(req, res, peerIp) {
    const path = req.url ?? "";
    // 唯一例外:delegate grok-route 三条精确路径。它们是容器(网关)发起的
    // master 内部 API,鉴权是 master 侧 verifyContainerIdentity(bearer oc-v3
    // + peer ip 重建的 boundIp 因子),与被转发的 /internal/v3/* 同一信任模型,
    // 不携带也不需要 egress 秘钥。生产 master 未开 selfhost 豁免 → 未挂载 →
    // 404,fail-closed 不变。
    if (
      path.split("?")[0]!.startsWith(CONTROL_ONLY_PREFIX) &&
      !isDelegateRouteForwardException(path.split("?")[0]!)
    ) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: { code: "CONTROL_ONLY_PATH", message: "not forwardable" } }));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      const lk = k.toLowerCase();
      if (HOP_BY_HOP.has(lk)) continue;
      if (lk === EGRESS_SECRET_HEADER) continue; // 容器不可能合法携带,剥掉防透传
      if (lk === EGRESS_PEER_IP_HEADER) continue; // 同上:peer ip 只信 socket
      headers[k] = v as string | string[];
    }
    headers[EGRESS_PEER_IP_HEADER] = peerIp;

    let aborted = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let currentUp: ReturnType<typeof httpRequest> | null = null;

    const cleanupTimer = (): void => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const cancel = (): void => {
      if (aborted) return;
      aborted = true;
      cleanupTimer();
      try {
        currentUp?.destroy();
      } catch {
        /* */
      }
      currentUp = null;
    };

    req.once("aborted", cancel);
    res.once("close", () => {
      if (!res.writableFinished) cancel();
    });

    const writeUpstreamError = (err: Error): void => {
      log.warn("forward_upstream_error", { path: path.split("?")[0], err: err.message });
      if (aborted || res.destroyed) return;
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: { code: "EGRESS_UPSTREAM_DOWN", message: "master control plane unavailable" },
          }),
        );
      } else {
        try {
          res.destroy();
        } catch {
          /* */
        }
      }
    };

    const attachUpstreamResponse = (
      up: ReturnType<typeof httpRequest>,
      onResponse: () => void,
    ): void => {
      up.on("response", (upRes) => {
        onResponse();
        if (aborted || res.destroyed) {
          upRes.resume();
          return;
        }
        res.statusCode = upRes.statusCode ?? 502;
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_BY_HOP.has(k.toLowerCase())) continue;
          try {
            res.setHeader(k, v as string | string[]);
          } catch {
            /* 非法头名 — 跳过 */
          }
        }
        upRes.pipe(res);
        upRes.on("error", () => {
          try {
            res.destroy();
          } catch {
            /* */
          }
        });
      });
    };

    const streamDirect = (prefetchedChunks?: Buffer[]): void => {
      if (aborted) return;
      const up = httpRequest({
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: req.method,
        path,
        headers,
      });
      currentUp = up;
      attachUpstreamResponse(up, () => {
        /* response headers committed */
      });
      up.on("error", (err) => {
        if (aborted) return;
        writeUpstreamError(err);
      });
      if (prefetchedChunks) {
        for (const chunk of prefetchedChunks) {
          if (chunk.length > 0) up.write(chunk);
        }
      }
      req.pipe(up);
      req.on("error", cancel);
    };

    const sendBuffered = (body: Buffer): void => {
      if (aborted) return;
      const attemptHeaders: Record<string, string | string[]> = { ...headers };
      const method = (req.method ?? "GET").toUpperCase();
      const safeAfterConnect = isSafeRetryMethodAfterConnect(method);
      if (body.length > 0 || (method !== "GET" && method !== "HEAD" && method !== "DELETE")) {
        delete attemptHeaders["content-length"];
        delete attemptHeaders["Content-Length"];
        attemptHeaders["content-length"] = String(body.length);
      }
      const deadline = Date.now() + retryBudgetMs;
      let attemptIdx = 0;

      const dial = (): void => {
        if (aborted || res.destroyed) return;
        let responseStarted = false;
        let socketConnected = false;
        const up = httpRequest({
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port,
          method: req.method,
          path,
          headers: attemptHeaders,
          agent: false,
        });
        currentUp = up;
        up.once("socket", (sock) => {
          if (!sock.connecting) {
            socketConnected = true;
          } else {
            sock.once("connect", () => {
              socketConnected = true;
            });
          }
        });
        attachUpstreamResponse(up, () => {
          responseStarted = true;
        });
        up.on("error", (err) => {
          if (aborted || res.destroyed) return;
          const remaining = deadline - Date.now();
          const errCode = (err as NodeJS.ErrnoException).code;
          // Pre-connect failure (ECONNREFUSED or error before TCP connect) proves zero bytes
          // reached upstream -> safe to retry any method. After TCP connect, ECONNRESET/EPIPE
          // has an ambiguous outcome -> retry ONLY RFC-safe methods (GET/HEAD/OPTIONS), never
          // non-safe methods (POST/PUT/PATCH/DELETE) even with Idempotency-Key.
          const preConnectFailure = !socketConnected || errCode === "ECONNREFUSED";
          if (
            !responseStarted &&
            !res.headersSent &&
            retryBudgetMs > 0 &&
            remaining > 0 &&
            isRetryableUpstreamError(err) &&
            (preConnectFailure || safeAfterConnect)
          ) {
            const delay = retryDelaysMs[Math.min(attemptIdx, retryDelaysMs.length - 1)]!;
            attemptIdx += 1;
            const waitMs = Math.min(delay, remaining);
            retryTimer = setTimeout(() => {
              retryTimer = null;
              dial();
            }, waitMs);
            retryTimer.unref?.();
            return;
          }
          writeUpstreamError(err);
        });
        if (body.length > 0) up.write(body);
        up.end();
      };

      dial();
    };

    const method = (req.method ?? "GET").toUpperCase();
    const rawContentLength = req.headers["content-length"];
    const declaredLength =
      typeof rawContentLength === "string" && /^[0-9]+$/.test(rawContentLength.trim())
        ? Number(rawContentLength.trim())
        : null;
    const hasTransferEncoding = req.headers["transfer-encoding"] !== undefined;

    if (retryBudgetMs <= 0 || maxRetryBodyBytes <= 0) {
      streamDirect();
      return;
    }
    if (declaredLength !== null && declaredLength > maxRetryBodyBytes) {
      streamDirect();
      return;
    }
    if (
      (method === "GET" || method === "HEAD") &&
      !hasTransferEncoding &&
      (declaredLength === null || declaredLength === 0)
    ) {
      sendBuffered(Buffer.alloc(0));
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let handedOff = false;

    const onData = (chunk: Buffer | string): void => {
      if (aborted || handedOff) return;
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      chunks.push(buf);
      if (totalBytes > maxRetryBodyBytes) {
        handedOff = true;
        req.off("data", onData);
        req.off("end", onEnd);
        req.off("error", onReqError);
        streamDirect(chunks);
      }
    };
    const onEnd = (): void => {
      if (aborted || handedOff) return;
      handedOff = true;
      req.off("data", onData);
      req.off("error", onReqError);
      sendBuffered(chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks, totalBytes));
    };
    const onReqError = (): void => {
      handedOff = true;
      cancel();
    };

    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onReqError);
  };
}
