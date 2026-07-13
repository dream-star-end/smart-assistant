// controlListener.ts — VIP + 私有双 listener(RFC-v5-dual-master-cohort D3)。
//
// R1 B3 修订:每 slot 常驻**私有诊断控制口**(A=18896/B=18897),healthz/smoke/运维直达本 slot;
// **VIP=127.0.0.1:18894**(egress 唯一目标,零改动)只由 desired_control_slot 匹配的实例 bind。
// 二者共用同一 dispatcher handler(现 internalProxyServer 的请求处理闭包)。
//
// bind 纪律:
//   · 私有口:本 slot 的自检基础设施,必须起——bind 失败 fail-loud 拒起。
//   · VIP:仅 desired_control_slot==本 slot 时尝试;**只对 EADDRINUSE 重试**(2s 间隔,finalize
//     交接窗内旧 slot 尚未释放的正常路径),权限错误/非法地址/handler 初始化失败 fail-loud 拒起。
//   · 运行时监听 desired 变更:desired 不再是本 slot → 优雅 close VIP(in-flight 完成,不强断)。
//
// 基建版兼容:A slot + desired_control_slot='A'(seed)→ 启动即 bind 127.0.0.1:18894(与今日
// egress 控制口现状同)+ 新增私有口 18896。

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { DesiredWatch, Slot } from "./deployState.js";

export interface ControlAddress {
  host: string;
  port: number;
}

/** 私有诊断口静态映射(RFC §3:A=18896 / B=18897)。 */
export function privatePortForSlot(slot: Slot): number {
  return slot === "A" ? 18896 : 18897;
}

export const DEFAULT_VIP: ControlAddress = { host: "127.0.0.1", port: 18894 };

export interface ControlListenerOptions {
  slot: Slot;
  desiredWatch: DesiredWatch;
  /** 请求 dispatcher(复用 internalProxyServer 的 handler)。 */
  handler: (req: IncomingMessage, res: ServerResponse) => void;
  vip?: ControlAddress;
  /** 私有口地址;默认 127.0.0.1:privatePortForSlot(slot)。 */
  privateAddr?: ControlAddress;
  eaddrInUseRetryMs?: number;
  logger?: {
    info: (m: string, meta?: unknown) => void;
    warn: (m: string, meta?: unknown) => void;
    error: (m: string, meta?: unknown) => void;
  };
}

export interface ControlListener {
  /** bind 私有口(fail-loud);按 desired 决定是否 bind VIP(首次非 EADDRINUSE 错误 fail-loud)。 */
  start(): Promise<void>;
  close(): Promise<void>;
  status(): { privateBound: boolean; vipBound: boolean; vipDesired: boolean };
}

const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };

