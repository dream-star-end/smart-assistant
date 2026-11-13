/** Real startup order and catalog/preset projections; no database or model calls. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Pool, QueryResultRow } from 'pg'
import { DEFAULT_CODEX_ENGINE_MODEL } from '@openclaude/protocol'
import { marketplaceArtifactHash } from '@openclaude/storage'
import { configureModelAvailability } from '../billing/modelAvailability.js'
import {
  ModelCatalogSnapshot,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
  type ModelCatalogState,
} from '../billing/modelCatalog.js'
import { projectPublicModels } from '../billing/modelPublicProjection.js'
import type { Params, QueryRunner } from '../db/queries.js'
import { resetPool, setPoolOverride } from '../db/index.js'
import type { FlavorIdentity } from '../flavor/assertFlavor.js'
import { assertSeedModelsActive } from '../http/internalModelCatalog.js'
import {
  VETTED_AGENT_TOOLSETS,
  canonicalizeAgentManifest,
  validateAgentManifest,
} from '../marketplace/agentManifest.js'
import {
  MarketplaceError,
  getInstallableVersionTarget,
  installMarketplaceBundle,
  listActiveInstalledArtifacts,
  listActiveInstalledAgents,
  listPlatformPresetAgents,
  listRuntimeReadyAgentSets,
  updateInstalledAgentScope,
} from '../marketplace/marketplaceDb.js'
import {
  PLATFORM_SEED_AGENT_DEFS,
  PLATFORM_SEED_AGENT_MODEL_IDS,
} from '../marketplace/seedPlatformAgents.js'
import { PLATFORM_DEFAULT_MODEL, PLATFORM_HIDDEN_REVIEWER_MODEL } from '../platformDefaults.js'

const root = mkdtempSync(join(tmpdir(), 'selfhost-preset-startup-'))
mkdirSync(join(root, 'deploy/v5-selfhost'), { recursive: true })
const policyFile = join(root, 'deploy/v5-selfhost/model-availability.json')
const commercialChild = process.env.OC_TEST_PRESET_STARTUP_FLAVOR === 'commercial'
after(() => rmSync(root, { recursive: true, force: true }))

const hardDependencies = [
  ['default', PLATFORM_DEFAULT_MODEL],
  ['hidden-reviewer', PLATFORM_HIDDEN_REVIEWER_MODEL],
  ['codex', DEFAULT_CODEX_ENGINE_MODEL],
] as const
const allModelIds = [...new Set([
  ...hardDependencies.map(([, id]) => id),
  ...PLATFORM_SEED_AGENT_MODEL_IDS,
  'grok-build-fast',
])]
const scope = { uid: 42, role: 'user' as const, grantedModelIds: new Set<string>(), userPlanTier: 10 }

function configure(grokEnabled: boolean, flavor: 'selfhost' | 'commercial' = 'selfhost'): void {
  writeFileSync(policyFile, JSON.stringify({ grokEnabled }))
  const identity: Extract<FlavorIdentity, { status: 'ok' }> = {
    status: 'ok', flavor, manifestPath: join(root, 'flavor.manifest.json'),
    manifest: {
      schema: 1, flavor, sourceCommit: 'a'.repeat(40), guardGeneration: 1,
      builder: flavor === 'selfhost' ? 'deploy-v5-selfhost.sh' : 'deploy-v5.sh',
      expectedHosts: [], expectedRoots: [], expectedDbNames: [],
    },
  }
  configureModelAvailability(identity)
}

function catalog(change?: { model: string; state: ModelCatalogState | 'absent' }): ModelCatalogSnapshot {
  const entries = allModelIds.flatMap((modelId, index): ModelCatalogEntry[] => {
    if (change?.model === modelId && change.state === 'absent') return []
    const state: ModelCatalogState = change?.model === modelId && change.state !== 'absent' ? change.state : 'active'
    return [{
      entryId: index + 1, modelId,
      engine: modelId.startsWith('grok-build') ? 'grok' : modelId === DEFAULT_CODEX_ENGINE_MODEL ? 'codex' : 'ccb',
      providerId: modelId.startsWith('grok-build') ? 'grok' : modelId === DEFAULT_CODEX_ENGINE_MODEL ? 'codex' : 'opencodego',
      upstreamModelId: null, contextWindow: 200_000, state,
      lockVersion: 0, capabilitySchemaVersion: 1,
      capabilityProfile: { supportsVision: false, reasoning: { supported: [], codexModelDefault: null },
        ccb: { capabilityZero: false, supportsThinking: false } },
    }]
  })
  const pricing: ModelCatalogPricing[] = allModelIds.map((modelId) => ({
    modelId, displayName: modelId, inputPerMtok: 100n, outputPerMtok: 200n,
    cacheReadPerMtok: 10n, cacheWritePerMtok: 0n, multiplier: '1.000',
    visibility: 'public', sortOrder: 1, defaultEffort: null,
  }))
  return new ModelCatalogSnapshot({ entries, pricing: new Map(pricing.map((p) => [p.modelId, p])),
    aliases: new Map(), securityEpoch: 1n })
}

function seedArtifacts() {
  return PLATFORM_SEED_AGENT_DEFS.map((def) => {
    const result = validateAgentManifest(def.body, {
      vettedToolsets: VETTED_AGENT_TOOLSETS,
      allowedModels: new Set(PLATFORM_SEED_AGENT_MODEL_IDS),
    })
    assert.ok(result.ok, `${def.slug}: real seed manifest must validate`)
    return {
      slug: def.slug, version: result.manifest.version, model: result.manifest.model,
      rawManifest: canonicalizeAgentManifest(result.manifest),
      hash: marketplaceArtifactHash(canonicalizeAgentManifest(result.manifest)),
    }
  })
}
const originalArtifacts = seedArtifacts()
const office = (() => {
  const definition = originalArtifacts.find((def) => def.slug === 'office-assistant')
  assert.ok(definition, 'the actual office preset exists')
  return definition
})()
const presetSlugs = originalArtifacts.map((def) => def.slug)

/** Only the database transport is replaced; both production projection functions run. */
function presetRunner(): QueryRunner {
  const rows = originalArtifacts.map((def, index) => ({
    slug: def.slug, version: def.version, version_id: String(index + 1),
    raw_artifact: def.rawManifest, artifact_hash: def.hash,
  }))
  return {
    async query<Row extends QueryResultRow>(_sql: string, params: Params = []) {
      const selected = Array.isArray(params[0])
        ? rows.filter((row) => (params[0] as readonly string[]).includes(row.slug))
        : rows
      return { rows: selected as unknown as Row[], rowCount: selected.length, command: 'SELECT', oid: 0, fields: [] }
    },
  }
}

