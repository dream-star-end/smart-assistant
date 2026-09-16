/**
 * settings 模块视觉审计场景(OCV5 v5 个人版审计 · A·settings)。
 *
 * 覆盖:设置中心七分区(账户/用量/偏好/快捷键/反馈;API 接入与关于分别复用 scenes-api-access /
 * scenes-workspace 既有场景)、订阅弹层、ChatGPT 直连向导、虎皮椒支付入口 + 待确认订单恢复条、
 * 组织中心五分区 + 创建向导、组织充值 / 订阅弹层。
 *
 * 全部数据走 api-stub 场景表;金额 / 积分按生产契约保持字符串大数。
 * 组件在 Radix Dialog 里的场景由 shoot.mjs 自动裁到 [role=dialog];裸组件场景整页截图。
 */
import { useEffect } from 'react'

import { ChatGptProxyDialog } from '../../src/components/ChatGptProxyDialog'
import { OrgCenter } from '../../src/components/OrgCenter'
import { SettingsCenter, type SettingsSection } from '../../src/components/SettingsCenter'
import { InvoicesTab } from '../../src/components/org/InvoicesTab'
import { MembersTab } from '../../src/components/org/MembersTab'
import { OrgSubscribeDialog } from '../../src/components/org/OrgSubscribeDialog'
import { OrgTopupDialog } from '../../src/components/org/OrgTopupDialog'
import { HupijiaoPaymentEntry } from '../../src/components/payment/HupijiaoPaymentEntry'
import { PendingPaymentRecovery } from '../../src/components/payment/PendingPaymentRecovery'
import { AccountTab } from '../../src/components/settings/AccountTab'
import { ApiAccessTab } from '../../src/components/settings/ApiAccessTab'
import { PreferencesTab } from '../../src/components/settings/PreferencesTab'
import { SubscriptionDialog } from '../../src/components/settings/SubscriptionDialog'
import { UsageTab } from '../../src/components/settings/UsageTab'
import { createMemoryAuthSession } from '../../src/lib/authSession'
import { extractAutoDreamFeature, extractPrefs } from '../../src/lib/modelPreferences'
import { savePendingPayment } from '../../src/lib/pendingPayment'
import type {
  MySubscription,
  OrgInvitation,
  OrgMember,
  OrgPlan,
  OrgSubscriptionInfo,
  OrgSummary,
  OrgUsageReport,
  SubscriptionPlanWire,
  UsageLedgerRow,
  UsageReport,
  UsageResponse,
  User,
} from '../../src/lib/types'
import type { Scene } from './types'

const auth = createMemoryAuthSession(() => {}, 'preview-token')
const noop = () => {}

/**
 * 关于页的「版本」行与「检查更新」都读 `<meta name="oc-build">`(生产由 index.html 注入;预览台的
 * HTML 没有这枚 meta)。渲染前补一枚,场景卸载时撤掉,不影响同一批次里的其他场景(FeedbackTab 也读它)。
 * 在 render 体里注入是刻意的:AboutSection 在首次渲染时就同步读 meta,effect 里补就晚了。
 */
function WithBuildMeta({ build, children }: { build: string; children: React.ReactNode }) {
  if (!document.querySelector('meta[name="oc-build"]')) {
    const meta = document.createElement('meta')
    meta.name = 'oc-build'
    meta.content = build
    meta.dataset.previewInjected = 'true'
    document.head.appendChild(meta)
  }
  useEffect(
    () => () => {
      document.querySelector('meta[name="oc-build"][data-preview-injected]')?.remove()
    },
    [],
  )
  return <>{children}</>
}

// ── 用户形态 ────────────────────────────────────────────────────────────────
const paidUser: User = {
  id: 'u-paid',
  displayName: '林晓',
  roles: ['user'],
  role: 'user',
  email: 'lin@example.com',
  credits: '12345678',
  org: {
    id: 'org-1',
    name: '晨星科技',
    role: 'member',
    status: 'active',
    billing_enabled: true,
    billing_delegate: false,
  },
}

const freeUser: User = {
  id: 'u-free',
  displayName: '新用户',
  roles: ['user'],
  role: 'user',
  credits: '0',
  org: null,
}

const ownerUser: User = {
  id: 'u-owner',
  displayName: '王拥有者',
  roles: ['user'],
  role: 'user',
  credits: '500000',
  org: {
    id: 'org-1',
    name: '晨星科技',
    role: 'owner',
    status: 'active',
    billing_enabled: true,
    billing_delegate: false,
  },
}

// ── 订阅 / 报表 / 流水假数据 ─────────────────────────────────────────────
const paidSub: MySubscription = {
  planCode: 'lite',
  planName: 'Lite',
  status: 'active',
  periodStart: '2026-08-20T00:00:00Z',
  periodEnd: '2026-09-20T00:00:00Z',
  periodCredits: '1480000',
  monthlyCredits: '4000000',
  priceCents: '3800',
  tier: 1,
  paid: true,
  balance: { wallet: '10865678', period: '1480000', total: '12345678' },
}

