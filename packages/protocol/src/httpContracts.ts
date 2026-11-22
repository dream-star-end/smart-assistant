/**
 * Core 5-Domain REST API Protocol Contracts (TypeBox Single Source of Truth).
 *
 * Covers the five high-frequency HTTP contract domains grounded directly in
 * Master (`packages/commercial/src/http/`) & Web (`packages/web-react/src/lib/`):
 *   1. sessions         — GET /api/sessions/list, PUT /api/sessions/:id
 *   2. billing          — GET /api/subscription/me
 *   3. pendingDecisions — GET /api/me/pending-decisions, POST /api/me/pending-decisions/:id/resolve
 *   4. sites            — GET /api/sites, GET /api/sites/:slug
 *   5. models           — GET /api/public/models
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed here.
 */
import { type Static, type TSchema, Type } from '@sinclair/typebox'

export const HTTP_REST_CONTRACT_DOMAINS = [
  'sessions',
  'billing',
  'pendingDecisions',
  'sites',
  'models',
] as const
export type HttpRestContractDomain = (typeof HTTP_REST_CONTRACT_DOMAINS)[number]

// ─── 1. Sessions ─────────────────────────────────────────────────────────────

export const SessionRunStateSchema = Type.Union([Type.Literal('running'), Type.Literal('idle')])
export type SessionRunStateContract = Static<typeof SessionRunStateSchema>

export const SessionLastOutcomeSchema = Type.Union([
  Type.Literal('completed'),
  Type.Literal('interrupted'),
  Type.Literal('crashed'),
  Type.Literal('not_accepted'),
  Type.Literal('executed_error'),
])
export type SessionLastOutcomeContract = Static<typeof SessionLastOutcomeSchema>

export const SessionMetaContractSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  agentId: Type.String({ minLength: 1 }),
  title: Type.String(),
  pinned: Type.Boolean(),
  createdAt: Type.Number(),
  lastAt: Type.Number(),
  messageCount: Type.Integer({ minimum: 0 }),
  updatedAt: Type.Number(),
  modelId: Type.Optional(Type.String()),
  projectId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  runState: Type.Optional(SessionRunStateSchema),
  lastOutcome: Type.Optional(Type.Union([SessionLastOutcomeSchema, Type.Null()])),
  lastErrorCode: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  archived: Type.Optional(Type.Boolean()),
  unread: Type.Optional(Type.Boolean()),
  lastMessagePreview: Type.Optional(Type.String()),
})
export type SessionMetaContract = Static<typeof SessionMetaContractSchema>

export const SessionListQuerySchema = Type.Object({
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
  before: Type.Optional(Type.Number()),
  includeArchived: Type.Optional(Type.Boolean()),
})
export type SessionListQueryContract = Static<typeof SessionListQuerySchema>

export const SessionListResponseSchema = Type.Object({
  sessions: Type.Array(SessionMetaContractSchema),
  nextCursor: Type.Optional(Type.Number()),
})
export type SessionListResponseContract = Static<typeof SessionListResponseSchema>

export const PutSessionRequestSchema = Type.Object({
  agentId: Type.Optional(Type.String()),
  title: Type.Optional(Type.String()),
  pinned: Type.Optional(Type.Boolean()),
  createdAt: Type.Optional(Type.Number()),
  lastAt: Type.Optional(Type.Number()),
  messages: Type.Optional(Type.Array(Type.Unknown())),
  modelId: Type.Optional(Type.String()),
  _baseSyncedAt: Type.Optional(Type.Number()),
})
export type PutSessionRequestContract = Static<typeof PutSessionRequestSchema>

/**
 * PUT /api/sessions/:id 200 response variants (grounded in `packages/gateway/src/routes/clientSessions.ts:1085-1117`):
 *   - Upsert applied: `{ ok: true, applied: true, updatedAt }`
 *   - Ensure probe hit existing active row (no-op): `{ ok: true, applied: false, existed: true }`
 */
