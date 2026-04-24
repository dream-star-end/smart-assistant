// WechatWorker — owns one binding's long-poll loop against ilinkai.weixin.qq.com.
//
// One worker per (oc_user_id, wechat_account_id) binding. Started/stopped by
// WechatManager. Responsible for:
//   1. POST /ilink/bot/getupdates long-poll with the persisted cursor
//   2. Parsing inbound msg batches → gateway.dispatch(InboundFrame)
//   3. Persisting context_token per sender so outbound replies can reach them
//   4. Session expiry (errcode/ret == -14) → clear cursor and retry
//   5. Network flakiness → exponential backoff 2s → 30s
//
// The worker does NOT do per-sender filtering or /bind whitelist enforcement —
// those policies live in the Manager/ChannelAdapter layer so they can be
// adjusted without bouncing the poll loop.

import type { ChannelContext } from '@openclaude/plugin-sdk'
import type { WechatBinding } from '@openclaude/storage'
import {
  updateWechatBindingCursor,
  updateWechatBindingStatus,
} from '@openclaude/storage'
import {
  extractIlinkText,
  getIlinkUpdates,
  ILINK_SESSION_EXPIRED,
  sendIlinkText,
} from './iLink.js'

export interface InboundEvent {
  binding: WechatBinding
  senderId: string // WeChat user id (from_user_id)
  text: string
  contextToken: string
  messageId: string // best-effort unique id from iLink (seq/message_id/client_id)
  raw: any
}

export type InboundHandler = (evt: InboundEvent) => void | Promise<void>

export interface WechatWorkerOpts {
  binding: WechatBinding
  ctx: ChannelContext
  onInbound: InboundHandler
}

export class WechatWorker {
  private binding: WechatBinding
  private readonly ctx: ChannelContext
  private readonly onInbound: InboundHandler
  private stopFlag = false
  private loopPromise: Promise<void> | null = null
  /**
   * true 仅在 loop 实际运行时(auth 过期 / getupdates 不可恢复 / loop 内未捕获异常
   * 导致 loop 自然结束时立即翻 false)。manager.isWorkerRunning() 读这个标志,
   * 避免 worker crash 后 workers.has() 仍 true 误导 UI"通道 healthy"。
   */
  private running = false
  private contextTokens: Record<string, string>

  constructor(opts: WechatWorkerOpts) {
    this.binding = opts.binding
    this.ctx = opts.ctx
    this.onInbound = opts.onInbound
    this.contextTokens = { ...(opts.binding.contextTokens || {}) }
  }

  get userId(): string {
    return this.binding.userId
  }
  get accountId(): string {
    return this.binding.accountId
  }
  get loginUserId(): string {
    return this.binding.loginUserId
  }
  get whitelist(): string[] {
    return this.binding.whitelist
  }
  get botToken(): string {
    return this.binding.botToken
  }

  /** Look up the last-seen context_token for a sender (needed to send replies). */
  getContextToken(senderId: string): string | undefined {
    return this.contextTokens[senderId]
  }

  /**
   * Refresh in-memory binding snapshot (e.g. whitelist updates).
   *
   * Race-safety: the poll loop mutates `this.contextTokens` in place as new
   * messages arrive, and also persists it. The reconcile path re-reads the
   * binding row from DB which may be STALE relative to in-memory tokens
   * (e.g. we just learned a new sender's context_token but haven't flushed
   * yet). We must NOT overwrite — merge the DB snapshot under any tokens the
   * loop has already learned so we don't lose the ability to reply.
   *
   * SINGLE-WRITER ASSUMPTION: this works because exactly one gateway process
   * owns each binding (personal edition, one worker instance per userId). If
   * we ever run multiple gateway replicas against the same DB, in-memory
   * tokens of a stale replica would incorrectly shadow fresh DB values
   * written by the active replica. Multi-gateway HA would require token
   * versioning or leader-election before enabling.
   */
  updateBinding(next: WechatBinding): void {
    this.binding = next
    const dbTokens = next.contextTokens || {}
    for (const [k, v] of Object.entries(dbTokens)) {
      if (!this.contextTokens[k]) this.contextTokens[k] = v
    }
  }

  async sendText(toUserId: string, text: string): Promise<void> {
    const ctxToken = this.contextTokens[toUserId]
    if (!ctxToken) {
      this.ctx.log.error(`[wechat:${this.userId}] no context_token for sender ${toUserId}, cannot reply`)
      return
    }
    try {
      const resp = await sendIlinkText(this.binding.botToken, toUserId, ctxToken, text)
      const errcode = Number(resp?.errcode || 0)
      const ret = Number(resp?.ret || 0)
      if (ret !== 0 || errcode !== 0) {
        this.ctx.log.error(
          `[wechat:${this.userId}] sendmessage failed ret=${ret} errcode=${errcode} errmsg=${resp?.errmsg}`,
        )
      }
    } catch (err: any) {
      this.ctx.log.error(`[wechat:${this.userId}] sendmessage exception: ${err?.message || err}`)
    }
  }