const freeSub: MySubscription = {
  planCode: 'free',
  planName: '免费版',
  status: 'active',
  periodStart: '2026-09-01T00:00:00Z',
  periodEnd: '2026-10-01T00:00:00Z',
  periodCredits: '0',
  monthlyCredits: '300000',
  priceCents: '0',
  tier: 0,
  paid: false,
  balance: { wallet: '0', period: '0', total: '0' },
}

const plans: SubscriptionPlanWire[] = [
  {
    code: 'free',
    name: '免费版',
    priceCents: '0',
    monthlyCredits: '300000',
    periodDays: 30,
    tier: 0,
  },
  {
    code: 'lite',
    name: 'Lite',
    priceCents: '3800',
    monthlyCredits: '4000000',
    periodDays: 30,
    tier: 1,
  },
  {
    code: 'pro',
    name: 'Pro',
    priceCents: '8800',
    monthlyCredits: '10000000',
    periodDays: 30,
    tier: 2,
  },
  {
    code: 'max',
    name: 'Max',
    priceCents: '29800',
    monthlyCredits: '35000000',
    periodDays: 30,
    tier: 3,
  },
  {
    code: 'ultra',
    name: 'Ultra',
    priceCents: '49800',
    monthlyCredits: '60000000',
    periodDays: 30,
    tier: 4,
  },
]

const days = ['09-09', '09-10', '09-11', '09-12', '09-13', '09-14', '09-15']

const usageReport7d: UsageReport = {
  window: '7d',
  summary: {
    requests: '412',
    input_tokens: '3821000',
    output_tokens: '412300',
    cache_read_tokens: '1520000',
    cache_write_tokens: '230000',
    credits: '1860000',
  },
  trend: days.map((d, i) => ({
    bucket: `2026-${d}`,
    requests: String(30 + i * 12),
    credits: String(120000 + i * 60000),
  })),
  models: [
    {
      model: 'cursor-fable-5.1-high',
      requests: '180',
      credits: '980000',
      input_tokens: '1800000',
      output_tokens: '200000',
      cache_read_tokens: '800000',
      cache_write_tokens: '120000',
    },
    {
      model: 'cursor-opus-5-high',
      requests: '90',
      credits: '520000',
      input_tokens: '1000000',
      output_tokens: '120000',
      cache_read_tokens: '400000',
      cache_write_tokens: '60000',
    },
    {
      model: 'cursor-sonnet-5-high',
      requests: '100',
      credits: '260000',
      input_tokens: '800000',
      output_tokens: '70000',
      cache_read_tokens: '250000',
      cache_write_tokens: '40000',
    },
    {
      model: 'cursor-gemini-3.8-flash-low',
      requests: '42',
      credits: '100000',
      input_tokens: '221000',
      output_tokens: '22300',
      cache_read_tokens: '70000',
      cache_write_tokens: '10000',
    },
  ],
  ledger: {
    trend: days.map((d, i) => ({
      bucket: `2026-${d}`,
      credited: i === 2 ? '4000000' : '0',
      debited: String(120000 + i * 60000),
    })),
    by_reason: [
      { reason: 'usage', debited: '1700000' },
      { reason: 'agent_open', debited: '100000' },
      { reason: 'subscription', debited: '60000' },
    ],
  },
}

const usageReportEmpty: UsageReport = {
  window: '7d',
  summary: {
    requests: '0',
    input_tokens: '0',
    output_tokens: '0',
    cache_read_tokens: '0',
    cache_write_tokens: '0',
    credits: '0',
  },
  trend: days.map((d) => ({ bucket: `2026-${d}`, requests: '0', credits: '0' })),
  models: [],
  ledger: {
    trend: days.map((d) => ({ bucket: `2026-${d}`, credited: '0', debited: '0' })),
    by_reason: [],
  },
}

const ledgerRows: UsageLedgerRow[] = [
  {
    id: 'l-9',
    delta: '-12500',
    balance_after: '12345678',
    reason: 'usage',
    ref_type: 'turn',
    ref_id: 't1',
    memo: null,
    created_at: '2026-09-15T13:42:00Z',
  },
  {
    id: 'l-8',
    delta: '-8200',
    balance_after: '12358178',
    reason: 'usage',
    ref_type: 'turn',
    ref_id: 't2',
    memo: null,
    created_at: '2026-09-15T12:10:00Z',
  },
  {
    id: 'l-7',
    delta: '-100000',
    balance_after: '12366378',
    reason: 'agent_open',
    ref_type: 'agent',
    ref_id: 'coder',
    memo: '开通编码智能体',
    created_at: '2026-09-14T09:03:00Z',
  },
  {
    id: 'l-6',
    delta: '4000000',
    balance_after: '12466378',
    reason: 'monthly_grant',
    ref_type: 'subscription',
    ref_id: 's1',
    memo: null,
    created_at: '2026-09-11T00:00:00Z',
  },
  {
    id: 'l-5',
    delta: '500000',
    balance_after: '8466378',
    reason: 'topup',
    ref_type: 'order',
    ref_id: 'o1',
    memo: '¥50 加量包',
    created_at: '2026-09-10T08:00:00Z',
  },
  {
    id: 'l-4',
    delta: '-3400',
    balance_after: '7966378',
    reason: 'some_unknown_reason',
    ref_type: null,
    ref_id: null,
    memo: null,
    created_at: '2026-09-09T20:15:00Z',
  },
]

