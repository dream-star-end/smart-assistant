/**
 * V3 Phase 3E — 容器健康检查 + WS upgrade probe + 启动 readiness 等待。
 *
 * 见 docs/v3/02-DEVELOPMENT-PLAN.md §9.3 Task 3E。
 *
 * 为什么不止 HTTP /healthz:
 *   容器内个人版 OpenClaude `npm run gateway` 启动顺序大致是
 *     bind HTTP server (httpServer.listen) → create WebSocketServer → 注册
 *     handleHttp / handleUpgrade。这中间 /healthz 可能已经返 200 但 ws.Server
 *     还没 attach 到 server 的 'upgrade' 事件,bridge 立刻接 ws 会被 reset。
 *   因此 readiness = HTTP /healthz 200 **且** WS 升级握手成功(不发数据,
 *   立即 close)。两条都过才 return ok。
 *
 * M2 多机扩展(Batch B.2):
 *   - `ReadinessEndpoint` 区分 direct(self-host 本机 docker bridge IP 直连)
 *     与 node-tunnel(远端 host 走 mTLS+PSK 经 node-agent `/tunnel/containers/<cid>/*`)。
 *   - direct 路径保留原 probeHealthzHttp + probeWsUpgrade;
 *     node-tunnel 路径用 `dialTunnelSocket` 起 raw TLS socket,自己解析
 *     HTTP 101 / 2xx 状态行 — 不 hydrate body、不关心数据,只要 upgrade/status
 *     成立就算 ready。
 *   - tunnel 的 NodeAgentTarget(含解密 PSK)每次 waitContainerReady 只 hydrate 一次,
 *     复用给循环内所有 probe;完成或失败时 psk.fill(0) 清零。
 *
 * 与 v3ensureRunning.ts 的关系:
 *   - 3D 已经做了 HTTP /healthz 轮询(只 HTTP);3E 替换成 waitContainerReady,
 *     里面跑两道 probe。调用方(B.4)把 scheduler 选出的 host 行转成 endpoint 传入。
 *   - 探活语义不变:超时返 false,caller 决定 ContainerUnreadyError(retryAfter, reason)。
 *
 * 设计取舍:
 *   - direct WS probe 用 `ws` 库构造 client;tunnel WS probe 直接写 raw
 *     HTTP/1.1 Upgrade 请求(dialTunnelSocket 内部已经完成 method/path/headers 的写入)
 *     然后读状态行,不走 `ws` 库 —— 避免再嵌一层 TLS upgrade。
 *   - HTTP probe 与 WS probe 串行(便宜的先,贵的后):/healthz 都没起来,显然
 *     ws 也不可能起来,跳过 ws probe 直接 false。
 */

import { request as httpRequest } from "node:http";
import { randomBytes } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { WebSocket } from "ws";

import { dialTunnelSocket, hostRowToTarget, type NodeAgentTarget } from "../compute-pool/nodeAgentClient.js";
import * as queries from "../compute-pool/queries.js";
// node-agent /tunnel/containers/{cid}/{sub} 强制要求 ?port=N(handler 缺则 400)。
// 只 import 常量,避免环依赖(v3supervisor 没引 v3readiness)。
import { V3_CONTAINER_PORT } from "./v3supervisor.js";

/** 默认 readiness 总超时(ms)。容器从 docker start 到 npm run gateway 完整 listen 一般 3-8s,留 10s 余量。 */
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

/** 默认轮询间隔(ms)。200ms 抓得到瞬态 ready 又不打满 docker 桥接。 */
export const DEFAULT_READINESS_INTERVAL_MS = 200;

/** 默认单次 HTTP /healthz probe 超时(ms)。 */
export const DEFAULT_HTTP_PROBE_MS = 1_000;

/** 默认单次 WS upgrade probe 超时(ms)。upgrade 握手很快,1s 给充裕余量。 */
export const DEFAULT_WS_PROBE_MS = 1_500;

/**
 * readiness endpoint。
 *
 *   - direct:self-host 路径。caller 持 docker bridge IP + 容器端口直连(网关进程
 *     与容器同机器,有直达 IP 可达性)。
 *   - node-tunnel:remote host 路径。master 无 docker bridge 可达性,必须经
 *     node-agent `/tunnel/containers/<cid>/*` 走 mTLS+PSK 的隧道;hostId 用于
 *     hydrate NodeAgentTarget。
 */
export type ReadinessEndpoint =
  | { kind: "direct"; host: string; port: number }
  | { kind: "node-tunnel"; hostId: string; containerInternalId: string };

// ─── direct probes(self-host)────────────────────────────────────────

/**
 * 单次 HTTP GET /healthz —— 2xx → ready,其他全部 false(不抛)。
 *
 * 不暴露 fetch 实现细节;失败原因(ECONNREFUSED / 超时 / 5xx)在 caller 看来都一样。
 */