export const PutSessionAppliedResponseSchema = Type.Object({
  ok: Type.Literal(true),
  applied: Type.Literal(true),
  updatedAt: Type.Number(),
})
export type PutSessionAppliedResponseContract = Static<typeof PutSessionAppliedResponseSchema>

export const PutSessionExistedResponseSchema = Type.Object({
  ok: Type.Literal(true),
  applied: Type.Literal(false),
  existed: Type.Literal(true),
})
export type PutSessionExistedResponseContract = Static<typeof PutSessionExistedResponseSchema>

export const PutSessionResponseSchema = Type.Union([
  PutSessionAppliedResponseSchema,
  PutSessionExistedResponseSchema,
])
export type PutSessionResponseContract = Static<typeof PutSessionResponseSchema>

// ─── 2. Billing ──────────────────────────────────────────────────────────────

/** Dual-wallet balance breakdown; all credit fields are exact BigInt strings (never JS number). */
export const BillingBalanceBreakdownSchema = Type.Object({
  wallet: Type.String({ minLength: 1 }),
  period: Type.String({ minLength: 1 }),
  total: Type.String({ minLength: 1 }),
})
export type BillingBalanceBreakdownContract = Static<typeof BillingBalanceBreakdownSchema>

export const BillingSubscriptionSummarySchema = Type.Object({
  plan_code: Type.String({ minLength: 1 }),
  plan_name: Type.String(),
  status: Type.String({ minLength: 1 }),
  period_start: Type.String(),
  period_end: Type.String(),
  period_credits: Type.String({ minLength: 1 }),
  monthly_credits: Type.String({ minLength: 1 }),
  price_cents: Type.String({ minLength: 1 }),
  tier: Type.Integer({ minimum: 0 }),
  paid: Type.Boolean(),
})
export type BillingSubscriptionSummaryContract = Static<typeof BillingSubscriptionSummarySchema>

export const BillingSubscriptionMeResponseSchema = Type.Object({
  ok: Type.Boolean(),
  data: Type.Object({
    subscription: BillingSubscriptionSummarySchema,
    balance: BillingBalanceBreakdownSchema,
  }),
})
export type BillingSubscriptionMeResponseContract = Static<
  typeof BillingSubscriptionMeResponseSchema
>

// ─── 3. Pending Decisions ────────────────────────────────────────────────────

export const PendingDecisionSourceSchema = Type.Union([
  Type.Literal('turn_permission'),
  Type.Literal('connector_write'),
  Type.Literal('taskboard'),
  Type.Literal('browser_handoff'),
])

export const PendingDecisionStatusSchema = Type.Union([
  Type.Literal('pending'),
  Type.Literal('approved'),
  Type.Literal('denied'),
  Type.Literal('expired'),
  Type.Literal('cancelled'),
])

export const PendingDecisionActionSchema = Type.Union([
  Type.Literal('approve'),
  Type.Literal('deny'),
])

export const PendingDecisionRiskLevelSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('critical'),
])

export const PendingDecisionItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  source: PendingDecisionSourceSchema,
  sourceId: Type.String({ minLength: 1 }),
  userId: Type.String({ minLength: 1 }),
  sessionId: Type.Union([Type.String(), Type.Null()]),
  title: Type.String(),
  summary: Type.String(),
  riskLevel: PendingDecisionRiskLevelSchema,
  status: PendingDecisionStatusSchema,
  metadata: Type.Record(Type.String(), Type.Unknown()),
  createdAt: Type.String({ minLength: 1 }),
  expiresAt: Type.Union([Type.String(), Type.Null()]),
  allowedActions: Type.Array(PendingDecisionActionSchema),
})
export type PendingDecisionItemContract = Static<typeof PendingDecisionItemSchema>

