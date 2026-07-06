/**
 * v3 file proxy — HOST → 容器 /api/file & /api/media/* 的反向代理。
 *
 * **流程**(见 v3-file-return-spec-mvp.md §0):
 *   1. 查 DB:`getV3ContainerStatus(uid)` → state=running
 *   2. SSRF 白名单:bound_ip ∈ 172.30/16 且 port === 18789
 *   3. capability 探测:/healthz 必须广播 file-proxy-v1 且 containerId echo 匹配
 *   4. 多 host 路由:
 *        - status.hostId === selfHostId(或 selfHostId 缺失)→ 直 fetch boundIp:port
 *        - status.hostId !== selfHostId → 走 node-agent tunnel
 *      两条路径都发 GET + 两个认证头:
 *        X-OpenClaude-Container-Id:<DB id>
 *        X-OpenClaude-Bridge-Nonce:HMAC(rootSecret, id)
 *      附带 Accept-Encoding: identity(禁 gzip 防 Range / Content-Length 对不上)
 *   5. 两段 timer:连接 3s → response 到达后 idle 120s
 *   6. 响应头重写:Cache-Control:no-store + Vary + RFC 5987 Content-Disposition
 *   7. per-uid ≤ 4 并发,超限 429
 *
 * **SSRF 深防**(多层布防):
 *   - JWT 校验(上层 router)→ sub ∈ DB users
 *   - `user_id = $sub`(只会查到自己的容器行)
 *   - 172.30/16 白名单 + port 18789(本地分支即便 DB 行被污染也防不出 docker
 *     网段;tunnel 分支由 node-agent {cid} 段做 docker hex 校验 + container
 *     -id echo 二重 binding)
 *   - containerId 绑定 + HMAC nonce(容器端校验)
 *
 * **per-uid 并发**:`inflight` Map 计数,release 在 cleanup 路径都要幂等
 *  (released flag + 顶层 res.close 监听器一加 1 就挂)。
 *
 * **多 host 错误分类**:
 *   - dial 失败 / head 读超时 → 502 BAD_GATEWAY 或 504 GATEWAY_TIMEOUT,
 *     **不是** CONTAINER_OUTDATED —— 后者专门给 capability 探活返 false 的场景。
 */

