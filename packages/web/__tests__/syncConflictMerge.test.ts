/**
 * Unit tests for sync.js 409 local-dominates resolution helpers.
 *
 * Covers the pure functions _localMessageSupersedes and _localDominates,
 * which decide whether a client can safely keep its local messages when
 * the server returns 409 conflict.
 *
 * Uses source-extract + new Function() to avoid pulling in ESM dependencies
 * that reference browser-only globals (localStorage etc.), following the
 * established pattern from pureFunctions.test.ts.
 *
 * Run: npx tsx --test packages/web/__tests__/syncConflictMerge.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)

/**
 * Extract a top-level `export function name(...)` by finding the signature
 * line, then scanning for the closing `}` at column 0 (top-level indent).
 */
function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  // Closing brace at column 0, exact "}"
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

function makeCallable<T extends (...args: any[]) => any>(src: string): T {
  const m = src.match(/function\s+(\w+)/)
  if (!m) throw new Error('no function name')
  return new Function(`${src}; return ${m[1]};`)() as T
}

// _localDominates calls _localMessageSupersedes which in turn calls
// _stableStringify. Compile the whole closure together in one `new Function`.
const _combined =
  extractTopLevelFn(SYNC_SRC, '_stableStringify') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes') +
  '\n' +
  extractTopLevelFn(SYNC_SRC, '_localDominates')
const _helpers = new Function(
  `${_combined}; return { _stableStringify, _localMessageSupersedes, _localDominates };`,
)() as {
  _stableStringify: (v: any) => string | null
  _localMessageSupersedes: (l: any, s: any) => boolean
  _localDominates: (s: any, l: any) => boolean
}
const _localMessageSupersedes = _helpers._localMessageSupersedes
const _localDominates = _helpers._localDominates

// ═══════════════════════════════════════════════════════════════════
// _localMessageSupersedes
// ═══════════════════════════════════════════════════════════════════

