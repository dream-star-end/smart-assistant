/**
 * V3 Phase 3E++ — userChatBridge 的"经 node-agent tunnel 拉容器 WS"工厂。
 *
 * 拓扑:
 *   master ──mTLS+PSK──▶ node-agent :9443
 *                           /tunnel/containers/<cid>/ws?port=<containerPort>
 *                                ──websocket upgrade──▶ remote docker bridge
 *                                                       └▶ 容器内 OpenClaude /ws
 *
 * 历史 bug(2026-04-26):bridge 默认 createContainerSocket 直接拨
 *   `ws://${boundIp}:${port}/ws`,但 remote-host 容器的 boundIp(如
 *   `172.30.2.10`)只在远端节点 docker bridge 上有意义,master 必然 EHOSTUNREACH。
 *   readiness 已经走 tunnel 修过(probeHealthzViaTunnel/probeWsUpgradeViaTunnel),
 *   bridge 这条路一直漏掉 → 用户看到"连上几秒就 4503 重连"。
 *
 * 设计要点:
 *   - PRE-DIAL:本函数 await 完 `dialNodeAgentVerifiedTls`(CA + SPIFFE URI + 指纹 pin
 *     全过)才返回 ws 客户端。PSK Authorization 头由 ws 库在自家 GET 请求行之后
 *     一并写出,绝不会在 cert 校验完成前上线。避免 sync createConnection + 异步
 *     verify 的 TOCTOU 风险。
 *   - createConnection 单次消费:使用 `consumed` 闭包标志保护,防止 ws 在异常路径
 *     上重用同一 socket。
 *   - signal:dial 阶段 abort → throw + destroy;dial 完成后 abort → destroy ws
 *     立即触发其 'error'/'close' 给上层走清理。
 *   - 不在日志/错误里打 target/psk:只暴露 hostId/containerId 用于排障。
 */

import type { TLSSocket } from "node:tls";
import { WebSocket } from "ws";

import {
  dialNodeAgentVerifiedTls,
  type NodeAgentTarget,
} from "../compute-pool/nodeAgentClient.js";

export interface CreateTunnelContainerSocketOpts {
  /** 单帧上限,透传给 ws Receiver/Sender;沿用 bridge 的 maxFrameBytes。 */
  maxFrameBytes: number;
  /** WS upgrade 握手超时 ms,默认 5000。connect 已经在 dial 阶段完成,这只算 ws 自身 handshake。 */
  handshakeTimeoutMs?: number;
}

/**
 * thrown when caller passes a bad container port.
 * 不用 generic Error 是为了让上层好辨识(不当作 EHOSTUNREACH 类故障重试)。
 */
export class InvalidTunnelArgsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTunnelArgsError";
  }
}

/**
 * 用 node-agent tunnel 建一个 client WebSocket 到容器的 /ws。
 *
 * 失败路径(均 reject 返回):
 *   - signal 已 abort(dial 前)→ AbortError
 *   - dialNodeAgentVerifiedTls 抛 → 透传(AgentUnreachableError / CertVerifyError)
 *   - dial 完成后 signal abort → 已 destroy 的 socket 会让 ws 立即 'error'
 *
 * 注意:即使 await 期间 user 关闭了 userWs,我们仍要清理预拨的 socket;
 *   abort 会触发 onAbort → socket.destroy。
 */