async function withV5<T>(run: () => Promise<T>): Promise<T> {
  const old = process.env.OC_RUNTIME_CHANNEL
  process.env.OC_RUNTIME_CHANNEL = 'v5'
  try { return await run() } finally {
    if (old === undefined) Reflect.deleteProperty(process.env, 'OC_RUNTIME_CHANNEL')
    else process.env.OC_RUNTIME_CHANNEL = old
  }
}

function assertOriginalArtifacts(): void {
  assert.equal(office.model, 'grok-build', 'fixture uses the actual office Grok seed')
  assert.equal(office.version, '1.0.3')
  assert.equal(office.hash, '932778674a9a5579f16f3ead635d86db214d6970478d24c9e61157c1038bba1e')
  assert.deepEqual(seedArtifacts(), originalArtifacts, 'pause/restore does not rewrite seed manifests, versions or hashes')
}

/** Real public data-layer methods stop at a controlled database boundary. */
async function withMutationBoundary<T>(
  firstRows: QueryResultRow[],
  run: (boundary: { queries: number; transactions: number; writes: number; stop: Error }) => Promise<T>,
): Promise<T> {
  const boundary = { queries: 0, transactions: 0, writes: 0, stop: new Error('fixture continuation boundary') }
  const pool = {
    async query<Row extends QueryResultRow>(sql: string) {
      boundary.queries++
      if (/^(?:INSERT|UPDATE|DELETE|BEGIN)\b/i.test(sql.trimStart())) {
        boundary.writes++
        throw new Error('unexpected mutable SQL before the policy boundary')
      }
      if (boundary.queries > 1) throw boundary.stop
      return { rows: firstRows as Row[], rowCount: firstRows.length, command: 'SELECT', oid: 0, fields: [] }
    },
    async connect() { boundary.transactions++; throw boundary.stop },
    async end() { /* The fake pool never opens a socket. */ },
  }
  setPoolOverride(pool as unknown as Pool)
  try { return await run(boundary) } finally { await resetPool() }
}

