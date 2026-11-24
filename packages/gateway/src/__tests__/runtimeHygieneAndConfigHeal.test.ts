import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  DEPRECATED_PROVIDERS,
  LEGACY_MODEL_POINTER_ALIASES,
  acquireKernelFileLock,
  gcCronOccurrenceTapes,
  gcDelegateInflightSurface,
  gcRetryQueueQuarantine,
  gcStaleBakFiles,
  healConfigModelPointers,
  resolveHealedModelPointer,
  runRuntimeHygieneGc,
  verifySafeSubdirWithinRoot,
  type ModelCatalogHealView,
} from '@openclaude/storage'
import Database from 'better-sqlite3'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import { AdvisorConfigStore } from '../advisorConfigStore.js'
import { DelegateInflightSurfaceStore } from '../delegateInflightSurface.js'
import type { LocalCatalogModel } from '../modelCatalogClient.js'

const DAY_MS = 24 * 3600_000

async function setFileMtime(filepath: string, mtimeMs: number): Promise<void> {
  const sec = mtimeMs / 1000
  await utimes(filepath, sec, sec)
}

async function exists(filepath: string): Promise<boolean> {
  try {
    await stat(filepath)
    return true
  } catch {
    return false
  }
}

function makeCatalog(opts: {
  models: Array<Partial<LocalCatalogModel> & { modelId: string }>
  aliases?: Record<string, string>
}): ModelCatalogHealView {
  const byId = new Map<string, LocalCatalogModel>()
  for (const m of opts.models) {
    byId.set(m.modelId, {
      modelId: m.modelId,
      displayName: m.displayName ?? m.modelId,
      engine: m.engine ?? 'ccb',
      providerId: m.providerId !== undefined ? m.providerId : 'openai',
      contextWindow: m.contextWindow ?? 200_000,
      supportedEfforts: m.supportedEfforts ?? [],
      supportsVision: m.supportsVision ?? false,
      capabilityZero: m.capabilityZero ?? false,
      supportsThinking: m.supportsThinking ?? false,
      defaultEffort: m.defaultEffort ?? null,
      available: m.available ?? true,
    })
  }
  const aliases = opts.aliases ?? {}
  return {
    canonicalize(id: string): string {
      return aliases[id] ?? id
    },
    isRoutable(id: string): boolean {
      return byId.has(id)
    },
    resolve(id: string): LocalCatalogModel | null {
      return byId.get(id) ?? null
    },
  }
}