export const PendingDecisionWarningSchema = Type.Object({
  source: PendingDecisionSourceSchema,
  code: Type.String({ minLength: 1 }),
  message: Type.String(),
})
export type PendingDecisionWarningContract = Static<typeof PendingDecisionWarningSchema>

export const ListPendingDecisionsQuerySchema = Type.Object({
  source: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1 })),
})
export type ListPendingDecisionsQueryContract = Static<typeof ListPendingDecisionsQuerySchema>

export const ListPendingDecisionsResponseSchema = Type.Object({
  items: Type.Array(PendingDecisionItemSchema),
  counts: Type.Object({
    total: Type.Integer({ minimum: 0 }),
    bySource: Type.Object({
      turn_permission: Type.Integer({ minimum: 0 }),
      connector_write: Type.Integer({ minimum: 0 }),
      taskboard: Type.Integer({ minimum: 0 }),
      browser_handoff: Type.Integer({ minimum: 0 }),
    }),
  }),
  warnings: Type.Optional(Type.Array(PendingDecisionWarningSchema)),
  generatedAt: Type.String({ minLength: 1 }),
})
export type ListPendingDecisionsResponseContract = Static<
  typeof ListPendingDecisionsResponseSchema
>

export const ResolvePendingDecisionRequestSchema = Type.Object({
  decision: PendingDecisionActionSchema,
  reason: Type.Optional(Type.String()),
  idempotencyKey: Type.Optional(Type.String()),
  originChannel: Type.Optional(Type.String()),
})
export type ResolvePendingDecisionRequestContract = Static<
  typeof ResolvePendingDecisionRequestSchema
>

export const ResolvePendingDecisionResponseSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  source: PendingDecisionSourceSchema,
  sourceId: Type.String({ minLength: 1 }),
  decision: PendingDecisionActionSchema,
  status: Type.Union([Type.Literal('approved'), Type.Literal('denied')]),
  idempotentReplay: Type.Boolean(),
  resolvedAt: Type.String({ minLength: 1 }),
  message: Type.Optional(Type.String()),
})
export type ResolvePendingDecisionResponseContract = Static<
  typeof ResolvePendingDecisionResponseSchema
>

// ─── 4. Sites ────────────────────────────────────────────────────────────────

export const UserSiteVisibilitySchema = Type.Union([
  Type.Literal('public'),
  Type.Literal('password'),
  Type.Literal('disabled'),
])

export const UserSiteCustomDomainStatusSchema = Type.Union([
  Type.Literal('none'),
  Type.Literal('pending'),
  Type.Literal('verified'),
])

export const UserSiteAccessRoleSchema = Type.Union([
  Type.Literal('owner'),
  Type.Literal('editor'),
  Type.Literal('viewer'),
])

export const UserSiteItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  slug: Type.String({ minLength: 1 }),
  url: Type.String({ minLength: 1 }),
  accessRole: Type.Optional(UserSiteAccessRoleSchema),
  ownerEmail: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  ownerDisplayName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  collaboratorCount: Type.Optional(Type.Integer({ minimum: 0 })),
  customDomain: Type.Union([Type.String(), Type.Null()]),
  customDomainStatus: Type.Optional(UserSiteCustomDomainStatusSchema),
  customDomainTxtName: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  customDomainTxtValue: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  originSessionId: Type.Union([Type.String(), Type.Null()]),
  hasServerApi: Type.Boolean(),
  title: Type.String(),
  visibility: UserSiteVisibilitySchema,
  spaMode: Type.Boolean(),
  fileCount: Type.Integer({ minimum: 0 }),
  sizeBytes: Type.Integer({ minimum: 0 }),
  contentSha256: Type.String(),
  edgeRevision: Type.Integer({ minimum: 0 }),
  createdAt: Type.String({ minLength: 1 }),
  updatedAt: Type.String({ minLength: 1 }),
  lastPublishedAt: Type.String({ minLength: 1 }),
})
export type UserSiteItemContract = Static<typeof UserSiteItemSchema>