function officeVersionRow(): QueryResultRow {
  return { slug: office.slug, kind: 'agent', version: office.version,
    security_review_state: 'security_approved', functional_verify_state: 'functional_verified', exec_revoked_at: null }
}

function notInstallable(error: unknown): boolean {
  return error instanceof MarketplaceError && error.code === 'NOT_INSTALLABLE'
}

async function assertAllowedMutationBoundaries(): Promise<void> {
  await withV5(async () => {
    await withMutationBoundary([officeVersionRow()], async (boundary) => {
      assert.deepEqual(await getInstallableVersionTarget('7654'), { slug: office.slug, kind: 'agent', version: office.version })
      assert.equal(boundary.queries, 1)
      assert.equal(boundary.transactions, 0)
    })
    await withMutationBoundary([officeVersionRow()], async (boundary) => {
      await assert.rejects(installMarketplaceBundle({ userId: 42, versionId: '7654' }), (error) => error === boundary.stop)
      assert.equal(boundary.queries, 2, 'available preset reaches the original capability discovery boundary')
      assert.equal(boundary.transactions, 0)
      assert.equal(boundary.writes, 0)
    })
    await withMutationBoundary([], async (boundary) => {
      await assert.rejects(updateInstalledAgentScope(42, 'scope-fixture-skill', [` ${office.slug} `]), (error) => error === boundary.stop)
      assert.equal(boundary.queries, 1, 'available scope reaches the original binding read')
      assert.equal(boundary.transactions, 1, 'available scope reaches the original transaction boundary')
      assert.equal(boundary.writes, 0)
    })
  })
}

