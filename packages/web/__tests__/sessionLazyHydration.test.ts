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
    'function _emitSyncStatus() {}',
    'function _rebindStreamingPointers() {}',
    extractTopLevelFn(SYNC_SRC, '_copyLocalSessionRuntimeState'),
    extractTopLevelFn(SYNC_SRC, '_buildSessionFromRemote'),
    extractTopLevelFn(SYNC_SRC, '_sessionDbSnapshot'),
    extractTopLevelFn(SYNC_SRC, '_canHydrateNow'),
    extractTopLevelFn(SYNC_SRC, 'hydrateSession'),
    extractTopLevelFn(SYNC_SRC, 'syncSessionsFromServer'),
  ].join('\n')
  return new Function(
    'deps',
    `const { apiGet, apiJson, dbGetAll, dbPut, dbDelete, state, isDeletePending, clearDeleteTombstone, _rebuildSearchIndex, pushSessionToServer } = deps; ${combined}; return { syncSessionsFromServer, hydrateSession, _buildSessionFromRemote };`,
  )
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
    const state = { token: 'tok', sessions: new Map(), currentSessionId: null, sendingInFlight: false }
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

    await pushSessionToServer({ id: 'web-placeholder', messages: [], _needsFetch: true, _syncedAt: 1 })
    assert.equal(called, false)
  })

  it('placeholder builder preserves live turn state while marking stale body', () => {
    const helpers = new Function(
      `${extractTopLevelFn(SYNC_SRC, '_copyLocalSessionRuntimeState')}\n${extractTopLevelFn(SYNC_SRC, '_buildSessionFromRemote')}; return { _buildSessionFromRemote };`,
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