const usageResponse: UsageResponse = {
  summary: {
    input_tokens: '98210000',
    output_tokens: '8123000',
    cache_read_tokens: '40120000',
    cache_write_tokens: '5200000',
    requests_total: '6210',
    billed_credits: '42100000',
    debited_credits: '41800000',
  },
  legacy_unattributed: {
    requests: '120',
    input_tokens: '0',
    output_tokens: '0',
    cache_read_tokens: '0',
    cache_write_tokens: '0',
    billed_credits: '0',
  },
  savings: {
    savings_credits: '8600000',
    savings_is_estimate: true,
    savings_unavailable: false,
    savings_rows_skipped: 0,
  },
  cache: { hit_rate: 0.408 },
  sessions: {
    rows: [
      {
        session_id: 's-alpha-0001-9f3c',
        requests: '84',
        input_tokens: '820000',
        output_tokens: '90000',
        cache_read_tokens: '300000',
        cache_write_tokens: '40000',
        billed_credits: '420000',
        last_used_at: '2026-09-15T13:42:00Z',
        delegate_credits: '120000',
        delegate_requests: '12',
        delegates: [
          {
            delegate_agent_id: 'coder',
            model: 'cursor-opus-5-high',
            requests: '8',
            billed_credits: '90000',
          },
          {
            delegate_agent_id: 'hidden-reviewer',
            model: 'cursor-sonnet-5-high',
            requests: '4',
            billed_credits: '30000',
          },
        ],
      },
      {
        session_id: 's-beta-0002-7a1d',
        requests: '31',
        input_tokens: '310000',
        output_tokens: '22000',
        cache_read_tokens: '100000',
        cache_write_tokens: '9000',
        billed_credits: '150000',
        last_used_at: '2026-09-14T22:10:00Z',
      },
      {
        session_id: 's-gamma-0003-2c2e',
        requests: '6',
        input_tokens: '42000',
        output_tokens: '5000',
        cache_read_tokens: '0',
        cache_write_tokens: '0',
        billed_credits: '22000',
        last_used_at: '2026-09-12T08:30:00Z',
        delegate_only: true,
        delegate_credits: '22000',
        delegate_requests: '6',
        delegates: [
          {
            delegate_agent_id: null,
            model: 'cursor-fable-5.1-high',
            requests: '6',
            billed_credits: '22000',
          },
        ],
      },
    ],
    limit: 20,
    offset: 0,
    has_more: true,
  },
  ledger: { rows: ledgerRows, next_before: 'l-4' },
  cutoff_started_at: '2026-06-01T00:00:00Z',
}

const usageResponseEmpty: UsageResponse = {
  summary: {
    input_tokens: '0',
    output_tokens: '0',
    cache_read_tokens: '0',
    cache_write_tokens: '0',
    requests_total: '0',
    billed_credits: '0',
    debited_credits: '0',
  },
  legacy_unattributed: {
    requests: '0',
    input_tokens: '0',
    output_tokens: '0',
    cache_read_tokens: '0',
    cache_write_tokens: '0',
    billed_credits: '0',
  },
  savings: {
    savings_credits: null,
    savings_is_estimate: false,
    savings_unavailable: true,
    savings_rows_skipped: 0,
  },
  cache: { hit_rate: null },
  sessions: { rows: [], limit: 20, offset: 0, has_more: false },
  ledger: { rows: [], next_before: null },
  cutoff_started_at: null,
}

const sessionTitles = [
  { id: 's-alpha-0001-9f3c', title: '重构支付轮询状态机并补齐用例' },
  { id: 's-beta-0002-7a1d', title: '周报草稿' },
]

const publicModels = {
  models: [
    {
      id: 'cursor-fable-5.1-high',
      engine: 'cursor',
      label: 'Fable 5.1',
      supported_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    },
    {
      id: 'cursor-opus-5-high',
      engine: 'cursor',
      label: 'Opus 5',
      supported_efforts: ['low', 'medium', 'high'],
    },
    {
      id: 'cursor-sonnet-5-high',
      engine: 'cursor',
      label: 'Sonnet 5',
      supported_efforts: ['low', 'medium', 'high'],
    },
    {
      id: 'cursor-gemini-3.8-flash-low',
      engine: 'cursor',
      label: 'Gemini 3.8 Flash',
      supported_efforts: [],
    },
  ],
  lockedModels: [],
}

