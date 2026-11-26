/**
 * Model-based property tests for 4-pool billing ledger conservation,
 * waterfall priority (`org_period -> org_wallet -> period -> wallet`),
 * zero-charge on `upstream_failed`, and idempotent settle / refund replay.
 *
 * Drives real production billing modules:
 *   - `spendTwoBucket` (`packages/commercial/src/billing/spend.ts`)
 *   - `settleUsageAndLedger`, `makeFinalizer`, `startInflightJournal`,
 *     `claimInflightJournalForSettlement`, `finalizeInflightJournal`,
 *     `abortInflightJournal` (`packages/commercial/src/billing/proxyBilling.ts`)
 *   - `computeCost` (`packages/commercial/src/billing/calculator.ts`)
 *   - `applyTurnWaiver` (`packages/commercial/src/billing/refund.ts`)
 */
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import type { Pool, PoolClient, QueryResult } from 'pg'

import {
  type AsyncCommand,
  assertAsyncProperty,
  asyncModelRun,
  fc,
  resolvePbtRuns,
} from '../../../kernel/src/testing/propertyCheck.js'
import type { AccountScheduler } from '../account-pool/scheduler.js'
import type { Logger } from '../logging/logger.js'
import { computeCost } from '../billing/calculator.js'
import type { PreCheckRedis, ReservationHandle } from '../billing/preCheck.js'
import type { ModelPricing } from '../billing/pricing.js'
import {
  makeFinalizer,
  settleUsageAndLedger,
  startInflightJournal,
} from '../billing/proxyBilling.js'
import { applyTurnWaiver } from '../billing/refund.js'
import { spendTwoBucket } from '../billing/spend.js'

const PBT_RUNS = resolvePbtRuns(200, process.env.PBT_RUNS)

const TEST_PRICING: ModelPricing = {
  model_id: 'claude-sonnet-4-6',
  display_name: 'Claude Sonnet 4.6',
  input_per_mtok: 300_000n,
  output_per_mtok: 1_500_000n,
  cache_read_per_mtok: 30_000n,
  cache_write_per_mtok: 375_000n,
  multiplier: '1.000',
  enabled: true,
  sort_order: 0,
  visibility: 'public',
  extra_system_prompt: null,
  default_effort: null,
  updated_at: new Date('2026-11-26T00:00:00Z'),
}

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return NOOP_LOGGER
  },
} as unknown as Logger

const NOOP_REDIS: PreCheckRedis = {
  async eval() {
    return 1
  },
  async del() {
    return 1
  },
} as unknown as PreCheckRedis

const NOOP_SCHEDULER: AccountScheduler = {
  async release() {},
} as unknown as AccountScheduler

function makeTurnKey(tag: string): string {
  return createHash('sha256').update(tag).digest('hex')
}

interface OrgRow {
  id: string
  status: 'active' | 'suspended'
  credits: bigint
}
interface OrgSubRow {
  id: string
  orgId: string
  status: 'active' | 'expired'
  periodCredits: bigint
  periodStartMs: number
  periodEndMs: number
}
interface OrgMembershipRow {
  orgId: string
  userId: string
  status: 'active' | 'removed'
  billingEnabled: boolean
  monthlyOrgBudget: bigint | null
}
interface UserRow {
  id: string
  role: 'user' | 'admin'
  status: 'active' | 'suspended'
  credits: bigint
}
interface UserSubRow {
  id: string
  userId: string
  status: 'active' | 'expired'
  periodCredits: bigint
  periodStartMs: number
  periodEndMs: number
}
interface LedgerEntryRow {
  id: bigint
  userId: string
  orgId: string | null
  delta: bigint
  balanceAfter: bigint
  reason: string
  bucket: 'wallet' | 'period' | 'org_wallet' | 'org_period'
  refType: string | null
  refId: string | null
  memo: string | null
  createdAtMs: number
}
interface UsageRow {
  id: bigint
  userId: string
  requestId: string
  costCredits: bigint
  status: string
  ledgerId: bigint | null
  turnKey: string | null
  parentTurnKey: string | null
}
interface JournalRow {
  requestId: string
  userId: string
  state: 'inflight' | 'finalizing' | 'committed' | 'aborted'
  ctx: Record<string, unknown>
  finalCredits: bigint | null
  ledgerId: bigint | null
  usageId: bigint | null
  failureCode: string | null
}
interface TurnWaiverRow {
  id: bigint
  userId: string
  turnKey: string
  reason: string
  status: 'pending' | 'applied'
  refundedCredits: bigint
  recordCount: number
  inboxMessageId: string | null
}

interface BillingDbState {
  nowMs: number
  seq: bigint
  orgs: Map<string, OrgRow>
  orgSubs: Map<string, OrgSubRow>
  memberships: OrgMembershipRow[]
  users: Map<string, UserRow>
  userSubs: Map<string, UserSubRow>
  ledger: LedgerEntryRow[]
  usage: UsageRow[]
  journals: Map<string, JournalRow>
  waivers: Map<string, TurnWaiverRow>
  pendingPatches: Map<string, { costCredits: bigint }>
  inboxIds: bigint[]
}

