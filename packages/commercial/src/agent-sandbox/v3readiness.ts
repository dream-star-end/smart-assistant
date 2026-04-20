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
 * 与 v3ensureRunning.ts 的关系:
 *   - 3D 已经做了 HTTP /healthz 轮询(只 HTTP);3E 替换成 waitContainerReady,
 *     里面跑两道 probe。3D 的 EnsureRunningOptions 仍然向后兼容
 *     (probeHealthz 保留覆盖路径,新增 probeWsUpgrade 覆盖路径)。
 *   - 探活语义不变:超时返 false,caller 决定 ContainerUnreadyError(retryAfter, reason)。
 *
 * 不在本文件管:
 *   - readiness 失败时是否要 docker stop / 标 vanish — caller(3F idle sweep)决定
 *   - WS 客户端的 jwtSecret / 真协议 — bridge(2E)管;readiness 只验证 upgrade 握手
 *
 * 设计取舍:
 *   - WS probe 用 `ws` 库构造 client,connect ws://host:port/ws,await open / error。
 *     不发 message,不带 token(personal-version /ws 在 connection 事件里做 auth,
 *     但 upgrade 阶段不阻;upgrade 成功 = ws server 已 attach,这就是我们要的)。
 *   - HTTP probe 与 WS probe 串行(便宜的先,贵的后):/healthz 都没起来,显然
 *     ws 也不可能起来,跳过 ws probe 直接 false,省一次 socket 开销。
 */

import { request as httpRequest } from "node:http";
import { WebSocket } from "ws";

/** 默认 readiness 总超时(ms)。容器从 docker start 到 npm run gateway 完整 listen 一般 3-8s,留 10s 余量。 */
export const DEFAULT_READINESS_TIMEOUT_MS = 10_000;

/** 默认轮询间隔(ms)。200ms 抓得到瞬态 ready 又不打满 docker 桥接。 */
export const DEFAULT_READINESS_INTERVAL_MS = 200;

/** 默认单次 HTTP /healthz probe 超时(ms)。 */
export const DEFAULT_HTTP_PROBE_MS = 1_000;

/** 默认单次 WS upgrade probe 超时(ms)。upgrade 握手很快,1s 给充裕余量。 */
export const DEFAULT_WS_PROBE_MS = 1_500;

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

export interface WaitContainerReadyOptions {
  /** 总超时,默认 10s */
  timeoutMs?: number;
  /** 轮询间隔,默认 200ms */
  intervalMs?: number;
  /** 单次 HTTP /healthz probe 超时,默认 1s */
  httpProbeMs?: number;
  /** 单次 WS upgrade probe 超时,默认 1.5s */
  wsProbeMs?: number;
  /** 测试钩子:覆盖 HTTP probe(默认走 probeHealthzHttp) */
  probeHttp?: (host: string, port: number) => Promise<boolean>;
  /** 测试钩子:覆盖 WS probe(默认走 probeWsUpgrade) */
  probeWs?: (host: string, port: number) => Promise<boolean>;
  /** 测试钩子:覆盖 sleep(默认 setTimeout) */
  sleep?: (ms: number) => Promise<void>;
  /** 测试钩子:覆盖 now(默认 Date.now) */
  now?: () => number;
}

/**
 * 轮询 HTTP + WS probe 直至两条都过或超时。
 *
 * 单次循环:
 *   1. probeHttp(host, port) — 没过 → 这一轮 fail,等下一轮(WS 都不试,省开销)
 *   2. probeWs(host, port)   — 没过 → 这一轮 fail,等下一轮
 *   3. 都过 → return true
 *
 * 任何一道连续 fail 直到 deadline 都返 false(不抛)。caller 决定 ContainerUnreadyError 语义。
 */
export async function waitContainerReady(
  host: string,
  port: number,
  options: WaitContainerReadyOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_READINESS_INTERVAL_MS;
  const httpProbeMs = options.httpProbeMs ?? DEFAULT_HTTP_PROBE_MS;
  const wsProbeMs = options.wsProbeMs ?? DEFAULT_WS_PROBE_MS;
  const probeHttp =
    options.probeHttp ?? ((h, p) => probeHealthzHttp(h, p, httpProbeMs));
  const probeWs =
    options.probeWs ?? ((h, p) => probeWsUpgrade(h, p, wsProbeMs));
  const sleep =
    options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;

  const deadline = now() + timeoutMs;
  // 第一次立即试,不等 interval
  while (true) {
    if (await probeHttp(host, port)) {
      if (await probeWs(host, port)) return true;
    }
    if (now() >= deadline) return false;
    await sleep(intervalMs);
    if (now() >= deadline) return false;
  }
}
