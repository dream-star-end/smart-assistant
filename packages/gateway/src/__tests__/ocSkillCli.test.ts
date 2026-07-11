/**
 * oc-skill CLI: 本地 relay base 解析 + 命令规划(--confirm 硬门)测试。
 * Run: npx tsx --test packages/gateway/src/__tests__/ocSkillCli.test.ts
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { planSkillCommand, resolveLocalSkillBase } from '../ocSkillCli.js'

function reader(files: Record<string, string>) {
  return (path: string) => {
    const v = files[path]
    if (v === undefined) throw new Error(`missing ${path}`)
    return v
  }
}

describe('resolveLocalSkillBase', () => {
  test('reads gateway port from openclaude.json → loopback skill-local base', () => {
    const readFile = reader({
      '/home/agent/.openclaude/openclaude.json': JSON.stringify({ gateway: { port: 18789 } }),
    }) as any
    assert.equal(
      resolveLocalSkillBase({ HOME: '/home/agent' }, readFile),
      'http://127.0.0.1:18789/internal/v3/skill-local',
    )
  })

  test('OPENCLAUDE_HOME wins over HOME; string port is coerced', () => {
    const readFile = reader({
      '/custom/openclaude.json': JSON.stringify({ gateway: { port: '19999' } }),
    }) as any
    assert.equal(
      resolveLocalSkillBase({ OPENCLAUDE_HOME: '/custom', HOME: '/home/agent' }, readFile),
      'http://127.0.0.1:19999/internal/v3/skill-local',
    )
  })

  test('missing config / bad port → null', () => {
    const missing = (() => {
      throw new Error('nope')
    }) as any
    assert.equal(resolveLocalSkillBase({ HOME: '/home/agent' }, missing), null)
    const badPort = reader({
      '/home/agent/.openclaude/openclaude.json': JSON.stringify({ gateway: { port: 0 } }),
    }) as any
    assert.equal(resolveLocalSkillBase({ HOME: '/home/agent' }, badPort), null)
  })
})

describe('planSkillCommand — --confirm hard gate', () => {
  test('train without --confirm → confirm-required, NO request', () => {
    const plan = planSkillCommand(['train', 'my-skill'])
    assert.equal(plan.kind, 'confirm-required')
    assert.match((plan as any).message, /消耗积分/)
    assert.match((plan as any).message, /同意/)
  })

  test('train with --confirm → POST request to skills/<name>/train', () => {
    const plan = planSkillCommand(['train', 'my-skill', '--confirm'])
    assert.deepEqual(plan, {
      kind: 'request',
      method: 'POST',
      op: 'skills/my-skill/train',
      body: {},
    })
  })

  test('train --confirm --focus carries focus into the body', () => {
    const plan = planSkillCommand(['train', 'my-skill', '--confirm', '--focus', '提高召回'])
    assert.deepEqual(plan, {
      kind: 'request',
      method: 'POST',
      op: 'skills/my-skill/train',
      body: { focus: '提高召回' },
    })
  })

  test('evals-generate without --confirm → confirm-required, NO request', () => {
    const plan = planSkillCommand(['evals-generate', 'my-skill'])
    assert.equal(plan.kind, 'confirm-required')
    assert.match((plan as any).message, /消耗积分/)
  })

  test('evals-generate with --confirm → POST skills/<name>/evals/generate', () => {
    const plan = planSkillCommand(['evals-generate', 'my-skill', '--confirm'])
    assert.deepEqual(plan, {
      kind: 'request',
      method: 'POST',
      op: 'skills/my-skill/evals/generate',
      body: {},
    })
  })

  test('status commands are plain GETs (no confirm gate)', () => {
    assert.deepEqual(planSkillCommand(['train-status', 'run-123']), {
      kind: 'request',
      method: 'GET',
      op: 'skill-training/run-123',
    })
    assert.deepEqual(planSkillCommand(['evals-gen-status', 'gen-9']), {
      kind: 'request',
      method: 'GET',
      op: 'skill-eval-gen/gen-9',
    })
  })

  test('missing positional / unknown command → usage (never a request)', () => {
    assert.equal(planSkillCommand(['train']).kind, 'usage')
    assert.equal(planSkillCommand(['train-status']).kind, 'usage')
    assert.equal(planSkillCommand(['evals-generate']).kind, 'usage')
    assert.equal(planSkillCommand(['bogus']).kind, 'usage')
    assert.equal(planSkillCommand([]).kind, 'usage')
  })
})