import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";
import { isIPv4 } from "node:net";
import { basename } from "node:path";
import type { TLSSocket } from "node:tls";
import type { RequestContext } from "./handlers.js";
import type { V3ContainerStatus, V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";
import { getV3ContainerStatus } from "../agent-sandbox/v3supervisor.js";
import { getRuntimeChannel } from "../runtimeChannel.js";
import {
  isContainerCapabilityReady,
  type CapabilityProbeDeps,
} from "./capabilityCache.js";
import { dialTunnelSocket, hostRowToTarget } from "../compute-pool/nodeAgentClient.js";
import type { ComputeHostRow } from "../compute-pool/types.js";
import { pipeBodyByContentLength, pipeBodyChunked, readResponseHead } from "./tunnelHttpReader.js";

const CONNECT_MS = 3_000;
// body idle 超时(非 connect 超时):上游 socket 在**已建连、传输中**连续无字节的
// 最长等待。D2:120s→300s。跨境慢速大文件下载在网络抖动时可能长时间(>2min)吐不
// 出一个包,却并非真断线;120s 会把这类慢速下载误杀成断流,用户被迫从头重下。放宽
// 到 300s 给跨境抖动足够容忍窗口。connect 超时(CONNECT_MS=3s,建连阶段)不放宽 ——
// 那是"容器活没活"的快速判定,与传输中慢速是两个关注点。
const IDLE_MS = 300_000;
// 同一 uid 的并发下载上限。D3:4→6。同一页多附件(如一条消息带 4~5 个交付物)用户
// 点"全部下载"会并发拉多个,4 太紧会 429 报障;放到 6 覆盖常见多附件场景,又不至于
// 让单用户占满 master 出站。
const PER_UID_MAX = 6;
const MAX_HEADER_BYTES = 64 * 1024;

/** per-uid 并发计数。key = uid string。release() 幂等。 */
const inflight = new Map<string, number>();

/** docker bridge 网段白名单(channel-aware)—— 容器必须在本 channel 自己的 bridge 上:
 *  v3=172.30.0.0/16,v5=172.31.0.0/16。各 channel 的 proxy 只能够到本 channel 网段容器,
 *  防 SSRF 跨网段、也防 v3 proxy 误连 v5 容器(反之亦然)。 */
function isBoundIpAllowed(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const p = ip.split(".").map(Number);
  const expectSecond = getRuntimeChannel() === "v5" ? 31 : 30;
  return p[0] === 172 && p[1] === expectSecond;
}

/**
 * RFC 5987 Content-Disposition `filename` 编码。
 *
 * - ASCII fallback:非打印字符 / " 和 \ 替换为 _
 * - UTF-8 `filename*=`:RFC 5987 percent-encoding,'()都额外 %HH(严格 attr-char)
 */
function rfc5987(name: string): string {
  const ascii = name
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_") || "file";
  const enc = encodeURIComponent(name).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `filename="${ascii}"; filename*=UTF-8''${enc}`;
}

/**
 * 安全 inline 白名单:图片(SVG 除外)、音频、视频、PDF。
 * 图片 SVG / HTML / XML / JS 都算活跃内容,强制 attachment。
 */
function isSafeInlineType(typeBase: string): boolean {
  if (typeBase === "image/svg+xml") return false;
  if (typeBase.startsWith("image/")) return true;
  if (typeBase.startsWith("audio/")) return true;
  if (typeBase.startsWith("video/")) return true;
  return typeBase === "application/pdf";
}

const ACTIVE_TYPES = new Set([
  "text/html",
  "image/svg+xml",
  "text/xml",
  "application/xml",
  "application/xhtml+xml",
  "application/javascript",
  "text/javascript",
]);

/** 转发的上游请求头白名单 */
const FORWARD_HEADERS = new Set([
  "range",
  "if-none-match",
  "if-modified-since",
  "accept",
  "user-agent",
]);

/** 响应头中要透传给浏览器的字段(除 Content-Type/Disposition 外) */
const PASSTHROUGH_RESPONSE_HEADERS = [
  "content-length",
  "accept-ranges",
  "content-range",
  "etag",
  "last-modified",
] as const;

/**
 * RFC 7230 hop-by-hop headers。tunnel 分支从容器响应里 strip 这些 ——
 * 它们是上游 HTTP/1.1 连接级控制信号,转给浏览器只会乱套。
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface ContainerFileProxyDeps {
  v3: V3SupervisorDeps;
  bridgeSecret: string;
  /** 本机 host UUID。未注入 = 单机 monolith,所有容器走本地 fetch 分支 */
  selfHostId?: string;
  /** 远端 tunnel dial fn(测试可注入 mock);多 host 模式必须传 */
  tunnelDial?: typeof dialTunnelSocket;
  /** 远端 host 行查询 fn;多 host 模式必须传 */
  getHostById?: (id: string) => Promise<ComputeHostRow | null>;
  /** 测试钩子:hostRowToTarget 注入(避开 psk 解密) */
  rowToTarget?: typeof hostRowToTarget;
  /** 测试钩子:注入 status(跳过 DB / docker inspect) */
  getStatus?: (uid: number) => Promise<V3ContainerStatus | null>;
  /** 测试钩子:注入 capability probe */
  capabilityProbe?: CapabilityProbeDeps;
  /** 测试钩子:注入 http.request(避开真 TCP)。签名与 node:http.request 兼容。 */
  httpRequestImpl?: typeof httpRequest;
  /**
   * 可选:覆盖 success 响应的 `Cache-Control` 头。
   *
   * 用于 `/api/media-signed`(自带 HMAC 过期戳的签名 URL)允许 CDN 在过期前
   * 短暂 public cache,绕开 iOS Safari + CF SameSite=Strict cookie drop 问题。
   *
   * 入参:**上游容器返回的 HTTP statusCode**(2xx / 3xx / 4xx / 5xx)。
   * 返回:
   *   - 字符串 → 用它作为 `Cache-Control` 值(典型 `public, max-age=...`)
   *   - `null` / `undefined` → 沿用默认 `no-store`(失败/错误统一保守)
   *
   * 调用方约定(handler 层强制):
   *   - **只在 statusCode === 200 || 206 时返回 public cache**;其余状态返 null,
   *     避免 CDN 缓存 4xx/5xx 错误响应导致 token 过期/路径变更后无法刷新。
   *   - 一并被 proxy 自身错误路径(429 / 502 / 504 / 500 等 sendJsonError)忽略 ——
   *     这些路径根本不调 buildClientResponseHead,默认就是 `no-store`。
   *
   * 不注入(personal version / 普通 /api/file 路径)→ 维持 `no-store`(原行为)。
   */
  responseCacheControlOverride?: (upstreamStatus: number) => string | null;
}