export const SiteEnvVarItemSchema = Type.Object({
  key: Type.String({ minLength: 1 }),
  value: Type.Union([Type.String(), Type.Null()]),
  isSecret: Type.Boolean(),
  hasValue: Type.Boolean(),
  updatedAt: Type.String({ minLength: 1 }),
})
export type SiteEnvVarItemContract = Static<typeof SiteEnvVarItemSchema>

export const SitesSummaryResponseSchema = Type.Object({
  enabled: Type.Boolean(),
  baseDomain: Type.String(),
  maxPerUser: Type.Integer({ minimum: 0 }),
  maxSiteBytes: Type.Integer({ minimum: 0 }),
  sites: Type.Array(UserSiteItemSchema),
})
export type SitesSummaryResponseContract = Static<typeof SitesSummaryResponseSchema>

export const SiteDetailResponseSchema = Type.Object({
  site: UserSiteItemSchema,
  envVars: Type.Array(SiteEnvVarItemSchema),
})
export type SiteDetailResponseContract = Static<typeof SiteDetailResponseSchema>

// ─── 5. Models ───────────────────────────────────────────────────────────────

export const PublicModelEffortSchema = Type.Union([
  Type.Literal('low'),
  Type.Literal('medium'),
  Type.Literal('high'),
  Type.Literal('xhigh'),
  Type.Literal('max'),
])

export const PublicModelEngineSchema = Type.Union([
  Type.Literal('ccb'),
  Type.Literal('codex'),
  Type.Literal('grok'),
  Type.Literal('cursor'),
  Type.Literal('zcode'),
  Type.Literal('antigravity'),
])

export const PublicModelPlacementSchema = Type.Union([
  Type.Literal('local'),
  Type.Literal('remote_pool'),
])

export const PublicModelItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  display_name: Type.Optional(Type.String()),
  input_per_ktok_credits: Type.Optional(Type.String()),
  output_per_ktok_credits: Type.Optional(Type.String()),
  cache_read_per_ktok_credits: Type.Optional(Type.String()),
  cache_write_per_ktok_credits: Type.Optional(Type.String()),
  multiplier: Type.Optional(Type.String()),
  supported_efforts: Type.Optional(Type.Array(PublicModelEffortSchema)),
  engine: Type.Optional(PublicModelEngineSchema),
  placement: Type.Optional(PublicModelPlacementSchema),
  context_window: Type.Optional(Type.Union([Type.Integer({ minimum: 0 }), Type.Null()])),
  supports_vision: Type.Optional(Type.Boolean()),
  provider_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  cost_x: Type.Optional(Type.Number()),
  degraded: Type.Optional(Type.Boolean()),
  promo_label: Type.Optional(Type.String()),
})
export type PublicModelItemContract = Static<typeof PublicModelItemSchema>

export const LockedPublicModelItemSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  display_name: Type.Optional(Type.String()),
  engine: Type.Optional(Type.String()),
  min_plan_code: Type.String({ minLength: 1 }),
  min_plan_name: Type.Optional(Type.String()),
  cost_x: Type.Optional(Type.Number()),
  promo_label: Type.Optional(Type.String()),
  placement: Type.Optional(PublicModelPlacementSchema),
})
export type LockedPublicModelItemContract = Static<typeof LockedPublicModelItemSchema>

export const PublicModelsResponseSchema = Type.Object({
  models: Type.Array(PublicModelItemSchema),
  locked_models: Type.Optional(Type.Array(LockedPublicModelItemSchema)),
  team_leader_model: Type.Optional(Type.Union([Type.String(), Type.Null()])),
})
export type PublicModelsResponseContract = Static<typeof PublicModelsResponseSchema>

// ─── Canonical Route Contract Registry & Snapshot Serializer ─────────────────

export interface HttpRouteContractDef {
  readonly domain: HttpRestContractDomain
  readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly params?: TSchema
  readonly query?: TSchema
  readonly request?: TSchema
  readonly response: TSchema
}