function cloneDbState(s: BillingDbState): BillingDbState {
  return {
    nowMs: s.nowMs,
    seq: s.seq,
    orgs: new Map([...s.orgs.entries()].map(([k, v]) => [k, { ...v }])),
    orgSubs: new Map([...s.orgSubs.entries()].map(([k, v]) => [k, { ...v }])),
    memberships: s.memberships.map((m) => ({ ...m })),
    users: new Map([...s.users.entries()].map(([k, v]) => [k, { ...v }])),
    userSubs: new Map([...s.userSubs.entries()].map(([k, v]) => [k, { ...v }])),
    ledger: s.ledger.map((l) => ({ ...l })),
    usage: s.usage.map((u) => ({ ...u })),
    journals: new Map(
      [...s.journals.entries()].map(([k, v]) => [k, { ...v, ctx: { ...v.ctx } }]),
    ),
    waivers: new Map([...s.waivers.entries()].map(([k, v]) => [k, { ...v }])),
    pendingPatches: new Map([...s.pendingPatches.entries()].map(([k, v]) => [k, { ...v }])),
    inboxIds: [...s.inboxIds],
  }
}

/**
 * Faithful transactional in-memory PostgreSQL Pool implementing the exact SQL
 * statements issued by `spendTwoBucket`, `settleUsageAndLedger`, `makeFinalizer`,
 * and `applyTurnWaiver`.
 */
class InMemoryBillingPool {
  state: BillingDbState

  constructor(initial: {
    userId: string
    userWallet: bigint
    userPeriod: bigint
    userPeriodActive: boolean
    orgId: string
    orgActive: boolean
    orgWallet: bigint
    orgPeriod: bigint
    orgPeriodActive: boolean
    billingEnabled: boolean
    monthlyOrgBudget: bigint | null
  }) {
    const nowMs = Date.UTC(2026, 10, 26, 12, 0, 0)
    const periodStartMs = nowMs - 10 * 86_400_000
    const activeEndMs = nowMs + 20 * 86_400_000
    const expiredEndMs = nowMs - 1_000

    this.state = {
      nowMs,
      seq: 1n,
      orgs: new Map([
        [
          initial.orgId,
          {
            id: initial.orgId,
            status: initial.orgActive ? 'active' : 'suspended',
            credits: initial.orgWallet,
          },
        ],
      ]),
      orgSubs: new Map([
        [
          'org-sub-1',
          {
            id: 'org-sub-1',
            orgId: initial.orgId,
            status: 'active',
            periodCredits: initial.orgPeriod,
            periodStartMs,
            periodEndMs: initial.orgPeriodActive ? activeEndMs : expiredEndMs,
          },
        ],
      ]),
      memberships: [
        {
          orgId: initial.orgId,
          userId: initial.userId,
          status: 'active',
          billingEnabled: initial.billingEnabled,
          monthlyOrgBudget: initial.monthlyOrgBudget,
        },
      ],
      users: new Map([
        ['1', { id: '1', role: 'admin', status: 'active', credits: 0n }],
        [initial.userId, { id: initial.userId, role: 'user', status: 'active', credits: initial.userWallet }],
      ]),
      userSubs: new Map([
        [
          'user-sub-1',
          {
            id: 'user-sub-1',
            userId: initial.userId,
            status: 'active',
            periodCredits: initial.userPeriod,
            periodStartMs,
            periodEndMs: initial.userPeriodActive ? activeEndMs : expiredEndMs,
          },
        ],
      ]),
      ledger: [],
      usage: [],
      journals: new Map(),
      waivers: new Map(),
      pendingPatches: new Map(),
      inboxIds: [],
    }
  }

  asPgPool(): Pool {
    return {
      query: (sql: string, params?: unknown[]) => this.execOn(this.state, sql, params ?? []),
      connect: async () => this.makeClient(),
    } as unknown as Pool
  }

  makeClient(): PoolClient {
    let txState: BillingDbState | null = null
    let txAborted = false
    const client = {
      query: async (sql: string, params: unknown[] = []): Promise<QueryResult> => {
        const norm = sql.replace(/\s+/g, ' ').trim()
        if (norm === 'BEGIN') {
          txState = cloneDbState(this.state)
          txAborted = false
          return { rows: [], rowCount: 0 } as unknown as QueryResult
        }
        if (norm === 'COMMIT') {
          if (txState && !txAborted) {
            this.state = txState
          }
          txState = null
          txAborted = false
          return { rows: [], rowCount: 0 } as unknown as QueryResult
        }
        if (norm === 'ROLLBACK') {
          txState = null
          txAborted = false
          return { rows: [], rowCount: 0 } as unknown as QueryResult
        }
        if (txAborted) {
          const err = new Error('current transaction is aborted') as Error & { code?: string }
          err.code = '25P02'
          throw err
        }
        try {
          return await this.execOn(txState ?? this.state, sql, params)
        } catch (err) {
          if (txState) txAborted = true
          throw err
        }
      },
      release() {
        txState = null
        txAborted = false
      },
    }
    return client as unknown as PoolClient
  }

  private async execOn(
    db: BillingDbState,
    rawSql: string,
    params: unknown[],
  ): Promise<QueryResult> {
    const sql = rawSql.replace(/\s+/g, ' ').trim()
    const ok = (rows: unknown[] = [], rowCount = rows.length): QueryResult =>
      ({ rows, rowCount }) as unknown as QueryResult

    // Advisory locks
    if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
      return ok([{ pg_advisory_xact_lock: '' }], 1)
    }

    // resolveOrgBillingContext
    if (sql.includes('FROM org_memberships m JOIN orgs o')) {
      const uid = String(params[0])
      const m = db.memberships.find((row) => {
        if (row.userId !== uid || row.status !== 'active') return false
        const o = db.orgs.get(row.orgId)
        return o !== undefined && o.status === 'active'
      })
      if (!m) return ok([])
      return ok([
        {
          org_id: m.orgId,
          billing_enabled: m.billingEnabled,
          monthly_org_budget: m.monthlyOrgBudget === null ? null : m.monthlyOrgBudget.toString(),
        },
      ])
    }