/**
 * 主入口。调用方确保:
 *   - url.pathname ∈ {/api/file, /api/media/*}
 *   - method === GET
 *   - 调用者(身份 = `uid`)已在 DB `status === 'active'`
 *   - role:取决于上游 caller —
 *       * router.ts 的 PROXY 分支只放 role === 'user'(admin fall-through 到 BLOCKED bypass)
 *       * handleMediaSigned 直接调本函数,role ∈ {'user', 'admin'} —— signed URL 既给
 *         user 用也给 admin 用,uid 就是 token 内 sub,真正 ACL 由容器内 handleApiFile
 *         (realpathSync + agentCwds + isFileAllowed) 把权威。
 *   - 不同 path/role 矩阵的具体收口由各调用方 (router/handleMediaSigned) 各自闭合,
 *     本函数只信任传入的 `uid` 是已认证身份。
 */
export async function containerFileProxy(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: ContainerFileProxyDeps,
  uid: bigint,
): Promise<void> {
  // R4 SHOULD#2 — bigint uid 必须能无损转 number(后面 getV3ContainerStatus
  // 接的是 number)。uid 出自 JWT sub,验签后仍要守 MVP 不变量:users.id 在
  // BIGSERIAL 区间但实际 < 2^31。> 2^53 的非法值(JWT 造假 / 未来 schema 漂移)
  // 一律 400 bail,不占 inflight slot,不进 DB。对齐 v3ensureRunning.ts:152。
  if (uid <= 0n || uid > BigInt(Number.MAX_SAFE_INTEGER)) {
    sendJsonError(res, 400, "BAD_UID", "invalid uid", ctx.requestId);
    return;
  }
  const uidStr = String(uid);
  if ((inflight.get(uidStr) ?? 0) >= PER_UID_MAX) {
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "2",
    });
    res.end(
      JSON.stringify({
        error: {
          code: "TOO_MANY_DOWNLOADS",
          message: "concurrent downloads per user limit reached",
          request_id: ctx.requestId,
        },
      }),
    );
    return;
  }
  inflight.set(uidStr, (inflight.get(uidStr) ?? 0) + 1)

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const n = (inflight.get(uidStr) ?? 1) - 1;
    if (n <= 0) inflight.delete(uidStr);
    else inflight.set(uidStr, n);
  };

  // R1 SHOULD-2 / R2 SHOULD 加固:res.close 监听必须 inflight 计数加 1 就挂上,
  // 不能延到 upstream `response` 事件里才挂 —— 客户端在 DB 查询 / SSRF 白名单 /
  // capability probe / connect / header 任一阶段断开,原实现 release 只能靠
  // timeout/error 兜底,per-uid slot 可能卡到 DB 调用超时(最坏几十秒)。
  // 另外,DB/probe 的 await 点可能在客户端已断开后仍继续走到出站请求创建,下面
  // 每个 await 后都 check clientClosed 并 bail,避免 fd/socket 泄漏。close 回调也把
  // clientClosed 置真,后续创建的 upstream / tunnel socket 在 else 分支里会被
  // 立即 destroy。
  let currentUpstream: ClientRequest | null = null;
  let currentTunnelSocket: TLSSocket | null = null;
  let clientClosed = false;
  res.on("close", () => {
    clientClosed = true;
    if (currentUpstream && !currentUpstream.destroyed) {
      try { currentUpstream.destroy(); } catch {}
    }
    if (currentTunnelSocket && !currentTunnelSocket.destroyed) {
      try { currentTunnelSocket.destroy(); } catch {}
    }
    release();
  });

  try {
    // 1. DB status
    const uidNum = Number(uid);
    const status = deps.getStatus
      ? await deps.getStatus(uidNum)
      : await getV3ContainerStatus(deps.v3, uidNum);
    if (clientClosed) return;
    if (!status || status.state !== "running") {
      // diag: v1.0.73 上线后 user 7 持续 503,确认 status 字段值
      ctx.log.warn("container_file_proxy_not_running", {
        uid: uidStr,
        statusNull: !status,
        state: status?.state,
        containerId: status?.containerId,
        hostId: status?.hostId,
        dockerContainerId: status?.dockerContainerId ? `${status.dockerContainerId.slice(0, 12)}...` : null,
      });
      sendJsonError(res, 503, "CONTAINER_NOT_RUNNING", "container is not running", ctx.requestId);
      release();
      return;
    }

    // 2. SSRF 白名单 —— 两个分支共享。tunnel 分支不直接连这个 IP,但保留是为了:
    //    (a) 兜底 DB 行污染(host_uuid 被改但 boundIp 还指向非 bridge 网段也拒)
    //    (b) 给 logging 一个统一的"奇怪 IP" 触发点
    if (!isBoundIpAllowed(status.boundIp) || status.port !== 18789) {
      ctx.log.warn("container_file_proxy_ssrf_denied", {
        uid: uidStr,
        boundIp: status.boundIp,
        port: status.port,
      });
      sendJsonError(res, 502, "BAD_GATEWAY", "container network invalid", ctx.requestId);
      release();
      return;
    }

    // 3. capability probe(自动按 hostId 走本地 fetch / tunnel —— 见 capabilityCache)
    const ready = await isContainerCapabilityReady(
      status,
      ["file-proxy-v1"],
      deps.capabilityProbe,
    );
    if (clientClosed) return;
    if (!ready) {
      // diag: 配合 capabilityCache console.warn 看具体 reason
      ctx.log.warn("container_file_proxy_outdated", {
        uid: uidStr,
        containerId: status.containerId,
        hostId: status.hostId,
        selfHostId: deps.selfHostId,
        isRemote: typeof deps.selfHostId === "string" && typeof status.hostId === "string" && status.hostId !== deps.selfHostId,
      });
      sendJsonError(res, 503, "CONTAINER_OUTDATED", "container missing file-proxy-v1 capability", ctx.requestId);
      release();
      return;
    }

    // 4. 路由本地 vs 远端
    const isRemote =
      typeof deps.selfHostId === "string"
      && typeof status.hostId === "string"
      && status.hostId !== deps.selfHostId;

    if (isRemote) {
      await dispatchViaTunnel(req, res, ctx, deps, status, uidStr, {
        clientClosedRef: () => clientClosed,
        setCurrentSocket: (s) => { currentTunnelSocket = s; },
        release,
      });
    } else {
      dispatchViaLocalHttp(req, res, ctx, deps, status, uidStr, {
        clientClosedRef: () => clientClosed,
        setCurrentUpstream: (u) => { currentUpstream = u; },
        release,
      });
    }
  } catch (err) {
    ctx.log.error("container_file_proxy_unhandled", {
      uid: uidStr,
      error: (err as Error)?.message ?? String(err),
    });
    if (!res.headersSent) {
      sendJsonError(res, 500, "INTERNAL", "internal proxy error", ctx.requestId);
    } else if (!res.writableEnded) {
      res.destroy();
    }
    release();
  }
}

