import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import type { Pool, PoolClient, QueryResult } from 'pg'
import { Value } from '@sinclair/typebox/value'
import { PublicModelsResponseSchema } from '@openclaude/protocol'
import { SignJWT } from 'jose'
import {
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
} from '../billing/modelCatalog.js'
import { projectLockedModels, projectPublicModels } from '../billing/modelPublicProjection.js'
import type { QueryRunner } from '../db/queries.js'
import { createPgSessionsBackend } from '../db/pgSessionsBackend.js'
import { handleListPublicModels, type CommercialHttpDeps, type RequestContext } from '../http/handlers.js'
import { MarketplaceError, RetryableInstallConflictError } from '../marketplace/marketplaceDb.js'
import { replaceTutorialBlobRefs, upsertTutorialBlobs } from '../tutorials/tutorialBlobs.js'
import type { TutorialBlobDraft } from '../tutorials/snapshotSanitizer.js'
import { PreferencesError, resolvePreferencesPatch } from '../user/preferences.js'
import { readPgSessionsBackendSource } from './helpers/pgSessionsSource.js'
import { readUserChatBridgeSource } from './helpers/userChatBridgeSource.js'

const JWT_SECRET = new Uint8Array(32).fill(7)

function makeRes() {
  let statusCode = 200
  let raw = ''
  const res = {
    get statusCode() { return statusCode },
    set statusCode(v: number) { statusCode = v },
    setHeader() {},
    end(chunk?: string) { raw = chunk ?? '' },
  } as unknown as import('node:http').ServerResponse
  return { res, get status() { return statusCode }, json: () => JSON.parse(raw) }
}

function makeCatalogEntry(over: Partial<ModelCatalogEntry> & { modelId: string }): ModelCatalogEntry {
  return {
    entryId: 1,
    engine: 'ccb',
    providerId: 'deepseek',
    upstreamModelId: null,
    contextWindow: 128000,
    capabilityProfile: {
      reasoning: { supported: ['low', 'medium', 'high'], codexModelDefault: null },
      supportsVision: true,
      ccb: { capabilityZero: false, supportsThinking: true },
    },
    capabilitySchemaVersion: 1,
    state: 'active',
    lockVersion: 1,
    ...over,
  }
}

function makePricingRow(over: Partial<ModelCatalogPricing> & { modelId: string }): ModelCatalogPricing {
  return {
    displayName: over.modelId,
    inputPerMtok: 100n,
    outputPerMtok: 300n,
    cacheReadPerMtok: 20n,
    cacheWritePerMtok: 125n,
    multiplier: '1.250',
    sortOrder: 10,
    visibility: 'public',
    defaultEffort: null,
    minPlanCode: null,
    minPlanTier: null,
    minPlanName: null,
    promoLabel: null,
    ...over,
  }
}

