/**
 * UXE-A1 — headless consumer helpers for userChatBridge.
 *
 * Kept out of userChatBridge.ts so the large-file ratchet stays green: drain
 * expiry may keep the container WS open while admitted/accepted dispatch
 * streams are still producing frames (frames continue to land in
 * client_session_live_frames and renew the lease). An online bridge for the
 * same uid+container that lands a frame for the same stream takes over.
 *
 * Resource bounds (same intent as the 120s drain ceiling):
 *   - only open dispatch streams go headless;
 *   - lifetime cap default 90min (= reconciler accepted-stuck floor);
 *   - in-process concurrency cap default 256; over the limit → drain closes;
 *   - LIMIT=0 disables headless; invalid env → defaults.
 */

import type { WebSocket } from "ws";
import { WebSocket as WsWebSocket } from "ws";
import type { Queryable } from "../dispatch/turnDispatchStore.js";
import { getDispatchByLogicalKey } from "../dispatch/turnDispatchStore.js";

export type HeadlessEndCause =
  | "client_close"
  | "container_close"
  | "container_error"
  | "container_unready"
  | "auth_failed"
  | "frame_too_big"
  | "binary_unsupported"
  | "backpressure"
  | "internal_error"
  | "shutdown";

export interface HeadlessConsumer {
  streams: ReadonlySet<string>;
  release(streamKey: string): void;
  end(cause: HeadlessEndCause): void;
}

export interface HeadlessBridgeLog {
  info?(msg: string, fields?: Record<string, unknown>): void;
  warn?(msg: string, fields?: Record<string, unknown>): void;
}

export type OpenDispatchStream = { sessionId: string; clientMessageId: string };

const DEFAULT_DISPATCH_HEADLESS_MAX_MS = 90 * 60_000;
const DEFAULT_DISPATCH_HEADLESS_LIMIT = 256;
const DEFAULT_DISPATCH_HEADLESS_CHECK_MS = 30_000;

function readPositiveEnvMs(key: string, fallback: number, min: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.trunc(n) : fallback;
}

export function readDispatchHeadlessMaxMs(): number {
  return readPositiveEnvMs("OC_DISPATCH_HEADLESS_MAX_MS", DEFAULT_DISPATCH_HEADLESS_MAX_MS, 50);
}

export function readDispatchHeadlessCheckMs(): number {
  return readPositiveEnvMs(
    "OC_DISPATCH_HEADLESS_CHECK_MS",
    DEFAULT_DISPATCH_HEADLESS_CHECK_MS,
    50,
  );
}

export function readDispatchHeadlessLimit(): number {
  return readPositiveEnvMs("OC_DISPATCH_HEADLESS_LIMIT", DEFAULT_DISPATCH_HEADLESS_LIMIT, 0);
}

export function headlessKey(uidKey: bigint, cid: number): string {
  return `${uidKey.toString()}:${cid}`;
}

export function dispatchStreamKey(sessionId: string, clientMessageId: string): string {
  return `${sessionId}\u0000${clientMessageId}`;
}

export type HeadlessRegistry = {
  readonly shutdown: boolean;
  readonly active: number;
  noteLiveStreamCovered(uidKey: bigint, cid: number, streamKey: string): void;
  addDrainingCheck(fn: () => void): void;
  removeDrainingCheck(fn: () => void): void;
  beginShutdown(): void;
  endAll(cause?: HeadlessEndCause): void;
  register(
    key: string,
    consumer: HeadlessConsumer,
    openHas: (streamKey: string) => boolean,
  ): void;
  unregister(key: string, consumer: HeadlessConsumer): void;
};

export function createHeadlessRegistry(): HeadlessRegistry {
  const headlessConsumers = new Map<string, Set<HeadlessConsumer>>();
  let headlessActive = 0;
  let headlessShutdown = false;
  const drainingChecks = new Set<() => void>();

  return {
    get shutdown() {
      return headlessShutdown;
    },
    get active() {
      return headlessActive;
    },
    noteLiveStreamCovered(uidKey, cid, streamKey) {
      const consumers = headlessConsumers.get(headlessKey(uidKey, cid));
      if (!consumers) return;
      for (const consumer of [...consumers]) consumer.release(streamKey);
    },
    addDrainingCheck(fn) {
      drainingChecks.add(fn);
    },
    removeDrainingCheck(fn) {
      drainingChecks.delete(fn);
    },
    beginShutdown() {
      headlessShutdown = true;
      for (const check of [...drainingChecks]) check();
    },
    endAll(cause: HeadlessEndCause = "shutdown") {
      for (const set of [...headlessConsumers.values()]) {
        for (const consumer of [...set]) consumer.end(cause);
      }
    },
    register(key, consumer, openHas) {
      // 同容器更早的 headless 桥若只盯着本桥也在盯的流,它已多余(容器对两条 WS 同发)。
      const peers = headlessConsumers.get(key);
      for (const older of peers ? [...peers] : []) {
        if ([...older.streams].every((s) => openHas(s))) older.end("client_close");
      }
      let set = headlessConsumers.get(key);
      if (!set) {
        set = new Set();
        headlessConsumers.set(key, set);
      }
      set.add(consumer);
      headlessActive += 1;
    },
    unregister(key, consumer) {
      const set = headlessConsumers.get(key);
      if (set?.delete(consumer)) {
        headlessActive -= 1;
        if (set.size === 0) headlessConsumers.delete(key);
      }
    },
  };
}

