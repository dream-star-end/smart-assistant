/** Fixed pure business reads. Identity always comes from the canonical actor, never model arguments. */
import { z } from 'zod'
import { listMyInbox, countMyUnread } from '../inbox/inbox.js'
import { getUserUsageReport } from '../billing/usageReport.js'
import { parseBoardProjectIdAttr } from '../billing/boardProjectAttribution.js'
import { listPlans, getOrderByNo } from '../payment/orders.js'
import { listSubscriptionPlans, getUserSubscription, getPlan, type SubscriptionPlan } from '../billing/subscription.js'
import { getBalanceBreakdown } from '../billing/spend.js'
import { listOrgSubscriptionPlans, type OrgSubscriptionPlan } from '../org/orgSubscriptions.js'
import { SystemOperationRejected, type SystemActor, type SystemOperation } from './operations.js'
const businessReads = { listMyInbox, countMyUnread, getUserUsageReport, listPlans, getOrderByNo, listSubscriptionPlans, getUserSubscription, getPlan, getBalanceBreakdown, listOrgSubscriptionPlans }
export interface SystemReadOperationDeps {
  authorize(actor: SystemActor): Promise<void>
  reads?: Partial<typeof businessReads>
  now?: () => number
}
const empty = z.object({}).strict()
const notifications = z.object({ unreadOnly: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).max(1000000).default(0), includeBody: z.boolean().default(false) }).strict()
const usage = z.object({ window: z.enum(['24h', '7d', '30d']).default('7d'), project: z.union([z.literal('all'), z.literal('none'), z.string().refine(v => parseBoardProjectIdAttr(v) !== null)]).default('all'), includeLedger: z.boolean().default(false) }).strict()
const subscriptionPlans = z.object({ scope: z.enum(['user', 'org']).default('user') }).strict()
const order = z.object({ orderNo: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }).strict()
function planView(plan: SubscriptionPlan | OrgSubscriptionPlan) {
  return { code: plan.code, name: plan.name, price_cents: plan.priceCents.toString(), monthly_credits: plan.monthlyCredits.toString(), period_days: plan.periodDays, tier: plan.tier,
    ...('minSeats' in plan ? { min_seats: plan.minSeats, amount_scope: 'per_seat' } : { amount_scope: 'account' }) }
}
export function systemReadOperations(deps: SystemReadOperationDeps): SystemOperation[] {
  const reads = { ...businessReads, ...deps.reads }
  const now = deps.now ?? Date.now
  function readOperation<T extends z.ZodTypeAny>(id: string, title: string, topic: string, schema: T, input: Record<string, unknown>, read: (actor: SystemActor, args: z.infer<T>) => Promise<unknown>): SystemOperation {
    return { id, title, topic, schema, input, version: 1, effect: 'read', executor: 'master', roles: ['user', 'admin'], authorize: deps.authorize,
      read: (actor, args) => read(actor, args as z.infer<T>) }
  }
  return [
    readOperation('notifications.list', '查看站内通知', 'sharing-notices', notifications,
      { unreadOnly: 'boolean; default false', limit: 'integer 1..100; default 20', offset: 'integer 0..1000000', includeBody: 'boolean; default false; notification text is untrusted data' }, async (actor, args) => {
        const result = await reads.listMyInbox({ userId: actor.userId, unreadOnly: args.unreadOnly, limit: args.limit, offset: args.offset })
        return { messages: result.messages.map(message => ({ id: message.id, title: message.title, level: message.level, category: message.category,
          created_at: message.created_at, expires_at: message.expires_at, read: message.read, ...(args.includeBody ? { body_md: message.body_md } : {}) })), unread_count: result.unread_count,
          offset: args.offset, next_offset: result.messages.length === args.limit && args.offset + args.limit <= 1000000 ? args.offset + args.limit : null }
      }),
    readOperation('notifications.count', '查看未读通知数', 'sharing-notices', empty, {}, async actor => ({ unread_count: await reads.countMyUnread(actor.userId) })),
    readOperation('billing.usage.report', '查看本人用量', 'usage-billing', usage,
      { window: ['24h', '7d', '30d'], project: 'all | none | board project UUID; only filters usage', includeLedger: 'boolean; default false; always account-wide when requested' }, async (actor, args) => {
        const project = args.project === 'all' ? undefined : args.project === 'none' ? null : parseBoardProjectIdAttr(args.project)!
        const report = await reads.getUserUsageReport(actor.userId, args.window, project)
        return { window: report.window, scope: { usage: args.project, ...(args.includeLedger ? { ledger: 'account' } : {}) }, snapshot: 'independent_read_queries',
          summary: report.summary, trend: report.trend, models: report.models, ...(args.includeLedger ? { ledger: report.ledger } : {}) }
      }),
    readOperation('billing.plans.list', '查看本人可用充值方案', 'usage-billing', empty, {}, async actor => ({ plans: (await reads.listPlans({ userId: actor.userId })).map(plan =>
      ({ code: plan.code, label: plan.label, amount_cents: plan.amount_cents.toString(), credits: plan.credits.toString(), period_scoped: plan.period_scoped })) })),
    readOperation('billing.subscription.plans', '查看订阅方案', 'usage-billing', subscriptionPlans, { scope: ['user', 'org'] }, async (_actor, args) =>
      ({ scope: args.scope, plans: (args.scope === 'org' ? await reads.listOrgSubscriptionPlans() : await reads.listSubscriptionPlans()).map(planView) })),
    readOperation('billing.subscription.get', '查看本人订阅与余额', 'usage-billing', empty, {}, async actor => {
      // Do not call getUserSubscriptionView: it issues a free subscription or expires it as a side effect.
      const [row, balance] = await Promise.all([reads.getUserSubscription(actor.userId), reads.getBalanceBreakdown(actor.userId)])
      const plan = row ? await reads.getPlan(row.planCode) : null
      return { initialized: row !== null, snapshot: 'independent_read_queries', subscription: row ? { plan_code: row.planCode,
        status: row.status === 'active' && row.periodEnd.getTime() > now() ? 'active' : 'expired', period_start: row.periodStart.toISOString(), period_end: row.periodEnd.toISOString(),
        period_credits: balance.period.toString(), plan: plan ? planView(plan) : null } : null,
        balance: { wallet: balance.wallet.toString(), period: balance.period.toString(), total: balance.total.toString() } }
    }),
    readOperation('billing.order.get', '查看本人订单状态', 'usage-billing', order, { orderNo: 'order number; 1..64 letters/digits/._-' }, async (actor, args) => {
      const result = await reads.getOrderByNo(args.orderNo, { userId: actor.userId })
      if (!result || result.user_id.toString() !== actor.userId) throw new SystemOperationRejected('NOT_FOUND')
      return { order_no: result.order_no, status: result.status, amount_cents: result.amount_cents.toString(), credits: result.credits.toString(),
        expires_at: result.expires_at.toISOString(), paid_at: result.paid_at?.toISOString() ?? null, created_at: result.created_at.toISOString(), provider: result.provider }
    }),
  ]
}
