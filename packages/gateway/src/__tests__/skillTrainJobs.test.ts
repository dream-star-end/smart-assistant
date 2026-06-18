/**
 * Tests for the skill-training Job registry: deterministic tool→phase mapping,
 * monotonic phase advance, proposal counting, terminal transitions, concurrency
 * guard, and durable reload (active runs reconciled to failed after restart).
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/skillTrainJobs.test.ts
 */
import * as assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

const testHome = await mkdtemp(join(tmpdir(), 'oc-trainstore-'))
process.env.OPENCLAUDE_HOME = testHome

const { SkillTrainJobStore, phaseForToolName } = await import('../skillTrainJobs.js')
const { paths } = await import('@openclaude/storage')

function tool(name: string, partial = false): any {
  return { kind: 'block', block: { kind: 'tool_use', toolName: name, partial } }
}
const T0 = 1_700_000_000_000

async function freshRun(store: any, runId: string, skillName: string | null = 'deploy-flow') {
  return store.create({
    runId,
    skillName,
    agentId: 'main',
    userId: 'u1',
    model: 'deepseek-v4-pro',
    effort: 'max',
    now: T0,
  })
}

describe('phaseForToolName', () => {
  it('maps discovery tools to phases and ignores others', () => {
    assert.equal(phaseForToolName('session_search'), 'scanning_sessions')
    assert.equal(phaseForToolName('skill_list'), 'evaluating')
    assert.equal(phaseForToolName('skill_view'), 'evaluating')
    assert.equal(phaseForToolName('skill_propose'), 'drafting')
    assert.equal(phaseForToolName('memory'), null)
  })
})

describe('SkillTrainJobStore concurrency guard', () => {
  it('caps total active runs and forbids two active runs on the same skill', async () => {
    const store = new SkillTrainJobStore({ maxConcurrent: 2 })
    await freshRun(store, 'r1', 'skill-a')
    assert.equal(store.canStart('skill-a').ok, false) // same skill busy
    assert.equal(store.canStart('skill-b').ok, true)
    await freshRun(store, 'r2', 'skill-b')
    assert.equal(store.canStart('skill-c').ok, false) // global cap reached (2 active)
  })
})

describe('SkillTrainJobStore.applyEvent', () => {
  it('advances phase monotonically, counts proposals, flips queued→running', async () => {
    const changes: string[] = []
    const store = new SkillTrainJobStore({ onChange: (r) => changes.push(`${r.status}:${r.phase}`) })
    await freshRun(store, 'r1')
    await store.applyEvent('r1', tool('skill_list'), T0 + 1)
    assert.equal(store.get('r1')?.status, 'running')
    assert.equal(store.get('r1')?.phase, 'evaluating')
    await store.applyEvent('r1', tool('session_search'), T0 + 2)
    // session_search (rank 1) must NOT regress phase from evaluating (rank 2)
    assert.equal(store.get('r1')?.phase, 'evaluating')
    await store.applyEvent('r1', tool('skill_propose'), T0 + 3)
    assert.equal(store.get('r1')?.phase, 'drafting')
    assert.equal(store.get('r1')?.proposalCount, 1)
    assert.equal(store.get('r1')?.toolCalls, 3)
  })

  it('ignores partial tool_use frames for counting', async () => {
    const store = new SkillTrainJobStore()
    await freshRun(store, 'r1')
    await store.applyEvent('r1', tool('skill_propose', true), T0 + 1) // partial — not counted
    assert.equal(store.get('r1')?.proposalCount, 0)
    assert.equal(store.get('r1')?.toolCalls, 0)
  })

  it('final with proposals → diff_ready; without → discarded', async () => {
    const store = new SkillTrainJobStore()
    await freshRun(store, 'r1')
    await store.applyEvent('r1', tool('skill_propose'), T0 + 1)
    await store.applyEvent('r1', { kind: 'final', meta: { stopReason: 'end_turn' } } as any, T0 + 2)
    assert.equal(store.get('r1')?.status, 'diff_ready')
    assert.equal(store.get('r1')?.finishedAt, T0 + 2)

    const store2 = new SkillTrainJobStore()
    await freshRun(store2, 'r2')
    await store2.applyEvent('r2', { kind: 'final', meta: {} } as any, T0 + 5)
    assert.equal(store2.get('r2')?.status, 'discarded')
    assert.equal(store2.get('r2')?.phase, 'done')
  })

  it('error → failed terminal, ignores later events', async () => {
    const store = new SkillTrainJobStore()
    await freshRun(store, 'r1')
    await store.applyEvent('r1', { kind: 'error', error: 'boom' } as any, T0 + 1)
    assert.equal(store.get('r1')?.status, 'failed')
    assert.equal(store.get('r1')?.error, 'boom')
    await store.applyEvent('r1', tool('skill_propose'), T0 + 2) // terminal — no-op
    assert.equal(store.get('r1')?.proposalCount, 0)
  })
})

describe('SkillTrainJobStore durability', () => {
  it('persists run.json and reconciles active runs to failed on reload', async () => {
    const store = new SkillTrainJobStore()
    await freshRun(store, 'r-persist')
    await store.applyEvent('r-persist', tool('skill_list'), T0 + 1) // now "running"
    assert.equal(existsSync(join(paths.skillDraftRunDir('r-persist'), 'run.json')), true)

    const reloaded = new SkillTrainJobStore()
    await reloaded.loadAll(T0 + 100)
    const r = reloaded.get('r-persist')
    assert.ok(r)
    assert.equal(r?.status, 'failed') // was running → reconciled
    assert.equal(r?.error, 'gateway restarted during training')
  })
})
