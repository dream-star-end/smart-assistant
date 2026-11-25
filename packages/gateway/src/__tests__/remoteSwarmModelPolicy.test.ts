import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  KNOWN_REMOTE_SWARM_MEMBER_MODEL_IDS,
  extractRouteAllowedRemoteSwarmModels,
  filterAvailableRemoteSwarmModels,
  formatAvailableRemoteSwarmModelsHint,
  formatRemoteSwarmModelsResponse,
  isKnownRemoteAntigravityModel,
  isRemoteAntigravitySwarmMemberModel,
  resolveRemoteSwarmMemberModel,
  resolveWorkerTurnEffort,
} from '../remoteSwarmModelPolicy.js'
import type { RosterMemberRecord } from '../remoteSwarmLocks.js'

describe('remoteSwarmModelPolicy (OCV5-893)', () => {
  it('resolves omitted/empty model to coordinator default model & effort', () => {
    const ctx = {
      defaultModel: 'antigravity-gemini-4-neon-remote',
      defaultEffort: 'xhigh',
      allowedModels: ['antigravity-gemini-4-neon-remote'],
    }
    assert.deepEqual(resolveRemoteSwarmMemberModel(undefined, ctx), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
      effort: 'xhigh',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('   ', ctx), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
      effort: 'xhigh',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel(null, { defaultModel: ctx.defaultModel }), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
    })
  })

  it('normalizes remote canonical ids, canonical-with-effort, and Antigravity CLI slugs deterministically', () => {
    const ctx = {
      defaultModel: 'antigravity-gemini-4-neon-remote',
      defaultEffort: 'high',
      allowedModels: [
        'antigravity-gemini-4-neon-remote',
        'antigravity-gemini-4-carbon-remote',
        'antigravity-gemini-4-hydrogen-remote',
        'antigravity-claude-opus-5.5-remote',
        'antigravity-claude-sonnet-5.5-remote',
        'antigravity-gpt-oss-120b-remote',
      ],
    }

    // 1. Canonical remote id inherits compatible default effort
    assert.deepEqual(resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote', ctx), {
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      effort: 'high',
    })
    // Canonical remote id with incompatible default effort (xhigh on carbon) does not leak xhigh
    assert.deepEqual(
      resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote', {
        ...ctx,
        defaultEffort: 'xhigh',
      }),
      {
        canonicalModel: 'antigravity-gemini-4-carbon-remote',
      },
    )
    // Canonical remote id with explicit -effort suffix
    assert.deepEqual(resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote-low', ctx), {
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      effort: 'low',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('antigravity-gemini-4-neon-remote-xhigh', ctx), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
      effort: 'xhigh',
    })

    // 2. CLI slugs map to canonical *-remote + effort
    assert.deepEqual(resolveRemoteSwarmMemberModel('gemini-4-carbon-high', ctx), {
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      effort: 'high',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('gemini-4-neon-medium', ctx), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
      effort: 'medium',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('gemini-4-hydrogen-xhigh', ctx), {
      canonicalModel: 'antigravity-gemini-4-hydrogen-remote',
      effort: 'xhigh',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('claude-opus-5-5-high', ctx), {
      canonicalModel: 'antigravity-claude-opus-5.5-remote',
      effort: 'high',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('claude-sonnet-5-5-low', ctx), {
      canonicalModel: 'antigravity-claude-sonnet-5.5-remote',
      effort: 'low',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('gpt-oss-120b-medium', ctx), {
      canonicalModel: 'antigravity-gpt-oss-120b-remote',
    })
  })

  it('fails closed on unauthorized, non-remote, cross-engine, invalid effort, and arbitrary models', () => {
    const ctx = {
      defaultModel: 'antigravity-gemini-4-neon-remote',
      defaultEffort: 'high',
      allowedModels: ['antigravity-gemini-4-neon-remote', 'antigravity-gemini-4-carbon-remote'],
    }

    // Valid remote Antigravity model not in session allowlist
    assert.throws(
      () => resolveRemoteSwarmMemberModel('claude-opus-5-5-high', ctx),
      /SWARM_MODEL_NOT_ALLOWED:claude-opus-5-5-high.*antigravity-gemini-4-carbon-remote/,
    )
    // Non-remote local canonical id rejected
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon', ctx),
      /SWARM_MODEL_NOT_ALLOWED:antigravity-gemini-4-carbon/,
    )
    // Cross-engine models (both local and -remote) rejected
    assert.throws(
      () => resolveRemoteSwarmMemberModel('gpt-6.2-astra', ctx),
      /SWARM_MODEL_NOT_ALLOWED:gpt-6\.2-astra/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel('gpt-6.2-astra-remote', ctx),
      /SWARM_MODEL_NOT_ALLOWED:gpt-6\.2-astra-remote/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel('claude-opus-4-6-remote', ctx),
      /SWARM_MODEL_NOT_ALLOWED:claude-opus-4-6-remote/,
    )
    // Unsupported effort suffix rejected
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote-xhigh', ctx),
      /SWARM_MODEL_NOT_ALLOWED:antigravity-gemini-4-carbon-remote-xhigh/,
    )
    // Arbitrary string / non-string rejected
    assert.throws(
      () => resolveRemoteSwarmMemberModel('evil-arbitrary-model', ctx),
      /SWARM_MODEL_NOT_ALLOWED:evil-arbitrary-model/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel(12345, ctx),
      /SWARM_MODEL_NOT_ALLOWED:12345/,
    )
  })

  it('enforces empty allowedModels=[] (default-only) and legacy undefined allowedModels safely', () => {
    const emptyCtx = {
      defaultModel: 'antigravity-gemini-4-neon-remote',
      defaultEffort: 'high',
      allowedModels: [] as readonly string[],
    }
    // Switching away from defaultModel is rejected
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote', emptyCtx),
      /SWARM_MODEL_NOT_ALLOWED:antigravity-gemini-4-carbon-remote/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel('gemini-4-carbon-high', emptyCtx),
      /SWARM_MODEL_NOT_ALLOWED:gemini-4-carbon-high/,
    )
    // Keeping defaultModel (omitted or explicit) still succeeds
    assert.deepEqual(resolveRemoteSwarmMemberModel(undefined, emptyCtx), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
      effort: 'high',
    })
    assert.deepEqual(resolveRemoteSwarmMemberModel('gemini-4-neon-medium', emptyCtx), {
      canonicalModel: 'antigravity-gemini-4-neon-remote',
      effort: 'medium',
    })

    // Legacy compat (`allowedModels: undefined`) allows known remote Antigravity member models,
    // still rejects orchestrators (unless default), local non-remote ids, and cross-engine models!
    const legacyCtx = {
      defaultModel: 'antigravity-gemini-4-neon-remote',
    }
    assert.deepEqual(resolveRemoteSwarmMemberModel('gemini-4-carbon-medium', legacyCtx), {
      canonicalModel: 'antigravity-gemini-4-carbon-remote',
      effort: 'medium',
    })
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-orchestrator-carbon-remote', legacyCtx),
      /SWARM_MODEL_NOT_ALLOWED:antigravity-orchestrator-carbon-remote/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon', legacyCtx),
      /SWARM_MODEL_NOT_ALLOWED:antigravity-gemini-4-carbon/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel('gpt-6.2-astra-remote', legacyCtx),
      /SWARM_MODEL_NOT_ALLOWED:gpt-6\.2-astra-remote/,
    )

    // Cross-engine garbage injected into allowedModels is stripped fail-closed
    const poisonedCtx = {
      defaultModel: 'antigravity-gemini-4-neon-remote',
      allowedModels: ['gpt-6.2-astra-remote', 'antigravity-gemini-4-carbon'],
    }
    assert.throws(
      () => resolveRemoteSwarmMemberModel('gpt-6.2-astra-remote', poisonedCtx),
      /SWARM_MODEL_NOT_ALLOWED:gpt-6\.2-astra-remote/,
    )
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote', poisonedCtx),
      /SWARM_MODEL_NOT_ALLOWED:antigravity-gemini-4-carbon-remote/,
    )
  })

  it('extracts route/catalog models, formats models response & directive hint, and guards worker turn effort', () => {
    assert.equal(isKnownRemoteAntigravityModel('antigravity-gemini-4-neon-remote'), true)
    assert.equal(isKnownRemoteAntigravityModel('antigravity-orchestrator-neon-remote'), true)
    assert.equal(isRemoteAntigravitySwarmMemberModel('antigravity-orchestrator-neon-remote'), false)
    assert.equal(isRemoteAntigravitySwarmMemberModel('antigravity-gemini-4-carbon-remote'), true)
    assert.ok(KNOWN_REMOTE_SWARM_MEMBER_MODEL_IDS.includes('antigravity-gemini-4-carbon-remote'))

    assert.equal(extractRouteAllowedRemoteSwarmModels(undefined), undefined)
    assert.deepEqual(extractRouteAllowedRemoteSwarmModels('not-array'), [])
    assert.deepEqual(
      extractRouteAllowedRemoteSwarmModels([
        'antigravity-gemini-4-neon-remote',
        'antigravity-gemini-4-carbon-remote',
        'antigravity-gemini-4-neon-remote',
        'antigravity-orchestrator-neon-remote',
        'antigravity-gemini-4-carbon',
        'gpt-6.2-astra-remote',
      ]),
      ['antigravity-gemini-4-neon-remote', 'antigravity-gemini-4-carbon-remote'],
    )

    assert.deepEqual(
      filterAvailableRemoteSwarmModels([
        { modelId: 'antigravity-gemini-4-neon-remote', engine: 'antigravity', available: true },
        { modelId: 'antigravity-gemini-4-carbon-remote', engine: 'antigravity', available: false },
        { modelId: 'antigravity-gemini-4-neon', engine: 'antigravity', available: true },
        { modelId: 'antigravity-orchestrator-neon-remote', engine: 'antigravity', available: true },
        { modelId: 'gpt-6.2-astra-remote', engine: 'codex', available: true },
      ]),
      ['antigravity-gemini-4-neon-remote'],
    )

    const hint = formatAvailableRemoteSwarmModelsHint([
      'antigravity-gemini-4-neon-remote',
      'antigravity-claude-opus-5.5-remote',
      'antigravity-orchestrator-neon-remote',
      'gpt-6.2-astra-remote',
    ])
    assert.equal(
      hint,
      '`antigravity-gemini-4-neon-remote`（或 `gemini-4-neon-{low,medium,high,xhigh}`）、`antigravity-claude-opus-5.5-remote`（或 `claude-opus-5-5-{low,medium,high}`）',
    )

    const modelsResp = formatRemoteSwarmModelsResponse({
      defaultModel: 'antigravity-gemini-4-neon-remote',
      defaultEffort: 'high',
      allowedModels: ['antigravity-gemini-4-neon-remote', 'antigravity-gemini-4-carbon-remote'],
    })
    assert.equal(modelsResp.ok, true)
    assert.equal(modelsResp.current_model, 'antigravity-gemini-4-neon-remote')
    assert.equal(modelsResp.current_effort, 'high')
    const avail = modelsResp.available_models as Array<{ id: string; efforts: string[]; cli_aliases: string[] }>
    assert.deepEqual(
      avail.map((m) => m.id),
      ['antigravity-gemini-4-neon-remote', 'antigravity-gemini-4-carbon-remote'],
    )
    assert.ok(avail[1]!.cli_aliases.includes('gemini-4-carbon-high'))

    // Worker turn effort guard prevents leaking xhigh to carbon or gpt-oss
    const legacyCarbonMember = {
      conversation_id: 'c1',
      role: 'worker',
      model: 'antigravity-gemini-4-carbon-remote',
      phase: 'WAITING',
      wake_mode: 'mentions',
      wait_since: 0,
      last_read_seq: 0,
      killed: false,
      channels: ['main'],
    } satisfies RosterMemberRecord
    assert.equal(resolveWorkerTurnEffort(legacyCarbonMember, 'xhigh'), undefined)
    assert.equal(resolveWorkerTurnEffort(legacyCarbonMember, 'medium'), 'medium')
    assert.equal(
      resolveWorkerTurnEffort({ ...legacyCarbonMember, effort: 'low' } as RosterMemberRecord, 'xhigh'),
      'low',
    )
  })

  it('OCV5-893 W1: orchestrator session primary with non-empty extra allowedModels stays valid across create & pre-dispatch recheck while revoked explicit models fail closed', () => {
    const ctx = {
      defaultModel: 'antigravity-orchestrator-carbon-remote',
      defaultEffort: 'medium',
      allowedModels: ['antigravity-gemini-4-carbon-remote'],
    }
    const inherited = resolveRemoteSwarmMemberModel(undefined, ctx)
    assert.equal(inherited.canonicalModel, 'antigravity-orchestrator-carbon-remote')
    // Pre-dispatch re-check passes the stored inherited model explicitly
    const rechecked = resolveRemoteSwarmMemberModel(inherited.canonicalModel, ctx)
    assert.equal(rechecked.canonicalModel, 'antigravity-orchestrator-carbon-remote')
    // Extra authorized model passes
    assert.equal(
      resolveRemoteSwarmMemberModel('antigravity-gemini-4-carbon-remote', ctx).canonicalModel,
      'antigravity-gemini-4-carbon-remote',
    )
    // Revoked historical explicit model MUST still fail closed
    assert.throws(
      () => resolveRemoteSwarmMemberModel('antigravity-gemini-4-neon-remote', ctx),
      /SWARM_MODEL_NOT_ALLOWED/,
    )
  })
})