    // sumMemberOrgMonthSpend
    if (sql.includes('SELECT COALESCE(SUM(-cl.delta), 0)::text AS spent FROM credit_ledger cl')) {
      const orgId = String(params[0])
      const uid = String(params[1])
      let sum = 0n
      for (const l of db.ledger) {
        if (
          l.orgId === orgId &&
          l.userId === uid &&
          (l.bucket === 'org_period' || l.bucket === 'org_wallet') &&
          l.delta < 0n
        ) {
          sum += -l.delta
        }
      }
      return ok([{ spent: sum.toString() }])
    }

    // SELECT 1 FROM orgs WHERE id = $1::bigint FOR ...
    if (sql.startsWith('SELECT 1 FROM orgs WHERE id = $1::bigint')) {
      const o = db.orgs.get(String(params[0]))
      return o ? ok([{ '?column?': 1 }]) : ok([])
    }

    // Lock org wallet (active only in spend, any status in refund)
    if (sql.startsWith('SELECT credits::text AS credits FROM orgs WHERE id')) {
      const o = db.orgs.get(String(params[0]))
      const requireActive = sql.includes("status = 'active'")
      if (!o || (requireActive && o.status !== 'active')) return ok([])
      return ok([{ credits: o.credits.toString() }])
    }

    // Lock org_subscriptions
    if (sql.includes('FROM org_subscriptions WHERE org_id')) {
      const oid = String(params[0])
      const sub = [...db.orgSubs.values()].find(
        (s) =>
          s.orgId === oid &&
          s.status === 'active' &&
          s.periodEndMs > db.nowMs &&
          (!sql.includes('period_start <= NOW()') || s.periodStartMs <= db.nowMs),
      )
      if (!sub) return ok([])
      return ok([
        {
          id: sub.id,
          period_credits: sub.periodCredits.toString(),
          period_start_us: (BigInt(sub.periodStartMs) * 1000n).toString(),
          period_end_us: (BigInt(sub.periodEndMs) * 1000n).toString(),
        },
      ])
    }

    // Lock users
    if (sql.startsWith('SELECT credits::text AS credits FROM users WHERE id')) {
      const u = db.users.get(String(params[0]))
      if (!u) return ok([])
      return ok([{ credits: u.credits.toString() }])
    }

    // readPersonalTotal in refund.ts
    if (sql.includes('SELECT (u.credits + COALESCE(( SELECT us.period_credits FROM user_subscriptions us')) {
      const uid = String(params[0])
      const u = db.users.get(uid)
      if (!u) return ok([])
      const sub = [...db.userSubs.values()].find(
        (s) => s.userId === uid && s.status === 'active' && s.periodEndMs > db.nowMs,
      )
      return ok([{ total: (u.credits + (sub?.periodCredits ?? 0n)).toString() }])
    }

    // Lock user_subscriptions
    if (sql.includes('FROM user_subscriptions WHERE user_id')) {
      const uid = String(params[0])
      const sub = [...db.userSubs.values()].find(
        (s) =>
          s.userId === uid &&
          s.status === 'active' &&
          s.periodEndMs > db.nowMs &&
          (!sql.includes('period_start <= NOW()') || s.periodStartMs <= db.nowMs),
      )
      if (!sub) return ok([])
      return ok([
        {
          id: sub.id,
          period_credits: sub.periodCredits.toString(),
          period_start_us: (BigInt(sub.periodStartMs) * 1000n).toString(),
          period_end_us: (BigInt(sub.periodEndMs) * 1000n).toString(),
        },
      ])
    }

    // Updates on 4 pools
    if (sql.startsWith('UPDATE org_subscriptions SET period_credits')) {
      const sub = db.orgSubs.get(String(params[1]))
      if (sub) sub.periodCredits = BigInt(String(params[0]))
      return ok([], sub ? 1 : 0)
    }
    if (sql.startsWith('UPDATE orgs SET credits')) {
      const o = db.orgs.get(String(params[1]))
      if (o) o.credits = BigInt(String(params[0]))
      return ok([], o ? 1 : 0)
    }
    if (sql.startsWith('UPDATE user_subscriptions SET period_credits')) {
      const sub = db.userSubs.get(String(params[1]))
      if (sub) sub.periodCredits = BigInt(String(params[0]))
      return ok([], sub ? 1 : 0)
    }
    if (sql.startsWith('UPDATE users SET credits')) {
      const u = db.users.get(String(params[1]))
      if (u) u.credits = BigInt(String(params[0]))
      return ok([], u ? 1 : 0)
    }

    // INSERT INTO credit_ledger (both spendTwoBucket 10-param and refund 7-param)
    if (sql.startsWith('INSERT INTO credit_ledger')) {
      const id = db.seq++
      if (sql.includes("'refund'")) {
        db.ledger.push({
          id,
          userId: String(params[0]),
          delta: BigInt(String(params[1])),
          balanceAfter: BigInt(String(params[2])),
          reason: 'refund',
          bucket: params[3] as LedgerEntryRow['bucket'],
          refType: 'usage_record',
          refId: String(params[4]),
          memo: params[5] ? String(params[5]) : null,
          orgId: params[6] ? String(params[6]) : null,
          createdAtMs: db.nowMs,
        })
      } else {
        db.ledger.push({
          id,
          userId: String(params[0]),
          delta: BigInt(String(params[1])),
          balanceAfter: BigInt(String(params[2])),
          reason: String(params[3]),
          bucket: params[4] as LedgerEntryRow['bucket'],
          refType: params[5] ? String(params[5]) : null,
          refId: params[6] ? String(params[6]) : null,
          memo: params[7] ? String(params[7]) : null,
          orgId: params[8] ? String(params[8]) : null,
          createdAtMs: db.nowMs,
        })
      }
      return ok([{ id: id.toString() }])
    }

