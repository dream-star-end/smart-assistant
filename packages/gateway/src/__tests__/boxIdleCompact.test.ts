import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, test } from 'node:test'
import { SessionManager, type AgentSession } from '../sessionManager.js'
import {
  IDLE_COMPACT_PROMPT,
  IdleCompactRejected,
  type BoxChainTerminalProof,
  runIdleCompact,
} from '../boxIdleCompact.js'

const proof = (): BoxChainTerminalProof => ({
  kind: 'box-chain-terminal-v1',
  sessionId: 'box-session',
  revision: 'rev-9',
  requestId: 'req-terminal',
  contextOwner: 'box-native-v1',
  canonicalModel: 'box-api-claude-opus-5-5',
  rows: [{
    requestId: 'req-terminal',
    boxState: 'terminal',
    committed: true,
    hasHandoff: false,
    hasUnknown: false,
  }],
})

describe('idle compact', () => {
  let dir = ''
  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true })
  })

  test('unknown chain and a busy session do not call the model', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-compact-'))
    let calls = 0
    const unknown = proof()
    unknown.rows = [{ ...unknown.rows[0], boxState: 'unknown', hasUnknown: true, committed: false }]
    await assert.rejects(runIdleCompact({
      sessionKey: 's',
      activeTurns: 0,
      activeClients: 0,
      proof: unknown,
      idleRequestId: 'idle-1',
      recoveryDir: dir,
      submit: async () => { calls += 1 },
      readSummary: () => 'unused',
    }), (error: unknown) => error instanceof IdleCompactRejected && error.code === 'IDLE_UNKNOWN_CHAIN')
    await assert.rejects(runIdleCompact({
      sessionKey: 's',
      activeTurns: 1,
      activeClients: 0,
      proof: proof(),
      idleRequestId: 'idle-1',
      recoveryDir: dir,
      submit: async () => { calls += 1 },
      readSummary: () => 'unused',
    }), (error: unknown) => error instanceof IdleCompactRejected && error.code === 'IDLE_SESSION_BUSY')
    assert.equal(calls, 0)
  })

  test('terminal summary is stored before apply, and recovery does not infer again', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-compact-'))
    const prompts: string[] = []
    const once = await runIdleCompact({
      sessionKey: 's',
      activeTurns: 0,
      activeClients: 0,
      proof: proof(),
      idleRequestId: 'idle-1',
      recoveryDir: dir,
      submit: async (prompt) => { prompts.push(prompt) },
      readSummary: () => 'kept goal',
    })
    assert.deepEqual(prompts, [IDLE_COMPACT_PROMPT])
    assert.equal(once.applied, true)
    assert.equal(once.nativeMiss, true)
    assert.equal(once.summaryText, 'kept goal')
    const stored = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(dir, 'idle-compact-recovery.json'), 'utf8'))) as {
      sessions: { s: { applied: boolean } }
    }
    stored.sessions.s.applied = false
    await import('node:fs').then((fs) => fs.writeFileSync(join(dir, 'idle-compact-recovery.json'), JSON.stringify(stored)))
    const recovered = await runIdleCompact({
      sessionKey: 's',
      activeTurns: 0,
      activeClients: 0,
      proof: proof(),
      idleRequestId: 'idle-2',
      recoveryDir: dir,
      submit: async () => { prompts.push('again') },
      readSummary: () => { throw new Error('must not read a new summary') },
    })
    assert.equal(recovered.applied, true)
    assert.equal(recovered.summaryText, 'kept goal')
    assert.deepEqual(prompts, [IDLE_COMPACT_PROMPT])
  })

  test('session manager sends /compact without a model switch and records native miss', async () => {
    dir = await mkdtemp(join(tmpdir(), 'idle-compact-'))
    const sm = new SessionManager({
      version: 1,
      gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
      auth: { mode: 'subscription', claudeCodePath: '' },
      sessions: { dbPath: '' },
      defaults: { model: 'box-api-claude-opus-5-5' },
    } as never)
    const seen: Array<{ prompt: string; switchId?: string }> = []
    const session = {
      sessionKey: 'agent:main:webchat:dm:idle-peer',
      model: 'box-api-claude-opus-5-5',
      _activeTurnCount: 0,
      _activeClientTurnCount: 0,
      _lastNativeCompactionSummary: undefined,
      _idleNativeMiss: undefined,
    } as AgentSession
    sm.submit = async (_session, prompt, _onEvent, _effort, _model, _requestId, _trace, _mode, opts) => {
      seen.push({ prompt: String(prompt), switchId: opts?.modelSwitchInternal })
      session._lastNativeCompactionSummary = 'idle summary'
    }
    const record = await sm.prepareIdleCompact(session, proof(), 'idle-req', dir)
    assert.equal(seen.length, 1)
    assert.equal(seen[0]?.prompt, IDLE_COMPACT_PROMPT)
    assert.equal(seen[0]?.switchId, undefined)
    assert.equal(record.nativeMiss, true)
    assert.equal(session._idleNativeMiss, true)
    assert.equal(record.sourceRequestId, 'req-terminal')
  })
})
