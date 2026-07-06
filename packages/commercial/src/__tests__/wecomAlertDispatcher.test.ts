/**
 * 企业微信告警投递 dispatcher 单测(全依赖注入,无 PG / 无网络)。
 *
 * 覆盖:
 *   - claim 显式过滤 channel_type='wecom_bot'(消除 v3 类型无关 claim 的 split-brain)
 *   - 成功 → markSent + markChannelSendSuccess;transient 失败 → markFailed(不降级通道)
 *   - permanent(WecomPermanentError)→ markFailed + markChannelError('permanent')
 *   - per-channel 限速节流:超 ratePerMinute 的行本 tick 跳过(不 markSent/不 markFailed)
 *   - 非 active / secrets 缺失 → markFailed,不 send
 *
 * Run: npx tsx --test packages/commercial/src/__tests__/wecomAlertDispatcher.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  startWecomAlertDispatcher,
  type WecomDispatcherDeps,
} from '../admin/wecomAlertDispatcher.js'
import { WecomPermanentError } from '../admin/wecomAlertSender.js'
import type { OutboxDispatchRow } from '../admin/alertOutbox.js'
import type { ChannelSecrets } from '../admin/alertChannels.js'

function makeRow(id: string, channelId: string, over: Partial<OutboxDispatchRow> = {}): OutboxDispatchRow {
  return {
    id,
    event_type: 'account_pool.degraded',
    severity: 'warning',
    status: 'pending',
    title: 'provider degraded',
    body: 'detail body',
    payload: {},
    channel_id: channelId,
    attempts: 0,
    last_error: null,
    next_attempt_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    sent_at: null,
    channel: {
      id: channelId,
      channel_type: 'wecom_bot',
      label: 'ops-wecom',
      enabled: true,
      activation_status: 'active',
      has_context_token: false,
    },
    ...over,
  }
}

const SECRETS: ChannelSecrets = {
  botToken: 'webhook-key-abcdef123456',
  contextToken: null,
  getUpdatesBuf: '',
  targetSenderId: null,
  ilinkAccountId: null,
  tgChatId: null,
}

interface Spies {
  claimCalls: Array<{ limit: number; channelType?: string }>
  markSent: string[]
  markFailed: Array<{ id: string; err: string }>
  markChannelSendSuccess: string[]
  markChannelError: Array<{ id: string; err: string; kind?: string }>
  sent: Array<{ webhookKey: string; markdown: string }>
}

function buildDeps(
  rows: OutboxDispatchRow[],
  opts: {
    spies: Spies
    sendBehavior?: (input: { webhookKey: string; markdown: string }) => Promise<void>
    secrets?: ChannelSecrets | null
    now?: () => number
  },
): Partial<WecomDispatcherDeps> {
  const { spies } = opts
  // claim 首次返回 rows,之后返回空(避免 dispatchNow 被反复喂同一批)。
  let served = false
  return {
    claimReadyAlerts: async (limit: number, channelType?: string) => {
      spies.claimCalls.push({ limit, channelType })
      if (served) return []
      served = true
      return rows
    },
    loadChannelSecrets: async () => (opts.secrets === undefined ? SECRETS : opts.secrets),
    markSent: async (id) => {
      spies.markSent.push(String(id))
    },
    markFailed: async (id, err) => {
      spies.markFailed.push({ id: String(id), err })
    },
    markChannelSendSuccess: async (id) => {
      spies.markChannelSendSuccess.push(String(id))
    },
    markChannelError: async (id, err, kind) => {
      spies.markChannelError.push({ id: String(id), err, kind })
    },
    sendWecomAlert: async (input) => {
      spies.sent.push({ webhookKey: input.webhookKey, markdown: input.markdown })
      if (opts.sendBehavior) return opts.sendBehavior(input)
    },
    now: opts.now,
  }
}

function emptySpies(): Spies {
  return {
    claimCalls: [],
    markSent: [],
    markFailed: [],
    markChannelSendSuccess: [],
    markChannelError: [],
    sent: [],
  }
}

describe('startWecomAlertDispatcher', () => {
  it("claims with channel_type='wecom_bot' filter", async () => {
    const spies = emptySpies()
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      deps: buildDeps([], { spies }),
    })
    await d.dispatchNow()
    await d.stop()
    assert.equal(spies.claimCalls.length, 1)
    assert.equal(spies.claimCalls[0].channelType, 'wecom_bot')
  })

  it('success → markSent + markChannelSendSuccess + forwards webhook key & markdown', async () => {
    const spies = emptySpies()
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      deps: buildDeps([makeRow('1', 'ch-1')], { spies }),
    })
    const sent = await d.dispatchNow()
    await d.stop()
    assert.equal(sent, 1)
    assert.deepEqual(spies.markSent, ['1'])
    assert.deepEqual(spies.markChannelSendSuccess, ['ch-1'])
    assert.equal(spies.markFailed.length, 0)
    assert.equal(spies.sent.length, 1)
    assert.equal(spies.sent[0].webhookKey, SECRETS.botToken)
    assert.match(spies.sent[0].markdown, /provider degraded/)
    assert.match(spies.sent[0].markdown, /account_pool\.degraded/)
  })

  it('transient send failure → markFailed, channel NOT degraded', async () => {
    const spies = emptySpies()
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      deps: buildDeps([makeRow('1', 'ch-1')], {
        spies,
        sendBehavior: async () => {
          throw new Error('wecom errcode=45009: freq limit')
        },
      }),
    })
    const sent = await d.dispatchNow()
    await d.stop()
    assert.equal(sent, 0)
    assert.equal(spies.markSent.length, 0)
    assert.equal(spies.markFailed.length, 1)
    assert.equal(spies.markFailed[0].id, '1')
    assert.equal(spies.markChannelError.length, 0, 'transient must not degrade channel')
  })

  it('permanent send failure → markFailed + markChannelError(permanent)', async () => {
    const spies = emptySpies()
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      deps: buildDeps([makeRow('1', 'ch-1')], {
        spies,
        sendBehavior: async () => {
          throw new WecomPermanentError('wecom errcode=93000: invalid key')
        },
      }),
    })
    await d.dispatchNow()
    await d.stop()
    assert.equal(spies.markFailed.length, 1)
    assert.equal(spies.markChannelError.length, 1)
    assert.equal(spies.markChannelError[0].id, 'ch-1')
    assert.equal(spies.markChannelError[0].kind, 'permanent')
  })

  it('per-channel rate limit: only ratePerMinute sent this tick, rest skipped (not failed)', async () => {
    const spies = emptySpies()
    const fixedNow = 1_000_000
    const rows = [
      makeRow('1', 'ch-1'),
      makeRow('2', 'ch-1'),
      makeRow('3', 'ch-1'),
      makeRow('4', 'ch-1'),
      makeRow('5', 'ch-1'),
    ]
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      ratePerMinute: 2,
      claimLimit: 20,
      deps: buildDeps(rows, { spies, now: () => fixedNow }),
    })
    const sent = await d.dispatchNow()
    await d.stop()
    assert.equal(sent, 2, 'only 2 sent under rate cap')
    assert.equal(spies.markSent.length, 2)
    assert.equal(spies.markFailed.length, 0, 'throttled rows are NOT marked failed')
    assert.equal(spies.sent.length, 2)
  })

  it('separate channels have independent rate windows', async () => {
    const spies = emptySpies()
    const fixedNow = 2_000_000
    const rows = [makeRow('1', 'ch-A'), makeRow('2', 'ch-A'), makeRow('3', 'ch-B'), makeRow('4', 'ch-B')]
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      ratePerMinute: 1,
      deps: buildDeps(rows, { spies, now: () => fixedNow }),
    })
    const sent = await d.dispatchNow()
    await d.stop()
    // 1 per channel → ch-A 发 1(row1),ch-B 发 1(row3),各自余 1 条被限速跳过
    assert.equal(sent, 2)
    assert.equal(spies.markSent.length, 2)
    assert.equal(spies.markFailed.length, 0)
  })

  it('inactive channel → markFailed, no send', async () => {
    const spies = emptySpies()
    const row = makeRow('1', 'ch-1', {
      channel: {
        id: 'ch-1',
        channel_type: 'wecom_bot',
        label: 'ops',
        enabled: true,
        activation_status: 'error',
        has_context_token: false,
      },
    })
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      deps: buildDeps([row], { spies }),
    })
    await d.dispatchNow()
    await d.stop()
    assert.equal(spies.sent.length, 0)
    assert.equal(spies.markFailed.length, 1)
    assert.match(spies.markFailed[0].err, /not active/)
  })

  it('missing secrets → markFailed, no send', async () => {
    const spies = emptySpies()
    const d = startWecomAlertDispatcher({
      dispatchIntervalMs: 60_000,
      deps: buildDeps([makeRow('1', 'ch-1')], { spies, secrets: null }),
    })
    await d.dispatchNow()
    await d.stop()
    assert.equal(spies.sent.length, 0)
    assert.equal(spies.markFailed.length, 1)
    assert.match(spies.markFailed[0].err, /secrets unavailable/)
  })
})
