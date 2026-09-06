/**
 * Durable-artifact resume ladder (all engines).
 *
 * Regression for the 2026-09-06 incident: container rebuild → resume-map head
 * `sand-ccb:ca2ec90a…` had never produced a JSONL (CLI emitted session_id and
 * died) → gateway dropped the entry and replayed 339 messages of history even
 * though the previous id `2c3f23a7…` (10 MB JSONL) was fully resumable.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { OpenClaudeConfig } from '@openclaude/storage'
import { paths } from '@openclaude/storage'
import { SessionManager } from '../sessionManager.js'

function makeConfigStub(): OpenClaudeConfig {
  return {
    version: 1,
    gateway: { bind: '127.0.0.1', port: 0, accessToken: '' },
    auth: { mode: 'subscription', claudeCodePath: '' },
    sessions: { dbPath: '' },
    defaults: { model: 'glm-5.3-zai' },
  } as unknown as OpenClaudeConfig
}

type Internals = {
  resumeMapPath: string
  _resumeMap: Map<string, string>
  _resumeMapTimestamps: Map<string, number>
  _resumeMapProvider: Map<string, string>
  _resumeMapHistory: Map<string, string[]>
  _loadResumeMap: () => void
  _saveResumeMap: () => void
  awaitResumeMapFlush: () => Promise<void>
  _resumeIdFor: (
    sessionKey: string,
    wantProvider: string,
    workspacePath?: string,
  ) => string | undefined
  _pushResumeHistory: (key: string, prev: string | undefined | null) => void
}

const OLD = '2c3f23a7-8556-4036-9a73-8995b0a3b38f'
const DEAD = 'ca2ec90a-a7c8-4717-8634-ad65b300848f'
const OLDER = '0da6f62a-f959-4c0e-bf94-e2450fbf8a5f'

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {}
  for (const k of Object.keys(patch)) {
    prev[k] = process.env[k]
    if (patch[k] === undefined) delete process.env[k]
    else process.env[k] = patch[k]
  }
  const restore = () => {
    for (const k of Object.keys(patch)) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
  try {
    const out = fn()
    if (out instanceof Promise) return out.finally(restore) as unknown as T
    restore()
    return out
  } catch (e) {
    restore()
    throw e
  }
}

function newManager(dir: string): Internals {
  const m = new SessionManager(makeConfigStub()) as unknown as Internals
  m.resumeMapPath = join(dir, 'resume-map.json')
  m._resumeMap.clear()
  m._resumeMapProvider.clear()
  m._resumeMapTimestamps.clear()
  m._resumeMapHistory.clear()
  return m
}

test('Cursor Sand: dead head + durable prior id → promotes prior id instead of dropping to replay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-sand-'))
  const configDir = join(dir, 'claude-config')
  const proj = join(configDir, 'projects', 'p')
  mkdirSync(proj, { recursive: true })
  writeFileSync(join(proj, `${OLD}.jsonl`), '{"type":"user"}\n')
  try {
    await withEnv({ CLAUDE_CONFIG_DIR: configDir }, async () => {
      const m = newManager(dir)
      const key = 'agent:main:webchat:dm:webmtokw68s7yinxj'
      m._resumeMap.set(key, `sand-ccb:${DEAD}`)
      m._resumeMapProvider.set(key, 'cursor')
      m._resumeMapHistory.set(key, [`sand-ccb:${OLD}`, `sand-ccb:${OLDER}`])

      assert.equal(m._resumeIdFor(key, 'cursor', join(dir, 'ws')), `sand-ccb:${OLD}`)
      // promoted in place; dead head gone; only ids older than promoted remain
      assert.equal(m._resumeMap.get(key), `sand-ccb:${OLD}`)
      assert.deepEqual(m._resumeMapHistory.get(key), [`sand-ccb:${OLDER}`])
      await m.awaitResumeMapFlush()
      const saved = JSON.parse(readFileSync(m.resumeMapPath, 'utf8'))
      assert.equal(saved[key].id, `sand-ccb:${OLD}`)
      assert.deepEqual(saved[key].history, [`sand-ccb:${OLDER}`])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CCB: dead head with empty ladder still drops (previous behaviour preserved)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-ccb-drop-'))
  const configDir = join(dir, 'claude-config')
  mkdirSync(join(configDir, 'projects', 'p'), { recursive: true })
  try {
    await withEnv({ CLAUDE_CONFIG_DIR: configDir }, async () => {
      const m = newManager(dir)
      m._resumeMap.set('k', DEAD)
      m._resumeMapProvider.set('k', 'ccb')
      assert.equal(m._resumeIdFor('k', 'ccb'), undefined)
      assert.equal(m._resumeMap.has('k'), false)
      assert.equal(m._resumeMapHistory.has('k'), false)
      await m.awaitResumeMapFlush()
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Codex: head rollout missing → ladder promotes thread whose rollout exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-codex-'))
  const codexHome = join(dir, 'codex')
  const day = join(codexHome, 'sessions', '2026', '09', '06')
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, `rollout-2026-09-06T00-00-00-${OLD}.jsonl`), '{}\n')
  try {
    await withEnv({ CODEX_HOME: codexHome }, async () => {
      const m = newManager(dir)
      m._resumeMap.set('k', DEAD)
      m._resumeMapProvider.set('k', 'codex')
      m._resumeMapHistory.set('k', [OLD])
      assert.equal(m._resumeIdFor('k', 'codex'), OLD)
      assert.equal(m._resumeMap.get('k'), OLD)
      await m.awaitResumeMapFlush()
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok: head session dir missing → ladder promotes prior session with content', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-grok-'))
  const home = join(dir, 'oc-home')
  const grp = join(home, 'grok-build', 'sessions', '%2Fws')
  mkdirSync(join(grp, OLD), { recursive: true })
  writeFileSync(join(grp, OLD, 'chat_history.jsonl'), '{}\n')
  try {
    await withEnv({ OPENCLAUDE_HOME: home }, async () => {
      const m = newManager(dir)
      m._resumeMap.set('k', DEAD)
      m._resumeMapProvider.set('k', 'grok')
      m._resumeMapHistory.set('k', [OLD])
      assert.equal(m._resumeIdFor('k', 'grok'), OLD)
      await m.awaitResumeMapFlush()
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Grok: head still durable → head returned untouched, ladder not consulted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-grok-ok-'))
  const home = join(dir, 'oc-home')
  const grp = join(home, 'grok-build', 'sessions', '%2Fws')
  mkdirSync(join(grp, DEAD), { recursive: true })
  writeFileSync(join(grp, DEAD, 'events.jsonl'), '{}\n')
  try {
    await withEnv({ OPENCLAUDE_HOME: home }, async () => {
      const m = newManager(dir)
      m._resumeMap.set('k', DEAD)
      m._resumeMapProvider.set('k', 'grok')
      m._resumeMapHistory.set('k', [OLD])
      assert.equal(m._resumeIdFor('k', 'grok'), DEAD)
      assert.deepEqual(m._resumeMapHistory.get('k'), [OLD])
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('history round-trips through resume-map.json and is bounded / deduped / head-excluded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-persist-'))
  try {
    const m = newManager(dir)
    m._resumeMap.set('k', 'head')
    m._resumeMapProvider.set('k', 'grok')
    for (const id of ['h1', 'h2', 'h1', 'h3', 'h4', 'h5']) m._pushResumeHistory('k', id)
    // newest first, dedup, bounded to 4
    assert.deepEqual(m._resumeMapHistory.get('k'), ['h5', 'h4', 'h3', 'h1'])
    m._saveResumeMap()
    await m.awaitResumeMapFlush()

    const saved = JSON.parse(readFileSync(m.resumeMapPath, 'utf8'))
    assert.deepEqual(saved.k.history, ['h5', 'h4', 'h3', 'h1'])

    // Manually poison the file with head duplicated in history + garbage entries
    saved.k.history = ['head', 'h5', 7, '', 'h4', 'h3', 'h1', 'h0']
    writeFileSync(m.resumeMapPath, JSON.stringify(saved))
    const m2 = newManager(dir)
    m2._loadResumeMap()
    assert.deepEqual(m2._resumeMapHistory.get('k'), ['h5', 'h4', 'h3', 'h1'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── Live-session promotion (GPT-6 review B2) ─────────────────────────────────
// A promotion that only rewrites the map is undone by _saveResumeMap's live
// overlay (session.ccbSessionId still = dead head) and never reaches the
// adapter, so the next spawn --resumes the dead id anyway. These tests drive a
// real getOrCreate() session (grok/ccb adapters construct without spawning).

const LIVE_A = '11111111-1111-4111-8111-111111111111'
const LIVE_B = '22222222-2222-4222-8222-222222222222'
const LIVE_C = '33333333-3333-4333-8333-333333333333'

type LiveSession = {
  sessionKey: string
  ccbSessionId: string | null
  workspaceCwd?: string
  runner: {
    nativeSessionId: string | null
    setResumeSessionId?: (id: string) => void
    emit: (ev: string, ...args: unknown[]) => boolean
  }
  _pendingStaleResumeClear?: boolean
}

type LiveInternals = Internals & {
  sessions: Map<string, LiveSession>
  getOrCreate: (opts: Record<string, unknown>) => Promise<LiveSession>
  submit: (...args: unknown[]) => Promise<void>
  runOneTurnWithRetry: (...args: unknown[]) => Promise<unknown>
}

async function liveSetup(engine: 'grok' | 'ccb') {
  const dir = mkdtempSync(join(tmpdir(), 'oc-ladder-live-'))
  const artifacts =
    engine === 'grok'
      ? join(dir, 'grok-build', 'sessions', '%2Fws')
      : join(dir, 'claude', 'projects', 'p')
  mkdirSync(artifacts, { recursive: true })
  for (const id of [LIVE_B, LIVE_C]) {
    if (engine === 'grok') {
      mkdirSync(join(artifacts, id))
      writeFileSync(join(artifacts, id, 'messages.jsonl'), '{}\n')
    } else {
      writeFileSync(join(artifacts, `${id}.jsonl`), '{"type":"user"}\n')
    }
  }
  const env = {
    OPENCLAUDE_HOME: dir,
    CLAUDE_CONFIG_DIR: join(dir, 'claude'),
    // Commercial runtime rejects submit() without a master sink; this test
    // is about resume steering, not persistence.
    OC_RUNTIME_CHANNEL: undefined,
    OPENCLAUDE_V3_MASTER_BASE_URL: undefined,
    OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
  }
  const model = engine === 'grok' ? 'grok-build' : 'glm-5.3-zai'
  const run = async <T>(fn: (m: LiveInternals, s: LiveSession) => Promise<T>): Promise<T> =>
    withEnv(env, async () => {
      const m = newManager(dir) as LiveInternals
      const s = await m.getOrCreate({
        sessionKey: 'ladder-live',
        agent: { id: 'ladder', model, cwd: dir },
        model,
        executionAuthority: { engine, canonicalModel: model, source: 'local_catalog' },
        workspaceCwd: dir,
      })
      s.runner.setResumeSessionId?.(LIVE_A)
      s.runner.emit('session_id', LIVE_A)
      m._resumeMapHistory.set(s.sessionKey, [LIVE_B, LIVE_C])
      try {
        return await fn(m, s)
      } finally {
        await m.awaitResumeMapFlush()
      }
    })
  return { dir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('live promotion steers session + adapter and survives _saveResumeMap overlay', async () => {
  const { run, cleanup } = await liveSetup('grok')
  try {
    await run(async (m, s) => {
      assert.equal(s.runner.nativeSessionId, LIVE_A)
      assert.equal(m._resumeIdFor(s.sessionKey, 'grok', s.workspaceCwd), LIVE_B)
      assert.equal(s.ccbSessionId, LIVE_B, 'live session must follow promotion')
      assert.equal(s.runner.nativeSessionId, LIVE_B, 'adapter must --resume promoted id')
      assert.equal(m._resumeMap.get(s.sessionKey), LIVE_B)
      await m.awaitResumeMapFlush()
      const saved = JSON.parse(readFileSync(m.resumeMapPath, 'utf8'))[s.sessionKey]
      assert.equal(saved.id, LIVE_B, 'serializer must not write the dead head back')
      assert.deepEqual(saved.history, [LIVE_C])
    })
  } finally {
    cleanup()
  }
})

test('consecutive runtime stale exits walk the ladder monotonically (rejected id never re-picked)', async () => {
  const { run, cleanup } = await liveSetup('ccb')
  try {
    await run(async (m, s) => {
      s._pendingStaleResumeClear = true
      s.runner.emit('exit', { code: 1, signal: null, crashed: true })
      assert.equal(s.runner.nativeSessionId, LIVE_B)
      assert.equal(m._resumeMap.get(s.sessionKey), LIVE_B)
      assert.deepEqual(m._resumeMapHistory.get(s.sessionKey), [LIVE_C])

      // Engine rejects B too (non-empty file ≠ resumable conversation).
      s._pendingStaleResumeClear = true
      s.runner.emit('exit', { code: 1, signal: null, crashed: true })
      assert.equal(s.runner.nativeSessionId, LIVE_C, 'must move on to C, not re-pick B')
      assert.equal(m._resumeMap.get(s.sessionKey), LIVE_C)
      assert.deepEqual(m._resumeMapHistory.get(s.sessionKey), [])

      // Ladder exhausted → forget (previous drop behaviour).
      s._pendingStaleResumeClear = true
      s.runner.emit('exit', { code: 1, signal: null, crashed: true })
      assert.equal(s.runner.nativeSessionId, null)
      assert.equal(m._resumeMap.has(s.sessionKey), false)
    })
  } finally {
    cleanup()
  }
})

test('submit() preflight promotion reaches the execution seam with the promoted id', async () => {
  const { run, cleanup } = await liveSetup('grok')
  try {
    await run(async (m, s) => {
      const seams: Array<{ nativeId: string | null; mapped: string | undefined }> = []
      m.runOneTurnWithRetry = async (session: unknown) => {
        const sess = session as LiveSession
        seams.push({
          nativeId: sess.runner.nativeSessionId,
          mapped: m._resumeMap.get(sess.sessionKey),
        })
      }
      await m.submit(
        s,
        'continue',
        () => {},
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          historicalMessages: [
            { id: 'old-u', role: 'user', content: 'prior task' },
            { id: 'srv-unknown-ladder-t1', role: 'assistant', content: 'prior response' },
          ],
        },
      )
      assert.equal(seams.length, 1, 'submit must reach execution seam')
      assert.equal(seams[0].nativeId, LIVE_B)
      assert.equal(seams[0].mapped, LIVE_B)
    })
  } finally {
    cleanup()
  }
})

test('paths.home is the default OPENCLAUDE_HOME for grok/zcode probes', () => {
  // Sanity: the module must not throw when env is unset and paths.home exists.
  assert.equal(typeof paths.home, 'string')
})
