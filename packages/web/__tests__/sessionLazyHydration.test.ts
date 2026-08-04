/**
 * Regression tests for mobile-safe lazy session hydration.
 *
 * Run: npx tsx --test packages/web/__tests__/sessionLazyHydration.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)
const WS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'websocket.js'),
  'utf-8',
)

function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

function makeLazySyncHarness() {
  const combined = [
    'const AUTO_HYDRATE_RECENT_LIMIT = 1',
    'const _pendingDeletes = new Set()',
    'const DEFERRED_HYDRATE_DELAYS_MS = [0, 0, 0]',
    'function _emitSyncStatus() {}',
    'function _rebindStreamingPointers() {}',
    extractTopLevelFn(SYNC_SRC, '_copyLocalSessionRuntimeState'),
    extractTopLevelFn(SYNC_SRC, '_serverTapeLastSeq'),
    extractTopLevelFn(SYNC_SRC, '_buildSessionFromRemote'),
    extractTopLevelFn(SYNC_SRC, '_sessionDbSnapshot'),
    extractTopLevelFn(SYNC_SRC, '_canHydrateNow'),
    extractTopLevelFn(SYNC_SRC, '_markHydrateDebt'),
    extractTopLevelFn(SYNC_SRC, '_serverSnapshotLosesLocalTail'),
    extractTopLevelFn(SYNC_SRC, 'hydrateSession'),
    extractTopLevelFn(SYNC_SRC, 'retryDeferredHydration'),
    extractTopLevelFn(SYNC_SRC, 'syncSessionsFromServer'),
  ].join('\n')
  return new Function(
    'deps',
    `const { apiGet, apiJson, dbGetAll, dbPut, dbDelete, state, isDeletePending, clearDeleteTombstone, _rebuildSearchIndex, pushSessionToServer, projectSessionTape } = deps; ${combined}; return { syncSessionsFromServer, hydrateSession, retryDeferredHydration, _serverSnapshotLosesLocalTail, _buildSessionFromRemote };`,
  )
}

// Mirrors the real short-circuit in messages.js renderMessages(): the full-pane
// placeholder is only allowed when there is genuinely nothing to render.
function rendersPlaceholderInsteadOfContent(sess: any): boolean {
  const msgs = (sess?.messages || []).filter((m: any) => m?.role !== 'goal')
  return !!sess?._needsFetch && msgs.length === 0
}

describe('lazy session hydration', () => {
  it('cold-start sync creates placeholders and hydrates only one session body', async () => {
    const makeHarness = makeLazySyncHarness()
    const sessionGets: string[] = []
    const metas = Array.from({ length: 100 }, (_, i) => ({
      id: `web-cold-${String(i).padStart(3, '0')}`,
      agentId: 'codex',
      title: `Session ${i}`,
      pinned: false,
      createdAt: 1_000 + i,
      lastAt: 2_000 + i,
      updatedAt: 3_000 + i,
      messageCount: 50,
    }))
    const state = {
      token: 'tok',
      sessions: new Map(),
      currentSessionId: null,
      sendingInFlight: false,
    }
    const dbWrites: any[] = []
    const { syncSessionsFromServer } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        if (path === '/api/sessions/list') return { sessions: metas }
        sessionGets.push(path)
        const id = path.split('/').pop()
        const meta = metas.find((m) => m.id === id)
        return { ...meta, messages: [{ id: `m-${id}`, role: 'user', text: 'hello' }] }
      },
      dbGetAll: async () => [],
      dbPut: async (s: any) => dbWrites.push(s),
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: (s: any) => {
        s._searchText = s.title.toLowerCase()
      },
      pushSessionToServer: async () => {},
    })

    await syncSessionsFromServer()

    assert.equal(state.sessions.size, 100)
    assert.deepEqual(sessionGets, ['/api/sessions/web-cold-000'])
    assert.equal(state.sessions.get('web-cold-000')._needsFetch, false)
    assert.equal(state.sessions.get('web-cold-000').messages.length, 1)
    assert.equal(state.sessions.get('web-cold-099')._needsFetch, true)
    assert.equal(state.sessions.get('web-cold-099').messages.length, 0)
    assert.equal(dbWrites.length, 101) // 100 metadata rows + 1 hydrated current row
  })

  it('same-turn tape growth hydrates the latest cursor even when updatedAt and turnCount stay equal', async () => {
    const makeHarness = makeLazySyncHarness()
    const local: any = {
      id: 'web-tape-growth',
      title: 'Tape growth',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'old', role: 'assistant', text: '旧回答' }],
      _syncedAt: 20,
      _tapeTurnCount: 1,
      _tapeLastSeq: 1,
      _tapeFrames: [{ tapeSeq: 1 }],
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-tape-growth', local]]),
      currentSessionId: 'web-tape-growth',
      sendingInFlight: false,
    }
    const gets: string[] = []
    const { syncSessionsFromServer } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        gets.push(path)
        if (path === '/api/sessions/list') {
          return {
            sessions: [
              {
                id: local.id,
                title: local.title,
                agentId: local.agentId,
                pinned: false,
                createdAt: 1,
                lastAt: 2,
                updatedAt: 20,
                messageCount: 2,
                tapeTurnCount: 1,
                lastTapeSeq: 3,
              },
            ],
          }
        }
        if (path === '/api/sessions/web-tape-growth') {
          return { ...local, messages: [], updatedAt: 20, tape: { lastTapeSeq: 3 } }
        }
        return { frames: [{ tapeSeq: 3 }], nextBefore: null, hasMore: false }
      },
      projectSessionTape: () => [{ id: 'latest', role: 'assistant', text: '最新回答' }],
      dbGetAll: async () => [local],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    await syncSessionsFromServer()

    assert.deepEqual(gets, [
      '/api/sessions/list',
      '/api/sessions/web-tape-growth',
      '/api/sessions/web-tape-growth/tape?turns=5',
    ])
    assert.equal(state.sessions.get(local.id)._tapeLastSeq, 3)
    assert.equal(state.sessions.get(local.id).messages.at(-1)?.text, '最新回答')
  })

  it('an unchanged authoritative tape cursor does not refetch a hydrated session', async () => {
    const makeHarness = makeLazySyncHarness()
    const local: any = {
      id: 'web-tape-stable',
      title: 'Tape stable',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'latest', role: 'assistant', text: '最新回答' }],
      _syncedAt: 20,
      _tapeTurnCount: 1,
      _tapeLastSeq: 3,
      _tapeFrames: [{ tapeSeq: 3 }],
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-tape-stable', local]]),
      currentSessionId: 'web-tape-stable',
      sendingInFlight: false,
    }
    const gets: string[] = []
    const { syncSessionsFromServer } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        gets.push(path)
        return {
          sessions: [
            {
              id: local.id,
              title: local.title,
              agentId: local.agentId,
              pinned: false,
              createdAt: 1,
              lastAt: 2,
              updatedAt: 20,
              messageCount: 2,
              tapeTurnCount: 1,
              lastTapeSeq: 3,
            },
          ],
        }
      },
      dbGetAll: async () => [local],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    await syncSessionsFromServer()
    assert.deepEqual(gets, ['/api/sessions/list'])
    assert.equal(state.sessions.get(local.id), local)
  })

  it('resume failure forces tape hydration despite equal metadata and the ordinary hydrate limit', async () => {
    const makeHarness = makeLazySyncHarness()
    const fallback: any = {
      id: 'web-fallback',
      title: 'Fallback',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 3,
      messages: [],
      _syncedAt: 10,
      _needsFetch: true,
    }
    const broken: any = {
      id: 'web-broken-equal',
      title: 'Broken',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'old', role: 'assistant', text: '旧回答' }],
      _syncedAt: 20,
      _tapeTurnCount: 1,
      _tapeLastSeq: 3,
      _tapeFrames: [{ tapeSeq: 3 }],
      _liveStreamBroken: true,
    }
    const state = {
      token: 'tok',
      sessions: new Map([
        [fallback.id, fallback],
        [broken.id, broken],
      ]),
      currentSessionId: fallback.id,
      sendingInFlight: false,
    }
    const gets: string[] = []
    const { syncSessionsFromServer } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        gets.push(path)
        if (path === '/api/sessions/list') {
          return {
            sessions: [
              { ...fallback, messageCount: 1, updatedAt: 10 },
              {
                id: broken.id,
                title: broken.title,
                agentId: broken.agentId,
                pinned: false,
                createdAt: 1,
                lastAt: 2,
                updatedAt: 20,
                messageCount: 2,
                tapeTurnCount: 1,
                lastTapeSeq: 3,
              },
            ],
          }
        }
        if (path === '/api/sessions/web-broken-equal') {
          return { ...broken, messages: [], tape: { lastTapeSeq: 3 } }
        }
        if (path === '/api/sessions/web-broken-equal/tape?turns=5') {
          return { frames: [{ tapeSeq: 3 }], nextBefore: null, hasMore: false }
        }
        return { ...fallback, messages: [{ id: 'fallback-full', role: 'user', text: 'q' }] }
      },
      projectSessionTape: () => [{ id: 'recovered', role: 'assistant', text: '恢复的最新回答' }],
      dbGetAll: async () => [fallback, broken],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    await syncSessionsFromServer()

    assert.ok(gets.includes('/api/sessions/web-broken-equal/tape?turns=5'))
    assert.ok(gets.includes('/api/sessions/web-fallback'))
    assert.equal(state.sessions.get(broken.id)._liveStreamBroken, false)
    assert.equal(state.sessions.get(broken.id).messages.at(-1)?.text, '恢复的最新回答')
  })

  it('placeholder sessions are never pushed before hydration', async () => {
    const pushSrc = extractTopLevelFn(SYNC_SRC, 'pushSessionToServer')
    let called = false
    const pushSessionToServer = new Function(
      'state',
      'apiFetch',
      'authHeaders',
      'apiGet',
      'dbPut',
      '_onConflictResolved',
      '_onRequestRetryPush',
      '_localDominates',
      '_mergeServerPlanFields',
      '_rebindStreamingPointers',
      '_rebuildSearchIndex',
      '_sessionDbSnapshot',
      `${pushSrc}; return pushSessionToServer;`,
    )(
      { token: 'tok', sessions: new Map() },
      async () => {
        called = true
        throw new Error('must not be called')
      },
      () => ({}),
      async () => ({}),
      async () => {},
      null,
      null,
      () => false,
      () => {},
      () => {},
      () => {},
      (s: any) => s,
    )

    await pushSessionToServer({
      id: 'web-placeholder',
      messages: [],
      _needsFetch: true,
      _syncedAt: 1,
    })
    assert.equal(called, false)
  })

  it('placeholder builder preserves live turn state while marking stale body', () => {
    const helpers = new Function(
      `${extractTopLevelFn(SYNC_SRC, '_copyLocalSessionRuntimeState')}\n${extractTopLevelFn(SYNC_SRC, '_serverTapeLastSeq')}\n${extractTopLevelFn(SYNC_SRC, '_buildSessionFromRemote')}; return { _buildSessionFromRemote };`,
    )() as { _buildSessionFromRemote: (remote: any, existing: any, opts: any) => any }
    const sess = helpers._buildSessionFromRemote(
      {
        id: 'web-existing',
        title: 'Remote title',
        agentId: 'codex',
        pinned: true,
        createdAt: 1,
        lastAt: 2,
        updatedAt: 99,
        messageCount: 1,
      },
      {
        messages: [{ id: 'm1', role: 'assistant', text: 'old' }],
        _syncedAt: 10,
        _sendingInFlight: true,
        _turnStartedAt: 11,
        _lastFrameAt: 12,
        _lastFrameSeq: 13,
      },
      { placeholder: true },
    )
    assert.equal(sess._needsFetch, true)
    assert.equal(sess._sendingInFlight, true)
    assert.equal(sess._turnStartedAt, 11)
    assert.equal(sess._lastFrameAt, 12)
    assert.equal(sess._lastFrameSeq, 13)
    assert.equal(sess.messages.length, 1)
  })

  it('dirty local sessions are not overwritten by stale metadata or hydration', async () => {
    const makeHarness = makeLazySyncHarness()
    const localDirty = {
      id: 'web-dirty',
      title: 'Local dirty title',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'local-msg', role: 'user', text: 'local unsynced' }],
      _syncedAt: 10,
      _dirty: true,
      _liveStreamBroken: true,
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-dirty', localDirty]]),
      currentSessionId: null,
      sendingInFlight: false,
    }
    const sessionGets: string[] = []
    const { syncSessionsFromServer, hydrateSession } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        if (path === '/api/sessions/list') {
          return {
            sessions: [
              {
                id: 'web-dirty',
                title: 'Remote newer title',
                agentId: 'main',
                pinned: true,
                createdAt: 1,
                lastAt: 50,
                updatedAt: 100,
                messageCount: 99,
              },
            ],
          }
        }
        sessionGets.push(path)
        return {
          id: 'web-dirty',
          title: 'Remote newer title',
          messages: [{ id: 'remote-msg', role: 'assistant', text: 'remote' }],
          updatedAt: 100,
        }
      },
      dbGetAll: async () => [localDirty],
      dbPut: async () => {
        throw new Error('dirty local should not be rewritten by sync/hydrate')
      },
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    await syncSessionsFromServer()
    assert.deepEqual(sessionGets, [])
    assert.equal(state.sessions.get('web-dirty'), localDirty)
    assert.equal(state.sessions.get('web-dirty').title, 'Local dirty title')
    assert.equal(state.sessions.get('web-dirty')._dirty, true)
    assert.equal(
      state.sessions.get('web-dirty')._liveStreamBroken,
      true,
      'a list-only sync must not retire an unreconciled replay miss',
    )
    assert.equal(state.sessions.get('web-dirty')._needsFetch, undefined)

    const hydrated = await hydrateSession('web-dirty')
    assert.equal(hydrated, localDirty)
    assert.deepEqual(sessionGets, [])
  })

  // Regression: a turn that ended abnormally (backgrounded subtask vanish,
  // disconnect, force-quit) leaves a stale persisted `_sendingInFlight=true`.
  // Within the 10-min freshness window sanitizeLoadedTurnState keeps it, and the
  // OLD gate (`_sendingInFlight && !_liveStreamBroken`) permanently blocked hydrate
  // — so reopening (esp. on mobile, restoring from IndexedDB) showed a truncated
  // history. The new gate ignores the persisted flag, so hydrate proceeds.
  it('stale persisted _sendingInFlight no longer blocks hydration', async () => {
    const makeHarness = makeLazySyncHarness()
    const stale = {
      id: 'web-stale',
      title: 'Stale',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'm-old', role: 'user', text: 'partial' }],
      _syncedAt: 10,
      _needsFetch: true,
      _sendingInFlight: true, // stale leftover; NO runtime streaming pointers
      _turnStartedAt: 11,
      _dirty: false,
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-stale', stale]]),
      currentSessionId: 'web-stale',
      sendingInFlight: true,
    }
    const sessionGets: string[] = []
    const { hydrateSession } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        sessionGets.push(path)
        return {
          id: 'web-stale',
          title: 'Stale',
          messages: [
            { id: 'm-old', role: 'user', text: 'partial' },
            { id: 'm-new', role: 'assistant', text: 'full reply' },
          ],
          updatedAt: 20,
        }
      },
      dbGetAll: async () => [stale],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    const hydrated = await hydrateSession('web-stale')
    assert.deepEqual(sessionGets, ['/api/sessions/web-stale'])
    assert.equal(hydrated.messages.length, 2)
    assert.equal(hydrated._needsFetch, false)
  })

  // A genuinely live stream (runtime-only pointer set by an in-flight turn in THIS
  // tab) must still skip hydrate so the server snapshot can't clobber the tail.
  it('live runtime streaming pointer still skips hydration', async () => {
    const makeHarness = makeLazySyncHarness()
    const live = {
      id: 'web-live',
      title: 'Live',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'm1', role: 'user', text: 'q' }],
      _syncedAt: 10,
      _needsFetch: true,
      _streamingAssistant: { id: 'stream-1' }, // runtime-only → truly streaming now
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-live', live]]),
      currentSessionId: 'web-live',
      sendingInFlight: true,
    }
    const sessionGets: string[] = []
    const { hydrateSession } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        sessionGets.push(path)
        return { id: 'web-live', messages: [], updatedAt: 20 }
      },
      dbGetAll: async () => [live],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    const result = await hydrateSession('web-live')
    assert.deepEqual(sessionGets, []) // no GET — protect the streaming tail
    assert.equal(result, live)
  })

  // resume_failed recovery: _liveStreamBroken takes priority over the live-pointer
  // skip so the REST refetch reconciles missed frames even while a long turn runs.
  it('liveStreamBroken forces hydration despite runtime pointer + sendingInFlight', async () => {
    const makeHarness = makeLazySyncHarness()
    const broken = {
      id: 'web-broken',
      title: 'Broken',
      agentId: 'codex',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [{ id: 'm1', role: 'user', text: 'q' }],
      _syncedAt: 10,
      _needsFetch: true,
      _sendingInFlight: true,
      _streamingAssistant: { id: 's1' }, // long turn still running, pointer lingers
      _liveStreamBroken: true, // but replay-miss → MUST refetch from REST
      _dirty: false,
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-broken', broken]]),
      currentSessionId: 'web-broken',
      sendingInFlight: true,
    }
    const sessionGets: string[] = []
    const dbWrites: any[] = []
    const { hydrateSession } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        sessionGets.push(path)
        return {
          id: 'web-broken',
          messages: [
            { id: 'm1', role: 'user', text: 'q' },
            { id: 'm2', role: 'assistant', text: 'recovered' },
          ],
          updatedAt: 20,
        }
      },
      dbGetAll: async () => [broken],
      dbPut: async (s: any) => dbWrites.push(s),
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    const hydrated = await hydrateSession('web-broken')
    assert.deepEqual(sessionGets, ['/api/sessions/web-broken'])
    assert.equal(hydrated.messages.length, 2)
    // _liveStreamBroken retired by the successful REST reconciliation — in memory
    // and in the persisted snapshot — so it can't survive a reload as a stale flag
    // that would later bypass the live-pointer protection.
    assert.equal(hydrated._liveStreamBroken, false)
    assert.equal(dbWrites.at(-1)?._liveStreamBroken, false)
  })

  // ── Cross-device: "the turn finished but the content isn't showing" ──
  //
  // Device B cold-starts into a placeholder session, then a turn started on
  // device A streams in over WS while B's hydration GET is still in flight.
  // The GET result must be dropped (it would clobber the tail), but the gap has
  // to be remembered and settled once the turn ends — otherwise the session
  // stays truncated until the user manually switches away and back.
  it('hydration lost to an arriving stream is retried after the turn ends', async () => {
    const makeHarness = makeLazySyncHarness()
    const sess: any = {
      id: 'web-crossdevice',
      title: '跨设备会话',
      agentId: 'main',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [],
      _syncedAt: 10,
      _needsFetch: true,
      _messageCount: 42,
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-crossdevice', sess]]),
      currentSessionId: 'web-crossdevice',
      sendingInFlight: false,
    }
    const history = Array.from({ length: 42 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 ? 'assistant' : 'user',
      text: `历史消息 ${i}`,
    }))
    const sessionGets: string[] = []
    const { hydrateSession, retryDeferredHydration } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async (path: string) => {
        sessionGets.push(path)
        if (sessionGets.length === 1) {
          // Device A's stream lands mid-GET → runtime pointer appears.
          const live = state.sessions.get('web-crossdevice')!
          live._streamingAssistant = { id: 'stream-1', role: 'assistant', text: '回答中…' }
          live.messages.push(live._streamingAssistant)
          return { id: 'web-crossdevice', messages: history, updatedAt: 20 }
        }
        // By retry time the gateway's server-authored write has landed.
        return {
          id: 'web-crossdevice',
          messages: [...history, { id: 's-final', role: 'assistant', text: '完整回答' }],
          updatedAt: 30,
        }
      },
      dbGetAll: async () => [sess],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    const raced = await hydrateSession('web-crossdevice')
    assert.deepEqual(sessionGets, ['/api/sessions/web-crossdevice'])
    assert.equal(raced.messages.length, 1, 'server body correctly not adopted mid-stream')
    assert.equal(raced._needsFetch, true)
    assert.equal(raced._hydrateDeferred, true, 'the gap must be recorded as debt')
    // Content already in memory stays visible — no full-pane placeholder.
    assert.equal(rendersPlaceholderInsteadOfContent(raced), false)

    // isFinal: pointers cleared, local tail holds the complete reply.
    const live = state.sessions.get('web-crossdevice')!
    live._streamingAssistant = null
    live._sendingInFlight = false
    live.messages[live.messages.length - 1].text = '完整回答'

    let rendered = 0
    await retryDeferredHydration('web-crossdevice', { onHydrated: () => rendered++ })

    const settled = state.sessions.get('web-crossdevice')!
    assert.equal(settled.messages.length, 43, 'full history recovered automatically')
    assert.equal(settled._needsFetch, false)
    assert.equal(settled._hydrateDeferred, false)
    assert.equal(rendered, 1, 'UI told to repaint')
  })

  // The gateway persists the authoritative assistant message with a
  // fire-and-forget write that is NOT ordered against isFinal, so a retry can
  // race it. Adopting a snapshot without the just-finished reply would erase a
  // visible answer — the exact bug in reverse.
  it('refuses a server snapshot that still lacks the finished reply', async () => {
    const makeHarness = makeLazySyncHarness()
    const sess: any = {
      id: 'web-race',
      title: 'Race',
      agentId: 'main',
      pinned: false,
      createdAt: 1,
      lastAt: 2,
      messages: [
        { id: 'm-0', role: 'user', text: '问题' },
        { id: 'm-1', role: 'assistant', text: '刚刚流式完成的完整回答' },
      ],
      _syncedAt: 10,
      _needsFetch: true,
      _hydrateDeferred: true,
    }
    const state = {
      token: 'tok',
      sessions: new Map([['web-race', sess]]),
      currentSessionId: 'web-race',
      sendingInFlight: false,
    }
    let gets = 0
    const { retryDeferredHydration } = makeHarness({
      state,
      apiJson: async () => ({}),
      apiGet: async () => {
        gets++
        // Persistence never lands: snapshot has history but not the reply.
        return {
          id: 'web-race',
          messages: [{ id: 'm-0', role: 'user', text: '问题' }],
          updatedAt: 20,
        }
      },
      dbGetAll: async () => [sess],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })

    let rendered = 0
    await retryDeferredHydration('web-race', { onHydrated: () => rendered++ })

    const after = state.sessions.get('web-race')!
    assert.equal(after.messages.length, 2, 'the streamed reply must survive')
    assert.equal(after.messages[1].text, '刚刚流式完成的完整回答')
    assert.equal(rendered, 0)
    assert.ok(gets >= 1 && gets <= 3, 'retries are bounded, not infinite')
    // Still incomplete, but the transcript renders — banner offers manual retry.
    assert.equal(rendersPlaceholderInsteadOfContent(after), false)
  })

  it('tail guard accepts a server snapshot that re-authored a superset', () => {
    const { _serverSnapshotLosesLocalTail } = makeLazySyncHarness()({
      state: { sessions: new Map() },
      apiGet: async () => ({}),
      apiJson: async () => ({}),
      dbGetAll: async () => [],
      dbPut: async () => {},
      dbDelete: async () => {},
      isDeletePending: () => false,
      clearDeleteTombstone: () => {},
      _rebuildSearchIndex: () => {},
      pushSessionToServer: async () => {},
    })
    const local = [{ id: 'm-1', role: 'assistant', text: '部分回' }]
    // Server re-authored the complete text under a different id — must adopt.
    assert.equal(
      _serverSnapshotLosesLocalTail(
        [{ id: 's-1', role: 'assistant', text: '部分回答完整版' }],
        local,
      ),
      false,
    )
    // Server is genuinely behind — must refuse.
    assert.equal(
      _serverSnapshotLosesLocalTail([{ id: 'm-0', role: 'user', text: '问' }], local),
      true,
    )
    // No local assistant content to lose — nothing to guard.
    assert.equal(
      _serverSnapshotLosesLocalTail([], [{ id: 'm-0', role: 'user', text: '问' }]),
      false,
    )
  })

  it('hello peer filter includes current placeholder and active sessions only', () => {
    const buildHelloPeers = new Function(
      'state',
      'HELLO_PEERS_LIMIT',
      `${extractTopLevelFn(WS_SRC, 'buildHelloPeers')}; return buildHelloPeers;`,
    )(
      {
        currentSessionId: 'web-current-placeholder',
        defaultAgentId: 'main',
        sessions: new Map([
          ['web-current-placeholder', { agentId: 'codex', _needsFetch: true }],
          ['web-inactive-placeholder', { agentId: 'codex', _needsFetch: true }],
          ['web-active', { agentId: 'main', _sendingInFlight: true }],
          ['web-cursor', { agentId: 'codex', _lastFrameSeq: 7 }],
        ]),
      },
      50,
    ) as () => Array<{ peerId: string; lastFrameSeq: number; inFlight: boolean }>

    const peers = buildHelloPeers()
    assert.deepEqual(
      peers.map((p) => p.peerId),
      ['web-current-placeholder', 'web-active', 'web-cursor'],
    )
    assert.equal(peers.find((p) => p.peerId === 'web-cursor')?.lastFrameSeq, 7)
    assert.equal(peers.find((p) => p.peerId === 'web-active')?.inFlight, true)
  })
})