    // request_finalize_journal operations
    if (sql.startsWith('INSERT INTO request_finalize_journal')) {
      const reqId = String(params[0])
      if (db.journals.has(reqId)) return ok([], 0)
      db.journals.set(reqId, {
        requestId: reqId,
        userId: String(params[1]),
        state: 'inflight',
        ctx: JSON.parse(String(params[3])),
        finalCredits: null,
        ledgerId: null,
        usageId: null,
        failureCode: null,
      })
      return ok([], 1)
    }
    if (sql.startsWith("UPDATE request_finalize_journal SET state='finalizing'")) {
      const reqId = String(params[0])
      const claimId = String(params[1])
      const j = db.journals.get(reqId)
      if (!j || j.state !== 'inflight') return ok([], 0)
      j.state = 'finalizing'
      j.ctx = { ...j.ctx, settlementClaimId: claimId }
      return ok([], 1)
    }
    if (sql.startsWith("UPDATE request_finalize_journal SET state='committed'")) {
      const reqId = String(params[0])
      const claimId = String(params[4])
      const j = db.journals.get(reqId)
      if (!j || j.state !== 'finalizing' || j.ctx.settlementClaimId !== claimId) return ok([], 0)
      j.state = 'committed'
      j.finalCredits = BigInt(String(params[1]))
      j.ledgerId = params[2] ? BigInt(String(params[2])) : null
      j.usageId = BigInt(String(params[3]))
      j.failureCode = null
      j.ctx.settlementClaimId = undefined
      return ok([], 1)
    }
    if (sql.startsWith("UPDATE request_finalize_journal SET state='aborted'")) {
      const reqId = String(params[0])
      const failureCode = String(params[2])
      const claimId = params[3] !== undefined ? String(params[3]) : undefined
      const j = db.journals.get(reqId)
      if (!j) return ok([], 0)
      if (claimId === undefined) {
        if (j.state !== 'inflight') return ok([], 0)
      } else {
        if (j.state !== 'finalizing' || j.ctx.settlementClaimId !== claimId) return ok([], 0)
      }
      j.state = 'aborted'
      j.finalCredits = 0n
      j.failureCode = failureCode
      j.ctx.settlementClaimId = undefined
      return ok([], 1)
    }

    // turn_waivers queries
    if (sql.startsWith('SELECT 1 FROM turn_waivers')) {
      const uid = String(params[0])
      const keys = params[1] as string[]
      const found = [...db.waivers.values()].some(
        (w) => w.userId === uid && keys.includes(w.turnKey),
      )
      return found ? ok([{ '?column?': 1 }]) : ok([])
    }
    if (sql.includes('FROM turn_waivers WHERE user_id = $1 AND turn_key = $2')) {
      const k = `${String(params[0])}:${String(params[1])}`
      const w = db.waivers.get(k)
      if (!w) return ok([])
      return ok([
        {
          id: w.id.toString(),
          reason: w.reason,
          status: w.status,
          refunded_credits: w.refundedCredits.toString(),
          record_count: w.recordCount,
          inbox_message_id: w.inboxMessageId,
        },
      ])
    }
    if (sql.startsWith('INSERT INTO turn_waivers')) {
      const uid = String(params[0])
      const turnKey = String(params[1])
      const reason = String(params[2])
      const id = db.seq++
      const row: TurnWaiverRow = {
        id,
        userId: uid,
        turnKey,
        reason,
        status: 'pending',
        refundedCredits: 0n,
        recordCount: 0,
        inboxMessageId: null,
      }
      db.waivers.set(`${uid}:${turnKey}`, row)
      return ok([
        {
          id: row.id.toString(),
          reason: row.reason,
          status: row.status,
          refunded_credits: '0',
          record_count: 0,
          inbox_message_id: null,
        },
      ])
    }
    if (sql.startsWith("UPDATE turn_waivers SET status='applied'")) {
      const wid = BigInt(String(params[0]))
      for (const w of db.waivers.values()) {
        if (w.id === wid && w.status === 'pending') {
          w.status = 'applied'
          w.refundedCredits = BigInt(String(params[1]))
          w.recordCount = Number(params[2])
          w.inboxMessageId = String(params[3])
          return ok([], 1)
        }
      }
      return ok([], 0)
    }

    // usage_records INSERT with UNIQUE (user_id, request_id)
    if (sql.startsWith('INSERT INTO usage_records')) {
      const uid = String(params[0])
      const requestId = String(params[13])
      const exists = db.usage.some((u) => u.userId === uid && u.requestId === requestId)
      if (exists) {
        const err = new Error(`duplicate key value violates unique constraint (${uid}, ${requestId})`) as Error & {
          code?: string
        }
        err.code = '23505'
        throw err
      }
      const id = db.seq++
      db.usage.push({
        id,
        userId: uid,
        requestId,
        costCredits: BigInt(String(params[9])),
        status: String(params[14]),
        ledgerId: null,
        turnKey: params[20] ? String(params[20]) : null,
        parentTurnKey: params[21] ? String(params[21]) : null,
      })
      return ok([{ id: id.toString() }])
    }
    if (sql.startsWith('UPDATE usage_records SET ledger_id=$1 WHERE id=$2')) {
      const uid = BigInt(String(params[1]))
      const row = db.usage.find((u) => u.id === uid)
      if (row) row.ledgerId = BigInt(String(params[0]))
      return ok([], row ? 1 : 0)
    }

