import assert from 'node:assert/strict'
import test from 'node:test'
import { systemReadOperations, type SystemReadOperationDeps } from '../system-assistant/readOperations.js'
import { SystemOperationRegistry, SystemOperationRejected, type SystemActor } from '../system-assistant/operations.js'
import type { OrderRow } from '../payment/orders.js'
import type { UserUsageReport } from '../billing/usageReport.js'
const actor: SystemActor = { userId: '765', role: 'user', sessionId: 'synthetic-session', agentId: 'main' }
function registry(reads: NonNullable<SystemReadOperationDeps['reads']>, authorize: SystemReadOperationDeps['authorize'] = async a => { assert.equal(a.userId, '765') }) {
  return new SystemOperationRegistry(systemReadOperations({ authorize, reads, now: () => 1000000 }))
}
test('notification reads bind canonical uid and project only visible fields; body is explicit and thread metadata stays private', async () => {
  let calls = 0
  const r = registry({ listMyInbox: async input => {
    calls++; assert.equal(input.userId, '765')
    return { unread_count: 1, messages: [{ id: 'synthetic-notice', audience: 'user', user_id: '765', title: '通知', body_md: 'SYNTHETIC PRIVATE BODY', level: 'info', category: 'user',
      created_by: 'SYNTHETIC PRIVATE OPERATOR', created_at: '2026-10-24T00:00:00Z', expires_at: null, read: false,
      thread_key: 'SYNTHETIC PRIVATE THREAD', thread_count: 999, source_type: 'SYNTHETIC PRIVATE SOURCE', source_id: 'private', source_phase: 'private' }] }
  } })
  const view = await r.read(actor, 'notifications.list', {}) as { messages: Record<string, unknown>[] }
  assert.deepEqual(Object.keys(view.messages[0]!).sort(), ['id', 'title', 'level', 'category', 'created_at', 'expires_at', 'read'].sort())
  assert.equal(JSON.stringify(view).includes('SYNTHETIC PRIVATE'), false)
  const full = await r.read(actor, 'notifications.list', { includeBody: true }) as { messages: Record<string, unknown>[] }
  assert.equal(full.messages[0]!.body_md, 'SYNTHETIC PRIVATE BODY'); assert.equal('thread_count' in full.messages[0]!, false)
  await assert.rejects(r.read(actor, 'notifications.list', { userId: '765' }))
  await assert.rejects(r.read(actor, 'notifications.list', { limit: 101 }))
  assert.equal(calls, 2)
})
test('unread counts are pure and reject recipient overrides', async () => {
  const r = registry({ countMyUnread: async uid => { assert.equal(uid, '765'); return 7 } })
  assert.deepEqual(await r.read(actor, 'notifications.count', {}), { unread_count: 7 })
  await assert.rejects(r.read(actor, 'notifications.count', { recipient: 'other' }))
})
test('project usage never silently labels account ledger as project data and uid/filter syntax cannot be overridden', async () => {
  const project = '00000000-0000-4000-8000-000000000001'
  let calls = 0
  const report: UserUsageReport = { window: '7d', summary: { requests: '1', input_tokens: '2', output_tokens: '3', cache_read_tokens: '0', cache_write_tokens: '0', credits: '4' }, trend: [], models: [], ledger: { trend: [], by_reason: [{ reason: 'SYNTHETIC ACCOUNT LEDGER', debited: '9' }] } }
  const r = registry({ getUserUsageReport: async (uid, window, board) => { calls++; assert.equal(uid, '765'); assert.equal(window, '7d'); assert.equal(board, project); return report } })
  const view = await r.read(actor, 'billing.usage.report', { project }) as Record<string, unknown>
  assert.equal('ledger' in view, false); assert.equal(JSON.stringify(view).includes('SYNTHETIC ACCOUNT LEDGER'), false)
  const full = await r.read(actor, 'billing.usage.report', { project, includeLedger: true }) as Record<string, unknown>
  assert.deepEqual(full.scope, { usage: project, ledger: 'account' }); assert.equal('ledger' in full, true)
  await assert.rejects(r.read(actor, 'billing.usage.report', { project: "x' OR TRUE" }))
  await assert.rejects(r.read(actor, 'billing.usage.report', { uid: '765' }))
  assert.equal(calls, 2)
})
test('plan catalogs preserve exact bigint money and current-user eligibility without internal catalog fields', async () => {
  const r = registry({ listPlans: async opts => { assert.deepEqual(opts, { userId: '765' }); return [{ id: 1n, code: 'synthetic-plan', label: '方案', amount_cents: 9007199254740993n, credits: 100n, sort_order: 1, enabled: true, period_scoped: false }] },
    listOrgSubscriptionPlans: async () => [{ code: 'synthetic-org-plan', name: '组织方案', priceCents: 100n, monthlyCredits: 200n, periodDays: 30, tier: 1, sortOrder: 1, enabled: true, minSeats: 3 }] })
  const view = await r.read(actor, 'billing.plans.list', {}) as { plans: Record<string, unknown>[] }
  assert.equal(view.plans[0]!.amount_cents, '9007199254740993'); assert.equal('id' in view.plans[0]!, false); assert.doesNotThrow(() => JSON.stringify(view))
  const org = await r.read(actor, 'billing.subscription.plans', { scope: 'org' }) as { plans: Record<string, unknown>[] }
  assert.equal(org.plans[0]!.min_seats, 3); assert.equal(org.plans[0]!.amount_scope, 'per_seat'); assert.equal('enabled' in org.plans[0]!, false)
})
test('a missing subscription is reported uninitialized without issuing a free subscription or looking up a plan', async () => {
  const r = registry({ getUserSubscription: async uid => { assert.equal(uid, '765'); return null }, getPlan: async () => { throw new Error('no plan lookup without subscription') },
    getBalanceBreakdown: async uid => { assert.equal(uid, '765'); return { wallet: 100n, period: 0n, total: 100n } } })
  const view = await r.read(actor, 'billing.subscription.get', {}) as Record<string, unknown>
  assert.equal(view.initialized, false); assert.equal(view.subscription, null); assert.deepEqual(view.balance, { wallet: '100', period: '0', total: '100' })
})
const ownedOrder: OrderRow = { id: 1n, order_no: 'synthetic-order', user_id: 765n, provider: 'hupijiao', provider_order: 'SYNTHETIC PRIVATE PROVIDER ORDER', amount_cents: 100n, credits: 200n, status: 'pending', kind: 'topup', plan_code: null, from_plan_code: null, org_id: null, org_name: null, plan_seats: null, paid_at: null, expires_at: new Date(2000000), ledger_id: null, refunded_ledger_id: null, created_at: new Date(1000000), updated_at: new Date(1000000) }
test('order reads always include owner filtering and never disclose provider receipts or another owner', async () => {
  let wrongOwner = false
  const r = registry({ getOrderByNo: async (number, options) => { assert.equal(number, 'synthetic-order'); assert.deepEqual(options, { userId: '765' }); return { ...ownedOrder, user_id: wrongOwner ? 999n : 765n } } })
  const view = await r.read(actor, 'billing.order.get', { orderNo: 'synthetic-order' }) as Record<string, unknown>
  assert.equal(view.amount_cents, '100'); assert.equal('user_id' in view, false); assert.equal(JSON.stringify(view).includes('SYNTHETIC PRIVATE'), false)
  wrongOwner = true
  await assert.rejects(r.read(actor, 'billing.order.get', { orderNo: 'synthetic-order' }), e => e instanceof SystemOperationRejected && e.code === 'NOT_FOUND')
  await assert.rejects(r.read(actor, 'billing.order.get', { orderNo: '../other', userId: '765' }))
})
test('revoked current identity is rejected before any business read and the catalog contains only read effects', async () => {
  let reads = 0
  const r = registry({ countMyUnread: async () => { reads++; return 0 } }, async () => { throw new SystemOperationRejected('FORBIDDEN') })
  await assert.rejects(r.read(actor, 'notifications.count', {})); assert.equal(reads, 0)
  const catalog = await registry({}).catalog(actor)
  assert.equal(catalog.items.length, 7); assert.equal(catalog.items.every(item => item.effect === 'read'), true)
})
