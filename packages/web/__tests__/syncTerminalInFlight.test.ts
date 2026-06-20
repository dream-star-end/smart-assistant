/**
 * Regression tests for REST-sync recovery of missed final frames.
 *
 * If a mobile/weak-network tab misses `outbound.message isFinal:true`, the
 * next `/api/sessions/:id` sync may still pull server-authored terminal rows.
 * sync.js must then drop local `_sendingInFlight`; otherwise the composer
 * remains a red stop button even though the run is already complete.
 *
 * Run: npx tsx --test packages/web/__tests__/syncTerminalInFlight.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

const _serverTimelineSettlesLocalInFlight = new Function(
  `${extractTopLevelFn(SYNC_SRC, '_serverTimelineSettlesLocalInFlight')};
   return _serverTimelineSettlesLocalInFlight;`,
)() as (existingLocal: any, mergedMessages: any[]) => boolean

const _shouldFetchSessionMetaForSync = new Function(
  `${extractTopLevelFn(SYNC_SRC, '_shouldFetchSessionMetaForSync')};
   return _shouldFetchSessionMetaForSync;`,
)() as (meta: any, local: any, live: any) => boolean

const _clearLocalInFlightAfterServerSettle = new Function(
  `${extractTopLevelFn(SYNC_SRC, '_clearLocalInFlightAfterServerSettle')};
   return _clearLocalInFlightAfterServerSettle;`,
)() as (sess: any, now?: number) => boolean

const makeSettleSyncedSessionInFlight = (state: any) => new Function(
  'state',
  `${extractTopLevelFn(SYNC_SRC, '_clearLocalInFlightAfterServerSettle')};
   ${extractTopLevelFn(SYNC_SRC, '_settleSyncedSessionInFlight')};
   return _settleSyncedSessionInFlight;`,
)(state) as (sess: any, now?: number) => void

const _preserveLocalInFlightRuntime = new Function(
  `${extractTopLevelFn(SYNC_SRC, '_preserveLocalInFlightRuntime')};
   return _preserveLocalInFlightRuntime;`,
)() as (existingLocal: any, sess: any) => void

const _rebindStreamingPointers = new Function(
  `${extractTopLevelFn(SYNC_SRC, '_rebindStreamingPointers')};
   return _rebindStreamingPointers;`,
)() as (sess: any) => void

const user = (id: string, status: string) => ({ id, role: 'user', text: id, status })
const server = (id: string, role = 'assistant', status = 'completed') => ({
  id,
  role,
  text: id,
  _source: 'server',
  status,
})

describe('_serverTimelineSettlesLocalInFlight', () => {
  it('settles when latest running user is followed by a completed server assistant', () => {
    const local = {
      _sendingInFlight: true,
      messages: [user('u1', 'sent')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'sent'),
        server('a1', 'assistant', 'completed'),
      ]),
      true,
    )
  })

  it('settles for server-authored terminal tool/crashed rows too', () => {
    const local = {
      _sendingInFlight: true,
      messages: [user('u1', 'read')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        server('tool1', 'tool', 'crashed'),
      ]),
      true,
    )
  })

  it('does not settle on completed tool/thinking rows that can be intermediate', () => {
    const local = {
      _sendingInFlight: true,
      messages: [user('u1', 'read')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        server('tool1', 'tool', 'completed'),
      ]),
      false,
    )
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        server('think1', 'thinking', 'completed'),
      ]),
      false,
    )
  })

  it('does not settle from a previous turn before the latest running user', () => {
    const local = {
      _sendingInFlight: true,
      messages: [user('u1', 'read'), user('u2', 'sent')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        server('a1', 'assistant', 'completed'),
        user('u2', 'sent'),
      ]),
      false,
    )
  })

  it('does not fall back to an older user when latest local user is queued', () => {
    const local = {
      _sendingInFlight: true,
      messages: [user('u1', 'read'), user('u2', 'queued')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        server('a1', 'assistant', 'completed'),
        user('u2', 'queued'),
      ]),
      false,
    )
  })

  it('does not settle on local-only completed-looking rows', () => {
    const local = {
      _sendingInFlight: true,
      messages: [user('u1', 'read')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        { id: 'a1', role: 'assistant', status: 'completed', text: 'local row' },
      ]),
      false,
    )
  })

  it('uses _replyingToMsgId when present to settle the tracked turn', () => {
    const local = {
      _sendingInFlight: true,
      _replyingToMsgId: 'u1',
      messages: [user('u1', 'read'), user('u2', 'queued')],
    }
    assert.equal(
      _serverTimelineSettlesLocalInFlight(local, [
        user('u1', 'read'),
        server('a1', 'assistant', 'completed'),
        user('u2', 'queued'),
      ]),
      true,
    )
  })

  it('is wired into both sync merge paths', () => {
    const callCount = (SYNC_SRC.match(/_serverTimelineSettlesLocalInFlight\s*\(/g) || []).length
    assert.equal(
      callCount,
      4,
      'definition plus partial-sync, dirty-skip detector, and full-sync call sites',
    )
  })
})

describe('_clearLocalInFlightAfterServerSettle', () => {
  it('clears only turn-state and preserves dirty local edits/messages', () => {
    const messages = [user('u1', 'read')]
    const sess = {
      id: 's1',
      title: 'local rename',
      pinned: true,
      agentId: 'local-agent',
      _dirty: true,
      _sendingInFlight: true,
      _streamingAssistant: { id: 'a-local' },
      _streamingThinking: { id: 't-local' },
      _turnStartedAt: 11,
      _lastFrameAt: 22,
      _activeTeamRun: { id: 'team', leaderAgentId: 'leader' },
      _isFirstTurnAfterReady: true,
      _turnStatus: { label: 'running' },
      _replyingToMsgId: 'u1',
      _currentTurnAnswerCount: 3,
      messages,
    }

    assert.equal(_clearLocalInFlightAfterServerSettle(sess, 1234), true)
    assert.equal(sess._dirty, true)
    assert.equal(sess.title, 'local rename')
    assert.equal(sess.pinned, true)
    assert.equal(sess.agentId, 'local-agent')
    assert.equal(sess.messages, messages)
    assert.equal(sess._sendingInFlight, false)
    assert.equal(sess._streamingAssistant, null)
    assert.equal(sess._streamingThinking, null)
    assert.equal(sess._turnStartedAt, null)
    assert.equal(sess._lastFrameAt, null)
    assert.equal(sess._activeTeamRun, null)
    assert.equal(sess._isFirstTurnAfterReady, false)
    assert.equal(sess._turnStatus, null)
    assert.equal(sess._replyingToMsgId, null)
    assert.equal(sess._currentTurnAnswerCount, 0)
    assert.equal(sess._trackerResetAt, 1234)
  })

  it('keeps dirty sessions on the skip path instead of merging remote over them', () => {
    assert.match(
      SYNC_SRC,
      /else if \(existingLocal\?\._dirty\) \{[\s\S]*const live = state\.sessions\.get\(remote\.id\)[\s\S]*_settleSyncedSessionInFlight\(live\)[\s\S]*continue/,
    )
    assert.doesNotMatch(
      SYNC_SRC,
      /dirtyServerSettled[\s\S]{0,240}mergedMessages = tentativeMerge/,
    )
  })
})

describe('_settleSyncedSessionInFlight', () => {
  it('clears both session and global current-session in-flight state', () => {
    const fakeState = { currentSessionId: 's1', sendingInFlight: true }
    const settle = makeSettleSyncedSessionInFlight(fakeState)
    const sess = {
      id: 's1',
      _sendingInFlight: true,
      _replyingToMsgId: 'u1',
      messages: [user('u1', 'read'), server('a1')],
    }

    settle(sess, 1234)

    assert.equal(sess._sendingInFlight, false)
    assert.equal(sess._replyingToMsgId, null)
    assert.equal(sess._trackerResetAt, 1234)
    assert.equal(fakeState.sendingInFlight, false)
  })

  it('is used by partial, dirty, and full server-settled paths', () => {
    const callCount = (SYNC_SRC.match(/_settleSyncedSessionInFlight\s*\(/g) || []).length
    assert.equal(callCount, 4, 'definition plus partial, dirty live, and full call sites')
  })
})

describe('_preserveLocalInFlightRuntime', () => {
  it('carries streaming pointers across non-terminal REST replacement and rebinds them', () => {
    const oldAssistant = { id: 'a1', role: 'assistant', text: 'old' }
    const oldThinking = { id: 't1', role: 'thinking', text: 'thinking-old' }
    const freshAssistant = { id: 'a1', role: 'assistant', text: 'fresh' }
    const freshThinking = { id: 't1', role: 'thinking', text: 'thinking-fresh' }
    const existingLocal = {
      _sendingInFlight: true,
      _streamingAssistant: oldAssistant,
      _streamingThinking: oldThinking,
      _replyingToMsgId: 'u1',
      _currentTurnAnswerCount: 2,
      _turnStartedAt: 10,
      _lastFrameAt: 20,
      _activeTeamRun: { id: 'team', leaderAgentId: 'leader' },
      _turnStatus: { status: 'compacting' },
      _pendingCostCredits: '3',
      _lastFinaledAssistantId: 'a0',
      _lastFinaledAt: 30,
    }
    const sess = { messages: [user('u1', 'read'), freshAssistant, freshThinking] }

    _preserveLocalInFlightRuntime(existingLocal, sess)
    _rebindStreamingPointers(sess)

    assert.equal(sess._sendingInFlight, true)
    assert.equal(sess._streamingAssistant, freshAssistant)
    assert.equal(sess._streamingThinking, freshThinking)
    assert.equal(sess._replyingToMsgId, 'u1')
    assert.equal(sess._currentTurnAnswerCount, 2)
    assert.equal(sess._turnStartedAt, 10)
    assert.equal(sess._lastFrameAt, 20)
    assert.deepEqual(sess._activeTeamRun, { id: 'team', leaderAgentId: 'leader' })
    assert.deepEqual(sess._turnStatus, { status: 'compacting' })
    assert.equal(sess._pendingCostCredits, '3')
    assert.equal(sess._lastFinaledAssistantId, 'a0')
    assert.equal(sess._lastFinaledAt, 30)
  })

  it('migrates the pre-rename _currentTurnBlockCount across REST replacement (deploy window)', () => {
    // A turn in flight when the rename shipped still carries the old field name
    // on the in-memory session object; preserve must not lose its answer count.
    const existingLocal = {
      _sendingInFlight: true,
      _replyingToMsgId: 'u1',
      _currentTurnBlockCount: 5,
    }
    const sess = { messages: [user('u1', 'read')] }
    _preserveLocalInFlightRuntime(existingLocal, sess)
    assert.equal(sess._currentTurnAnswerCount, 5)
  })

  it('is used by both non-terminal sync replacement paths', () => {
    const callCount = (SYNC_SRC.match(/_preserveLocalInFlightRuntime\s*\(/g) || []).length
    assert.equal(callCount, 3, 'definition plus partial-sync and full-sync call sites')
  })
})

describe('_shouldFetchSessionMetaForSync', () => {
  it('fetches missing local sessions', () => {
    assert.equal(_shouldFetchSessionMetaForSync({ id: 's1', updatedAt: 10 }, null, null), true)
  })

  it('force-fetches liveStreamBroken sessions even without newer updatedAt', () => {
    assert.equal(
      _shouldFetchSessionMetaForSync(
        { id: 's1', updatedAt: 10 },
        { id: 's1', _syncedAt: 10 },
        { id: 's1', _liveStreamBroken: true },
      ),
      true,
    )
  })

  it('fetches newer server metadata even when the live session is in-flight', () => {
    assert.equal(
      _shouldFetchSessionMetaForSync(
        { id: 's1', updatedAt: 20 },
        { id: 's1', _syncedAt: 10 },
        { id: 's1', _sendingInFlight: true },
      ),
      true,
    )
  })

  it('does not fetch unchanged synced sessions', () => {
    assert.equal(
      _shouldFetchSessionMetaForSync(
        { id: 's1', updatedAt: 10 },
        { id: 's1', _syncedAt: 10 },
        { id: 's1' },
      ),
      false,
    )
  })
})