/** 共享:浏览器请求头 → 上游请求头白名单 + 三个固定头 */
function buildUpstreamHeaders(
  req: IncomingMessage,
  status: Pick<V3ContainerStatus, "containerId">,
  bridgeSecret: string,
): Record<string, string | string[]> {
  const up: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    if (FORWARD_HEADERS.has(k.toLowerCase())) {
      up[k] = v as string | string[];
    }
  }
  up["X-OpenClaude-Container-Id"] = String(status.containerId);
  up["X-OpenClaude-Bridge-Nonce"] = createHmac("sha256", bridgeSecret)
    .update(String(status.containerId))
    .digest("hex");
  up["Accept-Encoding"] = "identity";
  return up;
}

/**
 * 共享:基于上游响应头 + URL,构造给浏览器的最终响应头。
 *
 * tunnel 分支没有 `IncomingMessage` 对象,只有 `Record<string, string>`,
 * 所以 helper 只读 case-insensitive header dict + statusCode。
 */
function buildClientResponseHead(
  upstreamHeaders: Record<string, string | string[] | undefined>,
  reqUrl: URL,
  isFilePath: boolean,
  upstreamStatus: number,
  cacheControlOverride?: (upstreamStatus: number) => string | null,
): { out: Record<string, string | number | string[]>; mode: "inline" | "attachment" } | { error: "bad_path" } {
  let rawName: string;
  try {
    rawName = isFilePath
      ? reqUrl.searchParams.get("path") ?? ""
      : decodeURIComponent(reqUrl.pathname.replace(/^\/api\/media\//, ""));
  } catch {
    // decodeURIComponent URIError(非法百分号)
    return { error: "bad_path" };
  }

  const fname =
    basename(rawName)
      .replace(/[\r\n"\\\x00]/g, "_")
      .slice(0, 255) || "file";

  const ctRaw = upstreamHeaders["content-type"];
  const type = String(Array.isArray(ctRaw) ? ctRaw[0] : ctRaw ?? "application/octet-stream");
  const typeBase = (type.split(";")[0] ?? "").trim().toLowerCase();
  const mode =
    !isFilePath && isSafeInlineType(typeBase) && !ACTIVE_TYPES.has(typeBase)
      ? "inline"
      : "attachment";

  // Cache-Control:默认 no-store。仅当 caller 注入 override **且** 上游返回成功
  // (200/206 由 handler 端 enforce)→ 用 override 返回值(典型 `public, max-age=...`)。
  // override 返回 null → 维持 no-store(handler 已对 4xx/5xx 返 null)。
  let cacheControl = "no-store";
  if (cacheControlOverride) {
    const overridden = cacheControlOverride(upstreamStatus);
    if (typeof overridden === "string" && overridden.length > 0) {
      cacheControl = overridden;
    }
  }

  const out: Record<string, string | number | string[]> = {
    "Content-Type": type,
    "Cache-Control": cacheControl,
    Vary: "Authorization, Cookie",
    "Content-Disposition": `${mode}; ${rfc5987(fname)}`,
  };
  for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
    const v = upstreamHeaders[h];
    if (v !== undefined) out[h] = v as string | string[];
  }
  return { out, mode };
}

/** 本地分支:直 httpRequest 到 boundIp:port */
function dispatchViaLocalHttp(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: ContainerFileProxyDeps,
  status: V3ContainerStatus,
  uidStr: string,
  hooks: {
    clientClosedRef: () => boolean;
    setCurrentUpstream: (u: ClientRequest | null) => void;
    release: () => void;
  },
): void {
  const host = req.headers.host ?? "x.invalid";
  const reqUrl = new URL(req.url ?? "/", `http://${host}`);
  const isFilePath = reqUrl.pathname === "/api/file";

  const up = buildUpstreamHeaders(req, status, deps.bridgeSecret);

  const requestImpl = deps.httpRequestImpl ?? httpRequest;
  const upstream = requestImpl({
    host: status.boundIp,
    port: status.port,
    method: "GET",
    path: reqUrl.pathname + reqUrl.search,
    headers: up,
    family: 4,
    timeout: CONNECT_MS,
  });
  hooks.setCurrentUpstream(upstream);
  if (hooks.clientClosedRef()) {
    try { upstream.destroy(); } catch {}
    return;
  }

  upstream.on("timeout", () => {
    upstream.destroy(new Error("connect_or_idle_timeout"));
  });
  upstream.on("error", (err) => {
    ctx.log.warn("container_file_proxy_upstream_error", {
      uid: uidStr,
      error: (err as Error)?.message ?? String(err),
    });
    if (!res.headersSent) {
      sendJsonError(res, 502, "BAD_GATEWAY", "upstream error", ctx.requestId);
    } else if (!res.writableEnded) {
      res.destroy();
    }
    hooks.release();
  });

  upstream.on("response", (r) => {
    r.socket.setTimeout(IDLE_MS);

    const built = buildClientResponseHead(
      r.headers,
      reqUrl,
      isFilePath,
      r.statusCode ?? 502,
      deps.responseCacheControlOverride,
    );
    if ("error" in built) {
      if (!res.headersSent) {
        sendJsonError(res, 400, "BAD_PATH", "invalid percent-encoding", ctx.requestId);
      }
      r.resume();
      hooks.release();
      return;
    }
    res.writeHead(r.statusCode ?? 502, built.out);

    r.on("end", () => hooks.release());
    r.on("error", () => {
      if (!res.writableEnded) res.destroy();
      hooks.release();
    });
    r.pipe(res);
  });

  upstream.end();
}

/** 远端分支:dialTunnelSocket → 手解 status+headers → pipe socket → res */
async function dispatchViaTunnel(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: ContainerFileProxyDeps,
  status: V3ContainerStatus,
  uidStr: string,
  hooks: {
    clientClosedRef: () => boolean;
    setCurrentSocket: (s: TLSSocket | null) => void;
    release: () => void;
  },
): Promise<void> {
  // 多 host 模式必须注入这两个 dep;漏注入 = 配置 bug,fail-closed
  if (!deps.tunnelDial || !deps.getHostById) {
    ctx.log.warn("container_file_proxy_tunnel_misconfigured", {
      uid: uidStr,
      hostId: status.hostId,
      hasDial: Boolean(deps.tunnelDial),
      hasGetHost: Boolean(deps.getHostById),
    });
    sendJsonError(res, 502, "BAD_GATEWAY", "remote dispatch unavailable", ctx.requestId);
    hooks.release();
    return;
  }
  if (!status.dockerContainerId) {
    // DB inconsistency:host_uuid 是远端但 container_internal_id 空
    ctx.log.warn("container_file_proxy_no_docker_id", { uid: uidStr });
    sendJsonError(res, 502, "BAD_GATEWAY", "container not provisioned", ctx.requestId);
    hooks.release();
    return;
  }

  const row = await deps.getHostById(status.hostId!);
  if (hooks.clientClosedRef()) return;
  if (!row) {
    ctx.log.warn("container_file_proxy_host_not_found", { uid: uidStr, hostId: status.hostId });
    sendJsonError(res, 502, "BAD_GATEWAY", "host not found", ctx.requestId);
    hooks.release();
    return;
  }
  // A3 — 终态 revoked host 不再走 container file tunnel(deny)。
  if (row.status === "revoked") {
    ctx.log.warn("container_file_proxy_host_revoked", { uid: uidStr, hostId: status.hostId });
    sendJsonError(res, 502, "BAD_GATEWAY", "host revoked", ctx.requestId);
    hooks.release();
    return;
  }
  const target = (deps.rowToTarget ?? hostRowToTarget)(row);
  target.requireFingerprint = true;

  const host = req.headers.host ?? "x.invalid";
  const reqUrl = new URL(req.url ?? "/", `http://${host}`);
  const isFilePath = reqUrl.pathname === "/api/file";

  const headers = buildUpstreamHeaders(req, status, deps.bridgeSecret);
  // **不**写 Connection: close —— node-agent tunnel 会剥 hop-by-hop header(见
  // tunnel.go),容器收不到。我们改为 master 侧按 Content-Length / chunked 边界
  // 主动 destroy socket,让 close 反向 propagate。
  // tunnel client 协议要求 string 值;flatten array(forward 名单里只有
  // accept-encoding 之类不会有 array,但防御性 squash)
  const flatHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    flatHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
  }

  // path+query merging:dialTunnelSocket 走 /tunnel/containers/{cid}/{rest}
  // —— 我们传的 pathAndQuery 必须包含原 path + 原 query + ?port=18789。用
  // URLSearchParams 合并避免 caller 自带 path=... 跟我们的 port 拼错。
  const params = new URLSearchParams(reqUrl.search);
  params.set("port", String(status.port));
  const pathAndQuery = `${reqUrl.pathname}?${params.toString()}`;

  let socket: TLSSocket;
  try {
    socket = await deps.tunnelDial({
      target,
      method: "GET",
      containerInternalId: status.dockerContainerId,
      pathAndQuery,
      headers: flatHeaders,
      connectTimeoutMs: CONNECT_MS,
    });
  } catch (err) {
    ctx.log.warn("container_file_proxy_tunnel_dial_failed", {
      uid: uidStr,
      hostId: status.hostId,
      error: (err as Error)?.message ?? String(err),
    });
    if (!res.headersSent) {
      sendJsonError(res, 502, "BAD_GATEWAY", "tunnel dial failed", ctx.requestId);
    }
    hooks.release();
    return;
  }
  hooks.setCurrentSocket(socket);
  if (hooks.clientClosedRef()) {
    try { socket.destroy(); } catch {}
    return;
  }

  // 读响应头:用 IDLE_MS 作头超时上限(实际 head 通常 << 1s,IDLE_MS 是兜底防
  // body 之前长 stall)。head 读失败 → 504 GATEWAY_TIMEOUT,**不**误归 OUTDATED。
  const head = await readResponseHead(socket, IDLE_MS, MAX_HEADER_BYTES);
  if (hooks.clientClosedRef()) {
    try { socket.destroy(); } catch {}
    return;
  }
  if (!head) {
    ctx.log.warn("container_file_proxy_tunnel_head_failed", {
      uid: uidStr,
      hostId: status.hostId,
    });
    if (!res.headersSent) {
      sendJsonError(res, 504, "GATEWAY_TIMEOUT", "upstream head timeout", ctx.requestId);
    }
    try { socket.destroy(); } catch {}
    hooks.release();
    return;
  }

  // 切到 socket idle timeout(body 阶段)
  socket.setTimeout(IDLE_MS, () => {
    try { socket.destroy(); } catch {}
  });

  const built = buildClientResponseHead(
    head.headers,
    reqUrl,
    isFilePath,
    head.statusCode || 502,
    deps.responseCacheControlOverride,
  );
  if ("error" in built) {
    if (!res.headersSent) {
      sendJsonError(res, 400, "BAD_PATH", "invalid percent-encoding", ctx.requestId);
    }
    try { socket.destroy(); } catch {}
    hooks.release();
    return;
  }

  // 防御:不透传 hop-by-hop。buildClientResponseHead 已经只取白名单字段,
  // 但白名单里若未来加进 hop-by-hop 会出错;此处一遍 strip 防回归。
  for (const h of HOP_BY_HOP_HEADERS) delete built.out[h];

  // body 路由:必须按 Content-Length / chunked 主动结束,否则永远等不到容器侧
  // close —— node-agent tunnel hop-by-hop strip + 双向 io.Copy 等 EOF。
  const cl = head.headers["content-length"];
  const te = (head.headers["transfer-encoding"] ?? "").toLowerCase();
  // 防御 NIT:容器若同时返 TE:chunked + CL,CL 是无效字段;走 chunked 解码,
  // 同时不能把 CL 透传给浏览器,否则浏览器按 CL 提前断定 body 完成。
  if (te.includes("chunked")) {
    delete built.out["content-length"];
    delete built.out["Content-Length" as keyof typeof built.out];
  }

  res.writeHead(head.statusCode || 502, built.out);
  const finalize = (why: "ok" | string) => {
    if (why === "ok") {
      hooks.release();
    } else {
      ctx.log.warn("container_file_proxy_tunnel_body_error", {
        uid: uidStr,
        hostId: status.hostId,
        why,
      });
      hooks.release();
    }
  };

  if (te.includes("chunked")) {
    pipeBodyChunked(socket, head.leftover, res, IDLE_MS, /*maxTotalBytes*/ 1024 * 1024 * 1024 /* 1 GB hard cap */, {
      onDone: () => finalize("ok"),
      onError: (why) => finalize(why),
    });
    return;
  }
  if (cl !== undefined) {
    const expected = Number.parseInt(cl, 10);
    if (!Number.isFinite(expected) || expected < 0) {
      ctx.log.warn("container_file_proxy_tunnel_bad_cl", {
        uid: uidStr,
        contentLength: cl,
      });
      try { socket.destroy(); } catch {}
      if (!res.writableEnded) try { res.destroy(); } catch {}
      hooks.release();
      return;
    }
    pipeBodyByContentLength(socket, head.leftover, res, expected, IDLE_MS, {
      onDone: () => finalize("ok"),
      onError: (why) => finalize(why),
    });
    return;
  }
  // 无 Content-Length 也无 chunked:协议异常(我们的容器 server 必发其一)。
  // bail,不冒险用 socket.pipe 等 close —— node-agent 会卡死。
  ctx.log.warn("container_file_proxy_tunnel_no_length", {
    uid: uidStr,
    hostId: status.hostId,
  });
  try { socket.destroy(); } catch {}
  if (!res.writableEnded) try { res.destroy(); } catch {}
  hooks.release();
}

function sendJsonError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  requestId: string,
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(
    JSON.stringify({
      error: { code, message, request_id: requestId },
    }),
  );
}

/** 测试用:清空 inflight 计数 */
export function __resetInflightForTest(): void {
  inflight.clear();
}
