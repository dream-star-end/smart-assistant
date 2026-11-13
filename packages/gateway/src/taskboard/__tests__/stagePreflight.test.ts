import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HIDDEN_SYSTEM_AGENT_IDS, type IdentityCompatProjection } from '@openclaude/protocol'
import type { AgentDef, AgentsConfig } from '@openclaude/storage'
import type { resolveLocalExecutionIfEnforced } from '../../localExecution.js'
import {
  assertTaskboardStagesRunnable,
  createTaskboardPreflight,
  TaskboardPreflightError,
  type TaskboardExecutionSpec,
} from '../stagePreflight.js'

const spec = (agentId: string | null, model: string | null = null): TaskboardExecutionSpec => ({
  kind: 'ai',
  agentId,
  model,
})
const config = (agents: AgentDef[]): AgentsConfig => ({ agents, routes: [], default: 'main' })

test('task preflight follows stage > agent > auto without changing configuration or routing preference', async () => {
  for (const [stageModel, agentModel, requested, preferred] of [
    ['gpt-5.6-sol', 'deepseek-v4-flash', 'gpt-5.6-sol', undefined],
    [null, 'deepseek-v4-flash', 'deepseek-v4-flash', undefined],
    ['grok-build', 'auto', 'grok-build', undefined],
    [null, 'auto', undefined, ['grok-build']],
    [null, undefined, undefined, ['grok-build']],
  ] as const) {
    const cfg = config([{ id: 'main', model: agentModel }])
    const before = JSON.stringify(cfg)
    const seen: Parameters<typeof resolveLocalExecutionIfEnforced>[0][] = []
    const check = createTaskboardPreflight({
      getAgentsConfig: async () => cfg,
      getIdentityProjection: async () => undefined,
      env: { OC_SELFHOST_ENGINE_LOCAL_TURNS: '1' },
      defaultModel: 'glm-5.2',
      resolveExecution: async (input) => {
        seen.push(input)
        return undefined
      },
    })
    assert.deepEqual(await check([spec('main', stageModel)]), [null])
    assert.equal(seen.length, 1)
    assert.equal(seen[0]!.model, requested)
    assert.equal(seen[0]!.agent.model, requested ?? agentModel)
    assert.deepEqual(seen[0]!.preferredModels, preferred)
    assert.equal(seen[0]!.defaultModel, 'glm-5.2')
    assert.equal(seen[0]!.kind, 'turn')
    assert.equal(JSON.stringify(cfg), before, 'preflight never rewrites stored agent defaults')
  }
})

test('a batch shares authenticated identity/config reads and checks each agent/model once', async () => {
  let reads = 0
  let identities = 0
  let routes = 0
  const check = createTaskboardPreflight({
    getAgentsConfig: async () => {
      reads++
      return config([{ id: 'main', model: 'glm-5.2' }])
    },
    getIdentityProjection: async () => {
      identities++
      return undefined
    },
    env: {},
    resolveExecution: async () => {
      routes++
      return undefined
    },
  })
  const stages = [
    spec('main'),
    spec('main'),
    spec('main', 'grok-build'),
    { kind: 'human' as const, agentId: null, model: null },
  ]
  assert.deepEqual(await check(stages), [null, null, null, null])
  assert.deepEqual([reads, identities, routes], [1, 1, 2])
})

test('missing or hidden helpers fail before any model check; a human-only pipeline needs no helper', async () => {
  let reads = 0
  let routes = 0
  const check = createTaskboardPreflight({
    getAgentsConfig: async () => {
      reads++
      return config([])
    },
    getIdentityProjection: async () => undefined,
    resolveExecution: async () => {
      routes++
      return undefined
    },
    env: {},
  })
  const hidden = [...HIDDEN_SYSTEM_AGENT_IDS][0]!
  assert.ok(hidden)
  const out = await check([spec(null), spec(hidden), { kind: 'human', agentId: null, model: null }])
  assert.equal(out[0]!.code, 'stage_agent_unavailable')
  assert.equal(out[1]!.code, 'stage_agent_unavailable')
  assert.equal(out[2], null)
  assert.equal(reads, 0)
  assert.equal((await check([spec('not-installed')]))[0]!.code, 'stage_agent_unavailable')
  assert.equal(routes, 0)
})

test('identity readiness and canonical installation are checked without rebinding the requested alias', async () => {
  const stage = spec('legacy-helper')
  const projection: IdentityCompatProjection = {
    schema: 1,
    userId: '765',
    profiles: [
      {
        readiness: 'ready',
        profile: {
          profileId: 'fixture',
          legacyAgentId: 'legacy-helper',
          canonicalAgentId: 'canonical-helper',
          localPersonaPath: 'agents/fixture/persona.md',
          localSkillStorageId: 'fixture',
        },
      },
    ],
  }
  let resolved = 0
  const seen: string[] = []
  const check = createTaskboardPreflight({
    getAgentsConfig: async () =>
      config([{ id: 'canonical-helper', model: 'glm-5.2', source: 'marketplace' }]),
    getIdentityProjection: async () => projection,
    resolveIdentityAgent: async (agent) => {
      resolved++
      return { agent, context: {} }
    },
    resolveExecution: async (input) => {
      seen.push(input.agent.id)
      return undefined
    },
    env: {},
  })
  assert.deepEqual(await check([stage]), [null])
  assert.equal(stage.agentId, 'legacy-helper')
  assert.deepEqual(seen, ['canonical-helper'])
  assert.equal(resolved, 1)
  projection.profiles[0]!.readiness = 'unavailable'
  assert.equal((await check([stage]))[0]!.code, 'stage_agent_unavailable')
  assert.equal(resolved, 1)
})

test('authority read failure is unavailable, never an empty compatibility fallback or a secret leak', async () => {
  let routed = false
  const check = createTaskboardPreflight({
    getAgentsConfig: async () => config([{ id: 'main', model: 'glm-5.2' }]),
    getIdentityProjection: async () => {
      throw new Error('PRIVATE_FIXTURE_DETAIL')
    },
    resolveExecution: async () => {
      routed = true
      return undefined
    },
    env: {},
  })
  const out = await check([spec('main')])
  assert.equal(out[0]!.code, 'execution_preflight_unavailable')
  assert.equal(out[0]!.status, 503)
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE_FIXTURE_DETAIL/)
  assert.equal(routed, false)
})

test('missing or malformed preflight cannot admit an AI stage', async () => {
  await assert.rejects(
    assertTaskboardStagesRunnable(undefined, [spec('main')]),
    TaskboardPreflightError,
  )
  await assert.rejects(
    assertTaskboardStagesRunnable(async () => [], [spec('main')]),
    TaskboardPreflightError,
  )
  await assert.rejects(
    assertTaskboardStagesRunnable(async () => [undefined as never], [spec('main')]),
    TaskboardPreflightError,
  )
  await assert.rejects(
    assertTaskboardStagesRunnable(async () => new Array(1), [spec('main')]),
    TaskboardPreflightError,
  )
  await assertTaskboardStagesRunnable(undefined, [{ kind: 'human', agentId: null, model: null }])
})
