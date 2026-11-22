import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Value } from '@sinclair/typebox/value'

import {
  BillingSubscriptionMeResponseSchema,
  HTTP_REST_CONTRACTS,
  HTTP_REST_CONTRACT_DOMAINS,
  ListPendingDecisionsResponseSchema,
  PublicModelsResponseSchema,
  PutSessionRequestSchema,
  PutSessionResponseSchema,
  ResolvePendingDecisionRequestSchema,
  ResolvePendingDecisionResponseSchema,
  SessionListResponseSchema,
  SiteDetailResponseSchema,
  SitesSummaryResponseSchema,
  serializeRestContractSnapshot,
} from '../httpContracts.js'

describe('httpContracts: 5 core REST domain schemas', () => {
  it('1. sessions: validates GET /api/sessions/list & PUT /api/sessions/:id payloads and rejects malformed payloads', () => {
    const validList = {
      sessions: [
        {
          id: 'sess-001',
          agentId: 'main',
          title: 'Governance Wave 2',
          pinned: true,
          createdAt: 1763800000000,
          lastAt: 1763800123000,
          messageCount: 12,
          updatedAt: 1763800123000,
          modelId: 'gpt-6.2-astra',
          projectId: null,
          runState: 'idle',
          lastOutcome: 'completed',
          lastErrorCode: null,
          archived: false,
          unread: false,
          lastMessagePreview: 'Done.',
        },
      ],
      nextCursor: 1763799000000,
    }
    assert.equal(Value.Check(SessionListResponseSchema, validList), true)

    // Bad payload: invalid runState enum & negative messageCount
    assert.equal(
      Value.Check(SessionListResponseSchema, {
        sessions: [{ ...validList.sessions[0], runState: 'paused' }],
      }),
      false,
    )
    assert.equal(
      Value.Check(SessionListResponseSchema, {
        sessions: [{ ...validList.sessions[0], messageCount: -1 }],
      }),
      false,
    )
    // Missing required `id`
    const { id: _omitted, ...missingId } = validList.sessions[0]!
    assert.equal(Value.Check(SessionListResponseSchema, { sessions: [missingId] }), false)

    // PUT /api/sessions/:id request & both real 200 response variants (clientSessions.ts:1085-1117)
    assert.equal(
      Value.Check(PutSessionRequestSchema, {
        title: 'Updated title',
        pinned: false,
        modelId: 'gpt-6.2-astra',
        _baseSyncedAt: 1763800123000,
      }),
      true,
    )
    assert.equal(Value.Check(PutSessionRequestSchema, { pinned: 'yes' }), false)
    assert.equal(
      Value.Check(PutSessionResponseSchema, { ok: true, applied: true, updatedAt: 1763800200000 }),
      true,
    )
    assert.equal(
      Value.Check(PutSessionResponseSchema, { ok: true, applied: false, existed: true }),
      true,
    )
    assert.equal(
      Value.Check(PutSessionResponseSchema, { ok: false, applied: true, updatedAt: 1763800200000 }),
      false,
    )
    assert.equal(
      Value.Check(PutSessionResponseSchema, { ok: true, applied: false }),
      false,
    )
    assert.equal(
      Value.Check(PutSessionResponseSchema, { ok: true, applied: true, existed: true }),
      false,
    )
  })

  it('2. billing: validates GET /api/subscription/me with string-bigint balances and rejects numeric balances', () => {
    const validBilling = {
      ok: true,
      data: {
        subscription: {
          plan_code: 'pro_monthly',
          plan_name: 'Pro',
          status: 'active',
          period_start: '2026-11-01T00:00:00.000Z',
          period_end: '2026-12-01T00:00:00.000Z',
          period_credits: '500000',
          monthly_credits: '1000000',
          price_cents: '9900',
          tier: 2,
          paid: true,
        },
        balance: {
          wallet: '125000',
          period: '500000',
          total: '625000',
        },
      },
    }
    assert.equal(Value.Check(BillingSubscriptionMeResponseSchema, validBilling), true)

    // Credits MUST stay string bigints (never JS numbers)
    assert.equal(
      Value.Check(BillingSubscriptionMeResponseSchema, {
        ...validBilling,
        data: {
          ...validBilling.data,
          balance: { wallet: 125000, period: '500000', total: '625000' },
        },
      }),
      false,
    )
    assert.equal(
      Value.Check(BillingSubscriptionMeResponseSchema, {
        ok: true,
        data: { subscription: validBilling.data.subscription },
      }),
      false,
    )
  })

  it('3. pendingDecisions: validates list & resolve payloads and rejects invalid sources/actions', () => {
    const validList = {
      items: [
        {
          id: 'turn_permission:req-42',
          source: 'turn_permission',
          sourceId: 'req-42',
          userId: '1001',
          sessionId: 'sess-001',
          title: 'Allow Bash execution',
          summary: 'Run database check script',
          riskLevel: 'high',
          status: 'pending',
          metadata: { toolName: 'Bash' },
          createdAt: '2026-11-22T10:00:00.000Z',
          expiresAt: '2026-11-22T10:15:00.000Z',
          allowedActions: ['approve', 'deny'],
        },
      ],
      counts: {
        total: 1,
        bySource: {
          turn_permission: 1,
          connector_write: 0,
          taskboard: 0,
          browser_handoff: 0,
        },
      },
      generatedAt: '2026-11-22T10:00:01.000Z',
    }
    assert.equal(Value.Check(ListPendingDecisionsResponseSchema, validList), true)

    assert.equal(
      Value.Check(ListPendingDecisionsResponseSchema, {
        ...validList,
        items: [{ ...validList.items[0], source: 'unknown_source' }],
      }),
      false,
    )

    assert.equal(
      Value.Check(ResolvePendingDecisionRequestSchema, {
        decision: 'approve',
        reason: 'looks safe',
        idempotencyKey: 'idem-001',
        originChannel: 'web',
      }),
      true,
    )
    assert.equal(
      Value.Check(ResolvePendingDecisionRequestSchema, { decision: 'maybe' }),
      false,
    )

    assert.equal(
      Value.Check(ResolvePendingDecisionResponseSchema, {
        id: 'turn_permission:req-42',
        source: 'turn_permission',
        sourceId: 'req-42',
        decision: 'approve',
        status: 'approved',
        idempotentReplay: false,
        resolvedAt: '2026-11-22T10:01:00.000Z',
      }),
      true,
    )
    assert.equal(
      Value.Check(ResolvePendingDecisionResponseSchema, {
        id: 'turn_permission:req-42',
        source: 'turn_permission',
        sourceId: 'req-42',
        decision: 'approve',
        status: 'pending', // resolved status must be 'approved' | 'denied'
        idempotentReplay: false,
        resolvedAt: '2026-11-22T10:01:00.000Z',
      }),
      false,
    )
  })

  it('4. sites: validates GET /api/sites summary & GET /api/sites/:slug detail and rejects bad payloads', () => {
    const sampleSite = {
      id: 'site-1',
      slug: 'my-demo-app',
      url: 'https://my-demo-app.sites.example.com',
      accessRole: 'owner',
      ownerEmail: 'dev@example.com',
      ownerDisplayName: 'Dev',
      collaboratorCount: 1,
      customDomain: null,
      customDomainStatus: 'none',
      originSessionId: 'sess-001',
      hasServerApi: false,
      title: 'My Demo App',
      visibility: 'public',
      spaMode: true,
      fileCount: 14,
      sizeBytes: 51200,
      contentSha256: 'abc123',
      edgeRevision: 3,
      createdAt: '2026-11-20T00:00:00.000Z',
      updatedAt: '2026-11-22T00:00:00.000Z',
      lastPublishedAt: '2026-11-22T00:00:00.000Z',
    }
    assert.equal(
      Value.Check(SitesSummaryResponseSchema, {
        enabled: true,
        baseDomain: 'sites.example.com',
        maxPerUser: 10,
        maxSiteBytes: 104857600,
        sites: [sampleSite],
      }),
      true,
    )
    assert.equal(
      Value.Check(SiteDetailResponseSchema, {
        site: sampleSite,
        envVars: [
          {
            key: 'PUBLIC_API_BASE',
            value: 'https://api.example.com',
            isSecret: false,
            hasValue: true,
            updatedAt: '2026-11-22T00:00:00.000Z',
          },
        ],
      }),
      true,
    )

    // Invalid visibility enum
    assert.equal(
      Value.Check(SiteDetailResponseSchema, {
        site: { ...sampleSite, visibility: 'private' },
        envVars: [],
      }),
      false,
    )
  })

  it('5. models: validates GET /api/public/models and rejects bad model entries', () => {
    const validModels = {
      models: [
        {
          id: 'gpt-6.2-astra',
          display_name: 'GPT-6.2-Astra',
          input_per_ktok_credits: '1.500000',
          output_per_ktok_credits: '6.000000',
          cache_read_per_ktok_credits: '0.150000',
          cache_write_per_ktok_credits: '1.500000',
          multiplier: '1.000',
          supported_efforts: ['low', 'medium', 'high', 'xhigh'],
          engine: 'codex',
          placement: 'local',
          context_window: 272000,
          supports_vision: true,
          provider_id: null,
          cost_x: 3.2,
          degraded: false,
        },
      ],
      locked_models: [
        {
          id: 'box-api-claude-opus-5-5',
          display_name: 'Claude Opus 5.5',
          engine: 'ccb',
          min_plan_code: 'pro_monthly',
          min_plan_name: 'Pro',
          cost_x: 5.0,
        },
      ],
      team_leader_model: 'gpt-6.2-astra',
    }
    assert.equal(Value.Check(PublicModelsResponseSchema, validModels), true)

    // Invalid effort level (`ultra` is explicitly NOT exposed on platform)
    assert.equal(
      Value.Check(PublicModelsResponseSchema, {
        models: [{ id: 'gpt-6.2-astra', supported_efforts: ['ultra'] }],
      }),
      false,
    )
    // Empty model id
    assert.equal(
      Value.Check(PublicModelsResponseSchema, {
        models: [{ id: '' }],
      }),
      false,
    )
  })

  it('registry covers all 5 core domains and snapshot serialization is deterministic', () => {
    const domainsCovered = new Set(Object.values(HTTP_REST_CONTRACTS).map((c) => c.domain))
    assert.deepEqual([...domainsCovered].sort(), [...HTTP_REST_CONTRACT_DOMAINS].sort())

    const s1 = JSON.stringify(serializeRestContractSnapshot())
    const s2 = JSON.stringify(serializeRestContractSnapshot())
    assert.equal(s1, s2)
  })
})