const prefsSnapshot = (opts: { eligible: boolean; optimizer: boolean; legacy?: boolean }) => ({
  prefs: {
    theme: 'light',
    default_model: 'cursor-fable-5.1-high',
    default_effort: 'high',
    notify_email: true,
    notify_telegram: false,
    qq_proactive_push: true,
    auto_optimizer_enabled: opts.optimizer,
  },
  features: {
    auto_dream: {
      eligible: opts.eligible,
      available: true,
      enabled: opts.optimizer,
      optimizer_enabled: opts.optimizer,
      legacy_enabled: opts.legacy ?? false,
      effective: opts.optimizer,
      minimum_plan_code: 'max',
      min_interval_hours: 168,
      min_new_sessions: 5,
    },
  },
  updated_at: '2026-09-15T10:00:00Z',
})

// ── 组织假数据 ───────────────────────────────────────────────────────────
const orgPlans: OrgPlan[] = [
  {
    code: 'org_std',
    name: '企业标准',
    seatPriceCents: '9900',
    perSeatCredits: '12000000',
    minSeats: 2,
    periodDays: 30,
  },
  {
    code: 'org_pro',
    name: '企业专业',
    seatPriceCents: '19900',
    perSeatCredits: '30000000',
    minSeats: 5,
    periodDays: 30,
  },
]

const orgSubInfo: OrgSubscriptionInfo = {
  subscription: {
    planCode: 'org_std',
    planName: 'org_std',
    status: 'active',
    seats: 5,
    periodStart: '2026-08-25T00:00:00Z',
    periodEnd: '2026-09-25T00:00:00Z',
    periodCredits: '23400000',
  },
  plans: orgPlans,
}

const orgSummary: OrgSummary = {
  id: 'org-1',
  name: '晨星科技',
  status: 'active',
  role: 'owner',
  billing_enabled: true,
  member_count: 5,
  max_members: 50,
  credits: '8650000',
}

const orgMembers: OrgMember[] = [
  {
    user_id: 'u-owner',
    email: 'owner@morningstar.dev',
    display_name: '王拥有者',
    org_role: 'owner',
    status: 'active',
    billing_enabled: true,
    billing_delegate: false,
    monthly_org_budget: null,
    month_org_spent: '1200000',
    user_status: 'active',
    invited_by: null,
    joined_at: '2026-06-01T08:00:00Z',
  },
  {
    user_id: 'u-fin',
    email: 'finance@morningstar.dev',
    display_name: '赵财务',
    org_role: 'admin',
    status: 'active',
    billing_enabled: true,
    billing_delegate: true,
    monthly_org_budget: '2000000',
    month_org_spent: '1500000',
    user_status: 'active',
    invited_by: 'u-owner',
    joined_at: '2026-06-03T08:00:00Z',
  },
  {
    user_id: 'u-paid',
    email: 'lin@example.com',
    display_name: '林晓',
    org_role: 'member',
    status: 'active',
    billing_enabled: true,
    billing_delegate: false,
    monthly_org_budget: '1000000',
    month_org_spent: '1000000',
    user_status: 'active',
    invited_by: 'u-owner',
    joined_at: '2026-07-12T08:00:00Z',
  },
  {
    user_id: 'u-x',
    email: 'no-name@morningstar.dev',
    display_name: null,
    org_role: 'member',
    status: 'suspended',
    billing_enabled: false,
    billing_delegate: false,
    monthly_org_budget: null,
    month_org_spent: '0',
    user_status: 'suspended',
    invited_by: 'u-fin',
    joined_at: '2026-08-01T08:00:00Z',
  },
  {
    user_id: 'u-y',
    email: 'a.very.long.email.address.for.overflow.testing@morningstar-example-domain.dev',
    display_name: '超长邮箱溢出测试成员',
    org_role: 'member',
    status: 'active',
    billing_enabled: true,
    billing_delegate: false,
    monthly_org_budget: '500000',
    month_org_spent: '120000',
    user_status: 'active',
    invited_by: 'u-owner',
    joined_at: '2026-09-01T08:00:00Z',
  },
]

const orgInvitations: OrgInvitation[] = [
  {
    id: 'inv-1',
    email: 'new.hire@morningstar.dev',
    org_role: 'member',
    status: 'pending',
    invited_by: 'u-owner',
    expires_at: '2026-09-22T00:00:00Z',
    accepted_at: null,
    revoked_at: null,
    created_at: '2026-09-15T09:00:00Z',
  },
  {
    id: 'inv-2',
    email: 'old@morningstar.dev',
    org_role: 'admin',
    status: 'expired',
    invited_by: 'u-owner',
    expires_at: '2026-09-01T00:00:00Z',
    accepted_at: null,
    revoked_at: null,
    created_at: '2026-08-25T09:00:00Z',
  },
]