export function createControlListener(opts: ControlListenerOptions): ControlListener {
  const log = opts.logger ?? noopLogger;
  const vipAddr = opts.vip ?? DEFAULT_VIP;
  const privAddr = opts.privateAddr ?? { host: "127.0.0.1", port: privatePortForSlot(opts.slot) };
  const retryMs = opts.eaddrInUseRetryMs ?? 2_000;

  let privateServer: Server | null = null;
  let vipServer: Server | null = null;
  let vipBinding = false; // 正在尝试 bind(含 EADDRINUSE 重试中)
  let vipRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let unsubDesired: (() => void) | null = null;
  // VIP bind cancellation epoch(BLOCKER 3):releaseVip/close/desired 翻走时 ++,作废在途 bind。
  // ensureVip 起手冻结 myEpoch,listen 成功后若 epoch 已变(desired 在 bind 期间翻走)→ 立即
  // close 刚 bind 的 server、绝不发布 vipServer(否则 candidate 会带着不该有的 VIP 上线)。
  let vipEpoch = 0;

  function desiredIsSelf(): boolean {
    return opts.desiredWatch.current()?.desiredControlSlot === opts.slot;
  }

  function makeServer(): Server {
    return createServer((req, res) => {
      try {
        opts.handler(req, res);
      } catch (err) {
        log.error("[controlListener] handler threw", err);
        if (!res.headersSent) {
          try {
            res.statusCode = 500;
            res.end();
          } catch {
            /* socket gone */
          }
        }
      }
    });
  }

  /** bind 一个 server;区分 EADDRINUSE(可重试)与其它错误(fail-loud)。 */
  function bindOnce(server: Server, addr: ControlAddress): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        server.removeListener("error", onError);
        reject(err);
      };
      server.once("error", onError);
      server.listen(addr.port, addr.host, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });
  }

  function clearRetry(): void {
    if (vipRetryTimer) {
      clearTimeout(vipRetryTimer);
      vipRetryTimer = null;
    }
  }

  /**
   * 确保 VIP 已 bind(desired==self 时)。firstAttempt=true 时非 EADDRINUSE 错误上抛(fail-loud);
   * 重试路径(firstAttempt=false)只处理 EADDRINUSE,其它错误 loud 记录并停止重试(等 desired 变更再触发)。
   */
  async function ensureVip(firstAttempt: boolean): Promise<void> {
    if (stopped || vipServer || vipBinding) return;
    if (!desiredIsSelf()) return;
    vipBinding = true;
    const myEpoch = vipEpoch; // 冻结:bind 期间 releaseVip/close/desired 翻走会 ++,使本次 bind 作废
    const server = makeServer();
    // 已 bind server 的运行时错误:清状态 + 重建(而非只 log)——见 handleVipRuntimeError。
    server.on("error", (err) => handleVipRuntimeError(server, err));
    try {
      await bindOnce(server, vipAddr);
      // ⑤ listen 成功后 re-check:epoch 变了(desired 在 bind 期间翻走 / 已 release)或不再 desired
      //    → 立即 close 刚 bind 的 server,不发布 vipServer(否则 candidate 误带 VIP 上线)。
      if (stopped || myEpoch !== vipEpoch || !desiredIsSelf()) {
        vipBinding = false;
        try {
          server.close();
        } catch {
          /* ignore */
        }
        log.info(`[controlListener] VIP bind 完成但 desired 已翻走/被取消,丢弃(slot=${opts.slot})`);
        return;
      }
      vipServer = server;
      vipBinding = false;
      log.info(`[controlListener] VIP bound ${vipAddr.host}:${vipAddr.port}(slot=${opts.slot})`);
    } catch (err) {
      vipBinding = false;
      try {
        server.close();
      } catch {
        /* ignore */
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        // 交接窗:旧 slot 尚持 VIP → 2s 后重试(desired 仍=self 且未被取消时)。
        log.warn(`[controlListener] VIP ${vipAddr.port} EADDRINUSE,${retryMs}ms 后重试(交接窗)`);
        scheduleVipRetry(myEpoch);
        return;
      }
      // 非 EADDRINUSE:权限/非法地址/handler 初始化失败。
      if (firstAttempt) {
        // 启动首绑失败 = 配置错误 → fail-loud 拒起。
        throw new Error(`[controlListener] VIP bind ${vipAddr.host}:${vipAddr.port} 失败(${code}):fail-closed 拒起`);
      }
      log.error("[controlListener] VIP bind 非 EADDRINUSE 错误,停止重试等 desired 变更", err);
    }
  }

  /**
   * 已 bind 的 VIP server 运行时 error(bind 成功后 emit):不能只 log。清状态后按 desired 决定
   * 重建或放弃(desired 仍 self → 重 bind;否则 release)。非当前 vipServer 的陈旧事件忽略。
   */
  function handleVipRuntimeError(server: Server, err: unknown): void {
    if (server !== vipServer) {
      // 陈旧(已被 release/替换)server 的迟到 error;bind 期间的 error 走 bindOnce 的 reject。
      log.warn("[controlListener] 陈旧 VIP server runtime error(忽略)", err);
      return;
    }
    log.error("[controlListener] 已 bind 的 VIP server runtime error → 清状态并重建", err);
    vipServer = null;
    vipBinding = false;
    vipEpoch++; // 作废任何在途 bind
    try {
      server.close();
    } catch {
      /* ignore */
    }
    if (!stopped && desiredIsSelf()) {
      void ensureVip(false);
    }
  }

  function scheduleVipRetry(atEpoch: number): void {
    if (stopped || vipRetryTimer) return;
    vipRetryTimer = setTimeout(() => {
      vipRetryTimer = null;
      // epoch 变了(重试等待期间 desired 翻走 / release)→ 放弃本次重试链。
      if (!stopped && !vipServer && atEpoch === vipEpoch && desiredIsSelf()) {
        void ensureVip(false);
      }
    }, retryMs);
    if (vipRetryTimer && typeof vipRetryTimer === "object" && "unref" in vipRetryTimer) {
      (vipRetryTimer as { unref: () => void }).unref();
    }
  }

  /** desired 不再是本 slot → 优雅 close VIP(in-flight 完成,不强断连接)+ 取消在途 bind(BLOCKER 3)。 */
  async function releaseVip(): Promise<void> {
    // ++epoch:作废任何 pending 的 bindOnce(它 listen 成功后会因 epoch 失配 self-close)。
    vipEpoch++;
    clearRetry();
    const server = vipServer;
    vipServer = null;
    vipBinding = false;
    if (!server) return;
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
    log.info(`[controlListener] VIP released ${vipAddr.host}:${vipAddr.port}(desired≠${opts.slot})`);
  }

  return {
    async start() {
      // 私有口:必须起(自检基础设施)。bind 失败任何原因都 fail-loud 拒起。
      privateServer = makeServer();
      privateServer.on("error", (err) => log.error("[controlListener] private runtime error", err));
      try {
        await bindOnce(privateServer, privAddr);
        log.info(`[controlListener] private bound ${privAddr.host}:${privAddr.port}(slot=${opts.slot})`);
      } catch (err) {
        try {
          privateServer.close();
        } catch {
          /* ignore */
        }
        privateServer = null;
        throw new Error(`[controlListener] 私有口 bind ${privAddr.host}:${privAddr.port} 失败:fail-closed 拒起 (${(err as Error).message})`);
      }

      // 首次 VIP:desired==self 时同步尝试(基建版 A slot 必须拿下 18894;非 EADDRINUSE 失败拒起)。
      await ensureVip(true);

      // 监听 desired 变更:翻到本 slot → 抢 VIP;翻走 → 优雅 release。
      unsubDesired = opts.desiredWatch.onChange((snap) => {
        if (stopped) return;
        if (snap.desiredControlSlot === opts.slot) {
          void ensureVip(false);
        } else {
          void releaseVip();
        }
      });
    },
    async close() {
      stopped = true;
      unsubDesired?.();
      unsubDesired = null;
      clearRetry();
      const servers = [vipServer, privateServer].filter((s): s is Server => s !== null);
      vipServer = null;
      privateServer = null;
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              try {
                s.close(() => resolve());
                const closeAll = (s as unknown as { closeAllConnections?: () => void }).closeAllConnections;
                if (typeof closeAll === "function") closeAll.call(s);
              } catch {
                resolve();
              }
            }),
        ),
      );
    },
    status: () => ({
      privateBound: privateServer !== null,
      vipBound: vipServer !== null,
      vipDesired: desiredIsSelf(),
    }),
  };
}