describe('Wave 3 PG perf, model projection, Auto-Dream, Law 2 & tutorial batching', () => {
  test('batchClientSessions(delete) uses 7 batch ANY($1::text[]) statements and idx_pup_parent user_id predicate', async () => {
    const queries: Array<{ sql: string; params: unknown[] | undefined }> = []
    const mockClient = {
      async query(sql: string, params?: unknown[]) {
        queries.push({ sql, params })
        if (/^SELECT id FROM client_sessions/i.test(sql.trim())) {
          return { rows: [{ id: 's1' }, { id: 's2' }, { id: 's3' }], rowCount: 3 } as QueryResult
        }
        if (/^UPDATE client_sessions/i.test(sql.trim())) {
          // Simulate s3 concurrently deleted before UPDATE
          return { rows: [{ id: 's1' }, { id: 's2' }], rowCount: 2 } as QueryResult
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult
      },
      release() {},
    } as unknown as PoolClient

    const mockPool = {
      async connect() { return mockClient },
      async query() { return { rows: [], rowCount: 0 } as unknown as QueryResult },
    } as unknown as Pool

    const deletedNotifications: Array<{ userId: string | undefined; ids: string[] }> = []
    const backend = createPgSessionsBackend(mockPool, {
      expectedGeneration: 1,
      onClientSessionsDeleted: (userId, ids) => {
        deletedNotifications.push({ userId, ids: [...ids] })
      },
    })

    const res = await backend.batchClientSessions('c:42', {
      action: 'delete',
      ids: ['s1', 's2', 's3'],
    })

    assert.equal(res.ok, true)
    if (res.ok) {
      assert.equal(res.updated, 2)
      assert.equal(res.skipped, 0)
    }
    assert.deepEqual(deletedNotifications, [{ userId: 'c:42', ids: ['s1', 's2'] }])

    const writeSqls = queries.filter(
      (q) => /^\s*(UPDATE|DELETE)\b/i.test(q.sql),
    )
    assert.equal(writeSqls.length, 7, 'batch delete must issue 1 UPDATE + 6 DELETE statements regardless of N')
    for (const w of writeSqls) {
      assert.match(w.sql, /ANY\(\$1::text\[\]\)/i, `expected batch ANY predicate in: ${w.sql}`)
    }
    const pupDelete = writeSqls.find((w) => /DELETE FROM pending_usage_patches/i.test(w.sql))
    assert.ok(pupDelete, 'expected pending_usage_patches delete')
    assert.match(pupDelete.sql, /user_id\s*=\s*\$2/i, 'must include user_id predicate for idx_pup_parent')
    assert.match(pupDelete.sql, /parent_session_id\s+IS\s+NOT\s+NULL/i, 'must match partial index predicate')
    assert.deepEqual(pupDelete.params, [['s1', 's2'], 'c:42'])
  })

  test('getClientSession executes openDispatch and permissionPrompts queries in parallel via Promise.all', async () => {
    let sawDispatch = false
    let sawPermission = false
    let releaseDispatch!: () => void
    const dispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve })

    const mockPool = {
      async query(sql: string) {
        if (/FROM client_sessions\b/i.test(sql)) {
          return {
            rows: [{
              id: 'sess-1',
              user_id: 'c:42',
              agent_id: 'main',
              title: 'Parallel Read',
              pinned: 0,
              created_at: '1000',
              last_at: '2000',
              messages: '[]',
              updated_at: '2000',
              history_revision: '1',
              timeline_generation: '1',
              model_id: null,
              archived_count: '0',
              archived_through_seq: '0',
            }],
            rowCount: 1,
          } as QueryResult
        }
        if (/FROM turn_dispatches\b/i.test(sql)) {
          sawDispatch = true
          // Only resolves once permission query has ALSO started (proves concurrency!)
          await dispatchGate
          return { rows: [], rowCount: 0 } as unknown as QueryResult
        }
        if (/turn_permission_requests/i.test(sql)) {
          sawPermission = true
          releaseDispatch()
          return { rows: [], rowCount: 0 } as unknown as QueryResult
        }
        return { rows: [], rowCount: 0 } as unknown as QueryResult
      },
    } as unknown as Pool

    const backend = createPgSessionsBackend(mockPool, { expectedGeneration: 1 })
    const session = await backend.getClientSession('sess-1', 'c:42')
    assert.ok(session)
    assert.equal(sawDispatch, true)
    assert.equal(sawPermission, true)

    const pgSrc = readPgSessionsBackendSource()
    assert.match(pgSrc, /async function execPgSpillPlan[\s\S]*FROM unnest\(\$4::int\[\], \$5::int\[\], \$6::int\[\], \$7::text\[\]\)[\s\S]*ON CONFLICT \(session_id, first_seq\) DO NOTHING[\s\S]*RETURNING message_count/i)
    assert.match(pgSrc, /INSERT INTO client_session_archived_ids \(session_id, msg_id\)[\s\S]*FROM unnest\(\$2::text\[\]\)/i)
  })

  test('handleListPublicModels falls back to oc_session cookie when Bearer is absent or invalid', async () => {
    const snap = new ModelCatalogSnapshot({
      entries: [
        makeCatalogEntry({ entryId: 1, modelId: 'public-model', providerId: 'deepseek' }),
        makeCatalogEntry({
          entryId: 2,
          modelId: 'pro-locked',
          engine: 'codex',
          providerId: 'openai',
          contextWindow: 272000,
          capabilityProfile: {
            reasoning: { supported: ['low', 'medium', 'high', 'xhigh'], codexModelDefault: null },
            supportsVision: true,
            ccb: { capabilityZero: false, supportsThinking: false },
          },
        }),
      ],
      aliases: new Map(),
      pricing: new Map([
        ['public-model', makePricingRow({ modelId: 'public-model', displayName: 'Public', sortOrder: 1 })],
        [
          'pro-locked',
          makePricingRow({
            modelId: 'pro-locked',
            displayName: 'Pro Locked',
            multiplier: '2.500',
            sortOrder: 2,
            minPlanCode: 'pro',
            minPlanTier: 2,
            minPlanName: 'Pro',
          }),
        ],
      ]),
      securityEpoch: 1n,
    })

    const token = await new SignJWT({ role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('42')
      .setExpirationTime('15m')
      .sign(JWT_SECRET)
    const deps = {
      jwtSecret: JWT_SECRET,
      modelCatalog: { assertFresh: async () => snap },
      loadUserModelAuthz: async (uid: bigint) => ({
        role: 'user' as const,
        grantedModelIds: new Set<string>(),
        userPlanTier: uid === 42n ? 2 : null,
      }),
    } as unknown as CommercialHttpDeps

    // Pure cookie session (no Authorization header) must see unlocked pro model
    const cookieRes = makeRes()
    await handleListPublicModels(
      { headers: { cookie: `theme=dark; oc_session=${token}` } } as unknown as import('node:http').IncomingMessage,
      cookieRes.res,
      {} as RequestContext,
      deps,
    )
    const cookieBody = cookieRes.json()
    assert.deepEqual(cookieBody.models.map((m: { id: string }) => m.id), ['public-model', 'pro-locked'])
    assert.deepEqual(cookieBody.locked_models, [])

    // Invalid Bearer + valid oc_session cookie also falls back to cookie
    const fallbackRes = makeRes()
    await handleListPublicModels(
      { headers: { authorization: 'Bearer invalid.jwt.token', cookie: `oc_session=${token}` } } as unknown as import('node:http').IncomingMessage,
      fallbackRes.res,
      {} as RequestContext,
      deps,
    )
    assert.deepEqual(fallbackRes.json().models.map((m: { id: string }) => m.id), ['public-model', 'pro-locked'])

    // Anonymous request sees locked_models with full metadata AND satisfies REST contract schema
    const anonRes = makeRes()
    await handleListPublicModels(
      { headers: {} } as unknown as import('node:http').IncomingMessage,
      anonRes.res,
      {} as RequestContext,
      deps,
    )
    const anonBody = anonRes.json()
    assert.equal(Value.Check(PublicModelsResponseSchema, anonBody), true)
    assert.equal(anonBody.locked_models.length, 1)
    const locked = anonBody.locked_models[0]
    assert.equal(locked.id, 'pro-locked')
    assert.equal(locked.context_window, 272000)
    assert.equal(locked.supports_vision, true)
    assert.deepEqual(locked.supported_efforts, ['low', 'medium', 'high', 'xhigh'])
    assert.equal(locked.multiplier, '2.500')
    assert.equal(locked.provider_id, 'openai')

    // Direct projection check matches projectPublicModels metadata fields
    const directLocked = projectLockedModels(snap, { uid: 0, role: 'user', grantedModelIds: new Set() })
    const directPublic = projectPublicModels(snap, { uid: 42, role: 'user', grantedModelIds: new Set(), userPlanTier: 2 }, new Set())
    const unlockedPro = directPublic.find((m) => m.id === 'pro-locked')!
    assert.equal(directLocked[0]!.context_window, unlockedPro.context_window)
    assert.equal(directLocked[0]!.supports_vision, unlockedPro.supports_vision)
    assert.deepEqual(directLocked[0]!.supported_efforts, unlockedPro.supported_efforts)
    assert.equal(directLocked[0]!.multiplier, unlockedPro.multiplier)
    assert.equal(directLocked[0]!.provider_id, unlockedPro.provider_id)
  })

  test('resolvePreferencesPatch normalizes before checking Auto-Dream mode availability', async () => {
    const calls: Array<{ uid: string; mode?: { legacyEnabled: boolean; optimizerEnabled: boolean } }> = []
    const feature = async (uid: string, mode?: { legacyEnabled: boolean; optimizerEnabled: boolean }) => {
      calls.push({ uid, mode })
      return { eligible: true, available: true }
    }

    await resolvePreferencesPatch('765', { auto_dream_enabled: true }, { feature })
    await resolvePreferencesPatch('765', { auto_optimizer_enabled: true }, { feature })
    // Mutual exclusion turns legacy off when both are true; feature check must observe optimizer mode
    await resolvePreferencesPatch('765', { auto_dream_enabled: true, auto_optimizer_enabled: true }, { feature })

    assert.deepEqual(calls, [
      { uid: '765', mode: { legacyEnabled: true, optimizerEnabled: false } },
      { uid: '765', mode: { legacyEnabled: false, optimizerEnabled: true } },
      { uid: '765', mode: { legacyEnabled: false, optimizerEnabled: true } },
    ])

    await assert.rejects(
      () => resolvePreferencesPatch('765', { auto_dream_enabled: true }, {
        feature: async (_uid, mode) => ({ eligible: true, available: mode?.optimizerEnabled === true }),
      }),
      (err: unknown) => err instanceof PreferencesError && err.code === 'UNAVAILABLE',
    )
  })

  test('High-Reliability Law 2: structured RetryableInstallConflictError and PG 23505 replace string/regex checks', () => {
    const err = new RetryableInstallConflictError('能力版本在安装期间发生变化,请重试')
    assert.ok(err instanceof MarketplaceError)
    assert.equal(err.code, 'INSTALL_CONFLICT')
    assert.equal(err.retryable, true)

    const marketplaceSrc = readFileSync(new URL('../marketplace/marketplaceDb.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(marketplaceSrc, /\/duplicate key\|unique\/i/)
    assert.doesNotMatch(marketplaceSrc, /\.includes\(['"]期间发生变化['"]\)/)
    assert.match(marketplaceSrc, /code\s*===\s*['"]23505['"]/)

    const remoteHostsSrc = readFileSync(new URL('../remoteHosts/service.ts', import.meta.url), 'utf8')
    assert.doesNotMatch(remoteHostsSrc, /\/duplicate key value\/i/)
    assert.match(remoteHostsSrc, /code\s*===\s*["']23505["']/)
  })

  test('tutorialBlobs and tutorialRevisions batch INSERTs via UNNEST preserving order and empty no-op', async () => {
    const calls: Array<{ sql: string; params: unknown[] | undefined }> = []
    const runner: QueryRunner = {
      async query(sql: string, params?: unknown[]) {
        calls.push({ sql, params })
        return { rows: [], rowCount: 0 } as unknown as QueryResult
      },
    }

    await upsertTutorialBlobs([], runner)
    assert.equal(calls.length, 0)

    await replaceTutorialBlobRefs('99', [], runner)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /^DELETE FROM tutorial_blob_refs/i)

    calls.length = 0
    const blobs: TutorialBlobDraft[] = [
      { sha256: 'a'.repeat(64), kind: 'artifact', mime: 'application/json', bytes: 2, body: Buffer.from('{}'), role: 'manifest', title: 'manifest' },
      { sha256: 'b'.repeat(64), kind: 'messages', mime: 'application/json', bytes: 2, body: Buffer.from('[]'), role: 'messages', title: 'messages' },
      { sha256: 'c'.repeat(64), kind: 'media', mime: 'image/png', bytes: 3, body: Buffer.from([1, 2, 3]), role: 'media/0', title: 'image' },
    ]
    await upsertTutorialBlobs(blobs, runner)
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.sql, /FROM unnest\(\$1::text\[\], \$2::text\[\], \$3::text\[\], \$4::int\[\], \$5::bytea\[\]\)/i)
    assert.match(calls[0]!.sql, /ON CONFLICT \(sha256\) DO NOTHING/i)
    assert.deepEqual(calls[0]!.params, [
      blobs.map((b) => b.sha256),
      blobs.map((b) => b.kind),
      blobs.map((b) => b.mime),
      blobs.map((b) => b.bytes),
      blobs.map((b) => b.body),
    ])

    calls.length = 0
    await replaceTutorialBlobRefs('99', blobs, runner)
    assert.equal(calls.length, 2)
    assert.match(calls[0]!.sql, /^DELETE FROM tutorial_blob_refs/i)
    assert.match(calls[1]!.sql, /FROM unnest\(\$2::text\[\], \$3::text\[\]\)/i)
    assert.deepEqual(calls[1]!.params, [
      '99',
      blobs.map((b) => b.sha256),
      blobs.map((b) => b.role),
    ])

    const revisionsSrc = readFileSync(new URL('../tutorials/tutorialRevisions.ts', import.meta.url), 'utf8')
    assert.match(revisionsSrc, /INSERT INTO community_tutorial_revision_images[\s\S]*FROM unnest\(\$2::text\[\]\)/i)
  })

  test('Auditor R1/R2 regressions: userChatBridge strips untrusted _masterHistoricalMessages on all JSON/binary entries and autoDream keeps UI/PATCH mode symmetric', () => {
    const bridgeSrc = readUserChatBridgeSource()
    assert.match(
      bridgeSrc,
      /(?:delete enriched\._masterHistoricalMessages;|Reflect\.deleteProperty\(enriched,\s*['"]_masterHistoricalMessages['"]\))/,
      'userChatBridge must unconditionally strip client _masterHistoricalMessages before master backfill',
    )
    assert.match(
      bridgeSrc,
      /(?:delete p\._masterHistoricalMessages;|Reflect\.deleteProperty\(p,\s*['"]_masterHistoricalMessages['"]\))/,
      'userChatBridge binary JSON branch must also strip _masterHistoricalMessages',
    )
    assert.match(
      bridgeSrc,
      /(?:delete parsedObj\._masterHistoricalMessages;|Reflect\.deleteProperty\(parsedObj,\s*['"]_masterHistoricalMessages['"]\))/,
      'userChatBridge text JSON entry must strip _masterHistoricalMessages for all frames',
    )
    const autoDreamSrc = readFileSync(new URL('../user/autoDream.ts', import.meta.url), 'utf8')
    assert.match(
      autoDreamSrc,
      /const mode: AutoDreamMode = optimizerEnabled \? 'optimizer_v2' : 'legacy_memory_v1'/,
      'getAutoDreamFeature must match legacy_memory_v1 when optimizer is off and optimizer_v2 when optimizer is on',
    )
  })
})
