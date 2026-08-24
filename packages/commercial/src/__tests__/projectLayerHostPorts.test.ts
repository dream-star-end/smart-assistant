import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  applyArmed,
  makeApplyPorts,
  parseUsageRowId,
  portsFromSnapshot,
  resolveLiveReadScript,
  type LiveSnapshot,
} from '../projectLayerHostPorts.js'

const OCV5 = '852859fa-cf1d-481c-96fd-23f2966b8b5f'

function snap(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    generatedAt: '2026-08-24T00:00:00Z',
    readonly: true,
    usageBoardColumn: false,
    sessions: [
      { id: 'web-a', projectId: null, updatedAt: 10, deletedAt: null, archivedAt: null },
    ],
    chatProjects: [{ id: 'chat-1', name: 'x', boardProjectId: null }],
    usage: [
      { id: '3830', sessionId: 'web-a', parentSessionId: null, boardProjectId: null, source: null },
    ],
    assets: [],
    cron: [{ id: 'remind-1', projectMode: 'follow_session', sourceSessionKey: 'agent:main:webchat:dm:web-a' }],
    board: { id: OCV5, key: 'OCV5', archivedAt: null, contextVersion: 0 },
    projectContext: {
      path: '/x',
      exists: false,
      contextVersion: 0,
      skillNames: [],
      uid: null,
      gid: null,
      mode: null,
      candidateFiles: [],
    },
    ...over,
  }
}

describe('parseUsageRowId', () => {
  test('accepts short bigint ids and rejects session keys', () => {
    assert.equal(parseUsageRowId('100'), '100')
    assert.equal(parseUsageRowId('1000'), '1000')
    assert.equal(parseUsageRowId(1000), '1000')
    assert.equal(parseUsageRowId('webmt6uqcvnj6p069'), null)
    assert.equal(parseUsageRowId(''), null)
    assert.equal(parseUsageRowId('12ab'), null)
  })
})

describe('resolveLiveReadScript', () => {
  test('does not hardcode the feature worktree path as the only source', () => {
    const p = resolveLiveReadScript()
    assert.equal(p.includes('/packages/commercial/scripts/ocv5-project-layer-live-read.py'), true)
    assert.equal(
      p === '/opt/openclaude/wt-ocv5-project-layer/packages/commercial/scripts/ocv5-project-layer-live-read.py',
      false,
    )
  })
})

describe('portsFromSnapshot', () => {
  test('exposes live session CAS tuple and usage row ids', async () => {
    const ports = portsFromSnapshot(snap())
    const s = await ports.getSession('web-a')
    assert.equal(s?.updatedAt, 10)
    const usage = await ports.listNullUsage?.(['web-a'])
    assert.equal(usage?.[0]?.id, '3830')
    const cron = await ports.listCronJobs?.()
    assert.equal(cron?.[0]?.id, 'remind-1')
  })
})

describe('makeApplyPorts', () => {
  test('refuses writes when apply is not armed', async () => {
    assert.equal(applyArmed(), false)
    const ports = makeApplyPorts({ boardProjectId: OCV5, snapshot: snap() })
    await assert.rejects(() => ports.createChatProject('OCV5'), /apply_disabled/)
    await assert.rejects(() => ports.ensureProjectContext(OCV5), /apply_disabled/)
  })
})
