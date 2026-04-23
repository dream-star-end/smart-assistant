/**
 * T-63 — iLink 告警通道 worker。
 *
 * 职责:
 *   1. **Per-channel long-poll loop**:每个 active/pending 通道一个独立 loop,
 *      调 `getIlinkUpdates` 拿入站消息。收到消息 → 提取 `from_user_id + context_token`
 *      → `updateChannelInbound` 持久化。pending 通道一旦收到首条消息转 active。
 *   2. **Global dispatcher loop**:每 5s 扫 `admin_alert_outbox` 里 pending/failed
 *      的行,按 channel 聚合后调 `sendIlinkText` 投递,成功 markSent 失败 markFailed。
 *
 * 为什么两个 loop 分开:
 *   - long-poll 会阻塞 35s,如果和 dispatch 合一会拖延告警(比如 AllDown 要等 35s 才 send)
 *   - channel 数少(一人一个 admin 最多几条),Node 轻量 async loop 可 10+ 个
 *
 * 启动 / 停止:由 `admin/alerts.ts` 的 scheduler 统一管理。
 *
 * 单实例约定:
 *   - v3 生产目前单 gateway 进程,不担心两个 worker 并行 long-poll 同 channel。
 *   - 如果未来多实例,这里要加 DB advisory lock。MVP 留 TODO。
 */

import {
  getIlinkUpdates,
  sendIlinkText,
  extractIlinkText,
  ILINK_SESSION_EXPIRED,
} from "../../../channels/wechat/src/iLink.js";
import {
  listDispatchableChannels,
  loadChannelSecrets,
  markChannelError,
  markChannelSendSuccess,
  updateChannelBuf,
  updateChannelInbound,
  type AlertChannelRow,
} from "./alertChannels.js";
import {
  claimReadyAlerts,
  markFailed,
  markSent,
  skipPendingForChannel,
} from "./alertOutbox.js";

// ─── 配置 ─────────────────────────────────────────────────────────────

export interface IlinkWorkerOptions {
  /** dispatcher 扫 outbox 的间隔。默认 5s,下限 500ms。 */
  dispatchIntervalMs?: number;
  /** 刷新 channel 列表的间隔(用于检测新加 / 删除的 channel)。默认 30s。 */
  refreshChannelsIntervalMs?: number;
  /** long-poll 循环错误后回退时间。默认 10s 起,指数退避封顶 5min。 */
  pollBackoffMinMs?: number;
  pollBackoffMaxMs?: number;
  /** 如为 true,worker 不真正 fetch,只扫 outbox 走测试 sender(测试用)。 */
  disableLongPoll?: boolean;
  /** 替换真实 iLink 函数(测试用)。 */
  inject?: {
    sendIlinkText?: typeof sendIlinkText;
    getIlinkUpdates?: typeof getIlinkUpdates;
  };
  /** 错误回调;默认 console.warn。 */
  onError?: (scope: string, err: unknown) => void;
}

export interface IlinkWorkerHandle {
  stop(): Promise<void>;
  /** 测试:强制跑一次 dispatch tick。 */
  dispatchNow(): Promise<number>;
  /** 当前活跃 long-poll channel ids。 */
  activeChannels(): Set<string>;
}