    // loadSettledUsageAttribution
    if (sql.includes('FROM usage_records WHERE user_id=$1 AND request_id=$2')) {
      const uid = String(params[0])
      const reqId = String(params[1])
      const storageUid = String(params[2])
      const u = db.usage.find((row) => row.userId === uid && row.requestId === reqId)
      if (!u) return ok([])
      const patch = db.pendingPatches.get(`${storageUid}:${reqId}`)
      return ok([
        {
          id: u.id.toString(),
          ledger_id: u.ledgerId === null ? null : u.ledgerId.toString(),
          cost_credits: u.costCredits.toString(),
          attribution_credits: patch ? patch.costCredits.toString() : null,
        },
      ])
    }

    // pending_usage_patches
    if (sql.startsWith('INSERT INTO pending_usage_patches')) {
      const key = `${String(params[1])}:${String(params[0])}`
      if (db.pendingPatches.has(key)) return ok([], 0)
      db.pendingPatches.set(key, { costCredits: BigInt(String(params[7])) })
      return ok([], 1)
    }

    // Refund debit lookup
    if (sql.includes('FROM usage_records ur JOIN credit_ledger cl')) {
      const uid = String(params[0])
      const turnKey = String(params[1])
      const rows: Array<{
        usage_id: string
        bucket: string
        delta: string
        org_id: string | null
        debited_at_us: string
      }> = []
      for (const u of db.usage) {
        if (u.userId !== uid || u.status !== 'success') continue
        if (u.turnKey !== turnKey && u.parentTurnKey !== turnKey) continue
        const alreadyRefunded = db.ledger.some(
          (l) =>
            l.userId === uid &&
            l.reason === 'refund' &&
            l.refType === 'usage_record' &&
            l.refId === u.id.toString(),
        )
        if (alreadyRefunded) continue
        for (const cl of db.ledger) {
          if (
            cl.userId === uid &&
            cl.refType === 'usage_record' &&
            cl.refId === u.id.toString() &&
            cl.delta < 0n
          ) {
            rows.push({
              usage_id: u.id.toString(),
              bucket: cl.bucket,
              delta: cl.delta.toString(),
              org_id: cl.orgId,
              debited_at_us: (BigInt(cl.createdAtMs) * 1000n).toString(),
            })
          }
        }
      }
      return ok(rows)
    }

    // Refund lineage & receipt & session touch
    if (sql.includes('FROM client_session_turn_tapes t')) return ok([])
    if (sql.includes('FROM client_sessions cs')) return ok([])
    if (sql.startsWith('INSERT INTO inbox_messages')) {
      const id = db.seq++
      db.inboxIds.push(id)
      return ok([{ id: id.toString() }])
    }
    if (sql.startsWith('UPDATE client_sessions s')) return ok([], 0)

    throw new Error(`InMemoryBillingPool: unhandled SQL: ${sql}`)
  }

  poolTotals(userId: string, orgId: string): {
    orgPeriod: bigint
    orgWallet: bigint
    period: bigint
    wallet: bigint
    sumAll: bigint
  } {
    const orgPeriod = this.state.orgSubs.get('org-sub-1')?.periodCredits ?? 0n
    const orgWallet = this.state.orgs.get(orgId)?.credits ?? 0n
    const period = this.state.userSubs.get('user-sub-1')?.periodCredits ?? 0n
    const wallet = this.state.users.get(userId)?.credits ?? 0n
    return {
      orgPeriod,
      orgWallet,
      period,
      wallet,
      sumAll: orgPeriod + orgWallet + period + wallet,
    }
  }
}