describe('runtimeHygieneGc: gcCronOccurrenceTapes', () => {
  it('deletes expired terminal tapes and strictly protects non-terminal, fresh, unknown, and symlink files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hygiene-cron-'))
    try {
      const nowMs = 1_800_000_000_000
      const oldMs = nowMs - 10 * DAY_MS
      const freshMs = nowMs - 2 * DAY_MS

      const tapesDir = join(dir, 'cron', 'occurrence-tapes')
      const occDir = join(dir, 'cron', 'occurrences')
      const settledDir = join(dir, 'cron', 'occurrences-settled')
      await mkdir(tapesDir, { recursive: true })
      await mkdir(occDir, { recursive: true })
      await mkdir(settledDir, { recursive: true })

      // 1. Expired + settled delivery_terminal -> DELETE
      await writeFile(
        join(settledDir, 'occ-settled-term.json'),
        JSON.stringify({ version: 1, deliveryId: 'occ-settled-term', state: 'delivery_terminal' }),
      )
      const f1 = join(tapesDir, 'occ-settled-term.jsonl')
      await writeFile(f1, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'text' } })}\n`)
      await setFileMtime(f1, oldMs)

      // 2. Expired + no occurrence record + tape last valid JSON line has execution_terminal (even with trailing corrupt fragment) -> DELETE
      const f2 = join(tapesDir, 'occ-tape-term.jsonl')
      await writeFile(
        f2,
        `${JSON.stringify({ observedAt: oldMs, event: { state: 'execution_terminal' } })}\n{truncated-crash-line`,
      )
      await setFileMtime(f2, oldMs)

      // 3. Expired + occurrences.json says execution_terminal -> DELETE
      const f3 = join(tapesDir, 'occ-index-term.jsonl')
      await writeFile(f3, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'step' } })}\n`)
      await setFileMtime(f3, oldMs)

      // 4. Expired + active occurrences/<id>.json is queued / running / delivered / needs_confirmation -> KEEP ALL!
      const protectedStates = ['queued', 'running', 'delivered', 'needs_confirmation', 'executing']
      const protectedFiles: string[] = []
      for (const state of protectedStates) {
        const id = `occ-prot-${state}`
        await writeFile(
          join(occDir, `${id}.json`),
          JSON.stringify({ version: 1, deliveryId: id, state }),
        )
        const fp = join(tapesDir, `${id}.jsonl`)
        // Even if the jsonl line mentions delivery_terminal, non-terminal occurrence record MUST protect it.
        await writeFile(fp, `${JSON.stringify({ state: 'delivery_terminal' })}\n`)
        await setFileMtime(fp, oldMs)
        protectedFiles.push(fp)
      }

      // 5. Expired + occurrences.json says delivered -> KEEP!
      await writeFile(
        join(dir, 'cron', 'occurrences.json'),
        JSON.stringify({
          'occ-index-term': { deliveryId: 'occ-index-term', state: 'execution_terminal' },
          'occ-index-delivered': { deliveryId: 'occ-index-delivered', state: 'delivered' },
        }),
      )
      const fIndexDelivered = join(tapesDir, 'occ-index-delivered.jsonl')
      await writeFile(fIndexDelivered, `${JSON.stringify({ state: 'delivery_terminal' })}\n`)
      await setFileMtime(fIndexDelivered, oldMs)

      // 6. Expired + no occurrence record + tape has NO terminal marker -> KEEP (fail-closed)
      const fUnknown = join(tapesDir, 'occ-unknown.jsonl')
      await writeFile(fUnknown, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'tool_use' } })}\n`)
      await setFileMtime(fUnknown, oldMs)

      // 7. Fresh (< 7d) + terminal -> KEEP
      const fFresh = join(tapesDir, 'occ-fresh.jsonl')
      await writeFile(fFresh, `${JSON.stringify({ state: 'delivery_terminal' })}\n`)
      await setFileMtime(fFresh, freshMs)

      // 8. Symlink pointing to an external file -> SKIP (neither symlink nor target deleted)
      const externalTarget = join(dir, 'external-keep.jsonl')
      await writeFile(externalTarget, `${JSON.stringify({ state: 'delivery_terminal' })}\n`)
      await setFileMtime(externalTarget, oldMs)
      const fSymlink = join(tapesDir, 'occ-symlink.jsonl')
      await symlink(externalTarget, fSymlink)

      // Dry-run first: zero deletions
      const dry = await gcCronOccurrenceTapes({ homeDir: dir, nowMs, dryRun: true })
      assert.equal(dry.deletedFiles, 3)
      assert.ok(dry.reclaimedBytes > 0)
      assert.equal(dry.errors.length, 0)
      assert.equal(await exists(f1), true)
      assert.equal(await exists(f2), true)
      assert.equal(await exists(f3), true)

      // Real run
      const res = await gcCronOccurrenceTapes({ homeDir: dir, nowMs, dryRun: false })
      assert.equal(res.deletedFiles, 3)
      assert.equal(res.reclaimedBytes, dry.reclaimedBytes)
      assert.equal(res.skippedActive, protectedStates.length + 1)
      assert.equal(res.skippedFresh, 1)
      assert.equal(res.skippedUnknown, 1)
      assert.equal(res.errors.length, 0)

      assert.equal(await exists(f1), false)
      assert.equal(await exists(f2), false)
      assert.equal(await exists(f3), false)
      for (const fp of protectedFiles) assert.equal(await exists(fp), true)
      assert.equal(await exists(fIndexDelivered), true)
      assert.equal(await exists(fUnknown), true)
      assert.equal(await exists(fFresh), true)
      assert.equal(await exists(externalTarget), true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runtimeHygieneGc: gcRetryQueueQuarantine', () => {
  it('cleans aged & over-budget *.quarantine* files while never touching *.json entries or symlinks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hygiene-retry-'))
    try {
      const nowMs = 1_800_000_000_000
      const qDir = join(dir, 'v3-master-retry.d')
      await mkdir(qDir, { recursive: true })

      // Active paid-output .json entry that is 100 days old and large -> MUST NEVER BE TOUCHED!
      const activeJson = join(qDir, '1700000000000-abcdef01.json')
      await writeFile(activeJson, 'x'.repeat(2000))
      await setFileMtime(activeJson, nowMs - 100 * DAY_MS)

      // Temp file -> MUST NEVER BE TOUCHED!
      const tmpFile = join(qDir, '1700000000000-abcdef02.json.tmp-123-abcd')
      await writeFile(tmpFile, 'y'.repeat(2000))
      await setFileMtime(tmpFile, nowMs - 100 * DAY_MS)

      // Aged quarantine (20d old, real v3MasterRetryQueue naming) -> deleted by age
      const qOld = join(qDir, '1700000000000-aaaa.json.quarantine-malformed-1700000001000')
      await writeFile(qOld, 'a'.repeat(400))
      await setFileMtime(qOld, nowMs - 20 * DAY_MS)

      // 3 fresh quarantines (5d, 3d, 1d old), 400 bytes each = 1200 bytes > maxTotalBytes(900)
      // Oldest fresh (5d) should be evicted by budget cap; 3d & 1d (800 bytes) remain.
      const qFresh1 = join(qDir, '1700000000001-bbbb.json.quarantine')
      const qFresh2 = join(qDir, '1700000000002-cccc.json.quarantine-immutable_conflict-1700000002000')
      const qFresh3 = join(qDir, '1700000000003-dddd.json.quarantine-retry_cap_after_settlement_handoff-1700000003000')
      await writeFile(qFresh1, 'b'.repeat(400))
      await writeFile(qFresh2, 'c'.repeat(400))
      await writeFile(qFresh3, 'd'.repeat(400))
      await setFileMtime(qFresh1, nowMs - 5 * DAY_MS)
      await setFileMtime(qFresh2, nowMs - 3 * DAY_MS)
      await setFileMtime(qFresh3, nowMs - 1 * DAY_MS)

      // Symlink quarantine -> skipped
      const outside = join(dir, 'outside-q.txt')
      await writeFile(outside, 'z'.repeat(2000))
      await setFileMtime(outside, nowMs - 50 * DAY_MS)
      await symlink(outside, join(qDir, 'sym.json.quarantine'))

      // Dry-run
      const dry = await gcRetryQueueQuarantine({
        homeDir: dir,
        nowMs,
        maxAgeMs: 14 * DAY_MS,
        maxTotalBytes: 900,
        dryRun: true,
      })
      assert.equal(dry.deletedByAge, 1)
      assert.equal(dry.deletedByBudget, 1)
      assert.equal(dry.deletedFiles, 2)
      assert.equal(dry.quarantineBudgetExceeded, true)
      assert.equal(dry.remainingBytes, 800)
      assert.equal(await exists(qOld), true)
      assert.equal(await exists(qFresh1), true)

      // Real run
      const res = await gcRetryQueueQuarantine({
        homeDir: dir,
        nowMs,
        maxAgeMs: 14 * DAY_MS,
        maxTotalBytes: 900,
        dryRun: false,
      })
      assert.equal(res.deletedByAge, 1)
      assert.equal(res.deletedByBudget, 1)
      assert.equal(res.deletedFiles, 2)
      assert.equal(res.quarantineBudgetExceeded, true)
      assert.equal(res.remainingFiles, 2)
      assert.equal(res.remainingBytes, 800)
      assert.equal(res.errors.length, 0)

      assert.equal(await exists(qOld), false)
      assert.equal(await exists(qFresh1), false)
      assert.equal(await exists(qFresh2), true)
      assert.equal(await exists(qFresh3), true)
      assert.equal(await exists(activeJson), true)
      assert.equal(await exists(tmpFile), true)
      assert.equal(await exists(outside), true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runtimeHygieneGc: gcDelegateInflightSurface + pruneStaleTerminalRows', () => {
  it('prunes only stale terminal rows in store & SQLite, preserves active/fresh rows, and truncates WAL', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hygiene-inflight-'))
    const dbPath = join(dir, 'delegate-inflight-surface.db')
    let clock = 1_700_000_000_000
    const store = new DelegateInflightSurfaceStore({
      dbPath,
      now: () => clock,
      terminalTtlMs: 30 * DAY_MS,
    })
    try {
      // Stale terminal rows (48h old)
      store.upsertEnqueue({
        jobId: 'dlgjob-stale-completed',
        parentSessionKey: 'agent:main:webchat:dm:s1',
        agentId: 'coder',
        state: 'completed',
        authoritative: true,
      })
      store.upsertEnqueue({
        jobId: 'dlgjob-stale-failed',
        parentSessionKey: 'agent:main:webchat:dm:s1',
        agentId: 'coder',
        state: 'failed',
        authoritative: true,
      })
      // Stale active non-terminal row (48h old) -> MUST NOT BE DELETED!
      store.upsertEnqueue({
        jobId: 'dlgjob-stale-running',
        parentSessionKey: 'agent:main:webchat:dm:s1',
        agentId: 'coder',
        state: 'running',
      })

      // Advance clock 48h and insert a fresh terminal row
      clock += 48 * 3600_000
      store.upsertEnqueue({
        jobId: 'dlgjob-fresh-completed',
        parentSessionKey: 'agent:main:webchat:dm:s1',
        agentId: 'coder',
        state: 'completed',
        authoritative: true,
      })

      // Dry-run via gcDelegateInflightSurface
      const dry = await gcDelegateInflightSurface({
        inflightSurface: store,
        nowMs: clock,
        maxAgeMs: 24 * 3600_000,
        dryRun: true,
      })
      assert.equal(dry.deletedRows, 2)
      assert.equal(dry.checkpointed, false)
      assert.ok(store.get('dlgjob-stale-completed'))

      // Real run via gcDelegateInflightSurface
      const res = await gcDelegateInflightSurface({
        inflightSurface: store,
        nowMs: clock,
        maxAgeMs: 24 * 3600_000,
        dryRun: false,
      })
      assert.equal(res.deletedRows, 2)
      assert.equal(res.checkpointed, true)
      assert.equal(res.errors.length, 0)

      // Memory store updated synchronously
      assert.equal(store.get('dlgjob-stale-completed'), undefined)
      assert.equal(store.get('dlgjob-stale-failed'), undefined)
      assert.ok(store.get('dlgjob-stale-running'))
      assert.ok(store.get('dlgjob-fresh-completed'))

      store.close()

      // Standalone dbPath mode: advance another 48h -> dlgjob-fresh-completed is now stale, running still protected
      const standalone = await gcDelegateInflightSurface({
        dbPath,
        nowMs: clock + 48 * 3600_000,
        maxAgeMs: 24 * 3600_000,
        dryRun: false,
      })
      assert.equal(standalone.deletedRows, 1)
      assert.equal(standalone.checkpointed, true)
      assert.equal(standalone.errors.length, 0)

      const verifyDb = new Database(dbPath, { readonly: true })
      try {
        const rows = verifyDb.prepare('SELECT job_id, state FROM inflight_delegate_surface').all() as Array<{
          job_id: string
          state: string
        }>
        assert.deepEqual(rows, [{ job_id: 'dlgjob-stale-running', state: 'running' }])
      } finally {
        verifyDb.close()
      }

      // Missing dbPath skips without creating file
      const missingPath = join(dir, 'nonexistent.db')
      const missingRes = await gcDelegateInflightSurface({ dbPath: missingPath, nowMs: clock })
      assert.equal(missingRes.skipped, true)
      assert.equal(await exists(missingPath), false)
    } finally {
      store.close()
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('runtimeHygieneGc: gcStaleBakFiles + runRuntimeHygieneGc', () => {
  it('deletes only stale non-whitelisted *.bak / *.bak.* in homeDir and agents/*/ without recursing into protected dirs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hygiene-bak-'))
    try {
      const nowMs = 1_800_000_000_000
      const oldMs = nowMs - 45 * DAY_MS
      const freshMs = nowMs - 5 * DAY_MS

      // Stale top-level bak files -> DELETE
      const topOld1 = join(dir, 'openclaude.json.bak')
      const topOld2 = join(dir, 'agents.yaml.bak.20260101')
      await writeFile(topOld1, 'old1')
      await writeFile(topOld2, 'old2')
      await setFileMtime(topOld1, oldMs)
      await setFileMtime(topOld2, oldMs)

      // Fresh top-level bak -> KEEP
      const topFresh = join(dir, 'recent.bak')
      await writeFile(topFresh, 'fresh')
      await setFileMtime(topFresh, freshMs)

      // Disaster-recovery whitelisted files (old) -> KEEP!
      const wl1 = join(dir, 'resume-map.json.bak')
      const wl2 = join(dir, 'MEMORY.md.pre-memdir.bak')
      const wl3 = join(dir, 'custom.pre-memdir.bak')
      const wl4 = join(dir, 'extra-keep.bak')
      for (const fp of [wl1, wl2, wl3, wl4]) {
        await writeFile(fp, 'keep')
        await setFileMtime(fp, oldMs)
      }

      // agents/main/ level 1 stale bak -> DELETE, pre-memdir -> KEEP
      const agentDir = join(dir, 'agents', 'main')
      await mkdir(agentDir, { recursive: true })
      const agentOld = join(agentDir, 'CLAUDE.md.bak.1')
      const agentPreMemdir = join(agentDir, 'MEMORY.md.pre-memdir.bak')
      await writeFile(agentOld, 'agent-old')
      await writeFile(agentPreMemdir, 'agent-keep')
      await setFileMtime(agentOld, oldMs)
      await setFileMtime(agentPreMemdir, oldMs)

      // Protected subdirs that MUST NEVER be recursed into!
      const forbiddenSubdirs = [
        join(dir, 'workspace'),
        join(dir, 'uploads'),
        join(dir, 'generated'),
        join(dir, 'memory-archive'),
        join(dir, 'skills-archive'),
        join(dir, 'skills'),
        join(agentDir, 'memory'),
      ]
      const forbiddenFiles: string[] = []
      for (const sub of forbiddenSubdirs) {
        await mkdir(sub, { recursive: true })
        const fp = join(sub, 'important.bak')
        await writeFile(fp, 'never-touch')
        await setFileMtime(fp, oldMs)
        forbiddenFiles.push(fp)
      }

      // Symlink .bak -> SKIP
      const target = join(dir, 'real.txt')
      await writeFile(target, 'real')
      await setFileMtime(target, oldMs)
      await symlink(target, join(dir, 'link.bak'))

      const dry = await gcStaleBakFiles({
        homeDir: dir,
        nowMs,
        dryRun: true,
        whitelist: ['extra-keep.bak'],
      })
      assert.equal(dry.deletedFiles, 3)
      assert.equal(dry.whitelistedSkipped, 5)
      assert.equal(await exists(topOld1), true)

      const res = await gcStaleBakFiles({
        homeDir: dir,
        nowMs,
        dryRun: false,
        whitelist: ['extra-keep.bak'],
      })
      assert.equal(res.deletedFiles, 3)
      assert.equal(res.whitelistedSkipped, 5)
      assert.equal(res.errors.length, 0)

      assert.equal(await exists(topOld1), false)
      assert.equal(await exists(topOld2), false)
      assert.equal(await exists(agentOld), false)
      assert.equal(await exists(topFresh), true)
      for (const fp of [wl1, wl2, wl3, wl4, agentPreMemdir, target, ...forbiddenFiles]) {
        assert.equal(await exists(fp), true, `expected preserved: ${fp}`)
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('runRuntimeHygieneGc aggregates metrics and fails open when one sub-task throws', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-hygiene-all-'))
    try {
      const nowMs = 1_800_000_000_000
      const oldBak = join(dir, 'stale.bak')
      await writeFile(oldBak, '1234567890')
      await setFileMtime(oldBak, nowMs - 40 * DAY_MS)

      const logs: Array<{ event: string; fields: Record<string, unknown> }> = []
      const report = await runRuntimeHygieneGc({
        homeDir: dir,
        nowMs,
        inflightSurface: {
          pruneStaleTerminalRows() {
            throw new Error('simulated sqlite lock')
          },
        },
        log: (event, fields) => logs.push({ event, fields }),
      })

      assert.equal(report.totalDeletedFiles, 1)
      assert.equal(report.totalReclaimedBytes, 10)
      assert.equal(report.errors.length, 1)
      assert.match(report.errors[0]!, /simulated sqlite lock/)
      assert.equal(logs.length, 1)
      assert.equal(logs[0]!.event, 'runtime_hygiene_gc')
      assert.equal(await exists(oldBak), false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('configPointerSelfHeal', () => {
  it('resolveHealedModelPointer respects catalog canonicalize, legacy aliases, extraAliases, and never blinds-migrates unroutable targets', () => {
    const catalog = makeCatalog({
      models: [
        { modelId: 'gpt-6.2-sol', engine: 'ccb', providerId: 'openai' },
        { modelId: 'cursor-grok-4.7-high', engine: 'cursor', providerId: 'cursor' },
        { modelId: 'claude-sonnet-4-6', engine: 'ccb', providerId: 'anthropic' },
      ],
      aliases: {
        'sonnet-latest': 'claude-sonnet-4-6',
      },
    })

    // Already routable canonical -> unchanged
    const same = resolveHealedModelPointer('gpt-6.2-sol', catalog)
    assert.equal(same.changed, false)
    assert.equal(same.to, 'gpt-6.2-sol')

    // Catalog alias -> canonicalized
    const catAlias = resolveHealedModelPointer('sonnet-latest', catalog)
    assert.equal(catAlias.changed, true)
    assert.equal(catAlias.to, 'claude-sonnet-4-6')
    assert.equal(catAlias.reason, 'catalog_canonicalized')

    // Built-in legacy alias (case-insensitive) -> migrated when target is routable
    const legacy = resolveHealedModelPointer('GPT-6.1-SOL', catalog)
    assert.equal(legacy.changed, true)
    assert.equal(legacy.to, 'gpt-6.2-sol')
    assert.equal(legacy.reason, 'legacy_alias')

    // Built-in legacy alias whose target (`gpt-6.2-astra`) is NOT in catalog -> kept untouched!
    assert.equal(LEGACY_MODEL_POINTER_ALIASES['gpt-6.1-astra'], 'gpt-6.2-astra')
    const unroutableTarget = resolveHealedModelPointer('gpt-6.1-astra', catalog)
    assert.equal(unroutableTarget.changed, false)
    assert.equal(unroutableTarget.to, 'gpt-6.1-astra')
    assert.equal(unroutableTarget.reason, 'unroutable_kept')

    // Custom extraAliases
    const extra = resolveHealedModelPointer('legacy-custom-v1', catalog, {
      'legacy-custom-v1': 'cursor-grok-4.7-high',
    })
    assert.equal(extra.changed, true)
    assert.equal(extra.to, 'cursor-grok-4.7-high')
    assert.equal(DEPRECATED_PROVIDERS.has('zai'), true)
  })

  it('heals openclaude.json, agents.yaml, and collaboration-config.json idempotently with single log & dryRun support', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-heal-cfg-'))
    try {
      const configPath = join(dir, 'openclaude.json')
      const agentsYamlPath = join(dir, 'agents.yaml')
      const collabPath = join(dir, 'collaboration-config.json')

      const catalog = makeCatalog({
        models: [
          { modelId: 'gpt-6.2-sol', engine: 'ccb', providerId: 'openai' },
          { modelId: 'gpt-6.2-astra', engine: 'ccb', providerId: null },
          { modelId: 'cursor-grok-4.7-high', engine: 'cursor', providerId: 'cursor' },
          { modelId: 'claude-sonnet-4-6', engine: 'ccb', providerId: 'anthropic' },
        ],
      })

      await writeFile(
        configPath,
        JSON.stringify(
          {
            version: 1,
            provider: 'zai',
            defaults: { model: 'gpt-6.1-sol', permissionMode: 'default' },
            channels: { webchat: { enabled: true } },
          },
          null,
          2,
        ),
      )

      await writeFile(
        agentsYamlPath,
        stringifyYaml({
          default: 'main',
          routes: [{ match: { channel: 'webchat' }, agent: 'main' }],
          agents: [
            {
              id: 'main',
              model: 'grok-build',
              provider: 'grok',
              displayName: 'Main Agent',
              toolsets: ['coding'],
            },
            {
              id: 'reviewer',
              model: 'gpt-6.1-astra',
              provider: 'z.ai',
              displayName: 'Reviewer',
            },
            {
              id: 'stable',
              model: 'claude-sonnet-4-6',
              provider: 'anthropic',
              displayName: 'Stable',
            },
            {
              id: 'unroutable',
              model: 'unknown-future-model',
              provider: 'anthropic',
            },
          ],
        }),
      )

      const store = new AdvisorConfigStore(collabPath)
      await store.putDefault({ mode: 'advisor', advisorModel: 'gpt-6.1-astra' }, 0)
      await store.putSession('web-1', { mode: 'advisor', advisorModel: 'cursor-grok-4.6-high' }, 1)
      await store.putSession('web-2', { mode: 'advisor', advisorModel: 'gpt-6.2-sol' }, 2)
      assert.equal(store.read().rev, 3)

      // Dry-run: detects migrations, touches ZERO files and does NOT increment rev
      const dryLogs: Array<{ event: string; fields: Record<string, unknown> }> = []
      const dryReport = await healConfigModelPointers({
        catalog,
        configPath,
        agentsYamlPath,
        collaborationConfigPath: collabPath,
        dryRun: true,
        log: (event, fields) => dryLogs.push({ event, fields }),
      })
      assert.equal(dryReport.dryRun, true)
      assert.deepEqual(dryReport.changedFiles, [])
      assert.ok(dryReport.migrations.length >= 6)
      assert.equal(dryReport.errors.length, 0)
      assert.equal(store.read().rev, 3)
      assert.equal(dryLogs.length, 1)

      // Real run #1
      const logs1: Array<{ event: string; fields: Record<string, unknown> }> = []
      const run1 = await healConfigModelPointers({
        catalog,
        configPath,
        agentsYamlPath,
        collaborationConfigPath: collabPath,
        log: (event, fields) => logs1.push({ event, fields }),
      })
      assert.deepEqual(run1.changedFiles, [
        'openclaude.json',
        'agents.yaml',
        'collaboration-config.json',
      ])
      assert.equal(run1.errors.length, 0)
      assert.equal(logs1.length, 1)
      assert.equal(logs1[0]!.event, 'config_pointer_self_healed')

      // Verify openclaude.json
      const healedCfg = JSON.parse(await readFile(configPath, 'utf8'))
      assert.equal(healedCfg.defaults.model, 'gpt-6.2-sol')
      assert.equal(healedCfg.provider, 'openai')
      assert.equal(healedCfg.defaults.permissionMode, 'default')

      // Verify agents.yaml (all unrelated fields preserved!)
      const healedAgents = parseYaml(await readFile(agentsYamlPath, 'utf8')) as {
        default: string
        routes: unknown[]
        agents: Array<Record<string, unknown>>
      }
      assert.equal(healedAgents.default, 'main')
      assert.equal(healedAgents.routes.length, 1)
      assert.equal(healedAgents.agents[0]!.model, 'gpt-6.2-sol')
      assert.equal(healedAgents.agents[0]!.provider, 'openai')
      assert.equal(healedAgents.agents[0]!.displayName, 'Main Agent')
      assert.deepEqual(healedAgents.agents[0]!.toolsets, ['coding'])
      assert.equal(healedAgents.agents[1]!.model, 'gpt-6.2-astra')
      // providerId is null on gpt-6.2-astra -> deprecated 'z.ai' cleared to default routing
      assert.equal('provider' in healedAgents.agents[1]!, false)
      assert.equal(healedAgents.agents[2]!.model, 'claude-sonnet-4-6')
      assert.equal(healedAgents.agents[2]!.provider, 'anthropic')
      assert.equal(healedAgents.agents[3]!.model, 'unknown-future-model')
      assert.equal(healedAgents.agents[3]!.provider, 'anthropic')

      // Verify collaboration-config.json
      const healedCollab = store.read()
      assert.equal(healedCollab.rev, 4)
      assert.equal(healedCollab.defaultAdvisorModel, 'gpt-6.2-astra')
      assert.equal(healedCollab.sessions['web-1']?.advisorModel, 'cursor-grok-4.7-high')
      assert.equal(healedCollab.sessions['web-2']?.advisorModel, 'gpt-6.2-sol')

      // Real run #2: 100% idempotent, completely silent, rev unchanged!
      const logs2: Array<{ event: string; fields: Record<string, unknown> }> = []
      const run2 = await healConfigModelPointers({
        catalog,
        configPath,
        agentsYamlPath,
        collaborationConfigPath: collabPath,
        log: (event, fields) => logs2.push({ event, fields }),
      })
      assert.deepEqual(run2.changedFiles, [])
      assert.deepEqual(run2.migrations, [])
      assert.deepEqual(run2.errors, [])
      assert.equal(logs2.length, 0)
      assert.equal(store.read().rev, 4)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('fails closed on corrupt JSON/YAML/collaboration-config without overwriting original bytes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-heal-corrupt-'))
    try {
      const configPath = join(dir, 'openclaude.json')
      const agentsYamlPath = join(dir, 'agents.yaml')
      const collabPath = join(dir, 'collaboration-config.json')

      await writeFile(configPath, '{corrupt-json')
      await writeFile(agentsYamlPath, 'agents: [unclosed: {')
      await writeFile(collabPath, '{"format": 999, "bad": true}')

      const catalog = makeCatalog({
        models: [{ modelId: 'gpt-6.2-sol', engine: 'ccb', providerId: 'openai' }],
      })

      const report = await healConfigModelPointers({
        catalog,
        configPath,
        agentsYamlPath,
        collaborationConfigPath: collabPath,
      })

      assert.deepEqual(report.changedFiles, [])
      assert.equal(report.errors.length, 3)
      assert.equal(await readFile(configPath, 'utf8'), '{corrupt-json')
      assert.equal(await readFile(agentsYamlPath, 'utf8'), 'agents: [unclosed: {')
      assert.equal(await readFile(collabPath, 'utf8'), '{"format": 999, "bad": true}')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('T2 Blocker #1: openclaude.json shares ${configPath}.lock and preserves concurrent OAuth updates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-heal-lock-'))
    try {
      const configPath = join(dir, 'openclaude.json')
      const catalog = makeCatalog({
        models: [{ modelId: 'gpt-6.2-sol', engine: 'ccb', providerId: 'openai' }],
      })

      await writeFile(
        configPath,
        JSON.stringify(
          {
            version: 1,
            provider: 'zai',
            auth: {
              mode: 'subscription',
              claudeCodePath: '/opt/ccb',
              claudeOAuth: {
                accessToken: 'old-token',
                refreshToken: 'old-refresh',
                expiresAt: 1000,
                scope: 'user',
              },
            },
            defaults: { model: 'gpt-6.1-sol', permissionMode: 'default' },
            channels: { webchat: { enabled: true } },
          },
          null,
          2,
        ),
      )

      // Hold the shared `${configPath}.lock`, start healer concurrently, update OAuth on disk, then release lock.
      const lock = await acquireKernelFileLock(`${configPath}.lock`)
      const healPromise = healConfigModelPointers({
        catalog,
        configPath,
        agentsYamlPath: join(dir, 'missing-agents.yaml'),
        collaborationConfigPath: join(dir, 'missing-collab.json'),
      })

      await new Promise((r) => setTimeout(r, 40))
      const live = JSON.parse(await readFile(configPath, 'utf8'))
      live.auth.claudeOAuth.accessToken = 'fresh-concurrent-oauth-token'
      live.auth.claudeOAuth.expiresAt = 999999
      await writeFile(configPath, JSON.stringify(live, null, 2))
      await lock.release()

      const report = await healPromise
      assert.deepEqual(report.changedFiles, ['openclaude.json'])
      assert.equal(report.errors.length, 0)

      const finalCfg = JSON.parse(await readFile(configPath, 'utf8'))
      assert.equal(finalCfg.defaults.model, 'gpt-6.2-sol')
      assert.equal(finalCfg.provider, 'openai')
      assert.equal(finalCfg.auth.claudeOAuth.accessToken, 'fresh-concurrent-oauth-token')
      assert.equal(finalCfg.auth.claudeOAuth.expiresAt, 999999)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('T2 Blocker #8: collaboration-config.json preserves top-level & session extension fields and stays idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-heal-collab-ext-'))
    try {
      const collabPath = join(dir, 'collaboration-config.json')
      const catalog = makeCatalog({
        models: [
          { modelId: 'gpt-6.2-astra', engine: 'ccb', providerId: 'openai' },
          { modelId: 'gpt-6.2-sol', engine: 'ccb', providerId: 'openai' },
        ],
      })

      const initialDoc = {
        format: 1,
        rev: 7,
        defaultMode: 'advisor',
        defaultAdvisorModel: 'gpt-6.1-astra',
        provenEngines: ['codex'],
        provenCcbModels: [],
        topLevelCustomFlag: true,
        topLevelMeta: { owner: 'ops', tags: ['v5', 'keep'] },
        sessions: {
          'web-ext-1': {
            mode: 'advisor',
            advisorModel: 'gpt-6.2-sol',
            updatedAt: 1700000000000,
            sessionCustomField: 'preserve-me',
            nestedExtra: { count: 42 },
          },
        },
      }
      await writeFile(collabPath, JSON.stringify(initialDoc, null, 2))

      const run1 = await healConfigModelPointers({
        catalog,
        configPath: join(dir, 'missing-openclaude.json'),
        agentsYamlPath: join(dir, 'missing-agents.yaml'),
        collaborationConfigPath: collabPath,
      })
      assert.deepEqual(run1.changedFiles, ['collaboration-config.json'])
      assert.equal(run1.errors.length, 0)
      assert.equal(run1.migrations.length, 1)
      assert.equal(run1.migrations[0]!.field, 'defaultAdvisorModel')

      const after1 = JSON.parse(await readFile(collabPath, 'utf8'))
      assert.equal(after1.rev, 8)
      assert.equal(after1.defaultAdvisorModel, 'gpt-6.2-astra')
      assert.equal(after1.topLevelCustomFlag, true)
      assert.deepEqual(after1.topLevelMeta, { owner: 'ops', tags: ['v5', 'keep'] })
      assert.equal(after1.sessions['web-ext-1'].sessionCustomField, 'preserve-me')
      assert.deepEqual(after1.sessions['web-ext-1'].nestedExtra, { count: 42 })

      // Second call must be 100% idempotent with zero rev increment.
      const run2 = await healConfigModelPointers({
        catalog,
        configPath: join(dir, 'missing-openclaude.json'),
        agentsYamlPath: join(dir, 'missing-agents.yaml'),
        collaborationConfigPath: collabPath,
      })
      assert.deepEqual(run2.changedFiles, [])
      assert.deepEqual(run2.migrations, [])
      assert.equal(run2.errors.length, 0)
      const after2 = JSON.parse(await readFile(collabPath, 'utf8'))
      assert.equal(after2.rev, 8)
      assert.deepEqual(after2, after1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('T2 audit regressions: symlink boundary (#3) and settled delivered cron tapes (#10)', () => {
  it('T2 Blocker #3: rejects parent-directory symlink escape across cron, retry-queue, inflight DB, and stale bak GCs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'oc-t2-root-'))
    const outside = await mkdtemp(join(tmpdir(), 'oc-t2-outside-'))
    try {
      const nowMs = 1_800_000_000_000
      const oldMs = nowMs - 45 * DAY_MS

      // Prepare outside files that MUST NEVER be deleted even if symlinked into root.
      const outCronTapes = join(outside, 'cron-target', 'occurrence-tapes')
      await mkdir(outCronTapes, { recursive: true })
      const outTape = join(outCronTapes, 'victim.jsonl')
      await writeFile(outTape, `${JSON.stringify({ state: 'delivery_terminal' })}\n`)
      await setFileMtime(outTape, oldMs)
      await symlink(join(outside, 'cron-target'), join(root, 'cron'))

      const outRetry = join(outside, 'retry-target')
      await mkdir(outRetry, { recursive: true })
      const outQuarantine = join(outRetry, 'victim.json.quarantine')
      await writeFile(outQuarantine, 'secret')
      await setFileMtime(outQuarantine, oldMs)
      await symlink(outRetry, join(root, 'v3-master-retry.d'))

      const outAgent = join(outside, 'agent-target')
      await mkdir(outAgent, { recursive: true })
      const outBak = join(outAgent, 'victim.bak')
      await writeFile(outBak, 'backup')
      await setFileMtime(outBak, oldMs)
      await mkdir(join(root, 'agents'), { recursive: true })
      await symlink(outAgent, join(root, 'agents', 'evil'))

      // verifySafeSubdirWithinRoot directly rejects intermediate symlink
      const check = await verifySafeSubdirWithinRoot(root, join(root, 'cron', 'occurrence-tapes'))
      assert.equal(check.ok, false)
      assert.equal(check.missing, false)

      const cronRes = await gcCronOccurrenceTapes({ homeDir: root, nowMs })
      assert.equal(cronRes.deletedFiles, 0)
      assert.ok(cronRes.errors.length >= 1)
      assert.equal(await exists(outTape), true)

      const retryRes = await gcRetryQueueQuarantine({ homeDir: root, nowMs })
      assert.equal(retryRes.deletedFiles, 0)
      assert.ok(retryRes.errors.length >= 1)
      assert.equal(await exists(outQuarantine), true)

      const bakRes = await gcStaleBakFiles({ homeDir: root, nowMs })
      assert.equal(bakRes.deletedFiles, 0)
      assert.ok(bakRes.errors.length >= 1)
      assert.equal(await exists(outBak), true)
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('T2 Blocker #10: reclaims settled delivered cron tapes while protecting active delivered, needs_confirmation, and standalone delivered-only tapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-t2-cron-settled-'))
    try {
      const nowMs = 1_800_000_000_000
      const oldMs = nowMs - 10 * DAY_MS

      const tapesDir = join(dir, 'cron', 'occurrence-tapes')
      const occDir = join(dir, 'cron', 'occurrences')
      const settledDir = join(dir, 'cron', 'occurrences-settled')
      await mkdir(tapesDir, { recursive: true })
      await mkdir(occDir, { recursive: true })
      await mkdir(settledDir, { recursive: true })

      // 1. Settled `delivered` (>7d, absent from active `occurrences/`) -> MUST RECLAIM!
      await writeFile(
        join(settledDir, 'occ-settled-delivered.json'),
        JSON.stringify({ version: 1, deliveryId: 'occ-settled-delivered', state: 'delivered' }),
      )
      const fSettledDelivered = join(tapesDir, 'occ-settled-delivered.jsonl')
      await writeFile(fSettledDelivered, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'text' } })}\n`)
      await setFileMtime(fSettledDelivered, oldMs)

      // 2. Settled `needs_confirmation` (>7d) -> MUST PROTECT!
      await writeFile(
        join(settledDir, 'occ-settled-confirm.json'),
        JSON.stringify({ version: 1, deliveryId: 'occ-settled-confirm', state: 'needs_confirmation' }),
      )
      const fSettledConfirm = join(tapesDir, 'occ-settled-confirm.jsonl')
      await writeFile(fSettledConfirm, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'text' } })}\n`)
      await setFileMtime(fSettledConfirm, oldMs)

      // 3. Unsettled active `occurrences/<id>.json` with `delivered` or `needs_confirmation` (>7d) -> MUST PROTECT!
      await writeFile(
        join(occDir, 'occ-active-delivered.json'),
        JSON.stringify({ version: 1, deliveryId: 'occ-active-delivered', state: 'delivered' }),
      )
      const fActiveDelivered = join(tapesDir, 'occ-active-delivered.jsonl')
      await writeFile(fActiveDelivered, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'text' } })}\n`)
      await setFileMtime(fActiveDelivered, oldMs)

      await writeFile(
        join(occDir, 'occ-active-confirm.json'),
        JSON.stringify({ version: 1, deliveryId: 'occ-active-confirm', state: 'needs_confirmation' }),
      )
      const fActiveConfirm = join(tapesDir, 'occ-active-confirm.jsonl')
      await writeFile(fActiveConfirm, `${JSON.stringify({ observedAt: oldMs, event: { kind: 'text' } })}\n`)
      await setFileMtime(fActiveConfirm, oldMs)

      // 4. Standalone tape with NO occurrence record whose last JSONL line only says `delivered` -> MUST NOT RECLAIM!
      const fStandaloneDelivered = join(tapesDir, 'occ-standalone-delivered.jsonl')
      await writeFile(fStandaloneDelivered, `${JSON.stringify({ observedAt: oldMs, state: 'delivered' })}\n`)
      await setFileMtime(fStandaloneDelivered, oldMs)

      const res = await gcCronOccurrenceTapes({ homeDir: dir, nowMs })
      assert.equal(res.errors.length, 0)
      assert.equal(res.deletedFiles, 1)
      assert.equal(res.skippedActive, 3)
      assert.equal(res.skippedUnknown, 1)

      assert.equal(await exists(fSettledDelivered), false)
      assert.equal(await exists(fSettledConfirm), true)
      assert.equal(await exists(fActiveDelivered), true)
      assert.equal(await exists(fActiveConfirm), true)
      assert.equal(await exists(fStandaloneDelivered), true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('Blocker #9: applyConfigPointerSelfHealToGateway publishes healed openclaude.json and agents.yaml live to Gateway, Router, and SessionManager without restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ocv5-883-live-publish-'))
    try {
      const configPath = join(dir, 'openclaude.json')
      const agentsYamlPath = join(dir, 'agents.yaml')
      const collabPath = join(dir, 'collaboration-config.json')
      const initialConfig = {
        version: 1 as const,
        gateway: { bind: '127.0.0.1', port: 18790, accessToken: 'tok' },
        auth: { mode: 'api_key' as const, claudeCodePath: '/tmp/ccb' },
        defaults: { model: 'gpt-6.1-sol', permissionMode: 'default' as const },
        provider: 'zai',
        channels: { webchat: { enabled: true } },
      }
      await writeFile(configPath, JSON.stringify(initialConfig, null, 2), 'utf8')
      await writeFile(
        agentsYamlPath,
        [
          'default: main',
          'routes: []',
          'agents:',
          '  - id: main',
          '    model: gpt-6.1-astra',
          '    provider: zai',
        ].join('\n') + '\n',
        'utf8',
      )

      const { Router } = await import('../router.js')
      const { applyConfigPointerSelfHealToGateway } = await import('../gatewayLifecycle.js')
      const { parse: parseYaml } = await import('yaml')

      const liveConfigRef = structuredClone(initialConfig)
      const initialAgents = {
        default: 'main',
        routes: [],
        agents: [{ id: 'main', model: 'gpt-6.1-astra', provider: 'zai' }],
      }
      const router = new Router(initialAgents)
      let sessionUpdatedModel = liveConfigRef.defaults.model
      const host = {
        _agentsConfigCache: initialAgents,
        _agentsConfigMtime: 12345,
        deps: { config: liveConfigRef, agentsConfig: initialAgents } as any,
        log: { info: () => {}, warn: () => {}, error: () => {} } as any,
        router,
        sessions: {
          updateConfig(cfg: any) {
            sessionUpdatedModel = cfg.defaults.model
          },
        } as any,
      }

      const catalog = makeCatalog({
        models: [
          { modelId: 'gpt-6.2-sol', engine: 'codex', providerId: 'codex-native' },
          { modelId: 'gpt-6.2-astra', engine: 'codex', providerId: 'codex-native' },
        ],
      })

      const report = await applyConfigPointerSelfHealToGateway(host, catalog as any, {
        configPath,
        agentsYamlPath,
        collaborationConfigPath: collabPath,
        readFreshConfig: async () => JSON.parse(await readFile(configPath, 'utf8')),
        readFreshAgents: async () => parseYaml(await readFile(agentsYamlPath, 'utf8')),
      })

      assert.ok(report)
      assert.deepEqual([...report.changedFiles].sort(), ['agents.yaml', 'openclaude.json'])
      // Same object reference mutated in place so CronScheduler + Gateway + SessionManager all see healed default immediately!
      assert.equal(liveConfigRef.defaults.model, 'gpt-6.2-sol')
      assert.equal(liveConfigRef.provider, 'codex-native')
      assert.equal(sessionUpdatedModel, 'gpt-6.2-sol')
      // Router & cached agentsConfig immediately reflect healed agent model without restart!
      assert.equal(host._agentsConfigCache, null)
      assert.equal(host._agentsConfigMtime, 0)
      const routed = router.route({
        id: 'm1',
        channel: 'webchat',
        peer: { id: 'p1', kind: 'dm' },
        text: 'hi',
      } as any)
      assert.equal(routed.agent.model, 'gpt-6.2-astra')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
