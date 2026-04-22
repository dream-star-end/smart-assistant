/**
 * v3 file proxy — HOST → 容器 /api/file & /api/media/* 的反向代理。
 *
 * **流程**(见 v3-file-return-spec-mvp.md §0):
 *   1. 查 DB:`getV3ContainerStatus(uid)` → state=running
 *   2. SSRF 白名单:bound_ip ∈ 172.30/16 且 port === 18789
 *   3. capability 探测:/healthz 必须广播 file-proxy-v1 且 containerId echo 匹配
 *   4. 发 GET http://boundIp:18789 + 两个认证头:
 *        X-OpenClaude-Container-Id:<DB id>
 *        X-OpenClaude-Bridge-Nonce:HMAC(rootSecret, id)
 *      附带 Accept-Encoding: identity(禁 gzip 防 Range / Content-Length 对不上)
 *   5. 两段 timer:连接 3s(Node `http.timeout` 语义) → response 到达后
 *      `r.socket.setTimeout(120s)` 切到 idle
 *   6. 响应头重写:Cache-Control:no-store + Vary + RFC 5987 Content-Disposition
 *   7. per-uid ≤ 4 并发,超限 429
 *
 * **SSRF 深防**(多层布防):
 *   - JWT 校验(上层 router)→ sub ∈ DB users
 *   - `user_id = $sub`(只会查到自己的容器行)
 *   - 172.30/16 白名单 + port 18789(即便 DB 行被污染也防不出 docker 网段)
 *   - containerId 绑定 + HMAC nonce(容器端校验)
 *
 * **per-uid 并发**:`inflight` Map 计数,release 在三种 cleanup 路径都要幂等:
 *   - 正常 end → release
 *   - upstream error → release
 *   - 客户端断连(res.close)→ release
 *   任意一条只做一次(`released` flag 幂等)
 */