describe('Property: 4-pool billing ledger conservation & idempotency', () => {
  it('spendTwoBucket enforces exact waterfall priority org_period -> org_wallet -> period -> wallet with zero drift', async () => {
    const scenarioArb = fc.record({
      orgActive: fc.boolean(),
      orgPeriodActive: fc.boolean(),
      userPeriodActive: fc.boolean(),
      orgPeriod: fc.bigInt({ min: 0n, max: 500_000n }),
      orgWallet: fc.bigInt({ min: 0n, max: 500_000n }),
      userPeriod: fc.bigInt({ min: 0n, max: 500_000n }),
      userWallet: fc.bigInt({ min: 0n, max: 500_000n }),
      monthlyBudget: fc.option(fc.bigInt({ min: 0n, max: 600_000n }), { freq: 3 }),
      amount: fc.bigInt({ min: 1n, max: 1_500_000n }),
    })

    await assertAsyncProperty(
      scenarioArb,
      async (s) => {
        const db = new InMemoryBillingPool({
          userId: '101',
          userWallet: s.userWallet,
          userPeriod: s.userPeriod,
          userPeriodActive: s.userPeriodActive,
          orgId: '501',
          orgActive: s.orgActive,
          orgWallet: s.orgWallet,
          orgPeriod: s.orgPeriod,
          orgPeriodActive: s.orgPeriodActive,
          billingEnabled: true,
          monthlyOrgBudget: s.monthlyBudget,
        })
        const before = db.poolTotals('101', '501')
        const client = db.makeClient()
        await client.query('BEGIN')
        const res = await spendTwoBucket(client, {
          userId: '101',
          orgId: '501',
          monthlyOrgBudget: s.monthlyBudget,
          amount: s.amount,
          reason: 'chat',
          ref: { type: 'usage_record', id: '1' },
        })
        await client.query('COMMIT')
        client.release()

        const after = db.poolTotals('101', '501')

        // 1. Non-negative invariant across every pool.
        assert.ok(after.orgPeriod >= 0n)
        assert.ok(after.orgWallet >= 0n)
        assert.ok(after.period >= 0n)
        assert.ok(after.wallet >= 0n)

        // 2. Exact conservation across pools and ledger rows.
        const poolDelta = before.sumAll - after.sumAll
        const ledgerNetOut = db.state.ledger.reduce((acc, row) => acc + -row.delta, 0n)
        assert.equal(res.debited, poolDelta, 'debited must equal sum of 4 pool reductions')
        assert.equal(res.debited, ledgerNetOut, 'debited must equal sum of negative ledger deltas')
        assert.equal(
          res.fromOrgPeriod + res.fromOrg + res.fromPeriod + res.fromWallet,
          res.debited,
        )

        // 3. Waterfall ordering invariant: org_period -> org_wallet -> period -> wallet.
        const orgPeriodAvailRaw = s.orgActive && s.orgPeriodActive ? s.orgPeriod : 0n
        const orgWalletAvailRaw = s.orgActive ? s.orgWallet : 0n
        const orgTotalAvail =
          s.monthlyBudget === null
            ? orgPeriodAvailRaw + orgWalletAvailRaw
            : orgPeriodAvailRaw + orgWalletAvailRaw < s.monthlyBudget
              ? orgPeriodAvailRaw + orgWalletAvailRaw
              : s.monthlyBudget
        const expOrgPeriodAvail =
          orgTotalAvail < orgPeriodAvailRaw ? orgTotalAvail : orgPeriodAvailRaw
        const expOrgWalletAvail = orgTotalAvail - expOrgPeriodAvail
        const expUserPeriodAvail = s.userPeriodActive ? s.userPeriod : 0n

        if (res.fromOrg > 0n) {
          assert.equal(
            res.fromOrgPeriod,
            expOrgPeriodAvail,
            'org_wallet must not be touched before org_period is exhausted',
          )
        }
        if (res.fromPeriod > 0n) {
          assert.equal(
            res.fromOrgPeriod + res.fromOrg,
            orgTotalAvail,
            'user period must not be touched before org pools are exhausted/capped',
          )
        }
        if (res.fromWallet > 0n) {
          assert.equal(
            res.fromPeriod,
            expUserPeriodAvail,
            'user wallet must not be touched before user period is exhausted',
          )
        }
        if (s.monthlyBudget !== null) {
          assert.ok(
            res.fromOrgPeriod + res.fromOrg <= s.monthlyBudget,
            'org spend must never exceed monthlyOrgBudget',
          )
        }
      },
      { numRuns: PBT_RUNS, seed: 0x11b1111, label: 'spendTwoBucket-waterfall-conservation' },
    )
  })

  it('stateful interleaved settle / upstream_failed / duplicate-retry / refund preserves conservation', async () => {
    interface Model {
      initialTotal: bigint
      totalTopUps: bigint
      settledRequests: Map<string, { turnKey: string; debited: bigint }>
      waivedTurns: Set<string>
      failedRequests: Set<string>
      nextReqSeq: number
    }
    interface Real {
      pool: InMemoryBillingPool
      pg: Pool
      userId: bigint
      orgId: string
      finalizers: Map<string, ReturnType<typeof makeFinalizer>>
    }

    const assertConservation = (m: Model, r: Real, context: string): void => {
      const totals = r.pool.poolTotals(r.userId.toString(), r.orgId)
      assert.ok(totals.orgPeriod >= 0n, `${context}: orgPeriod < 0`)
      assert.ok(totals.orgWallet >= 0n, `${context}: orgWallet < 0`)
      assert.ok(totals.period >= 0n, `${context}: period < 0`)
      assert.ok(totals.wallet >= 0n, `${context}: wallet < 0`)

      const ledgerNetDelta = r.pool.state.ledger.reduce((acc, row) => acc + row.delta, 0n)
      assert.equal(
        m.initialTotal + m.totalTopUps + ledgerNetDelta,
        totals.sumAll,
        `${context}: global conservation violated`,
      )
    }

    class SettleSuccessCmd implements AsyncCommand<Model, Real> {
      constructor(
        readonly turnSlot: number,
        readonly inputTokens: number,
        readonly outputTokens: number,
      ) {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        const reqId = `req-ok-${m.nextReqSeq++}`
        const turnKey = makeTurnKey(`turn-${this.turnSlot}`)
        const before = r.pool.poolTotals(r.userId.toString(), r.orgId)
        const ledgerBefore = r.pool.state.ledger.length

        const started = await startInflightJournal(r.pg, {
          requestId: reqId,
          userId: r.userId,
          containerId: 1n,
          model: TEST_PRICING.model_id,
          precheckCredits: 100n,
        })
        assert.equal(started, true)

        const reservation: ReservationHandle = {
          userId: r.userId.toString(),
          requestId: reqId,
        }
        const fin = makeFinalizer(
          { pgPool: r.pg, preCheckRedis: NOOP_REDIS, scheduler: NOOP_SCHEDULER },
          {
            requestId: reqId,
            userId: r.userId,
            containerId: 1n,
            accountId: null,
            slotId: null,
            model: TEST_PRICING.model_id,
            pricing: TEST_PRICING,
            precheckCredits: 100n,
            preCheckReservation: reservation,
            log: NOOP_LOGGER,
            sessionId: 'sess-pbt',
            turnKey,
          },
        )
        r.finalizers.set(reqId, fin)

        const usage = {
          input_tokens: this.inputTokens,
          output_tokens: this.outputTokens,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
        }
        const out = await fin.commit({ kind: 'final', usage })
        assert.equal(out.state, 'committed')

        const after = r.pool.poolTotals(r.userId.toString(), r.orgId)
        const expectedCost = computeCost(usage, TEST_PRICING).cost_credits
        const actualDebited = before.sumAll - after.sumAll

        if (this.outputTokens === 0 || m.waivedTurns.has(turnKey)) {
          assert.equal(actualDebited, 0n, 'zero-output or already-waived turn must charge 0')
          assert.equal(r.pool.state.ledger.length, ledgerBefore)
        } else {
          assert.ok(actualDebited <= expectedCost)
          assert.equal(out.debitedCredits ?? 0n, actualDebited)
        }

        m.settledRequests.set(reqId, { turnKey, debited: actualDebited })
        assertConservation(m, r, this.toString())
      }
      toString(): string {
        return `SettleSuccess(turn=${this.turnSlot},in=${this.inputTokens},out=${this.outputTokens})`
      }
    }

    class UpstreamFailedCmd implements AsyncCommand<Model, Real> {
      constructor(readonly mode: 'finalizer_fail' | 'settle_error') {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        const reqId = `req-fail-${m.nextReqSeq++}`
        const before = r.pool.poolTotals(r.userId.toString(), r.orgId)
        const ledgerBefore = r.pool.state.ledger.length

        if (this.mode === 'finalizer_fail') {
          await startInflightJournal(r.pg, {
            requestId: reqId,
            userId: r.userId,
            containerId: 1n,
            model: TEST_PRICING.model_id,
            precheckCredits: 100n,
          })
          const fin = makeFinalizer(
            { pgPool: r.pg, preCheckRedis: NOOP_REDIS, scheduler: NOOP_SCHEDULER },
            {
              requestId: reqId,
              userId: r.userId,
              containerId: 1n,
              accountId: null,
              slotId: null,
              model: TEST_PRICING.model_id,
              pricing: TEST_PRICING,
              precheckCredits: 100n,
              preCheckReservation: { userId: r.userId.toString(), requestId: reqId },
              log: NOOP_LOGGER,
              sessionId: 'sess-pbt',
            },
          )
          const out = await fin.fail(
            { kind: 'none' },
            new Error('upstream_failed: 503'),
            'UPSTREAM_UNAVAILABLE',
          )
          assert.equal(out.state, 'aborted')
          assert.equal(out.finalCredits, 0n)
          assert.equal(out.debitedCredits, null)
        } else {
          const settled = await settleUsageAndLedger(r.pg, {
            userId: r.userId,
            accountId: null,
            requestId: reqId,
            model: TEST_PRICING.model_id,
            usage: { input_tokens: 5000, output_tokens: 5000, cache_read_tokens: 0, cache_write_tokens: 0 },
            snapshotJson: '{}',
            costCredits: 5000n,
            status: 'error',
            sessionId: 'sess-pbt',
          })
          assert.equal(settled.debitedCredits, null)
          assert.equal(settled.ledgerId, null)
        }

        const after = r.pool.poolTotals(r.userId.toString(), r.orgId)
        assert.equal(after.sumAll, before.sumAll, 'upstream_failed must incur strictly zero debit')
        assert.equal(r.pool.state.ledger.length, ledgerBefore, 'upstream_failed must emit 0 ledger rows')
        m.failedRequests.add(reqId)
        assertConservation(m, r, this.toString())
      }
      toString(): string {
        return `UpstreamFailed(${this.mode})`
      }
    }

    class DuplicateSettleRetryCmd implements AsyncCommand<Model, Real> {
      constructor(readonly pickIdx: number) {}
      check(m: Readonly<Model>): boolean {
        return m.settledRequests.size > 0
      }
      async run(m: Model, r: Real): Promise<void> {
        const keys = [...m.settledRequests.keys()]
        const reqId = keys[this.pickIdx % keys.length]!
        const info = m.settledRequests.get(reqId)!
        const before = r.pool.poolTotals(r.userId.toString(), r.orgId)
        const ledgerBefore = r.pool.state.ledger.length

        // 1. Re-invoke finalizer single-shot handle.
        const fin = r.finalizers.get(reqId)
        if (fin) {
          const again = await fin.commit({
            kind: 'final',
            usage: { input_tokens: 9999, output_tokens: 9999, cache_read_tokens: 0, cache_write_tokens: 0 },
          })
          assert.equal(again.state, 'committed')
        }

        // 2. Re-invoke settleUsageAndLedger directly to trigger PG 23505 unique_violation idempotency.
        const retry = await settleUsageAndLedger(r.pg, {
          userId: r.userId,
          accountId: null,
          requestId: reqId,
          model: TEST_PRICING.model_id,
          usage: { input_tokens: 9999, output_tokens: 9999, cache_read_tokens: 0, cache_write_tokens: 0 },
          snapshotJson: '{}',
          costCredits: 9999n,
          status: 'success',
          sessionId: 'sess-pbt',
          turnKey: info.turnKey,
        })
        assert.equal(retry.commitDisposition, 'existing')
        assert.equal(retry.debitedCredits, null)
        assert.equal(retry.balanceAfter, null)

        const after = r.pool.poolTotals(r.userId.toString(), r.orgId)
        assert.equal(after.sumAll, before.sumAll, 'duplicate settle retry must not double-debit')
        assert.equal(r.pool.state.ledger.length, ledgerBefore)
        assertConservation(m, r, this.toString())
      }
      toString(): string {
        return `DuplicateSettleRetry(idx=${this.pickIdx})`
      }
    }

    class ApplyTurnWaiverRefundCmd implements AsyncCommand<Model, Real> {
      constructor(readonly turnSlot: number) {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        const turnKey = makeTurnKey(`turn-${this.turnSlot}`)
        const before = r.pool.poolTotals(r.userId.toString(), r.orgId)
        const alreadyWaived = m.waivedTurns.has(turnKey)

        const res = await applyTurnWaiver(r.pg, {
          userId: r.userId,
          turnKey,
          reason: 'idle_timeout',
          logger: NOOP_LOGGER,
        })
        assert.ok(res.waiverId !== null)

        const after = r.pool.poolTotals(r.userId.toString(), r.orgId)
        if (alreadyWaived) {
          assert.equal(res.newlyApplied, false, 'repeated refund must be idempotent')
          assert.equal(after.sumAll, before.sumAll, 'repeated refund must not double-credit')
        } else {
          assert.equal(res.newlyApplied, true)
          assert.equal(
            after.sumAll - before.sumAll,
            res.refundedCredits,
            'refunded credits must exactly equal sum increase across 4 pools',
          )
          m.waivedTurns.add(turnKey)
        }
        assertConservation(m, r, this.toString())
      }
      toString(): string {
        return `ApplyTurnWaiverRefund(turn=${this.turnSlot})`
      }
    }

    class ToggleEnvironmentCmd implements AsyncCommand<Model, Real> {
      constructor(readonly op: 'toggle_org' | 'expire_user_period' | 'topup_wallet') {}
      check(): boolean {
        return true
      }
      async run(m: Model, r: Real): Promise<void> {
        if (this.op === 'toggle_org') {
          const org = r.pool.state.orgs.get(r.orgId)!
          org.status = org.status === 'active' ? 'suspended' : 'active'
        } else if (this.op === 'expire_user_period') {
          const sub = r.pool.state.userSubs.get('user-sub-1')!
          sub.periodEndMs = r.pool.state.nowMs - 500
        } else {
          const bonus = 5_000n
          const u = r.pool.state.users.get(r.userId.toString())!
          u.credits += bonus
          m.totalTopUps += bonus
        }
        assertConservation(m, r, this.toString())
      }
      toString(): string {
        return `ToggleEnvironment(${this.op})`
      }
    }

    const cmdsArb = fc.commands<Model, Real, AsyncCommand<Model, Real>>(
      [
        {
          weight: 5,
          arbitrary: fc
            .record({
              turnSlot: fc.integer({ min: 0, max: 3 }),
              inputTokens: fc.integer({ min: 100, max: 25_000 }),
              outputTokens: fc.oneof(
                { weight: 1, arbitrary: fc.constant(0) },
                { weight: 4, arbitrary: fc.integer({ min: 50, max: 15_000 }) },
              ),
            })
            .map((x) => new SettleSuccessCmd(x.turnSlot, x.inputTokens, x.outputTokens)),
        },
        {
          weight: 2,
          arbitrary: fc
            .constantFrom('finalizer_fail' as const, 'settle_error' as const)
            .map((mode) => new UpstreamFailedCmd(mode)),
        },
        {
          weight: 3,
          arbitrary: fc.nat(10).map((idx) => new DuplicateSettleRetryCmd(idx)),
        },
        {
          weight: 3,
          arbitrary: fc.integer({ min: 0, max: 3 }).map((slot) => new ApplyTurnWaiverRefundCmd(slot)),
        },
        {
          weight: 2,
          arbitrary: fc
            .constantFrom('toggle_org' as const, 'expire_user_period' as const, 'topup_wallet' as const)
            .map((op) => new ToggleEnvironmentCmd(op)),
        },
      ],
      { minLength: 4, maxLength: 20 },
    )

    const initialArb = fc.record({
      orgPeriod: fc.bigInt({ min: 0n, max: 20_000n }),
      orgWallet: fc.bigInt({ min: 0n, max: 20_000n }),
      userPeriod: fc.bigInt({ min: 0n, max: 20_000n }),
      userWallet: fc.bigInt({ min: 0n, max: 20_000n }),
      billingEnabled: fc.boolean(),
      monthlyOrgBudget: fc.option(fc.bigInt({ min: 1_000n, max: 25_000n }), { freq: 3 }),
      cmds: cmdsArb,
    })

    await assertAsyncProperty(
      initialArb,
      async (scenario) => {
        await asyncModelRun(
          () => {
            const pool = new InMemoryBillingPool({
              userId: '101',
              userWallet: scenario.userWallet,
              userPeriod: scenario.userPeriod,
              userPeriodActive: true,
              orgId: '501',
              orgActive: true,
              orgWallet: scenario.orgWallet,
              orgPeriod: scenario.orgPeriod,
              orgPeriodActive: true,
              billingEnabled: scenario.billingEnabled,
              monthlyOrgBudget: scenario.monthlyOrgBudget,
            })
            const initialTotal = pool.poolTotals('101', '501').sumAll
            return {
              model: {
                initialTotal,
                totalTopUps: 0n,
                settledRequests: new Map(),
                waivedTurns: new Set(),
                failedRequests: new Set(),
                nextReqSeq: 1,
              },
              real: {
                pool,
                pg: pool.asPgPool(),
                userId: 101n,
                orgId: '501',
                finalizers: new Map(),
              },
            }
          },
          scenario.cmds,
        )
      },
      { numRuns: PBT_RUNS, seed: 0x22b2222, label: 'billing-state-machine-conservation' },
    )
  })
})