const orgUsage: OrgUsageReport = {
  window: '24h',
  summary: {
    requests: '1320',
    input_tokens: '9800000',
    output_tokens: '1120000',
    cache_read_tokens: '3800000',
    cache_write_tokens: '520000',
    credits: '5230000',
  },
  members: [
    {
      user_id: 'u-owner',
      email: 'owner@morningstar.dev',
      display_name: '王拥有者',
      requests: '400',
      input_tokens: '3000000',
      output_tokens: '400000',
      cache_read_tokens: '1000000',
      cache_write_tokens: '100000',
      credits: '2000000',
    },
    {
      user_id: 'u-paid',
      email: 'lin@example.com',
      display_name: '林晓',
      requests: '520',
      input_tokens: '4000000',
      output_tokens: '500000',
      cache_read_tokens: '1800000',
      cache_write_tokens: '300000',
      credits: '2400000',
    },
    {
      user_id: 'u-fin',
      email: 'finance@morningstar.dev',
      display_name: null,
      requests: '400',
      input_tokens: '2800000',
      output_tokens: '220000',
      cache_read_tokens: '1000000',
      cache_write_tokens: '120000',
      credits: '830000',
    },
  ],
  models: [
    {
      model: 'cursor-fable-5.1-high',
      requests: '800',
      input_tokens: '6000000',
      output_tokens: '700000',
      cache_read_tokens: '2500000',
      cache_write_tokens: '300000',
      credits: '3800000',
    },
    {
      model: 'cursor-sonnet-5-high',
      requests: '520',
      input_tokens: '3800000',
      output_tokens: '420000',
      cache_read_tokens: '1300000',
      cache_write_tokens: '220000',
      credits: '1430000',
    },
  ],
  trend: Array.from({ length: 24 }, (_, h) => ({
    bucket: `2026-09-15T${String(h).padStart(2, '0')}:00:00+08:00`,
    requests: String(20 + ((h * 7) % 60)),
    credits: String(80000 + ((h * 37) % 23) * 10000),
  })),
}

const orgApi = {
  getOrg: async () => orgSummary,
  getOrgSubscription: async () => orgSubInfo,
  listOrgMembers: async () => orgMembers,
  listOrgInvitations: async () => orgInvitations,
  getOrgUsage: async () => orgUsage,
  getOrgInvoiceProfile: async () => ({
    org_id: 'org-1',
    title: '晨星科技(北京)有限公司',
    tax_id: '91110108MA01ABCD2X',
    address: '北京市海淀区中关村大街 1 号',
    email: 'finance@morningstar.dev',
    updated_by: 'u-fin',
    updated_at: '2026-09-01T10:00:00Z',
  }),
  listOrgOrders: async () => [
    {
      order_no: 'ORG20260901123456',
      status: 'paid',
      amount_cents: '49500',
      credits: '60000000',
      created_at: '2026-09-01T10:00:00Z',
      paid_at: '2026-09-01T10:02:00Z',
    },
    {
      order_no: 'ORG20260910120000',
      status: 'paid',
      amount_cents: '100000',
      credits: '10000000',
      created_at: '2026-09-10T08:00:00Z',
      paid_at: '2026-09-10T08:01:00Z',
    },
    {
      order_no: 'ORG20260915090000',
      status: 'pending',
      amount_cents: '9900',
      credits: '12000000',
      created_at: '2026-09-15T09:00:00Z',
      paid_at: null,
    },
  ],
  listOrgInvoices: async () => [
    {
      id: 'iv-1',
      org_id: 'org-1',
      order_ids: ['1', '2'],
      amount_cents: '149500',
      profile_snapshot: { title: '晨星科技(北京)有限公司' },
      status: 'pending',
      requested_by: 'u-fin',
      admin_note: null,
      processed_by: null,
      processed_at: null,
      created_at: '2026-09-12T10:00:00Z',
    },
    {
      id: 'iv-0',
      org_id: 'org-1',
      order_ids: ['0'],
      amount_cents: '49500',
      profile_snapshot: { title: '晨星科技(北京)有限公司' },
      status: 'rejected',
      requested_by: 'u-fin',
      admin_note: '抬头与营业执照不一致,请修正后重新申请。',
      processed_by: 'admin',
      processed_at: '2026-08-20T10:00:00Z',
      created_at: '2026-08-18T10:00:00Z',
    },
  ],
  getOrgSkills: async () => ({
    installed: [
      { slug: 'weekly-report', name: '周报生成器', summary: '汇总本周会话与任务,自动生成周报' },
      { slug: 'code-review', name: '代码评审助手', summary: null },
    ],
    available: [{ slug: 'meeting-notes', name: '会议纪要', summary: '从录音转写生成结构化纪要' }],
  }),
  getOrgPlans: async () => orgPlans,
  getOrgBalance: async () => '8650000',
}

// ── 通用 api 表 ───────────────────────────────────────────────────────────
const accountApi = {
  getMySubscription: async () => paidSub,
  getMyUsageReport: async () => usageReport7d,
  getUsage: async () => usageResponse,
  listSessions: async () => sessionTitles,
  listSubscriptionPlans: async () => plans,
  getPublicModels: async () => publicModels,
}

/** 一个稳定的 SVG 数据 URL 当二维码占位(离线 harness 里外链 PNG 会被 204 兜底成裂图)。 */
const QR_PLACEHOLDER = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#fff"/>${Array.from(
    { length: 400 },
    (_, i) => {
      const x = (i % 20) * 10
      const y = Math.floor(i / 20) * 10
      return (i * 7919) % 3 === 0
        ? `<rect x="${x}" y="${y}" width="10" height="10" fill="#111"/>`
        : ''
    },
  ).join('')}</svg>`,
)}`

