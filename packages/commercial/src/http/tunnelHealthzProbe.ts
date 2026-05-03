/**
 * v3 file-proxy 远端 host capability 探活。
 *
 * 本机容器:capabilityCache 用 `defaultFetchHealthz` 直接 `fetch(http://boundIp:18789/healthz)`
 * 远端容器:bridge IP 在 docker host 内部,master 不可达 → 必须走 node-agent
 *           tunnel(`/tunnel/containers/{cid}/healthz?port=18789`)。
 *
 * 流程:
 *   1. `getHostById(hostId)` 拿 ComputeHostRow;查不到/quarantined 等也照样
 *      hostRowToTarget(只判断行存在与否,不挑 status —— 与 v3readiness 的探活
 *      策略一致;由 node-agent 端 mTLS 校验决定能不能连上)
 *   2. dialTunnelSocket → 拿 raw TLSSocket
 *   3. readResponseHead → 拿 status / headers / leftover
 *   4. status >=400 → null;否则 readBodyCapped(leftover, 8KB)→ JSON.parse
 *   5. finally: socket.destroy()
 *
 * 失败语义:任何步骤异常都 throw —— caller(capabilityCache)目前对探活异常
 * 一律返 false。**不**做无声 swallow,让 caller 决定 cache 怎么写。
 *
 * 不写 cache:cache 在 capabilityCache 里。本文件只负责"探一次拿 raw response"。
 */

import type { ComputeHostRow } from "../compute-pool/types.js";
import { dialTunnelSocket, hostRowToTarget } from "../compute-pool/nodeAgentClient.js";
import { V3_CONTAINER_PORT } from "../agent-sandbox/v3supervisor.js";
import { readBodyByContentLength, readBodyCapped, readBodyChunked, readResponseHead } from "./tunnelHttpReader.js";
import type { HealthzResponse } from "./capabilityCache.js";

/** healthz response body 大小上限。/healthz 极小,8KB 远高于任何合理值 */
const HEALTHZ_BODY_CAP = 8 * 1024;

export type GetHostByIdFn = (id: string) => Promise<ComputeHostRow | null>;

export interface TunnelFetchHealthzDeps {
  getHostById: GetHostByIdFn;
  /** 测试钩子:dial 注入(避开真 mTLS) */
  dial?: typeof dialTunnelSocket;
  /** 测试钩子:hostRowToTarget 注入(规避 psk 解密) */
  rowToTarget?: typeof hostRowToTarget;
}

/**
 * 默认远端 healthz fetcher。
 *
 * `containerInternalId` 必须是 docker hex 64-char ID(node-agent tunnel 的
 * `{cid}` 段语义,见 tunnel.go 注释 / v3supervisor `dockerContainerId` 字段)。
 *
 * 失败 throw:hostId 不存在 / dial 失败 / response head 读失败 / 非 2xx /
 * body 解析失败,任意一种都视为探活失败,caller 应 catch → return false。
 */
export async function defaultTunnelFetchHealthz(
  hostId: string,
  containerInternalId: string,
  timeoutMs: number,
  deps: TunnelFetchHealthzDeps,
): Promise<HealthzResponse> {
  const row = await deps.getHostById(hostId);
  if (!row) {
    throw new Error(`tunnelFetchHealthz: compute_host ${hostId} not found`);
  }
  const target = (deps.rowToTarget ?? hostRowToTarget)(row);
  let socket: Awaited<ReturnType<typeof dialTunnelSocket>> | null = null;
  try {
    socket = await (deps.dial ?? dialTunnelSocket)({
      target,
      method: "GET",
      containerInternalId,
      pathAndQuery: `/healthz?port=${V3_CONTAINER_PORT}`,
      // Connection: close 是 hop-by-hop,node-agent 会剥(见 tunnel.go),容器收
      // 不到。所以靠 Content-Length 精确读边界,而不是等 close。/healthz 必返
      // CL(我们的 server 都是 fixed-buffer 响应);若返 chunked → 视为协议异常 throw。
      connectTimeoutMs: timeoutMs,
    });
    const head = await readResponseHead(socket, timeoutMs);
    if (!head) throw new Error("tunnelFetchHealthz: head read failed");
    if (head.statusCode < 200 || head.statusCode >= 300) {
      throw new Error(`tunnelFetchHealthz: status=${head.statusCode}`);
    }
    const clRaw = head.headers["content-length"];
    const teRaw = head.headers["transfer-encoding"];
    let body: Buffer | null;
    if (clRaw !== undefined) {
      const cl = Number.parseInt(clRaw, 10);
      if (!Number.isFinite(cl) || cl < 0 || cl > HEALTHZ_BODY_CAP) {
        throw new Error(`tunnelFetchHealthz: invalid content-length=${clRaw}`);
      }
      body = await readBodyByContentLength(socket, head.leftover, cl, timeoutMs);
    } else if (typeof teRaw === "string" && teRaw.toLowerCase().includes("chunked")) {
      // Node http.Server 对 res.end(jsonString) 在 keep-alive + 不显式设 CL 时,
      // 默认走 chunked encoding(实测容器内 /healthz 即此分支)。必须 chunked
      // decode,否则 readBodyCapped 等 close 永远 hang —— node-agent 对小响应
      // 通常不主动 close,且 Connection: close 是 hop-by-hop 被剥(tunnel.go)。
      body = await readBodyChunked(socket, head.leftover, timeoutMs, HEALTHZ_BODY_CAP);
    } else {
      // 无 CL 也无 chunked:协议不规范。fallback readBodyCapped(等 close),
      // 大概率因 keep-alive 而 timeout → caller catch → false。
      body = await readBodyCapped(socket, head.leftover, timeoutMs, HEALTHZ_BODY_CAP);
    }
    if (!body) throw new Error("tunnelFetchHealthz: body read failed (timeout or > cap)");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      throw new Error("tunnelFetchHealthz: invalid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new Error("tunnelFetchHealthz: response not object");
    }
    return parsed as HealthzResponse;
  } finally {
    if (socket) {
      try { socket.destroy(); } catch { /* */ }
    }
  }
}