export async function probeHealthzHttp(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const req = httpRequest(
      {
        host,
        port,
        path: "/healthz",
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const ok = !!res.statusCode && res.statusCode >= 200 && res.statusCode < 300;
        // 必须 resume + drain,否则 socket 不归还(影响下次 probe 的 keepalive 池)
        res.resume();
        res.on("end", () => resolve(ok));
        res.on("error", () => resolve(false));
      },
    );
    req.on("timeout", () => {
      try { req.destroy(); } catch { /* */ }
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

/**
 * 单次 WS upgrade probe —— 连 ws://host:port/ws,握手成功 = ready。
 *
 * - 不发 message,不带 token / Bearer(`personal-version` /ws 在 'connection'
 *   事件里做 auth;upgrade 不需要 auth,握手就能成 = ws.Server 已 attach 到
 *   httpServer.upgrade,这就是 readiness 信号)
 * - 不等 'message' 也不发,避免容器误以为是真 client;立即 close 1000 normal
 * - 单次超时 ms;超时 / error / unexpected-response → false
 *
 * 注意:握手过程中 personal-version 的 connection handler 会试图调 sessions / auth,
 * 这个时候我们 close 1000 是合法行为,不会污染容器内任何 session 表。
 */
export async function probeWsUpgrade(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finalize = (ok: boolean, ws?: WebSocket) => {
      if (settled) return;
      settled = true;
      if (ws) {
        try { ws.close(1000); } catch { /* */ }
        try { ws.terminate(); } catch { /* */ }
      }
      resolve(ok);
    };
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://${host}:${port}/ws`, {
        // 不带 token / 不带 Bearer。bridge 自己的鉴权在 connection handler。
        handshakeTimeout: timeoutMs,
        // 显式 perMessageDeflate=false:不需要协商压缩,缩短握手响应大小
        perMessageDeflate: false,
      });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => finalize(false, ws), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      finalize(true, ws);
    });
    ws.once("unexpected-response", () => {
      clearTimeout(timer);
      finalize(false, ws);
    });
    ws.once("error", () => {
      clearTimeout(timer);
      finalize(false, ws);
    });
  });
}

// ─── tunnel probes(remote host via node-agent)───────────────────────

/**
 * 读 TLS socket 直到遇到 `\r\n`,返回第一行(HTTP status line)或超时 null。
 *
 * 不 hydrate body、不处理 chunked。探活只认状态行成立,后续字节丢弃。
 */
function readStatusLine(
  socket: TLSSocket,
  timeoutMs: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const done = (line: string | null) => {
      if (settled) return;
      settled = true;
      try { socket.removeAllListeners("data"); } catch { /* */ }
      try { socket.removeAllListeners("error"); } catch { /* */ }
      try { socket.removeAllListeners("close"); } catch { /* */ }
      clearTimeout(timer);
      resolve(line);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\r\n");
      if (nl >= 0) done(buf.slice(0, nl));
      // 防御极端情况 (attacker 发超长单行);>16KB 就放弃
      else if (buf.length > 16 * 1024) done(null);
    });
    socket.on("error", () => done(null));
    socket.on("close", () => done(null));
  });
}

/**
 * 单次 HTTP /healthz probe via node-agent tunnel。
 *
 * `dial` 默认走真 dialTunnelSocket;暴露此参数是为了在 Node 20(无 mock.module)
 * 下让单测能断言传给 dialer 的 path 契约。生产调用使用默认 dialer。
 */
export async function probeHealthzViaTunnel(
  target: NodeAgentTarget,
  containerInternalId: string,
  timeoutMs: number,
  dial: typeof dialTunnelSocket = dialTunnelSocket,
): Promise<boolean> {
  let socket: TLSSocket | null = null;
  try {
    socket = await dial({
      target,
      method: "GET",
      containerInternalId,
      pathAndQuery: `/healthz?port=${V3_CONTAINER_PORT}`,
      connectTimeoutMs: timeoutMs,
    });
  } catch {
    return false;
  }
  try {
    const line = await readStatusLine(socket, timeoutMs);
    if (!line) return false;
    const m = /^HTTP\/\d\.\d (\d{3}) /.exec(line);
    if (!m) return false;
    const code = Number.parseInt(m[1]!, 10);
    return code >= 200 && code < 300;
  } finally {
    try { socket.destroy(); } catch { /* */ }
  }
}

/**
 * 单次 WS upgrade probe via node-agent tunnel;期待 HTTP/1.1 101。
 *
 * `dial` 仅供单测注入,见 probeHealthzViaTunnel 注释。
 */