export type OpenStreamBook = {
  readonly size: number;
  hasOpen(): boolean;
  has(key: string): boolean;
  keys(): IterableIterator<string>;
  entries(): IterableIterator<[string, OpenDispatchStream]>;
  close(key: string): void;
  noteFrame(
    sessionId: string,
    clientMessageId: string,
    isFinal: boolean,
    headlessHeld: boolean,
  ): void;
  clear(): void;
};

export function createOpenStreamBook(opts: {
  capable: boolean;
  isShutdown: () => boolean;
  onClose: () => void;
}): OpenStreamBook {
  const open = new Map<string, OpenDispatchStream>();
  const closed = new Set<string>();
  const book: OpenStreamBook = {
    get size() {
      return open.size;
    },
    hasOpen() {
      return !opts.isShutdown() && open.size > 0;
    },
    has(key) {
      return open.has(key);
    },
    keys() {
      return open.keys();
    },
    entries() {
      return open.entries();
    },
    close(key) {
      closed.add(key);
      if (open.delete(key)) opts.onClose();
    },
    noteFrame(sessionId, clientMessageId, isFinal, headlessHeld) {
      if (!opts.capable) return;
      const key = dispatchStreamKey(sessionId, clientMessageId);
      if (isFinal) {
        book.close(key);
        return;
      }
      // headless 期不再认领新流:那是别的回合,归在线桥。
      if (headlessHeld || closed.has(key)) return;
      open.set(key, { sessionId, clientMessageId });
    },
    clear() {
      open.clear();
    },
  };
  return book;
}

export type TryEnterHeadlessArgs = {
  registry: HeadlessRegistry;
  streams: OpenStreamBook;
  capable: boolean;
  containerWs: WebSocket;
  uid: bigint;
  containerId: number;
  bridgeLog?: HeadlessBridgeLog | null;
  admittedCount: number;
  inflightCount: number;
  closeStream: (key: string) => void;
  cleanup: (cause: HeadlessEndCause, force: boolean) => void;
  expireDrain: (message: string) => void;
  setDrainTimer: (timer: ReturnType<typeof setTimeout>) => void;
  setCheckTimer: (timer: ReturnType<typeof setInterval>) => void;
  setHeadless: (c: HeadlessConsumer) => void;
  checkStreams: () => Promise<void>;
};

/**
 * drain 到期仍有 open dispatch 流 → 留着容器 WS 当 headless consumer。
 * drainTimer 换成寿命上限 timer,所以 cleanup() 的 drain 抢占语义(container_close/
 * error/shutdown/force 立即 final)原样适用;流清空走 checkDrainComplete 收尾。
 */
export function tryEnterHeadless(args: TryEnterHeadlessArgs): boolean {
  const {
    registry,
    streams,
    capable,
    containerWs,
    uid,
    containerId,
    bridgeLog,
    admittedCount,
    inflightCount,
    closeStream,
    cleanup,
    expireDrain,
    setDrainTimer,
    setCheckTimer,
    setHeadless,
    checkStreams,
  } = args;
  if (
    registry.shutdown ||
    !capable ||
    !streams.hasOpen() ||
    containerWs.readyState !== WsWebSocket.OPEN
  ) {
    return false;
  }
  const limit = readDispatchHeadlessLimit();
  if (registry.active >= limit) {
    bridgeLog?.warn?.("user-chat-bridge: headless limit reached, closing at drain timeout", {
      limit,
      ux_headless_active: registry.active,
      openStreams: streams.size,
    });
    return false;
  }
  const key = headlessKey(uid, containerId);
  const consumer: HeadlessConsumer = {
    streams: new Set(streams.keys()),
    release: (streamKey) => closeStream(streamKey),
    end: (endCause) => cleanup(endCause, true),
  };
  registry.register(key, consumer, (s) => streams.has(s));
  setHeadless(consumer);
  const maxMs = readDispatchHeadlessMaxMs();
  const drainTimer = setTimeout(
    () => expireDrain("user-chat-bridge: headless max lifetime"),
    maxMs,
  );
  drainTimer.unref?.();
  setDrainTimer(drainTimer);
  const checkTimer = setInterval(() => {
    void checkStreams();
  }, readDispatchHeadlessCheckMs());
  checkTimer.unref?.();
  setCheckTimer(checkTimer);
  bridgeLog?.info?.("user-chat-bridge: enter headless", {
    openStreams: streams.size,
    admittedCount,
    inflightCount,
    maxMs,
    ux_headless_active: registry.active,
  });
  void checkStreams();
  return true;
}

/** PG 是终态权威:流对应的 dispatch 已终态 / 转人工 / 不存在 → 放下。 */
export async function checkHeadlessDispatchStreams(args: {
  pool: Queryable;
  uid: bigint;
  streams: OpenStreamBook;
  headless: HeadlessConsumer | null;
  bridgeLog?: HeadlessBridgeLog | null;
  closeStream: (key: string) => void;
}): Promise<void> {
  const { pool, uid, streams, headless, bridgeLog, closeStream } = args;
  if (headless === null) return;
  for (const [key, stream] of [...streams.entries()]) {
    try {
      const row = await getDispatchByLogicalKey(pool, {
        userId: uid,
        sessionId: stream.sessionId,
        clientMessageId: stream.clientMessageId,
      });
      if (row === null || row.status === "terminal" || row.status === "manual_reconcile") {
        closeStream(key);
      }
    } catch (err) {
      bridgeLog?.warn?.("user-chat-bridge: headless dispatch check failed", { err });
    }
  }
}