export function startIlinkAlertWorker(opts: IlinkWorkerOptions = {}): IlinkWorkerHandle {
  const dispatchMs = Math.max(500, opts.dispatchIntervalMs ?? 5_000);
  const refreshMs = Math.max(5_000, opts.refreshChannelsIntervalMs ?? 30_000);
  const pollMin = Math.max(1_000, opts.pollBackoffMinMs ?? 10_000);
  const pollMax = Math.max(pollMin, opts.pollBackoffMaxMs ?? 300_000);
  const onError = opts.onError ?? ((scope, err) => {
    // eslint-disable-next-line no-console
    console.warn(`[admin/ilinkWorker] ${scope}:`, err);
  });

  const sendFn = opts.inject?.sendIlinkText ?? sendIlinkText;
  const getUpdatesFn = opts.inject?.getIlinkUpdates ?? getIlinkUpdates;

  let stopped = false;
  const channelLoops = new Map<string, AbortController>();

  // ── channel refresh loop ───────────────────────────────────────────
  const refreshTimer = setInterval(() => {
    if (stopped || opts.disableLongPoll) return;
    void syncChannelLoops();
  }, refreshMs);
  if (typeof refreshTimer.unref === "function") refreshTimer.unref();

  async function syncChannelLoops(): Promise<void> {
    try {
      const channels = await listDispatchableChannels();
      const desired = new Set<string>();
      for (const ch of channels) {
        if (ch.channel_type !== "ilink_wechat") continue;
        if (!ch.enabled) continue;
        if (ch.activation_status !== "active" && ch.activation_status !== "pending") continue;
        desired.add(ch.id);
      }
      // stop 离场的
      for (const [id, ctrl] of channelLoops.entries()) {
        if (!desired.has(id)) {
          ctrl.abort();
          channelLoops.delete(id);
          // 属于此 channel 的 pending outbox 也清掉
          try { await skipPendingForChannel(id); } catch (err) { onError("skipPending", err); }
        }
      }
      // start 新加的
      for (const id of desired) {
        if (!channelLoops.has(id)) {
          const ctrl = new AbortController();
          channelLoops.set(id, ctrl);
          void runChannelLongPoll(id, ctrl.signal);
        }
      }
    } catch (err) {
      onError("syncChannelLoops", err);
    }
  }

  // 启动时先同步一次
  if (!opts.disableLongPoll) {
    void syncChannelLoops();
  }

  async function runChannelLongPoll(channelId: string, signal: AbortSignal): Promise<void> {
    let backoff = pollMin;
    while (!stopped && !signal.aborted) {
      const secrets = await loadChannelSecrets(channelId).catch((err) => {
        onError(`loadSecrets[${channelId}]`, err);
        return null;
      });
      if (!secrets) {
        // 没凭据:等一会儿再试,可能刚 create 完还没 commit
        await sleep(backoff, signal);
        backoff = Math.min(pollMax, backoff * 2);
        continue;
      }
      let resp: Record<string, unknown>;
      try {
        resp = (await getUpdatesFn(secrets.botToken, secrets.getUpdatesBuf)) as Record<string, unknown>;
        backoff = pollMin; // 成功:重置退避
      } catch (err) {
        if (signal.aborted) return;
        onError(`getUpdates[${channelId}]`, err);
        await markChannelError(channelId, (err as Error)?.message ?? String(err)).catch(() => {});
        await sleep(backoff, signal);
        backoff = Math.min(pollMax, backoff * 2);
        continue;
      }

      // session expired
      // iLink /getupdates 错误码实际走 `errcode` 或 `ret` 字段(见
      // packages/channels/wechat/src/worker.ts:162-183 的范式),不是 ret_code/code。
      const errcode = Number((resp as { errcode?: number })?.errcode ?? 0);
      const ret = Number((resp as { ret?: number })?.ret ?? 0);
      if (errcode === ILINK_SESSION_EXPIRED || ret === ILINK_SESSION_EXPIRED) {
        await markChannelError(channelId, "iLink session expired (errcode=-14)", true).catch(() => {});
        // 会话过期 → 通道变 error,轮询退出,管理员需重新扫码
        return;
      }

      // parse updates
      try {
        await handleUpdates(channelId, resp, secrets.getUpdatesBuf);
      } catch (err) {
        onError(`handleUpdates[${channelId}]`, err);
      }
    }
  }

  async function handleUpdates(
    channelId: string,
    resp: Record<string, unknown>,
    currentBuf: string,
  ): Promise<void> {
    // iLink /getupdates 响应真实 schema(见 packages/channels/wechat/src/worker.ts:185-186):
    //   - 消息数组在 `msgs` 字段(不是 `updates`)
    //   - 新游标在 `get_updates_buf`;偶尔还会带 `sync_buf`,兜底从它取
    const rawNextBuf =
      typeof resp.get_updates_buf === "string" && resp.get_updates_buf.trim()
        ? (resp.get_updates_buf as string)
        : typeof (resp as { sync_buf?: unknown }).sync_buf === "string"
          ? ((resp as { sync_buf: string }).sync_buf)
          : "";
    const nextBuf = rawNextBuf.trim() || currentBuf;
    const msgs = Array.isArray((resp as { msgs?: unknown }).msgs)
      ? ((resp as { msgs: Array<Record<string, unknown>> }).msgs)
      : [];

    // 没入站消息 → 只刷 buf
    if (msgs.length === 0) {
      if (nextBuf !== currentBuf) {
        await updateChannelBuf(channelId, nextBuf).catch(() => {});
      }
      return;
    }

    // 取最后一条带 context_token 的 message 做激活;多条时 context_token 之间互相替代
    let lastCtx: { from: string; ctx: string } | null = null;
    for (const msg of msgs) {
      if (!msg || typeof msg !== "object") continue;
      const ctx = typeof (msg as { context_token?: unknown }).context_token === "string"
        ? String((msg as { context_token: string }).context_token).trim()
        : "";
      const from = typeof (msg as { from_user_id?: unknown }).from_user_id === "string"
        ? String((msg as { from_user_id: string }).from_user_id).trim()
        : "";
      if (!ctx || !from) continue;
      lastCtx = { from, ctx };
      // 把文本抽出来(可选:未来可做命令,例如发 /silence 1h 静默告警)
      const _text = extractIlinkText(msg);
      void _text;
    }

    if (lastCtx) {
      await updateChannelInbound(channelId, {
        contextToken: lastCtx.ctx,
        getUpdatesBuf: nextBuf,
        senderId: lastCtx.from,
      }).catch((err) => onError(`updateInbound[${channelId}]`, err));
    } else if (nextBuf !== currentBuf) {
      await updateChannelBuf(channelId, nextBuf).catch(() => {});
    }
  }

  // ── dispatch loop ─────────────────────────────────────────────────
  const dispatchTimer = setInterval(() => {
    if (stopped) return;
    void dispatchTick();
  }, dispatchMs);
  if (typeof dispatchTimer.unref === "function") dispatchTimer.unref();

  let dispatchInflight: Promise<number> | null = null;
  async function dispatchTick(): Promise<number> {
    if (dispatchInflight) return dispatchInflight;
    dispatchInflight = doDispatch().finally(() => { dispatchInflight = null; });
    return dispatchInflight;
  }

  async function doDispatch(): Promise<number> {
    let sent = 0;
    let ready: Awaited<ReturnType<typeof claimReadyAlerts>>;
    try {
      ready = await claimReadyAlerts(20);
    } catch (err) {
      onError("claimReady", err);
      return 0;
    }
    if (ready.length === 0) return 0;

    for (const row of ready) {
      if (stopped) break;
      if (!row.channel_id || !row.channel) {
        // channel 被删 / 不可用 → 标 failed 并留给 cron 清理
        await markFailed(row.id, "channel missing").catch(() => {});
        continue;
      }
      if (row.channel.channel_type !== "ilink_wechat") {
        // 未来的其他 channel_type 留给不同 sender;当前硬跳过
        await markFailed(row.id, `unsupported channel_type ${row.channel.channel_type}`).catch(() => {});
        continue;
      }
      if (!row.channel.enabled || row.channel.activation_status !== "active") {
        await markFailed(row.id, `channel not active (status=${row.channel.activation_status}, enabled=${row.channel.enabled})`).catch(() => {});
        continue;
      }
      const secrets = await loadChannelSecrets(row.channel_id).catch(() => null);
      if (!secrets || !secrets.contextToken || !secrets.targetSenderId) {
        await markFailed(row.id, "channel missing context_token/target_sender_id").catch(() => {});
        continue;
      }
      const text = formatOutboxText(row);
      try {
        const resp = await sendFn(secrets.botToken, secrets.targetSenderId, secrets.contextToken, text);
        const code = Number((resp as { ret_code?: number })?.ret_code ?? 0);
        if (code === ILINK_SESSION_EXPIRED) {
          await markChannelError(row.channel_id, "iLink session expired on send", true).catch(() => {});
          await markFailed(row.id, "session expired").catch(() => {});
          continue;
        }
        if (code !== 0 && code !== undefined && Number.isFinite(code) && code < 0) {
          await markFailed(row.id, `iLink ret_code=${code}`).catch(() => {});
          continue;
        }
        await markSent(row.id);
        await markChannelSendSuccess(row.channel_id).catch(() => {});
        sent++;
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        await markFailed(row.id, msg).catch(() => {});
        await markChannelError(row.channel_id, msg).catch(() => {});
      }
    }
    return sent;
  }

  return {
    async stop() {
      stopped = true;
      clearInterval(refreshTimer);
      clearInterval(dispatchTimer);
      for (const ctrl of channelLoops.values()) ctrl.abort();
      channelLoops.clear();
      if (dispatchInflight) {
        try { await dispatchInflight; } catch { /* */ }
      }
    },
    async dispatchNow() {
      return dispatchTick();
    },
    activeChannels() {
      return new Set(channelLoops.keys());
    },
  };
}

// ─── helpers ─────────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    }
  });
}

/**
 * 把一条 outbox 渲染成 WeChat 可读文本。
 * iLink 不支持富格式,直接发 plain text。为了可读性保留 markdown 原样(**bold**、代码等),
 * 用户在微信里看到的是原始字符,但信息足够。
 */
export function formatOutboxText(row: {
  event_type: string;
  severity: string;
  title: string;
  body: string;
  payload: Record<string, unknown>;
}): string {
  const sevTag = row.severity.toUpperCase();
  const time = new Date().toISOString().slice(0, 19).replace("T", " ");
  const base = `【${sevTag}】${row.title}\n${row.body}`;
  // 附加 event_type + 时间,便于 admin 对账
  return `${base}\n\n— event: ${row.event_type} @ ${time} UTC`;
}

// ─── QR bind flow(adminAlerts.ts 调用)──────────────────────────────

export { fetchIlinkQrcode, pollIlinkQrcodeStatus, extractConfirmed } from "../../../channels/wechat/src/iLink.js";