export async function probeWsUpgradeViaTunnel(
  target: NodeAgentTarget,
  containerInternalId: string,
  timeoutMs: number,
  dial: typeof dialTunnelSocket = dialTunnelSocket,
): Promise<boolean> {
  let socket: TLSSocket | null = null;
  try {
    socket = await dial({
      target,
      method: "GET",
      containerInternalId,
      pathAndQuery: `/ws?port=${V3_CONTAINER_PORT}`,
      upgradeWebSocket: true,
      // WebSocket 协议要求这两个头,缺失 server 可能拒 400。
      headers: {
        "Sec-WebSocket-Key": randomBytes(16).toString("base64"),
        "Sec-WebSocket-Version": "13",
      },
      connectTimeoutMs: timeoutMs,
    });
  } catch {
    return false;
  }
  try {
    const line = await readStatusLine(socket, timeoutMs);
    if (!line) return false;
    return /^HTTP\/\d\.\d 101 /.test(line);
  } finally {
    try { socket.destroy(); } catch { /* */ }
  }
}

// ─── wait loop ────────────────────────────────────────────────────────

export interface WaitContainerReadyOptions {
  /** 总超时,默认 10s */
  timeoutMs?: number;
  /** 轮询间隔,默认 200ms */
  intervalMs?: number;
  /** 单次 HTTP /healthz probe 超时,默认 1s */
  httpProbeMs?: number;
  /** 单次 WS upgrade probe 超时,默认 1.5s */
  wsProbeMs?: number;
  /** 测试钩子:覆盖 HTTP probe */
  probeHttp?: () => Promise<boolean>;
  /** 测试钩子:覆盖 WS probe */
  probeWs?: () => Promise<boolean>;
  /** 测试钩子:覆盖 sleep(默认 setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** 测试钩子:覆盖 now(默认 Date.now) */
  now?: () => number;
  /** 测试钩子:覆盖 node-tunnel NodeAgentTarget 的 hydrate(默认走 queries.getHostById + hostRowToTarget) */
  resolveTarget?: (hostId: string) => Promise<NodeAgentTarget>;
}

/**
 * 轮询 HTTP + WS probe 直至两条都过或超时。
 *
 * 单次循环:
 *   1. probeHttp() — 没过 → 这一轮 fail,等下一轮(WS 都不试,省开销)
 *   2. probeWs()   — 没过 → 这一轮 fail,等下一轮
 *   3. 都过 → return true
 *
 * 任何一道连续 fail 直到 deadline 都返 false(不抛)。caller 决定 ContainerUnreadyError 语义。
 *
 * endpoint 为 node-tunnel 时,一次性 hydrate NodeAgentTarget,循环内复用;
 * 方法返回(无论结果)立即 psk.fill(0) 清零。
 */
export async function waitContainerReady(
  endpoint: ReadinessEndpoint,
  options: WaitContainerReadyOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const httpProbeMs = options.httpProbeMs ?? DEFAULT_HTTP_PROBE_MS;
  const wsProbeMs = options.wsProbeMs ?? DEFAULT_WS_PROBE_MS;
  const sleep =
    options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  let probeHttp: () => Promise<boolean>;
  let probeWs: () => Promise<boolean>;
  let tunnelTarget: NodeAgentTarget | null = null;

  if (endpoint.kind === "direct") {
    // 每个 probe 独立 fallback:只覆盖其中一个 hook 时,另一个仍走默认实现。
    probeHttp = options.probeHttp ?? (() => probeHealthzHttp(endpoint.host, endpoint.port, httpProbeMs));
    probeWs = options.probeWs ?? (() => probeWsUpgrade(endpoint.host, endpoint.port, wsProbeMs));
  } else {
    // node-tunnel 路径:只在至少一个 default probe 要用时才 hydrate target(避免两个 hook 都传的测试花 psk hydrate 开销)。
    const needTarget = !options.probeHttp || !options.probeWs;
    if (needTarget) {
      const resolveTarget =
        options.resolveTarget ??
        (async (hostId: string) => {
          const row = await queries.getHostById(hostId);
          if (!row) throw new Error(`unknown hostId: ${hostId}`);
          return hostRowToTarget(row);
        });
      tunnelTarget = await resolveTarget(endpoint.hostId);
    }
    const cid = endpoint.containerInternalId;
    probeHttp = options.probeHttp ?? (() => probeHealthzViaTunnel(tunnelTarget!, cid, httpProbeMs));
    probeWs = options.probeWs ?? (() => probeWsUpgradeViaTunnel(tunnelTarget!, cid, wsProbeMs));
  }

  try {
    const deadline = now() + timeoutMs;
    // 第一次立即试,不等 interval
    while (true) {
      if (await probeHttp()) {
        if (await probeWs()) return true;
      }
      if (now() >= deadline) return false;
      await sleep(intervalMs);
      if (now() >= deadline) return false;
    }
  } finally {
    if (tunnelTarget?.psk) {
      try { tunnelTarget.psk.fill(0); } catch { /* */ }
    }
  }
}