  start(): void {
    if (this.loopPromise) return
    this.stopFlag = false
    this.running = true
    this.loopPromise = this.loop()
      .catch((err) => {
        this.ctx.log.error(`[wechat:${this.userId}] worker crashed: ${err?.message || err}`)
      })
      .finally(() => {
        // loop 自然结束(auth expired break / getupdates 不可恢复)或异常退出时
        // 立即翻回 false,让 manager.isWorkerRunning() 如实汇报"通道已停"。
        this.running = false
      })
  }

  /** 真正在跑吗?workers.has() + running + !stopFlag 三段守卫,任一 false 即 UI 给 danger。 */
  isRunning(): boolean {
    return this.running && !this.stopFlag
  }

  async stop(): Promise<void> {
    this.stopFlag = true
    if (this.loopPromise) await this.loopPromise
    this.loopPromise = null
  }

  private async loop(): Promise<void> {
    let buf = this.binding.getUpdatesBuf || ''
    let retryMs = 2_000
    this.ctx.log.info(
      `[wechat:${this.userId}] worker start account=${this.accountId} loginUser=${this.loginUserId}`,
    )

    while (!this.stopFlag) {
      let resp: any
      try {
        resp = await getIlinkUpdates(this.binding.botToken, buf)
      } catch (err: any) {
        if (this.stopFlag) break
        this.ctx.log.error(
          `[wechat:${this.userId}] getupdates failed: ${err?.message || err}; retry in ${retryMs}ms`,
        )
        await sleep(retryMs)
        retryMs = Math.min(retryMs * 2, 30_000)
        continue
      }
      retryMs = 2_000

      const errcode = Number(resp?.errcode || 0)
      const ret = Number(resp?.ret || 0)
      if (errcode === ILINK_SESSION_EXPIRED || ret === ILINK_SESSION_EXPIRED) {
        this.ctx.log.info(`[wechat:${this.userId}] session expired; clearing cursor`)
        buf = ''
        try { await updateWechatBindingCursor(this.userId, '') } catch {}
        await sleep(5_000)
        continue
      }
      if (ret !== 0 || errcode !== 0) {
        this.ctx.log.error(
          `[wechat:${this.userId}] getupdates ret=${ret} errcode=${errcode} errmsg=${resp?.errmsg}`,
        )
        // Hard-fatal auth errors: mark binding expired and stop worker.
        if (errcode === 40001 || errcode === 40014 || ret === 40001 || ret === 40014) {
          try { await updateWechatBindingStatus(this.userId, 'expired') } catch {}
          this.ctx.log.error(`[wechat:${this.userId}] auth token invalid; marking expired and exiting`)
          break
        }
        await sleep(5_000)
        continue
      }

      const nextBuf = String(resp?.get_updates_buf || '').trim()
      const msgs: any[] = Array.isArray(resp?.msgs) ? resp.msgs : []

      let ctxDirty = false
      for (const msg of msgs) {
        const senderId = String(msg?.from_user_id || '').trim()
        const contextToken = String(msg?.context_token || '').trim()
        const text = extractIlinkText(msg)
        if (contextToken && senderId) {
          if (this.contextTokens[senderId] !== contextToken) {
            this.contextTokens[senderId] = contextToken
            ctxDirty = true
          }
        }
        if (!senderId || !contextToken) continue

        // Idempotency key must be STABLE across retries — if iLink gives us
        // no seq/message_id/client_id we have no way to deduplicate, so drop
        // the message rather than fabricate a Date.now() id that would let
        // the gateway dispatch the same user text twice on redelivery.
        const idSrc = msg?.seq ?? msg?.message_id ?? msg?.client_id
        if (idSrc === undefined || idSrc === null || String(idSrc).trim() === '') {
          this.ctx.log.error(
            `[wechat:${this.userId}] drop msg with no stable id from=${senderId}`,
          )
          continue
        }
        const messageId = String(idSrc)
        try {
          await this.onInbound({
            binding: this.binding,
            senderId,
            text,
            contextToken,
            messageId,
            raw: msg,
          })
        } catch (err: any) {
          this.ctx.log.error(`[wechat:${this.userId}] onInbound handler failed: ${err?.message || err}`)
        }
      }

      if (nextBuf || ctxDirty) {
        buf = nextBuf || buf
        try {
          await updateWechatBindingCursor(this.userId, buf, ctxDirty ? this.contextTokens : undefined)
        } catch (err: any) {
          this.ctx.log.error(`[wechat:${this.userId}] cursor persist failed: ${err?.message || err}`)
        }
      }
    }
    this.ctx.log.info(`[wechat:${this.userId}] worker stopped`)
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