if (commercialChild) {
  test('commercial false flag keeps real startup, catalog and preset artifacts unchanged', async () => {
    configure(false, 'commercial')
    const untouched = catalog()
    assert.doesNotThrow(() => assertSeedModelsActive(untouched))
    assert.deepEqual(untouched.activeModelIds().sort(), [...allModelIds].sort())
    assert.ok(projectPublicModels(untouched, scope, new Set()).some((row) => row.id === office.model))
    for (const model of new Set([...hardDependencies.map(([, id]) => id), ...PLATFORM_SEED_AGENT_MODEL_IDS])) {
      for (const state of ['absent', 'disabled'] as const) {
        assert.throws(() => assertSeedModelsActive(catalog({ model, state })),
          (error) => error instanceof Error && error.message.includes(model),
          `commercial ${model} ${state} remains fatal even when the selfhost file says false`)
      }
    }
    await withV5(async () => {
      assert.deepEqual((await listPlatformPresetAgents(presetSlugs, presetRunner())).map((row) => row.slug).sort(), [...presetSlugs].sort())
      assert.deepEqual((await listActiveInstalledAgents(42, presetRunner())).map((row) => row.slug).sort(), [...presetSlugs].sort())
    })
    await assertAllowedMutationBoundaries()
    configure(true, 'commercial')
    assert.equal(catalog().executionRevision, untouched.executionRevision)
    assert.equal(catalog().billingRevision, untouched.billingRevision)
    assertOriginalArtifacts()
  })
} else {
  test('selfhost paused Grok: actual startup policy → catalog rebuild → seed guard succeeds', () => {
    configure(false)
    const snapshot = catalog()
    assertOriginalArtifacts()
    assert.equal(snapshot.entries.find((entry) => entry.modelId === office.model)?.state, 'active', 'raw database fixture has the real active office seed')
    assert.equal(snapshot.isRoutable(office.model), false, 'effective catalog applies the release pause before startup assertion')
    assert.doesNotThrow(() => assertSeedModelsActive(snapshot), 'an intentionally paused preset must not make registerCommercial refuse startup')
  })

  test('selfhost paused projections exclude office, including a pre-existing installed copy', async () => {
    configure(false)
    const publicRows = projectPublicModels(catalog(), scope, new Set())
    assert.ok(!publicRows.some((row) => row.id.startsWith('grok-build')))
    const expected = presetSlugs.filter((slug) => slug !== office.slug).sort()
    await withV5(async () => {
      assert.deepEqual((await listPlatformPresetAgents(presetSlugs, presetRunner())).map((row) => row.slug).sort(), expected)
      assert.deepEqual((await listActiveInstalledAgents(42, presetRunner())).map((row) => row.slug).sort(), expected)
    })
    assertOriginalArtifacts()
  })

  test('selfhost paused preset does not require its hidden model to remain active in the database', () => {
    configure(false)
    for (const state of ['absent', 'staged', 'disabled', 'retired'] as const) {
      assert.doesNotThrow(() => assertSeedModelsActive(catalog({ model: office.model, state })))
    }
  })

  test('selfhost true flag restores startup and real preset/catalog projections without reseeding', async () => {
    configure(true)
    assert.doesNotThrow(() => assertSeedModelsActive(catalog()))
    assert.ok(projectPublicModels(catalog(), scope, new Set()).some((row) => row.id === office.model))
    await withV5(async () => {
      assert.deepEqual((await listPlatformPresetAgents(presetSlugs, presetRunner())).map((row) => row.slug).sort(), [...presetSlugs].sort())
      assert.deepEqual((await listActiveInstalledAgents(42, presetRunner())).map((row) => row.slug).sort(), [...presetSlugs].sort())
    })
    assertOriginalArtifacts()
  })

  test('paused office stays denied when the runtime caller omits all preset slugs', async () => {
    configure(false)
    let queries = 0
    const runner: QueryRunner = {
      async query<Row extends QueryResultRow>() {
        queries++
        assert.equal(queries, 1, 'paused old install must not enter readiness or later database effects')
        const rows = [{ slug: office.slug, version: office.version, version_id: '1',
          raw_artifact: office.rawManifest, artifact_hash: office.hash }]
        return { rows: rows as unknown as Row[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
      },
    }
    await withV5(async () => {
      const result = await listRuntimeReadyAgentSets(42, [], runner)
      assert.deepEqual(result.installed, [])
      assert.deepEqual(result.presets, [])
      assert.ok(result.denied.has(office.slug), 'omitting a paused reserved slug cannot revive an old install or main fallback')
      assert.equal(queries, 1)
    })
  })

  test('paused skill scopes remove office without granting main, and restore unchanged', async () => {
    const rows = [
      { slug: 'office-only-fixture', version: '1.0.0', raw_skill_md: 'fixture office skill',
        artifact_hash: 'a'.repeat(64), agent_ids: [office.slug], raw_bundle: null },
      { slug: 'mixed-scope-fixture', version: '1.0.0', raw_skill_md: 'fixture mixed skill',
        artifact_hash: 'b'.repeat(64), agent_ids: [office.slug, 'main'], raw_bundle: null },
    ]
    const storedScopes = rows.map((row) => [...row.agent_ids])
    const runner: QueryRunner = {
      async query<Row extends QueryResultRow>(sql: string) {
        const selected = sql.includes('FROM org_memberships') ? [] : rows
        assert.ok(sql.includes('FROM org_memberships') || sql.includes('SELECT DISTINCT ON (m.slug)'), 'only existing membership and skill projection queries run')
        return { rows: selected as unknown as Row[], rowCount: selected.length, command: 'SELECT', oid: 0, fields: [] }
      },
    }
    await withV5(async () => {
      configure(false)
      const paused = await listActiveInstalledArtifacts(42, runner)
      assert.deepEqual(paused.map((row) => [row.slug, row.agentIds]), [['mixed-scope-fixture', ['main']]])
      configure(true)
      const restored = await listActiveInstalledArtifacts(42, runner)
      assert.deepEqual(restored.map((row) => [row.slug, row.agentIds]), [
        ['office-only-fixture', [office.slug]], ['mixed-scope-fixture', [office.slug, 'main']],
      ])
      assert.deepEqual(restored.map((row) => row.artifactHash), rows.map((row) => row.artifact_hash))
      assert.deepEqual(rows.map((row) => row.agent_ids), storedScopes, 'projection never mutates stored ownership')
    })
  })

  test('paused known-version agent lookup and install reject before capabilities or transactions', async () => {
    configure(false)
    await withV5(async () => {
      await withMutationBoundary([officeVersionRow()], async (boundary) => {
        assert.equal(await getInstallableVersionTarget('7654'), null)
        assert.equal(boundary.queries, 1)
        assert.equal(boundary.transactions, 0)
        assert.equal(boundary.writes, 0)
      })
      await withMutationBoundary([officeVersionRow()], async (boundary) => {
        await assert.rejects(installMarketplaceBundle({ userId: 42, versionId: '7654' }), notInstallable)
        assert.equal(boundary.queries, 1, 'no capability discovery after locating the paused preset')
        assert.equal(boundary.transactions, 0)
        assert.equal(boundary.writes, 0)
      })
    })
  })

  test('paused explicit office scope is rejected before any database read and never grants main', async () => {
    configure(false)
    for (const agentIds of [[office.slug], [` ${office.slug} `], ['main', office.slug]]) {
      await withMutationBoundary([], async (boundary) => {
        await assert.rejects(updateInstalledAgentScope(42, 'scope-fixture-skill', agentIds), notInstallable)
        assert.equal(boundary.queries, 0)
        assert.equal(boundary.transactions, 0)
        assert.equal(boundary.writes, 0)
      })
    }
  })

  test('skill install with whitespace office ownership rejects after root lookup without fallback', async () => {
    configure(false)
    await withMutationBoundary([{ slug: 'scope-fixture-skill', kind: 'skill' }], async (boundary) => {
      await assert.rejects(installMarketplaceBundle({ userId: 42, versionId: '7654', agentIds: [` ${office.slug} `] }), notInstallable)
      assert.equal(boundary.queries, 1)
      assert.equal(boundary.transactions, 0)
      assert.equal(boundary.writes, 0)
    })
  })

  test('restoring the policy keeps known-version and scope mutation paths available', async () => {
    configure(true)
    await assertAllowedMutationBoundaries()
    assertOriginalArtifacts()
  })

  test('default, hidden reviewer, codex and unpaused preset dependencies remain fatal when missing or inactive', () => {
    const unpausedPresetModels = PLATFORM_SEED_AGENT_MODEL_IDS.filter((id) => !id.startsWith('grok-build'))
    for (const enabled of [false, true]) {
      configure(enabled)
      for (const [role, model] of [...hardDependencies, ...unpausedPresetModels.map((id) => ['preset', id] as const)]) {
        for (const state of ['absent', 'staged', 'disabled', 'retired'] as const) {
          assert.throws(() => assertSeedModelsActive(catalog({ model, state })),
            (error) => error instanceof Error && error.message.includes(model),
            `${role} ${model} ${state} stays fatal with grokEnabled=${enabled}`)
        }
      }
    }
  })

  test('restored Grok seed still must exist and be active', () => {
    configure(true)
    for (const state of ['absent', 'staged', 'disabled', 'retired'] as const) {
      assert.throws(() => assertSeedModelsActive(catalog({ model: office.model, state })),
        (error) => error instanceof Error && error.message.includes(office.model))
    }
  })

  test('commercial startup is checked in a fresh process, preserving immutable deployment identity', () => {
    const repo = fileURLToPath(new URL('../../../../', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', './scripts/lib/test-blocking-stdio.mjs',
      '--test', '--test-force-exit', fileURLToPath(import.meta.url)], {
      cwd: repo, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, OC_TEST_PRESET_STARTUP_FLAVOR: 'commercial' },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stdout, /# pass 1\b/, 'the commercial startup assertion actually executed')
  })
}