function settings(section: SettingsSection, user: User, extra?: { subscribeOpenSignal?: number }) {
  return (
    <SettingsCenter
      open
      auth={auth}
      user={user}
      theme="light"
      onClose={noop}
      onSetTheme={noop}
      onOpenMemory={noop}
      onRefreshMe={noop}
      onOpenProjectSettings={noop}
      feedbackContext={{ sessionId: 's-alpha-0001-9f3c', requestId: 'req-7f3a' }}
      initialSection={section}
      subscribeOpenSignal={extra?.subscribeOpenSignal ?? 0}
    />
  )
}

/**
 * 「整页」外壳:Dialog 定高只截得到首屏,长分区(账户 / 用量 / 偏好 / API 接入 / 成员 / 发票)
 * 折叠在滚动区里看不见。这里把分区组件裸渲染进一个与 Dialog 正文同宽的容器,让 shoot.mjs
 * 走 fullPage 路径,把整段内容一次截完。仅用于审计取证,不代表生产布局。
 */
function FullPage({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-bg py-4 text-fg">
      {/* 生产 CSS 把 html/body/#root 钉成 100dvh + overflow:hidden(应用壳自己滚)。fullPage 截图量的是
          文档滚动高度,不放开就永远只截到首屏;仅在本取证外壳内放开。 */}
      <style>
        {'html,body,#root{height:auto!important;max-height:none!important;overflow:visible!important;}' +
          '#root{position:static!important;}'}
      </style>
      <div className="mx-auto w-full max-w-[790px] border border-border bg-surface md:rounded-xl">
        {children}
      </div>
    </div>
  )
}

const prefsFull = prefsSnapshot({ eligible: true, optimizer: false, legacy: true })
const apiAccessKeys = [
  {
    id: 'k-1',
    label: 'MacBook · Claude Code',
    keyPrefix: 'abcd1234',
    createdAt: '2026-09-01T09:00:00Z',
    lastUsedAt: '2026-09-15T08:00:00Z',
    disabledAt: null,
    creditLimit: '1000000',
    spentCredits: '823400',
  },
  {
    id: 'k-2',
    label: 'CI 流水线',
    keyPrefix: 'efgh5678',
    createdAt: '2026-08-20T09:00:00Z',
    lastUsedAt: null,
    disabledAt: '2026-09-10T09:00:00Z',
    creditLimit: null,
    spentCredits: '0',
  },
  {
    id: 'k-3',
    label: '一个非常非常长的密钥名称用于测试溢出与截断表现',
    keyPrefix: 'ijkl9012',
    createdAt: '2026-09-12T09:00:00Z',
    lastUsedAt: '2026-09-14T08:00:00Z',
    disabledAt: null,
    creditLimit: '500000',
    spentCredits: '500000',
  },
]
const apiAccessReport = {
  window: '7d',
  key_id: null,
  summary: {
    requests: '1842',
    input_tokens: '12800000',
    output_tokens: '980000',
    cache_read_tokens: '6100000',
    cache_write_tokens: '420000',
    credits: '2340000',
  },
  trend: days.map((d, i) => ({
    bucket: `2026-${d}`,
    requests: String(200 + i * 30),
    credits: String(280000 + i * 20000),
  })),
  by_key: [
    {
      api_key_id: 'k-1',
      label: 'MacBook · Claude Code',
      key_prefix: 'abcd1234',
      revoked: false,
      disabled: false,
      requests: '1500',
      credits: '1900000',
      input_tokens: '10000000',
      output_tokens: '800000',
      last_used_at: '2026-09-15T08:00:00Z',
    },
    {
      api_key_id: 'k-3',
      label: '一个非常非常长的密钥名称用于测试溢出与截断表现',
      key_prefix: 'ijkl9012',
      revoked: false,
      disabled: false,
      requests: '300',
      credits: '400000',
      input_tokens: '2500000',
      output_tokens: '160000',
      last_used_at: '2026-09-14T08:00:00Z',
    },
    {
      api_key_id: 'k-old',
      label: null,
      key_prefix: null,
      revoked: true,
      disabled: false,
      requests: '42',
      credits: '40000',
      input_tokens: '300000',
      output_tokens: '20000',
      last_used_at: '2026-09-09T08:00:00Z',
    },
  ],
  by_model: usageReport7d.models,
  recent: Array.from({ length: 6 }, (_, i) => ({
    id: `r-${i}`,
    created_at: `2026-09-15T1${i}:2${i}:00Z`,
    api_key_id: i % 3 === 2 ? null : 'k-1',
    label: i % 3 === 2 ? null : 'MacBook · Claude Code',
    model: i % 2 ? 'cursor-fable-5.1-high' : 'cursor-sonnet-5-high',
    input_tokens: String(12000 + i * 900),
    output_tokens: String(800 + i * 50),
    cache_read_tokens: '3000',
    cache_write_tokens: '0',
    cost_credits: i === 4 ? '0' : String(1800 + i * 120),
    status: i === 4 ? 'insufficient_credits' : 'success',
  })),
}