export const HTTP_REST_CONTRACTS: Readonly<Record<string, HttpRouteContractDef>> = {
  'GET /api/sessions/list': {
    domain: 'sessions',
    method: 'GET',
    path: '/api/sessions/list',
    query: SessionListQuerySchema,
    response: SessionListResponseSchema,
  },
  'PUT /api/sessions/:id': {
    domain: 'sessions',
    method: 'PUT',
    path: '/api/sessions/:id',
    request: PutSessionRequestSchema,
    response: PutSessionResponseSchema,
  },
  'GET /api/subscription/me': {
    domain: 'billing',
    method: 'GET',
    path: '/api/subscription/me',
    response: BillingSubscriptionMeResponseSchema,
  },
  'GET /api/me/pending-decisions': {
    domain: 'pendingDecisions',
    method: 'GET',
    path: '/api/me/pending-decisions',
    query: ListPendingDecisionsQuerySchema,
    response: ListPendingDecisionsResponseSchema,
  },
  'POST /api/me/pending-decisions/:id/resolve': {
    domain: 'pendingDecisions',
    method: 'POST',
    path: '/api/me/pending-decisions/:id/resolve',
    request: ResolvePendingDecisionRequestSchema,
    response: ResolvePendingDecisionResponseSchema,
  },
  'GET /api/sites': {
    domain: 'sites',
    method: 'GET',
    path: '/api/sites',
    response: SitesSummaryResponseSchema,
  },
  'GET /api/sites/:slug': {
    domain: 'sites',
    method: 'GET',
    path: '/api/sites/:slug',
    response: SiteDetailResponseSchema,
  },
  'GET /api/public/models': {
    domain: 'models',
    method: 'GET',
    path: '/api/public/models',
    response: PublicModelsResponseSchema,
  },
}

export interface SerializedRouteContract {
  domain: HttpRestContractDomain
  method: string
  path: string
  params?: Record<string, unknown>
  query?: Record<string, unknown>
  request?: Record<string, unknown>
  response: Record<string, unknown>
}

export interface RestContractSnapshot {
  schema: 1
  domains: readonly HttpRestContractDomain[]
  routes: Record<string, SerializedRouteContract>
}

/** Recursively normalize a JSON value with lexicographically sorted object keys (strips Symbol keys). */
function canonicalizeJsonValue(val: unknown): unknown {
  if (Array.isArray(val)) {
    return val.map(canonicalizeJsonValue)
  }
  if (val !== null && typeof val === 'object') {
    const src = val as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(src).sort()) {
      const v = src[key]
      if (v !== undefined) {
        out[key] = canonicalizeJsonValue(v)
      }
    }
    return out
  }
  return val
}

/** Produce a deterministic, pure JSON Schema snapshot of all registered REST contracts. */
export function serializeRestContractSnapshot(
  contracts: Readonly<Record<string, HttpRouteContractDef>> = HTTP_REST_CONTRACTS,
): RestContractSnapshot {
  const routes: Record<string, SerializedRouteContract> = {}
  for (const key of Object.keys(contracts).sort()) {
    const def = contracts[key]!
    const entry: SerializedRouteContract = {
      domain: def.domain,
      method: def.method,
      path: def.path,
      response: canonicalizeJsonValue(def.response) as Record<string, unknown>,
    }
    if (def.params) {
      entry.params = canonicalizeJsonValue(def.params) as Record<string, unknown>
    }
    if (def.query) {
      entry.query = canonicalizeJsonValue(def.query) as Record<string, unknown>
    }
    if (def.request) {
      entry.request = canonicalizeJsonValue(def.request) as Record<string, unknown>
    }
    routes[key] = entry
  }
  return {
    schema: 1,
    domains: [...HTTP_REST_CONTRACT_DOMAINS],
    routes,
  }
}