describe('_localMessageSupersedes — role whitelist', () => {
  it('assistant: identical text → true', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hello' },
      ),
      true,
    )
  })

  it('assistant: local extends server as prefix → true (primary streaming case)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello world' },
        { id: 'a1', role: 'assistant', text: 'hello' },
      ),
      true,
    )
  })

  it('thinking: local extends server as prefix → true', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'thinking', text: 'analyzing the problem carefully' },
        { id: 't1', role: 'thinking', text: 'analyzing the' },
      ),
      true,
    )
  })

  it('assistant: local shorter than server → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hi' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ),
      false,
    )
  })

  it('assistant: same length but divergent (non-prefix) → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello there!' },
        { id: 'a1', role: 'assistant', text: 'hello friend' },
      ),
      false,
    )
  })

  it('assistant: server text empty, local non-empty → true', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello' },
        { id: 'a1', role: 'assistant', text: '' },
      ),
      true,
    )
  })

  it('user: identical text → true (status field ignored by design)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'u1', role: 'user', text: 'hi', status: 'sending' },
        { id: 'u1', role: 'user', text: 'hi', status: 'sent' },
      ),
      true,
    )
  })

  it('user: text differs → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'u1', role: 'user', text: 'hi' },
      ),
      false,
    )
  })

  it('tool role, diverging fields → false (Layer 1 fails, not whitelisted for Layer 2)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' },
        { id: 't1', role: 'tool', text: 'Bash', _completed: false },
      ),
      false,
    )
  })

  it('tool role, identical → true via Layer 1 stable-equality', () => {
    // Regression guard: historical tool rows in shared prefix must pass
    // if nothing mutated, otherwise they'd block local-dominates and
    // sessions with any past tool call would drop streaming extensions.
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' },
        { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' },
      ),
      true,
    )
  })

  it('tool role, identical but key insertion order differs → true (stable stringify)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'tool', _completed: true, text: 'Bash', output: 'done' },
        { output: 'done', role: 'tool', text: 'Bash', id: 't1', _completed: true },
      ),
      true,
    )
  })

  it('agent-group role, identical → true via Layer 1', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'g1', role: 'agent-group', text: 'agent' },
        { id: 'g1', role: 'agent-group', text: 'agent' },
      ),
      true,
    )
  })

  it('agent-group role, diverging text → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'g1', role: 'agent-group', text: 'agent-v2' },
        { id: 'g1', role: 'agent-group', text: 'agent-v1' },
      ),
      false,
    )
  })

  it('permission role, identical → true via Layer 1', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'p1', role: 'permission', text: 'bash' },
        { id: 'p1', role: 'permission', text: 'bash' },
      ),
      true,
    )
  })

  it('assistant with identical childBlocks → true via Layer 1', () => {
    const cb = [{ kind: 'text', text: 'x' }]
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello', childBlocks: cb },
        { id: 'a1', role: 'assistant', text: 'hello', childBlocks: [{ kind: 'text', text: 'x' }] },
      ),
      true,
    )
  })

  it('assistant with childBlocks locally but not on server → false (Layer 2 also refused)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello', childBlocks: [] },
        { id: 'a1', role: 'assistant', text: 'hello' },
      ),
      false,
    )
  })

  it('assistant, server side has childBlocks, local extends text but not blocks → false', () => {
    // Even though local.text extends server.text, childBlocks on server
    // side means Layer 2 refuses (the blocks themselves could have data
    // we don\'t have on local).
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello world' },
        {
          id: 'a1',
          role: 'assistant',
          text: 'hello',
          childBlocks: [{ kind: 'text', text: 'x' }],
        },
      ),
      false,
    )
  })

  it('role mismatch → false (malformed data guard)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'x1', role: 'assistant', text: 'hi' },
        { id: 'x1', role: 'user', text: 'hi' },
      ),
      false,
    )
  })

  it('null / undefined args → false', () => {
    assert.equal(_localMessageSupersedes(null, { id: 'a', role: 'assistant', text: 'x' }), false)
    assert.equal(_localMessageSupersedes({ id: 'a', role: 'assistant', text: 'x' }, null), false)
    assert.equal(_localMessageSupersedes(undefined, undefined), false)
  })

  it('missing text field on both sides → treated as empty, assistant accepts', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant' },
        { id: 'a1', role: 'assistant' },
      ),
      true,
    )
  })

  it('same object reference → true (identity shortcut)', () => {
    const m = { id: 'a1', role: 'assistant', text: 'whatever' }
    assert.equal(_localMessageSupersedes(m, m), true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// _localDominates
// ═══════════════════════════════════════════════════════════════════

describe('_localDominates — local clean-superset judge', () => {
  const u = (id: string, text: string) => ({ id, role: 'user', text })
  const a = (id: string, text: string) => ({ id, role: 'assistant', text })

  it('identical messages → true', () => {
    const msgs = [u('u1', 'hi'), a('a1', 'hello')]
    assert.equal(_localDominates(msgs, msgs), true)
  })

  it('local is server + extra tail (append-only) → true', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello')]
    const local = [u('u1', 'hi'), a('a1', 'hello'), u('u2', 'more')]
    assert.equal(_localDominates(server, local), true)
  })

  it('same length, last assistant extends server prefix (streaming) → true', () => {
    const server = [u('u1', 'hi'), a('a1', 'partial')]
    const local = [u('u1', 'hi'), a('a1', 'partial answer complete')]
    assert.equal(_localDominates(server, local), true)
  })

  it('server longer than local → false', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello'), u('u2', 'more')]
    const local = [u('u1', 'hi'), a('a1', 'hello')]
    assert.equal(_localDominates(server, local), false)
  })

  it('id mismatch at some index → false', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello')]
    const local = [u('u1', 'hi'), a('a2', 'hello')]
    assert.equal(_localDominates(server, local), false)
  })

  it('same id mid-prefix but content diverges non-prefix → false (edit conflict)', () => {
    const server = [u('u1', 'hi'), a('a1', 'version A'), u('u2', 'more')]
    const local = [u('u1', 'hi'), a('a1', 'version B'), u('u2', 'more')]
    assert.equal(_localDominates(server, local), false)
  })

  it('shared prefix has tool with diverging state → false (Layer 1 fails, Layer 2 not whitelisted)', () => {
    const server = [
      u('u1', 'run'),
      { id: 't1', role: 'tool', text: 'Bash', _partial: true },
    ]
    const local = [
      u('u1', 'run'),
      { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' },
    ]
    assert.equal(_localDominates(server, local), false)
  })

  it('shared prefix has IDENTICAL historical tool + tail assistant streaming extension → true (primary bug fix)', () => {
    // This is the exact scenario where the original bug resurfaced:
    // almost every real conversation has at least one tool row in its
    // history. Without Layer 1 (stable stringify), that historical row
    // would force server-wins and the streaming assistant extension
    // would be dropped — the "flash and disappear" symptom.
    const tool = { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' }
    const server = [
      u('u1', 'run'),
      { ...tool },  // fresh object same fields
      a('a1', 'partial answer'),
    ]
    const local = [
      u('u1', 'run'),
      { ...tool },
      a('a1', 'partial answer plus streaming extension'),
    ]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has identical agent-group + tail user append → true', () => {
    const group = { id: 'g1', role: 'agent-group', text: 'agent', metadata: { x: 1 } }
    const server = [u('u1', 'hi'), { ...group }]
    const local = [u('u1', 'hi'), { ...group }, u('u2', 'follow up')]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has identical permission → does not block dominance', () => {
    const perm = { id: 'p1', role: 'permission', text: 'bash', approved: true }
    const server = [u('u1', 'hi'), { ...perm }, a('a1', 'partial')]
    const local = [u('u1', 'hi'), { ...perm }, a('a1', 'partial extended')]
    assert.equal(_localDominates(server, local), true)
  })

  it('server empty → true (any local dominates empty)', () => {
    assert.equal(_localDominates([], [u('u1', 'hi')]), true)
    assert.equal(_localDominates([], []), true)
  })

  it('local empty, server non-empty → false', () => {
    assert.equal(_localDominates([u('u1', 'hi')], []), false)
  })

  it('non-array inputs treated as empty', () => {
    assert.equal(_localDominates(null as any, []), true)
    assert.equal(_localDominates([], null as any), true)
    assert.equal(_localDominates([u('u1', 'hi')], null as any), false)
  })

  it('middle insert on local (not append-only) → false', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello')]
    const local = [u('u1', 'hi'), a('a-new', 'surprise'), a('a1', 'hello')]
    assert.equal(_localDominates(server, local), false)
  })

  it('msg with missing id at server index → false', () => {
    const server: any[] = [{ role: 'user', text: 'hi' }, a('a1', 'x')]
    const local = [u('u1', 'hi'), a('a1', 'x')]
    assert.equal(_localDominates(server, local), false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// pushSessionToServer — 409 integration paths
// ═══════════════════════════════════════════════════════════════════
//
// Extracts pushSessionToServer + its helper closure into a fresh function
// body and injects stubbed `apiFetch`, `apiGet`, `authHeaders`, `dbPut`,
// `_rebuildSearchIndex`, `state`, and dep callbacks as named parameters.
// This way we exercise the real production code path without pulling in
// the browser-global deps in sync.js's own imports.

// 2026-05-06 §4.6 改动 12 — pushSessionToServer 在 PUT 前调 _stripMessageEphemeral
// 把客户端不该写的字段(_seq/_source/usage/_truncated/_errorCode/_errorDetail/
// _rawMeta/_partial/_completed/output/error/bashTail/inputJson/inputPreview/metaText
// + status='replied')剥掉。这是模块级 export 函数,在 makePush 的 new Function 闭包
// 里看不到 — 必须显式 extract 进 src bundle,否则 pushSessionToServer 一调就 ReferenceError。
// _MSG_EPHEMERAL_KEYS / _MSG_SERVER_AUTHORITATIVE_KEYS 是 module-level const 数组,
// 同样需要镜像到闭包。下面用正则从 SYNC_SRC 抓 const 块。
const _MSG_EPHEMERAL_KEYS_SRC =
  /const\s+_MSG_EPHEMERAL_KEYS\s*=\s*\[[\s\S]*?\]/.exec(SYNC_SRC)?.[0] ?? ''
const _MSG_SERVER_AUTHORITATIVE_KEYS_SRC =
  /const\s+_MSG_SERVER_AUTHORITATIVE_KEYS\s*=\s*\[[\s\S]*?\]/.exec(SYNC_SRC)?.[0] ?? ''
if (!_MSG_EPHEMERAL_KEYS_SRC) {
  throw new Error('_MSG_EPHEMERAL_KEYS const not found in sync.js source')
}
if (!_MSG_SERVER_AUTHORITATIVE_KEYS_SRC) {
  throw new Error('_MSG_SERVER_AUTHORITATIVE_KEYS const not found in sync.js source')
}

const _pushFnSrc =
  _MSG_EPHEMERAL_KEYS_SRC + '\n' +
  _MSG_SERVER_AUTHORITATIVE_KEYS_SRC + '\n' +
  extractTopLevelFn(SYNC_SRC, '_stripMessageEphemeral') + '\n' +
  extractTopLevelFn(SYNC_SRC, '_stableStringify') + '\n' +
  extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes') + '\n' +
  extractTopLevelFn(SYNC_SRC, '_localDominates') + '\n' +
  extractTopLevelFn(SYNC_SRC, '_rebindStreamingPointers') + '\n' +
  extractTopLevelFn(SYNC_SRC, 'pushSessionToServer')

type PushDeps = {
  apiFetch: (url: string, opts: any) => Promise<any>
  apiGet: (url: string) => Promise<any>
  authHeaders: (h: any) => any
  dbPut: (row: any) => Promise<void>
  _rebuildSearchIndex: (sess: any) => void
  state: { token: string; sessions: Map<string, any> }
  _onConflictResolved: ((id: string, mode?: 'local-dominates' | 'server-wins') => void) | null
  _onRequestRetryPush: ((id: string) => void) | null
}

// Parse the production CONFLICT_RETRY_MAX value out of sync.js. The harness
// keeps its integration-test cap small (3) for short loops, but this lets
// tests also assert the CURRENT production value — so a stealth regression
// (someone halves the cap) breaks tests instead of degrading quietly at
// runtime.
const _capMatch = /const CONFLICT_RETRY_MAX = (\d+)/.exec(SYNC_SRC)
const PROD_CONFLICT_RETRY_MAX = _capMatch ? Number(_capMatch[1]) : NaN

function makePush(deps: PushDeps, retryMax = 3) {
  const factory = new Function(
    'apiFetch', 'apiGet', 'authHeaders', 'dbPut', '_rebuildSearchIndex',
    'state', '_onConflictResolved', '_onRequestRetryPush', 'CONFLICT_RETRY_MAX',
    `${_pushFnSrc}; return pushSessionToServer;`,
  )
  return factory(
    deps.apiFetch, deps.apiGet, deps.authHeaders, deps.dbPut,
    deps._rebuildSearchIndex, deps.state,
    deps._onConflictResolved, deps._onRequestRetryPush, retryMax,
  ) as (sess: any) => Promise<any>
}

// Minimal response shape pushSessionToServer expects
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body })
const conflict = () => ({ ok: false, status: 409, json: async () => ({}) })

function baseDeps(overrides: Partial<PushDeps> = {}): PushDeps & {
  putCalls: any[]
  getCalls: string[]
  dbCalls: any[]
  rebuildCalls: any[]
  conflictCb: Array<{ id: string; mode?: string }>
  retryCb: string[]
} {
  const putCalls: any[] = []
  const getCalls: string[] = []
  const dbCalls: any[] = []
  const rebuildCalls: any[] = []
  const conflictCb: Array<{ id: string; mode?: string }> = []
  const retryCb: string[] = []

  const deps: any = {
    apiFetch: async (_url: string, opts: any) => {
      putCalls.push(JSON.parse(opts.body))
      return (overrides as any)._apiFetchImpl
        ? (overrides as any)._apiFetchImpl(putCalls.length)
        : ok({ applied: true, updatedAt: Date.now() })
    },
    apiGet: async (url: string) => {
      getCalls.push(url)
      return (overrides as any)._apiGetImpl?.() ?? null
    },
    authHeaders: (h: any) => h,
    dbPut: async (row: any) => { dbCalls.push(row) },
    _rebuildSearchIndex: (sess: any) => { rebuildCalls.push(sess.id) },
    state: { token: 'tok', sessions: new Map() },
    _onConflictResolved: (id: string, mode?: string) => { conflictCb.push({ id, mode }) },
    _onRequestRetryPush: (id: string) => { retryCb.push(id) },
    ...overrides,
  }
  return Object.assign(deps, { putCalls, getCalls, dbCalls, rebuildCalls, conflictCb, retryCb })
}

describe('pushSessionToServer — 409 local-dominates', () => {
  it('primary case: streaming assistant prefix extension — keeps local, bumps retry count, triggers retry', async () => {
    const sessId = 'sess-a'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial answer complete' }

    const sess: any = {
      id: sessId,
      title: 'local title',
      messages: [userMsg, localAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'agent-a',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server title',  // another tab renamed
        messages: [userMsg, serverAsst],  // stale snapshot
        lastAt: 1100,  // server lastAt newer (another tab activity)
        pinned: true,  // another tab pinned
        agentId: 'agent-b',  // another tab switched agent
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Local messages preserved (the whole point)
    assert.equal(sess.messages[1].text, 'partial answer complete')
    // Server metadata adopted (blocker 1: no clobbering of other tab's edits)
    assert.equal(sess.title, 'server title')
    assert.equal(sess.pinned, true)
    assert.equal(sess.agentId, 'agent-b')
    assert.equal(sess.lastAt, 1100)
    // Retry bookkeeping
    assert.equal(sess._conflictRetryCount, 1)
    assert.equal(sess._dirty, true)
    assert.equal(sess._syncedAt, 2000)
    // Callbacks
    assert.equal(deps.conflictCb.length, 1)
    // local-dominates tag tells the UI to SKIP renderMessages() — local
    // messages are preserved in this branch (the whole point of the fix),
    // so only sidebar re-render is needed. Regressing this tag repaints
    // the whole messages pane on every 409 and flickers the UI during
    // long streaming turns that legitimately hit multiple 409s in a row.
    assert.equal(deps.conflictCb[0].mode, 'local-dominates')
    assert.equal(deps.retryCb.length, 1)
    assert.equal(deps.retryCb[0], sessId)
    // dbPut persisted
    assert.equal(deps.dbCalls.length, 1)
  })

  it('retry cap: after 3 retries, 4th 409 does NOT trigger another retry', async () => {
    const sessId = 'sess-r'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial extension' }

    const sess: any = {
      id: sessId,
      title: 't',
      messages: [userMsg, localAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _conflictRetryCount: 3,  // already at the cap
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't', messages: [userMsg, serverAsst],
        lastAt: 1000, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    // Silence the cap-reached warning in test output
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      await makePush(deps)(sess)
    } finally {
      console.warn = originalWarn
    }

    assert.equal(sess._conflictRetryCount, 4)
    assert.equal(deps.retryCb.length, 0, 'retry callback must NOT fire once cap reached')
    assert.equal(sess._dirty, true, 'left dirty so next user action re-pushes')
  })

  it('scheduleSaveFromUserEdit-equivalent reset: if caller resets _conflictRetryCount to 0, cap counter restarts', async () => {
    // Proves the counter is a plain field consumers can reset; this is
    // what sessions.js does on every user edit.
    const sessId = 'sess-x'
    const sess: any = {
      id: sessId, title: 't', messages: [{ id: 'u1', role: 'user', text: 'hi' }],
      lastAt: 1000, pinned: false, agentId: 'a',
      _dirty: true, _syncedAt: 500, _conflictRetryCount: 3,
    }
    sess._conflictRetryCount = 0  // simulate reset from user edit

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't', messages: [{ id: 'u1', role: 'user', text: 'hi' }],
        lastAt: 1000, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)
    assert.equal(sess._conflictRetryCount, 1, 'counter restarts after reset')
    assert.equal(deps.retryCb.length, 1)
  })

  it('keeps LOCAL metadata when user edited during PUT (localMetaIsNewer path)', async () => {
    const sessId = 'sess-m'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial extension' }

    const sess: any = {
      id: sessId,
      title: 'local-edited-title',
      messages: [userMsg, localAsst],
      lastAt: 2000,  // > preFlightLastAt (will snapshot 2000 at call time; then bumped below)
      pinned: true,
      agentId: 'local-agent',
      _dirty: true,
      _syncedAt: 500,
    }

    // Intercept: before the 409 path runs, simulate a concurrent user edit
    // by bumping live.lastAt after the preFlightLastAt snapshot was taken.
    // We achieve this by intercepting apiFetch: when called, we bump live.lastAt
    // in state.sessions so the 409 handler sees live.lastAt > preFlightLastAt.
    const deps = baseDeps({
      _apiFetchImpl: () => {
        // User edits while PUT is in flight — bump live.lastAt
        const live = deps.state.sessions.get(sessId)
        live.lastAt = 2500
        return conflict()
      },
      _apiGetImpl: () => ({
        id: sessId, title: 'server-title',
        messages: [userMsg, serverAsst],
        lastAt: 1800, pinned: false, agentId: 'server-agent',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Local messages preserved
    assert.equal(sess.messages[1].text, 'partial extension')
    // Local metadata preserved — user edit beat preflight
    assert.equal(sess.title, 'local-edited-title')
    assert.equal(sess.pinned, true)
    assert.equal(sess.agentId, 'local-agent')
    assert.equal(sess.lastAt, 2500)
  })

  // 2026-05-06 §4.5 改动 13(Codex review fix)— server-authoritative overlay 防御。
  //
  // 历史:local-dominates 分支只 adopt server session metadata,不 overlay server
  // 同 id 消息上的权威字段 → live.messages 内存版本可能缺 usage / _seq 等字段,
  // dbPut 写出去的 IDB 也缺这些字段 → 强刷瞬间 token 行空白(直到下一次 GET 修复)。
  //
  // 本 PR 把 usage 权威化后,server 可能在 client text 没动的窗口里通过
  // pending_usage_patches 异步 patch 了 usage(commercial 改动 4-6 路径)→
  // 这正是该修复要 catch 的"client 没新 text 但 server 多了权威字段"场景。
  it('overlays server-authoritative fields (usage/_seq/_source/_truncated/_errorCode/_errorDetail) onto local same-id messages', async () => {
    const sessId = 'sess-overlay'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    // Server 端权威字段都齐(typical 异步 patch 后场景)
    const serverAsst = {
      id: 'a1',
      role: 'assistant',
      text: 'partial', // server text 仍是流式中段
      _source: 'server',
      _seq: 7,
      usage: { costCredits: '850', inputTokens: 13178, outputTokens: 142, turn: 1 },
      _truncated: false,
    }
    // Local 端 streaming 已经 extend 了文本,但 usage / _seq / _source 都没拿到
    const localAsst: any = {
      id: 'a1',
      role: 'assistant',
      text: 'partial extension complete',
    }

    const sess: any = {
      id: sessId,
      title: 't',
      messages: [userMsg, localAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't',
        messages: [userMsg, serverAsst],
        lastAt: 1100, pinned: false, agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // 文本 — local 胜出(streaming 扩展不丢)
    assert.equal(sess.messages[1].text, 'partial extension complete')
    // server-authoritative 字段 overlay 进来
    assert.deepEqual(sess.messages[1].usage, {
      costCredits: '850',
      inputTokens: 13178,
      outputTokens: 142,
      turn: 1,
    })
    assert.equal(sess.messages[1]._seq, 7)
    assert.equal(sess.messages[1]._source, 'server')
    assert.equal(sess.messages[1]._truncated, false)
    // dbPut 持久化的 row 也含 usage(防强刷闪烁)
    assert.equal(deps.dbCalls.length, 1)
    const persistedRow = deps.dbCalls[0]
    assert.deepEqual(persistedRow.messages[1].usage, serverAsst.usage)
    assert.equal(persistedRow.messages[1]._seq, 7)
  })

  // 2026-05-06 §4.5 改动 13(Codex round-2 feedback)— status overlay 必须发生。
  //
  // 历史(round-1):担心 overlay status 会让 client 误以为流结束,所以排除 status。
  // Codex round-2 反驳:
  //   - 流式结束**不由** assistant.status 决定,而由 _streamingAssistant /
  //     _sendingInFlight / isFinal 帧控制。
  //   - status 字段唯一消费者是 _deriveUserMsgStatus(扫描 completed assistant tail
  //     派生 user message 的 'replied' 角标)。
  //   - 不 overlay status 会让 token 行恢复但"已回复"角标永远空白 — 制造一个新
  //     的 server↔client drift,正是本 PR 要消除的那一类。
  // 解决:对 _source === 'server' 的同 id 消息 overlay status。
  // user 消息没 _source='server',其 client-maintained sending/sent/read 不被覆盖。
  it('overlay 把 server-authored assistant 终态 status 写进 local (覆盖 _deriveUserMsgStatus 派生)', async () => {
    const sessId = 'sess-status-overlay'
    const serverAsst = {
      id: 'a1',
      role: 'assistant',
      text: 'partial',
      _source: 'server',
      status: 'completed', // server 已标完成
      usage: { costCredits: '100' },
    }
    const localAsst: any = {
      id: 'a1',
      role: 'assistant',
      text: 'partial extending',
      // local 没 status,流式中本地状态由 _streamingAssistant 决定,不是 status 字段
    }
    const sess: any = {
      id: sessId, title: 't', lastAt: 1000, pinned: false, agentId: 'a',
      messages: [{ id: 'u1', role: 'user', text: 'hi' }, localAsst],
      _dirty: true, _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't',
        messages: [{ id: 'u1', role: 'user', text: 'hi' }, serverAsst],
        lastAt: 1100, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)
    await makePush(deps)(sess)

    // usage overlay 进来(round-1 已覆盖)
    assert.deepEqual(sess.messages[1].usage, { costCredits: '100' })
    assert.equal(sess.messages[1]._source, 'server')
    // status 也 overlay — 这是 round-2 修复的核心:_deriveUserMsgStatus 才能扫到
    // completed assistant tail,user 消息上的"已回复"角标才能在强刷后回来。
    assert.equal(
      sess.messages[1].status,
      'completed',
      'server-authored assistant 终态 status 必须 overlay,_deriveUserMsgStatus 依赖它',
    )
    // 文本仍然是 local 胜出(local-dominates 分支保留 streaming 扩展)
    assert.equal(sess.messages[1].text, 'partial extending')
    // dbPut 写出去的也带 status
    assert.equal(deps.dbCalls.length, 1)
    assert.equal(deps.dbCalls[0].messages[1].status, 'completed')
  })

  it('overlay 不覆盖非 _source="server" 消息的 status (保护 client user.status)', async () => {
    // 反向场景:server 端的 user message 没 _source='server'(因为 user
    // message 在新方案里不是 server-authored — server 只 stamp 自己写的 row),
    // 即使它带 status 字段(理论上不应该,但作为防御性测试),也不应 overlay 到
    // client 的 user message 上,因为 client 维护的 sending/sent/read 是权威的。
    const sessId = 'sess-user-status-protect'
    const serverUserMsg = {
      id: 'u1',
      role: 'user',
      text: 'hi',
      // 没 _source: 'server'(user message 不是 server-authored)
      status: 'replied' as any, // 理论上 server 不会发,但即便发了也不该被 overlay
    }
    const localUserMsg: any = {
      id: 'u1',
      role: 'user',
      text: 'hi',
      status: 'sending', // client 流式中维护的状态
    }
    const localAsst: any = {
      id: 'a1', role: 'assistant', text: 'partial extending',
    }
    const serverAsst = {
      id: 'a1', role: 'assistant', text: 'partial',
      _source: 'server', usage: { costCredits: '50' },
    }
    const sess: any = {
      id: sessId, title: 't', lastAt: 1000, pinned: false, agentId: 'a',
      messages: [localUserMsg, localAsst],
      _dirty: true, _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't',
        messages: [serverUserMsg, serverAsst],
        lastAt: 1100, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)
    await makePush(deps)(sess)

    // user.status 保留 client 的 'sending'(server 没标 _source='server',不进 overlay)
    assert.equal(
      sess.messages[0].status,
      'sending',
      'user 消息没 _source="server",client status 必须保留',
    )
    // assistant 的 usage 还是正常 overlay
    assert.deepEqual(sess.messages[1].usage, { costCredits: '50' })
  })

  it('overlay 跳过 server 端独有 id 消息(只处理同 id)', async () => {
    // local 不持有 id='a-server-only',overlay 时不应误植入。
    const sessId = 'sess-disjoint'
    const serverOnlyAsst = {
      id: 'a-server-only',
      role: 'assistant',
      text: '',
      _source: 'server',
      _seq: 9,
      usage: { costCredits: '5' },
    }
    const localAsst = {
      id: 'a1', role: 'assistant', text: 'something',
    }
    const sess: any = {
      id: sessId, title: 't', lastAt: 1000, pinned: false, agentId: 'a',
      messages: [{ id: 'u1', role: 'user', text: 'hi' }, localAsst],
      _dirty: true, _syncedAt: 500,
    }
    // server.messages.length > local.messages.length → _localDominates 返回 false → 走 server-wins,
    // 不再走 local-dominates overlay 路径。这个 case 仅断言 overlay 不会误把 server-only 的字段
    // 塞进 local id 不同的项。
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't',
        messages: [{ id: 'u1', role: 'user', text: 'hi' }, localAsst, serverOnlyAsst],
        lastAt: 1100, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)
    await makePush(deps)(sess)

    // 走 server-wins 分支:整体替换 messages
    assert.equal(sess.messages.length, 3)
    assert.equal(sess.messages[2].id, 'a-server-only')
    // 这里 sess.messages[1] 现在是 server.messages[1] 的引用 — 验证 server-wins 路径(非 overlay)
    assert.equal(deps.conflictCb[0].mode, 'server-wins')
  })
})

describe('pushSessionToServer — 409 server-wins fallback', () => {
  it('adopts server state when local does NOT dominate, rebinds _streamingAssistant', async () => {
    const sessId = 'sess-sw'
    const oldLocalAsst = { id: 'a-old', role: 'assistant', text: 'local regen' }
    const sess: any = {
      id: sessId,
      title: 'local title',
      messages: [oldLocalAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _streamingAssistant: oldLocalAsst,  // points at the soon-to-be-replaced obj
      _blockIdToMsgId: new Map([['b', 'a-old']]),
      _agentGroups: new Map(),
    }

    const serverAsst = { id: 'a-new', role: 'assistant', text: 'server side answer' }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server title',
        messages: [serverAsst],
        lastAt: 1100,
        pinned: true,
        agentId: 'a2',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Adopted server state
    assert.equal(sess.title, 'server title')
    assert.equal(sess.messages[0].id, 'a-new')
    assert.equal(sess.agentId, 'a2')
    assert.equal(sess._dirty, false)
    assert.equal(sess._syncedAt, 2000)
    // Streaming pointer: old ref was a-old which is NOT in new messages → cleared
    assert.equal(sess._streamingAssistant, null, 'orphan streaming pointer must be cleared')
    // Runtime maps invalidated
    assert.equal(sess._blockIdToMsgId, null)
    assert.equal(sess._agentGroups, null)
    // Retry cap reset on server-wins
    assert.equal(sess._conflictRetryCount, 0)
    // Search index rebuilt & conflict callback fired
    assert.equal(deps.rebuildCalls.length, 1)
    assert.equal(deps.conflictCb.length, 1)
    // server-wins tag tells the UI to renderMessages() — messages were just
    // overwritten by Object.assign and the DOM must catch up.
    assert.equal(deps.conflictCb[0].mode, 'server-wins')
  })

  it('rebinds _streamingAssistant to the fresh object when same id still present', async () => {
    const sessId = 'sess-reb'
    const oldRef = { id: 'a1', role: 'assistant', text: 'old-local' }
    const sess: any = {
      id: sessId, title: 't', messages: [oldRef], lastAt: 1000,
      pinned: false, agentId: 'a', _dirty: true, _syncedAt: 500,
      _streamingAssistant: oldRef,
    }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'brand new answer' }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't',
        // New server snapshot has EXTRA message + same id a1 → doesn't dominate
        messages: [{ id: 'u-extra', role: 'user', text: 'someone else asked' }, serverAsst],
        lastAt: 1100, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.messages.length, 2)
    // _streamingAssistant must now point at the NEW a1 object in messages
    assert.equal(sess._streamingAssistant?.text, 'brand new answer')
    assert.equal(sess._streamingAssistant, sess.messages[1])
  })

  it('clears _replyingToMsgId and _currentTurnBlockCount when that msg vanishes from server', async () => {
    const sessId = 'sess-rpl'
    const sess: any = {
      id: sessId, title: 't',
      messages: [{ id: 'u1', role: 'user', text: 'hi' }, { id: 'orphan', role: 'assistant', text: 'gone' }],
      lastAt: 1000, pinned: false, agentId: 'a', _dirty: true, _syncedAt: 500,
      _replyingToMsgId: 'orphan',
      _currentTurnBlockCount: 7,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't',
        // Server snapshot has a user msg local doesn't (cross-device add) —
        // forces server-wins fallback. And no 'orphan' → pointer clears.
        messages: [
          { id: 'u1', role: 'user', text: 'hi' },
          { id: 'u2-other-device', role: 'user', text: 'from phone' },
        ],
        lastAt: 1100, pinned: false, agentId: 'a', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess._replyingToMsgId, null)
    assert.equal(sess._currentTurnBlockCount, 0)
  })

  it('preserves local if user typed during PUT (live.lastAt > preFlightLastAt)', async () => {
    const sessId = 'sess-g'
    const sess: any = {
      id: sessId, title: 'local', messages: [{ id: 'u1', role: 'user', text: 'mine' }],
      lastAt: 1000, pinned: false, agentId: 'a',
      _dirty: true, _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => {
        // simulate concurrent edit: bump lastAt AFTER preFlight snapshot taken
        deps.state.sessions.get(sessId).lastAt = 1500
        return conflict()
      },
      _apiGetImpl: () => ({
        // Server has DIFFERENT user msg (not dominated) → fallback path
        id: sessId, title: 'server',
        messages: [{ id: 'u-other', role: 'user', text: 'someone else' }],
        lastAt: 1200, pinned: true, agentId: 'b', updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Guard triggered — local kept, server NOT adopted
    assert.equal(sess.title, 'local')
    assert.equal(sess.messages[0].id, 'u1')
  })
})

describe('pushSessionToServer — sess !== live divergence (caller passes stale snapshot)', () => {
  it('409 local-dominates must mutate state.sessions entry, not the caller snapshot', async () => {
    // Scenario: syncSessionsFromServer iterates over dbGetAll() results and
    // calls pushSessionToServer(local) — that `local` is a distinct object
    // from state.sessions.get(id). If we mutated only `sess`, the live
    // session keeps its old _syncedAt and the enqueued retry PUT fires
    // again with the stale _baseSyncedAt → 409 loop until cap.
    const sessId = 'sess-div'
    const liveMsg = { id: 'a1', role: 'assistant', text: 'partial ext' }
    const live: any = {
      id: sessId, title: 't-old', messages: [liveMsg], lastAt: 1000,
      pinned: false, agentId: 'agent-old',
      _dirty: true, _syncedAt: 500,
    }
    // Caller-snapshot (sess) is a different object, deliberately missing
    // the extra fields. The handler should NOT write _syncedAt onto this.
    const staleSnap: any = {
      id: sessId, title: 't-old', messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 1000, pinned: false, agentId: 'agent-old',
      _dirty: true, _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't-server',
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1100, pinned: true, agentId: 'agent-server',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, live)

    await makePush(deps)(staleSnap)

    // The LIVE session must have picked up the server metadata + refreshed sync stamp
    assert.equal(live._syncedAt, 2000, 'live._syncedAt must be refreshed')
    assert.equal(live.title, 't-server', 'live.title must be adopted from server')
    assert.equal(live.pinned, true)
    assert.equal(live.agentId, 'agent-server')
    assert.equal(live._conflictRetryCount, 1)
    // The caller snapshot must be untouched (still stale)
    assert.equal(staleSnap._syncedAt, 500, 'caller snapshot must NOT be mutated')
    assert.equal(staleSnap.title, 't-old')
    // dbPut must receive live data (so IDB has fresh _syncedAt)
    assert.equal(deps.dbCalls[0]._syncedAt, 2000)
    assert.equal(deps.dbCalls[0].title, 't-server')
  })

  it('409 server-wins must mutate state.sessions entry, not the caller snapshot', async () => {
    const sessId = 'sess-div2'
    const live: any = {
      id: sessId, title: 't-old', messages: [{ id: 'a1', role: 'assistant', text: 'local' }],
      lastAt: 1000, pinned: false, agentId: 'agent-old',
      _dirty: true, _syncedAt: 500,
    }
    const staleSnap: any = {
      id: sessId, title: 't-old', messages: [{ id: 'a1', role: 'assistant', text: 'local' }],
      lastAt: 1000, pinned: false, agentId: 'agent-old',
      _dirty: true, _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 't-server',
        // Server has data local doesn't → forces server-wins
        messages: [
          { id: 'other', role: 'user', text: 'from phone' },
          { id: 'a1', role: 'assistant', text: 'server' },
        ],
        lastAt: 1100, pinned: true, agentId: 'agent-server',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, live)

    await makePush(deps)(staleSnap)

    assert.equal(live.title, 't-server')
    assert.equal(live.messages.length, 2)
    assert.equal(live._syncedAt, 2000)
    assert.equal(live._dirty, false)
    // Caller snapshot untouched
    assert.equal(staleSnap.title, 't-old')
    assert.equal(staleSnap.messages.length, 1)
  })
})

describe('pushSessionToServer — search index hygiene', () => {
  it('local-dominates with title change triggers _rebuildSearchIndex so sidebar filter stays correct', async () => {
    const sessId = 'sess-sr'
    const sess: any = {
      id: sessId, title: 'old title',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 1000, pinned: false, agentId: 'a',
      _dirty: true, _syncedAt: 500,
      _searchText: 'old title cached — will go stale if not rebuilt',
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 'NEW title from other tab',
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1100, pinned: false, agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.title, 'NEW title from other tab')
    assert.equal(deps.rebuildCalls.length, 1, 'rebuildSearchIndex must fire when title adopted from server')
    assert.equal(deps.rebuildCalls[0], sessId)
  })

  it('local-dominates without title change does NOT waste a rebuild', async () => {
    const sessId = 'sess-sr2'
    const sess: any = {
      id: sessId, title: 'same',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 1000, pinned: false, agentId: 'a',
      _dirty: true, _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId, title: 'same',  // unchanged
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1100, pinned: false, agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)
    assert.equal(deps.rebuildCalls.length, 0, 'no rebuild when title unchanged')
  })

  it('local-dominates with localMetaIsNewer: keeps local title, no rebuild needed', async () => {
    const sessId = 'sess-sr3'
    const sess: any = {
      id: sessId, title: 'local edited',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 2000, pinned: false, agentId: 'a',
      _dirty: true, _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => {
        // simulate concurrent user edit bumping lastAt past preFlight
        deps.state.sessions.get(sessId).lastAt = 2500
        return conflict()
      },
      _apiGetImpl: () => ({
        id: sessId, title: 'server title (should be ignored)',
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1800, pinned: false, agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)
    assert.equal(sess.title, 'local edited', 'local meta preserved')
    assert.equal(deps.rebuildCalls.length, 0, 'no rebuild when local meta kept (title unchanged)')
  })
})

describe('pushSessionToServer — successful PUT', () => {
  it('200 response clears _conflictRetryCount', async () => {
    const sessId = 'sess-ok'
    const sess: any = {
      id: sessId, title: 't', messages: [], lastAt: 1000, pinned: false, agentId: 'a',
      _dirty: true, _syncedAt: 500, _conflictRetryCount: 2,
    }
    const deps = baseDeps()
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess._conflictRetryCount, 0)
    assert.equal(sess._dirty, false)
  })
})

describe('pushSessionToServer — CONFLICT_RETRY_MAX', () => {
  // The production cap was raised 3→10 in fix/sync-409-flicker to absorb
  // legitimate 409 bursts on long streaming sessions (>500KB). Guard the
  // current production value so a stealth revert breaks tests rather than
  // spamming "409 auto-retry cap reached" in console at runtime.
  it('production value matches expected', () => {
    assert.equal(PROD_CONFLICT_RETRY_MAX, 10)
  })

  it('cap gates retry callback: below cap fires retry, at/above cap stops', async () => {
    // Minimal local-dominates setup: local is superset of server (empty).
    const build = (count: number) => {
      const sessId = 'sess-cap'
      const localMsg = { id: 'u1', role: 'user', text: 'hi' }
      const sess: any = {
        id: sessId,
        title: 'local', messages: [localMsg], lastAt: 1000,
        pinned: false, agentId: 'a',
        _dirty: true, _syncedAt: 500,
        _conflictRetryCount: count,
      }
      const deps = baseDeps({
        apiFetch: async () => conflict(),
        apiGet: async () => ({
          id: sessId, title: 'remote', messages: [], lastAt: 900,
          pinned: false, agentId: 'a', updatedAt: 2000,
        }),
      })
      deps.state.sessions.set(sessId, sess)
      return { sess, deps }
    }

    // Use a small cap so the test completes in bounded time. The point is the
    // cap SEMANTICS — that `<=` lets the Nth retry still fire and `> cap`
    // stops — not the specific 10.
    const CAP = 2

    // Pre-count 0, 1: retry fires (count becomes 1, 2 respectively)
    for (const preCount of [0, 1]) {
      const { sess, deps } = build(preCount)
      await makePush(deps, CAP)(sess)
      assert.equal(sess._conflictRetryCount, preCount + 1, `preCount ${preCount}: count should bump`)
      assert.equal(deps.retryCb.length, 1, `preCount ${preCount}: retry should fire while count <= cap`)
    }

    // Pre-count 2 (== cap): after +1 = 3 (> cap), retry MUST NOT fire
    const { sess: sessCap, deps: depsCap } = build(CAP)
    await makePush(depsCap, CAP)(sessCap)
    assert.equal(sessCap._conflictRetryCount, CAP + 1)
    assert.equal(depsCap.retryCb.length, 0, 'retry must not fire when count exceeds cap')
    // Dirty flag must still be set so the next user action can retry manually.
    assert.equal(sessCap._dirty, true)
  })
})