import type { ClientRequest, IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { createHmac } from "node:crypto";
import { isIPv4 } from "node:net";
import { basename } from "node:path";
import type { RequestContext } from "./handlers.js";
import type { V3ContainerStatus, V3SupervisorDeps } from "../agent-sandbox/v3supervisor.js";
import { getV3ContainerStatus } from "../agent-sandbox/v3supervisor.js";
import {
  isContainerCapabilityReady,
  type CapabilityProbeDeps,
} from "./capabilityCache.js";

const CONNECT_MS = 3_000;
const IDLE_MS = 120_000;
const PER_UID_MAX = 4;

/** per-uid 并发计数。key = uid string。release() 幂等。 */
const inflight = new Map<string, number>();

/** 172.30.0.0/16 白名单 —— 容器必须在我们自己的 docker bridge 上 */
function isBoundIpAllowed(ip: string): boolean {
  if (!isIPv4(ip)) return false;
  const p = ip.split(".").map(Number);
  return p[0] === 172 && p[1] === 30;
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

export interface ContainerFileProxyDeps {
  v3: V3SupervisorDeps;
  bridgeSecret: string;
  /** 测试钩子:注入 status(跳过 DB / docker inspect) */
  getStatus?: (uid: number) => Promise<V3ContainerStatus | null>;
  /** 测试钩子:注入 capability probe */
  capabilityProbe?: CapabilityProbeDeps;
  /** 测试钩子:注入 http.request(避开真 TCP)。签名与 node:http.request 兼容。 */
  httpRequestImpl?: typeof httpRequest;
}

/**
 * 主入口。调用方(router)确保:
 *   - url.pathname ∈ {/api/file, /api/media/*}
 *   - method === GET
 *   - JWT 已验过 + sub === uid + role === 'user' + DB status === 'active'
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
  // 另外,DB/probe 的 await 点可能在客户端已断开后仍继续走到 httpRequest(...) 创建
  // 出站 upstream,下面每个 await 后都 check clientClosed 并 bail,避免 fd/socket
  // 泄漏。close 回调也把 clientClosed 置真,后续创建的 upstream 会在 else 分支里
  // 被立即 destroy。
  let currentUpstream: ClientRequest | null = null;
  let clientClosed = false;
  res.on("close", () => {
    clientClosed = true;
    if (currentUpstream && !currentUpstream.destroyed) {
      try { currentUpstream.destroy(); } catch {}
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
      sendJsonError(res, 503, "CONTAINER_NOT_RUNNING", "container is not running", ctx.requestId);
      release();
      return;
    }

    // 2. SSRF 白名单
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

    // 3. capability probe
    const ready = await isContainerCapabilityReady(
      status,
      ["file-proxy-v1"],
      deps.capabilityProbe,
    );
    if (clientClosed) return;
    if (!ready) {
      sendJsonError(res, 503, "CONTAINER_OUTDATED", "container missing file-proxy-v1 capability", ctx.requestId);
      release();
      return;
    }

    // 4. 构造上游请求
    const host = req.headers.host ?? "x.invalid";
    const reqUrl = new URL(req.url ?? "/", `http://${host}`);
    const isFilePath = reqUrl.pathname === "/api/file";

    const up: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (FORWARD_HEADERS.has(k.toLowerCase())) {
        up[k] = v as string | string[];
      }
    }
    up["X-OpenClaude-Container-Id"] = String(status.containerId);
    up["X-OpenClaude-Bridge-Nonce"] = createHmac("sha256", deps.bridgeSecret)
      .update(String(status.containerId))
      .digest("hex");
    // 强制 identity:防止未来容器端对 /api/file gzip 后 Range / Content-Length 错配。
    up["Accept-Encoding"] = "identity";

    const requestImpl = deps.httpRequestImpl ?? httpRequest;
    const upstream = requestImpl({
      host: status.boundIp,
      port: status.port,
      method: "GET",
      path: reqUrl.pathname + reqUrl.search,
      headers: up,
      family: 4,
      // Node http.timeout 语义 = socket inactivity。response 前复用于 connect+header;
      // response 后我们 `r.socket.setTimeout(IDLE_MS)` 切到 body idle。单个 timeout
      // 事件 handler 即可覆盖两种场景。
      timeout: CONNECT_MS,
    });
    currentUpstream = upstream;
    // 极晚 bail:upstream 已创建但同步任务 tick 内客户端已断开 —— 顶层 close 回调
    // 会把 clientClosed 置 true 且 destroy(但只 destroy currentUpstream,我们
    // 是否已赋值取决于 event loop 时序)。双保险:此处显式检查,主动销毁已创建的
    // upstream,避免对容器发出一个无人消费的请求。
    if (clientClosed) {
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
      release();
    });

    upstream.on("response", (r) => {
      // 切到 socket idle timeout(涵盖 header 到 body 之间和 body 中的任何 stall)
      r.socket.setTimeout(IDLE_MS);

      // 文件名:/api/file?path=... 用 path 参数;/api/media/<name> 解 URL 段。
      let rawName: string;
      try {
        rawName = isFilePath
          ? reqUrl.searchParams.get("path") ?? ""
          : decodeURIComponent(reqUrl.pathname.replace(/^\/api\/media\//, ""));
      } catch {
        // decodeURIComponent URIError(非法百分号)
        if (!res.headersSent) {
          sendJsonError(res, 400, "BAD_PATH", "invalid percent-encoding", ctx.requestId);
        }
        r.resume();
        release();
        return;
      }

      const fname =
        basename(rawName)
          .replace(/[\r\n"\\\x00]/g, "_")
          .slice(0, 255) || "file";

      const type = String(r.headers["content-type"] ?? "application/octet-stream");
      const typeBase = (type.split(";")[0] ?? "").trim().toLowerCase();
      // /api/file 永远 attachment;/api/media 在安全类型列表 + 非活跃类型 → inline
      const mode =
        !isFilePath && isSafeInlineType(typeBase) && !ACTIVE_TYPES.has(typeBase)
          ? "inline"
          : "attachment";

      const out: Record<string, string | number | string[]> = {
        "Content-Type": type,
        "Cache-Control": "no-store",
        Vary: "Authorization, Cookie",
        "Content-Disposition": `${mode}; ${rfc5987(fname)}`,
      };
      for (const h of PASSTHROUGH_RESPONSE_HEADERS) {
        const v = r.headers[h];
        if (v !== undefined) out[h] = v as string | string[];
      }

      res.writeHead(r.statusCode ?? 502, out);

      // cleanup 路径:r.end / r.error / (顶层已挂 res.close)。release 幂等。
      r.on("end", () => release());
      r.on("error", () => {
        if (!res.writableEnded) res.destroy();
        release();
      });
      r.pipe(res);
    });

    upstream.end();
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
