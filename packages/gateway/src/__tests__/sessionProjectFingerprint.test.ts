/**
 * B3: existing session rebind/unbind/fingerprint rebuilds runner before next turn.
 * Run: npx tsx --test packages/gateway/src/__tests__/sessionProjectFingerprint.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { AgentDef, OpenClaudeConfig } from '@openclaude/storage'
import { SessionManager } from '../sessionManager.js'
import '../engine/ccbAdapter.js'
import '../engine/codexAdapter.js'
import { writeProjectInstructions } from '@openclaude/storage'

const home = await mkdtemp(path.join(tmpdir(), 'oc-sess-fp-'))
process.env.OPENCLAUDE_HOME = home
process.env.OC_PROJECT_CONTEXT = '1'

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.2' },
  } as unknown as OpenClaudeConfig
}

function makeSm(): SessionManager {
  const sm = new SessionManager(makeConfigStub())
  const ins = sm as unknown as { _saveResumeMap: () => void }
  ins._saveResumeMap = () => {}
  return sm
}

const KEY = 'agent:main:webchat:dm:fp-peer'
const ccbAgent = { id: 'main', model: 'glm-5.2' } as AgentDef
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

describe('session project fingerprint rebuild', () => {
  test('projectId A→B→null recycles runner; unchanged fingerprint reuses CCB and Codex', async () => {
    const sm = makeSm()
    await writeProjectInstructions(A, 'a-ins', 0)
    await writeProjectInstructions(B, 'b-ins', 0)

    const first = await sm.getOrCreate({
      sessionKey: KEY,
      agent: ccbAgent,
      channel: 'webchat',
      peerId: 'fp-peer',
      projectId: A,
    })
    const firstRunner = first.runner
    assert.equal(first.projectId, A)

    const rebound = await sm.getOrCreate({
      sessionKey: KEY,
      agent: ccbAgent,
      channel: 'webchat',
      peerId: 'fp-peer',
      projectId: B,
    })
    assert.equal(rebound.projectId, B)
    assert.notEqual(rebound.runner, firstRunner)

    const unbound = await sm.getOrCreate({
      sessionKey: KEY,
      agent: ccbAgent,
      channel: 'webchat',
      peerId: 'fp-peer',
      projectId: null,
    })
    assert.equal(unbound.projectId, null)
    assert.notEqual(unbound.runner, rebound.runner)

    const againUnbound = await sm.getOrCreate({
      sessionKey: KEY,
      agent: ccbAgent,
      channel: 'webchat',
      peerId: 'fp-peer',
      projectId: null,
    })
    assert.equal(againUnbound.runner, unbound.runner)

    const live = await sm.getOrCreate({
      sessionKey: KEY,
      agent: ccbAgent,
      channel: 'webchat',
      peerId: 'fp-peer',
      projectId: A,
    })
    const beforeEdit = live.runner
    await writeProjectInstructions(A, 'a-ins-v2', 1)
    const afterEdit = await sm.getOrCreate({
      sessionKey: KEY,
      agent: ccbAgent,
      channel: 'webchat',
      peerId: 'fp-peer',
      projectId: A,
    })
    assert.notEqual(afterEdit.runner, beforeEdit)

    const codexKey = 'agent:main:webchat:dm:fp-codex'
    const firstCodex = await sm.getOrCreate({
      sessionKey: codexKey,
      agent: { id: 'main', model: 'gpt-5.6-sol', provider: 'codex-native' } as AgentDef,
      channel: 'webchat',
      peerId: 'fp-codex',
      projectId: A,
      model: 'gpt-5.6-sol',
    })
    const againCodex = await sm.getOrCreate({
      sessionKey: codexKey,
      agent: { id: 'main', model: 'gpt-5.6-sol', provider: 'codex-native' } as AgentDef,
      channel: 'webchat',
      peerId: 'fp-codex',
      projectId: A,
      model: 'gpt-5.6-sol',
    })
    assert.equal(againCodex.runner, firstCodex.runner)
  })
})