export async function createTunnelContainerSocket(
  target: NodeAgentTarget,
  containerInternalId: string,
  containerPort: number,
  signal: AbortSignal,
  opts: CreateTunnelContainerSocketOpts,
): Promise<WebSocket> {
  if (
    !Number.isInteger(containerPort) ||
    containerPort <= 0 ||
    containerPort > 65535
  ) {
    throw new InvalidTunnelArgsError(
      `invalid containerPort: ${containerPort}`,
    );
  }
  if (!containerInternalId) {
    throw new InvalidTunnelArgsError("containerInternalId is empty");
  }
  if (signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  // pre-dial:全部安全检查(CA + SPIFFE URI + 指纹 pin)在此 await 内完成。
  // dial 期间 abort:先转换 reject,然后 finally 段销毁 socket。
  let preDialed: TLSSocket;
  const onAbortDuringDial = (): void => {
    // dial Promise 内部已注册了 error/close listener,这里没法直接中断 tlsConnect
    // 已在飞的握手;但 caller 一旦走完 await 就会感知 abort,然后我们走下面的清理。
    // 用空 listener 占位避免 unhandled "abort" 错;真正的 destroy 在 await 完成后。
  };
  signal.addEventListener("abort", onAbortDuringDial, { once: true });
  try {
    preDialed = await dialNodeAgentVerifiedTls(target);
  } finally {
    signal.removeEventListener("abort", onAbortDuringDial);
  }
  if (signal.aborted) {
    try { preDialed.destroy(); } catch { /* */ }
    throw new DOMException("aborted", "AbortError");
  }

  // ws 库通过 createConnection 拿这个 socket。Node http 看到 socket.writable=true
  // 会立刻 _flush() 把 GET ... HTTP/1.1 + Upgrade headers + Authorization 写出去 ——
  // 此时 PSK 才上线,而 cert pin 早已在 dial 阶段完成。
  let consumed = false;
  const createConnection = (): TLSSocket => {
    if (consumed) {
      // 防御:ws 异常路径若重试创建 connection,绝不复用已交付的 socket。
      throw new Error("createTunnelContainerSocket: socket already consumed");
    }
    consumed = true;
    return preDialed;
  };

  const cid = encodeURIComponent(containerInternalId);
  // url 的 host:port 实际不会被用来开新 TLS(我们 hijack 了 createConnection),
  // 但 ws 用它来组 'GET <pathname>?<search> HTTP/1.1' 请求行,所以路径必须是
  // node-agent 的 tunnel route。
  const url =
    `wss://${target.host}:${target.agentPort}` +
    `/tunnel/containers/${cid}/ws?port=${containerPort}`;

  // PSK Buffer → hex string 是一次内存 copy(.toString 不持有原 Buffer 引用)。
  // 拷贝完立即 fill(0) 清原 Buffer:hex 字符串还在 ws 内部 headers 对象里,但
  // 那是 V8 string,无法主动清(GC 回收)。匹配 readiness 的 finally fill(0) 模式,
  // 缩短 Buffer 在堆里的可见窗口,降低 heap-dump 时 PSK 暴露面。
  const headers: Record<string, string> = {};
  if (target.psk) {
    headers["Authorization"] = `Bearer ${target.psk.toString("hex")}`;
    try { target.psk.fill(0); } catch { /* */ }
  }

  // 防御:new WebSocket 同步抛错(URL 异常 / options 校验失败)→ preDialed
  // 还没移交给 ws 库,必须自己 destroy,避免 socket 半开 + listener 泄漏。
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, {
      createConnection,
      headers,
      perMessageDeflate: false,
      maxPayload: opts.maxFrameBytes,
      handshakeTimeout: opts.handshakeTimeoutMs ?? 5_000,
    });
  } catch (err) {
    if (!consumed) {
      try { preDialed.destroy(); } catch { /* */ }
    }
    throw err;
  }

  // dial 完成后 abort:让 ws 立即 'error'/'close',上层 bridge cleanup 接管。
  if (!signal.aborted) {
    const onAbortAfterConstruct = (): void => {
      try { ws.terminate(); } catch { /* */ }
    };
    signal.addEventListener("abort", onAbortAfterConstruct, { once: true });
    // ws 关闭时把监听摘掉(避免持有引用 → 长寿命 signal 的内存泄漏)
    const dropAbortListener = (): void => {
      signal.removeEventListener("abort", onAbortAfterConstruct);
    };
    ws.once("close", dropAbortListener);
    ws.once("error", dropAbortListener);
  } else {
    // 极小概率:await 完到这一行之间 abort 触发 → 立即 terminate
    try { ws.terminate(); } catch { /* */ }
  }

  return ws;
}
