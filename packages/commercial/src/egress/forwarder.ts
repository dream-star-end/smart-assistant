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
 *     唯一例外:/internal/v5/delegate/grok-route/{mint,release,renew} 三条
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
import { isDelegateGrokRoutePath } from "../http/internalDelegateGrokRoute.js";
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

export interface ForwarderOpts {
  /** master 控制口,如 http://127.0.0.1:18894 */
  controlBaseUrl: string;
  logger?: Logger;
}

export type Forwarder = (req: IncomingMessage, res: ServerResponse, peerIp: string) => void;

export function makeForwarder(opts: ForwarderOpts): Forwarder {
  const log = (opts.logger ?? rootLogger).child({ subsys: "egressForwarder" });
  const base = new URL(opts.controlBaseUrl);

  return function forward(req, res, peerIp) {
    const path = req.url ?? "";
    // 唯一例外:delegate grok-route 三条精确路径。它们是容器(网关)发起的
    // master 内部 API,鉴权是 master 侧 verifyContainerIdentity(bearer oc-v3
    // + peer ip 重建的 boundIp 因子),与被转发的 /internal/v3/* 同一信任模型,
    // 不携带也不需要 egress 秘钥。生产 master 未开 selfhost 豁免 → 未挂载 →
    // 404,fail-closed 不变。
    if (
      path.split("?")[0]!.startsWith(CONTROL_ONLY_PREFIX) &&
      !isDelegateGrokRoutePath(path.split("?")[0]!)
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

    const up = httpRequest(
      {
        protocol: base.protocol,
        hostname: base.hostname,
        port: base.port,
        method: req.method,
        path,
        headers,
      },
      (upRes) => {
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
      },
    );
    up.on("error", (err) => {
      log.warn("forward_upstream_error", { path: path.split("?")[0], err: err.message });
      if (!res.headersSent) {
        res.statusCode = 503;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ error: { code: "EGRESS_UPSTREAM_DOWN", message: "master control plane unavailable" } }));
      } else {
        try {
          res.destroy();
        } catch {
          /* */
        }
      }
    });
    req.pipe(up);
    req.on("error", () => {
      try {
        up.destroy();
      } catch {
        /* */
      }
    });
  };
}