export const settingsScenes: Scene[] = [
  {
    id: 'settings-full-account',
    label: '整页 · 账户与计费(Lite 付费 · 组织成员 · 图表 + 流水)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: accountApi,
    render: () => (
      <FullPage>
        <AccountTab
          auth={auth}
          user={paidUser}
          onManageSub={noop}
          reloadKey={0}
          onRefreshMe={noop}
        />
      </FullPage>
    ),
  },
  {
    id: 'settings-full-usage',
    label: '整页 · 用量(四图 + 累计 + 会话明细含组队)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: accountApi,
    render: () => (
      <FullPage>
        <UsageTab auth={auth} onOpenProjectSettings={noop} />
      </FullPage>
    ),
  },
  {
    id: 'settings-full-preferences',
    label: '整页 · 偏好(Auto-Dream 旧版提示 · QQ 已绑定 · 通知)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getPublicModels: async () => publicModels,
      getQqBinding: async () => ({ available: true, bound: true, maskedOpenid: 'o9F**********3k' }),
    },
    render: () => (
      <FullPage>
        <PreferencesTab
          auth={auth}
          prefs={extractPrefs(prefsFull)}
          autoDream={extractAutoDreamFeature(prefsFull)}
          theme="light"
          onSetTheme={noop}
          onPatch={async () => {}}
          onUpgrade={noop}
          onOpenMemory={noop}
        />
      </FullPage>
    ),
  },
  {
    id: 'settings-full-api-access',
    label: '整页 · API 接入(三把密钥 · 消耗统计 · 请求审计错误态)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      listApiKeys: async () => apiAccessKeys,
      getApiKeyUsage: async () => apiAccessReport,
      getPublicModels: async () => publicModels,
    },
    render: () => (
      <FullPage>
        <ApiAccessTab auth={auth} />
      </FullPage>
    ),
  },
  {
    id: 'org-full-members',
    label: '整页 · 组织成员(五名成员 · 邀请表单 · 邀请记录)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <FullPage>
        <MembersTab
          auth={auth}
          callerRole="owner"
          onRefreshMe={noop}
          subscription={orgSubInfo.subscription}
          canManageBilling
          onAddSeats={noop}
        />
      </FullPage>
    ),
  },
  {
    id: 'org-full-invoices',
    label: '整页 · 组织发票(抬头 · 订单勾选 · 申请记录含驳回备注)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <FullPage>
        <InvoicesTab auth={auth} canManageBilling />
      </FullPage>
    ),
  },
  {
    id: 'settings-account-paid-org',
    label: '设置 · 账户与计费(Lite 付费 · 组织成员 · 有流水)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: accountApi,
    render: () => settings('account', paidUser),
  },
  {
    id: 'settings-account-free-empty',
    label: '设置 · 账户与计费(免费 · 余额 0 · 无组织 · 无流水)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getMySubscription: async () => freeSub,
      getMyUsageReport: async () => usageReportEmpty,
      getUsage: async () => usageResponseEmpty,
    },
    render: () => settings('account', freeUser),
  },
  {
    id: 'settings-usage',
    label: '设置 · 用量(7 天窗口 · 四图 · 会话含组队明细)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: accountApi,
    render: () => settings('usage', paidUser),
  },
  {
    id: 'settings-usage-empty',
    label: '设置 · 用量(全空态)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getMyUsageReport: async () => usageReportEmpty,
      getUsage: async () => usageResponseEmpty,
      listSessions: async () => [],
    },
    render: () => settings('usage', freeUser),
  },
  {
    id: 'settings-preferences',
    label: '设置 · 偏好(Max 可用 Auto-Dream · QQ 已绑定)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getPreferences: async () => prefsSnapshot({ eligible: true, optimizer: false, legacy: true }),
      getPublicModels: async () => publicModels,
      getQqBinding: async () => ({ available: true, bound: true, maskedOpenid: 'o9F**********3k' }),
    },
    render: () => settings('preferences', paidUser),
  },
  {
    id: 'settings-preferences-locked',
    label: '设置 · 偏好(免费用户 Auto-Dream 锁定 · QQ 未配置)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getPreferences: async () => prefsSnapshot({ eligible: false, optimizer: false }),
      getPublicModels: async () => publicModels,
      getQqBinding: async () => ({ available: false, bound: false }),
    },
    render: () => settings('preferences', freeUser),
  },
  {
    id: 'settings-hotkeys',
    label: '设置 · 快捷键',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      // B 阶段(SET-02)后快捷键分区是静态表,不再拉 prefs / 模型列表;这两个桩只作回归哨兵 ——
      // manifest.unmockedApi 若重新出现这两个方法,说明快捷键又被挂回了偏好页的加载链。
      getPreferences: async () => prefsSnapshot({ eligible: true, optimizer: true }),
      getPublicModels: async () => publicModels,
    },
    render: () => settings('hotkeys', paidUser),
  },
  {
    id: 'settings-feedback',
    label: '设置 · 反馈(带会话定位)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => settings('feedback', paidUser),
  },
  {
    // 二期(t-628):关于页带构建号 → 出现「检查更新」;备案位在 brand.ts 仍是占位文案时不渲染。
    id: 'settings-about-update-check',
    label: '设置 · 关于(有构建号:版本行 + 检查更新;备案占位不渲染)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {},
    render: () => (
      <WithBuildMeta build="9f3c2ab7e1d4">{settings('about', paidUser)}</WithBuildMeta>
    ),
  },
  {
    id: 'settings-subscription-dialog',
    label: '订阅中心弹层(Lite 当前 · 五档 · 加量包)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: accountApi,
    render: () => <SubscriptionDialog open auth={auth} onClose={noop} onPaid={noop} />,
  },
  {
    id: 'settings-chatgpt-proxy',
    label: 'ChatGPT 直连向导(已有凭据)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getChatGptProxyAccess: async () => ({
        enabled: true,
        proxyHost: 'proxy.example.openclaude.dev',
        proxyPort: 8443,
        pacUrl: 'https://proxy.example.openclaude.dev/pac/u-paid.pac',
        homeUrl: 'https://chatgpt.com/',
        username: 'u-paid',
        hasCredential: true,
        createdAt: '2026-09-01T08:00:00Z',
        rotatedAt: '2026-09-10T08:00:00Z',
        lastUsedAt: '2026-09-15T12:00:00Z',
      }),
    },
    render: () => <ChatGptProxyDialog open onOpenChange={noop} auth={auth} />,
  },
  {
    id: 'payment-hupijiao-entry',
    label: '支付 · 虎皮椒扫码入口 + 待确认订单恢复条',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: {
      getOrder: async () => ({
        orderNo: 'T20260915153000',
        status: 'pending',
        amountCents: '3800',
        credits: '4000000',
        expiresAt: '2099-01-01T00:00:00Z',
        paidAt: null,
        createdAt: '2026-09-15T15:30:00Z',
        provider: 'hupijiao',
      }),
    },
    render: () => {
      savePendingPayment({ orderNo: 'T20260915153000', label: '套餐订阅' })
      return (
        <div className="min-h-screen bg-bg p-6 text-fg">
          <div className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-surface p-5">
            <div className="text-center text-meta text-faint">订阅 Lite</div>
            <HupijiaoPaymentEntry
              qrcodeUrl={QR_PLACEHOLDER}
              mobileUrl="https://pay.xunhupay.com/h5/abc"
              pendingPayment={{ orderNo: 'T20260915153000', label: '套餐订阅' }}
              amountCents="3800"
              expiresAt="2099-01-01T00:00:00Z"
              onReorder={noop}
              token="preview-token"
            />
          </div>
          <PendingPaymentRecovery auth={auth} onPaid={noop} />
        </div>
      )
    },
  },
  {
    id: 'org-center-overview',
    label: '组织中心 · 概览(owner · 已订阅 · 席位满)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgCenter
        open
        auth={auth}
        user={ownerUser}
        onClose={noop}
        onRefreshMe={noop}
        initialSection="overview"
      />
    ),
  },
  {
    id: 'org-center-members',
    label: '组织中心 · 成员(owner 视角 · 限额 · 邀请)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgCenter
        open
        auth={auth}
        user={ownerUser}
        onClose={noop}
        onRefreshMe={noop}
        initialSection="members"
      />
    ),
  },
  {
    id: 'org-center-skills',
    label: '组织中心 · 技能',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgCenter
        open
        auth={auth}
        user={ownerUser}
        onClose={noop}
        onRefreshMe={noop}
        initialSection="skills"
      />
    ),
  },
  {
    id: 'org-center-reports',
    label: '组织中心 · 报表(24h)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgCenter
        open
        auth={auth}
        user={ownerUser}
        onClose={noop}
        onRefreshMe={noop}
        initialSection="reports"
      />
    ),
  },
  {
    id: 'org-center-invoices',
    label: '组织中心 · 发票(owner 可写)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgCenter
        open
        auth={auth}
        user={ownerUser}
        onClose={noop}
        onRefreshMe={noop}
        initialSection="invoices"
      />
    ),
  },
  {
    id: 'org-center-wizard',
    label: '组织中心 · 无组织 → 创建向导(选档步骤)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => <OrgCenter open auth={auth} user={freeUser} onClose={noop} onRefreshMe={noop} />,
  },
  {
    id: 'org-topup-dialog',
    label: '组织充值弹层(填额段)',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgTopupDialog open auth={auth} baselineCredits="8650000" onClose={noop} onPaid={noop} />
    ),
  },
  {
    id: 'org-subscribe-dialog',
    label: '组织续费 / 变更套餐弹层',
    group: '工作区',
    viewports: ['desktop', 'mobile'],
    api: orgApi,
    render: () => (
      <OrgSubscribeDialog
        open
        auth={auth}
        mode="subscribe"
        subInfo={orgSubInfo}
        onClose={noop}
        onPaid={noop}
      />
    ),
  },
]
