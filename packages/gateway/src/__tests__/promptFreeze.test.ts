/**
 * OCV5-755: a session's platform prompt stays byte-identical across CCB
 * respawns while its explicit inputs are unchanged and the provider cache
 * window is still open.
 *
 * Run:
 *   npx tsx --test packages/gateway/src/__tests__/promptFreeze.test.ts
 */
import './helpers/subprocessRunnerSpawnEnvIsolate.js'

import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const HOME = mkdtempSync(join(tmpdir(), 'ocv5-755-home-'))
process.env.OPENCLAUDE_HOME = HOME
delete process.env.OC_PROMPT_FREEZE

const freeze = await import('../promptFreeze.js')
const { SubprocessRunner } = await import('../subprocessRunner.js')

function build(content: string, slots: Record<string, string>) {
  const sha = (text: string) => createHash('sha256').update(text).digest('hex')
  return {
    content,
    contentSha256: sha(content),
    applied: Object.entries(slots).map(([name, text]) => ({ name, bytes: text.length, sha256: sha(text) })),
  }
}

let n = 0
function key(): string {
  n += 1
  return `agent:main:webchat:dm:ocv5-755-unit-${n}`
}

test('mode: env wins, then the flag file, default shadow', () => {
  const home = mkdtempSync(join(tmpdir(), 'ocv5-755-mode-'))
  assert.equal(freeze.resolvePromptFreezeMode(home, {}), 'shadow')
  mkdirSync(join(home, 'runtime-flags'))
  writeFileSync(join(home, 'runtime-flags', 'prompt-freeze'), 'enforce\n')
  assert.equal(freeze.resolvePromptFreezeMode(home, {}), 'enforce')
  assert.equal(freeze.resolvePromptFreezeMode(home, { OC_PROMPT_FREEZE: 'off' }), 'off')
  writeFileSync(join(home, 'runtime-flags', 'prompt-freeze'), 'bogus')
  assert.equal(freeze.resolvePromptFreezeMode(home, {}), 'shadow')
})

test('enforce: a respawn with drifted memory index reuses the first prompt', () => {
  const sessionKey = key()
  const first = build('static\nMEMORY v1', { SOUL: 's', MEMORY_INDEX: 'v1' })
  const a = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: first })
  assert.equal(a.decision, 'fresh_first')
  assert.equal(a.chosen.content, first.content)
  const drifted = build('static\nMEMORY v2', { SOUL: 's', MEMORY_INDEX: 'v2' })
  const b = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: drifted })
  assert.equal(b.decision, 'reuse')
  assert.equal(b.reused, true)
  assert.equal(b.chosen.content, first.content)
  assert.deepEqual(b.chosen.applied, first.applied)
  assert.deepEqual(b.changedSlots, ['MEMORY_INDEX'])
  assert.equal(b.sameContent, false)
  assert.equal(b.ccbContextFile, freeze.ccbContextFreezePath(HOME, sessionKey))
})

test('shadow: records like enforce but always runs the fresh prompt', () => {
  const sessionKey = key()
  const first = build('p1', { MEMORY_INDEX: 'v1' })
  freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'shadow', inputsKey: 'k', fresh: first })
  const drifted = build('p2', { MEMORY_INDEX: 'v2' })
  const b = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'shadow', inputsKey: 'k', fresh: drifted })
  assert.equal(b.decision, 'reuse')
  assert.equal(b.reused, false)
  assert.equal(b.chosen.content, 'p2')
  assert.equal(b.ccbContextFile, '')
  // The stored prompt is still the first one, exactly what enforce would keep.
  assert.equal(freeze.readFrozenPrompt(HOME, sessionKey)?.record.content, 'p1')
})

test('enforce: changed explicit inputs (e.g. privacy fingerprint) take the fresh prompt and reset the CCB snapshot', () => {
  const sessionKey = key()
  freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'privacy-a', fresh: build('old', { USER: 'a' }) })
  const ccb = freeze.ccbContextFreezePath(HOME, sessionKey)
  writeFileSync(ccb, '{"v":1}')
  const b = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'privacy-b', fresh: build('new', { USER: '' }) })
  assert.equal(b.decision, 'fresh_inputs')
  assert.equal(b.chosen.content, 'new')
  assert.equal(existsSync(ccb), false)
  assert.equal(freeze.readFrozenPrompt(HOME, sessionKey)?.record.content, 'new')
})

test('enforce: past the cache window the fresh prompt wins', () => {
  const sessionKey = key()
  freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: build('old', {}) })
  const old = (Date.now() - freeze.PROMPT_FREEZE_TTL_MS - 60_000) / 1000
  utimesSync(freeze.promptFreezePath(HOME, sessionKey), old, old)
  const b = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: build('new', {}) })
  assert.equal(b.decision, 'fresh_ttl')
  assert.equal(b.chosen.content, 'new')
})

test('activity touch keeps the window open', () => {
  const sessionKey = key()
  freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: build('old', {}) })
  const old = (Date.now() - freeze.PROMPT_FREEZE_TTL_MS - 60_000) / 1000
  utimesSync(freeze.promptFreezePath(HOME, sessionKey), old, old)
  freeze.touchFrozenPrompt(HOME, sessionKey)
  const b = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: build('new', {}) })
  assert.equal(b.decision, 'reuse')
  assert.equal(b.chosen.content, 'old')
})

test('a tampered record is ignored', () => {
  const sessionKey = key()
  freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: build('old', {}) })
  const path = freeze.promptFreezePath(HOME, sessionKey)
  const rec = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...rec, content: 'tampered' }))
  const b = freeze.applyPromptFreeze({ home: HOME, sessionKey, mode: 'enforce', inputsKey: 'k', fresh: build('new', {}) })
  assert.equal(b.decision, 'fresh_first')
  assert.equal(b.chosen.content, 'new')
})

test('inputs key: tool order is irrelevant, policy fingerprint is not', () => {
  const base = {
    agentId: 'main', provider: 'ccb', cacheLayout: 'static-first', availableMcpTools: ['a', 'b'],
    intelligentUi: false, promptPolicyFingerprint: 'p1',
  }
  assert.equal(
    freeze.promptFreezeInputsKey(base),
    freeze.promptFreezeInputsKey({ ...base, availableMcpTools: ['b', 'a'] }),
  )
  assert.notEqual(
    freeze.promptFreezeInputsKey(base),
    freeze.promptFreezeInputsKey({ ...base, promptPolicyFingerprint: 'p2' }),
  )
})

// ── Real entry: SubprocessRunner.buildLearningContext writes extra-prompt.md ──

// One agent dir per session, as in production: the cwd is an explicit input.
const agentDirs = new Map<string, string>()
function runner(sessionKey: string) {
  let base = agentDirs.get(sessionKey)
  if (!base) {
    base = mkdtempSync(join(tmpdir(), 'ocv5-755-agent-'))
    agentDirs.set(sessionKey, base)
  }
  return new SubprocessRunner({
    sessionKey,
    peerId: 'ocv5-755-peer',
    agentId: 'main',
    agentBaseDir: base,
    harness: 'ccb',
    config: {
      auth: { mode: 'subscription', claudeCodePath: base, claudeCodeRuntime: 'node' },
      defaults: { permissionMode: 'default' },
      terminal: { type: 'local' },
    },
  } as never)
}

function writeMemoryIndex(text: string): void {
  const dir = join(HOME, 'agents', 'main')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), text)
}

async function spawnPrompt(r: InstanceType<typeof SubprocessRunner>): Promise<string> {
  const out = (await (r as any).buildLearningContext(null)) as { extraPromptFile?: string }
  assert.ok(out.extraPromptFile, 'extra-prompt.md must be written')
  return readFileSync(out.extraPromptFile!, 'utf8')
}

async function respawnAcrossMemoryDrift(mode: 'shadow' | 'enforce'): Promise<[string, string]> {
  process.env.OC_PROMPT_FREEZE = mode
  try {
    const sessionKey = key()
    writeMemoryIndex(`- [first](memory/first.md) — ${mode} before`)
    const first = await spawnPrompt(runner(sessionKey))
    writeMemoryIndex(`- [second](memory/second.md) — ${mode} after`)
    // A fresh runner = a respawn after container rebuild / config restart.
    const second = await spawnPrompt(runner(sessionKey))
    return [first, second]
  } finally {
    delete process.env.OC_PROMPT_FREEZE
  }
}

test('real spawn, shadow (pre-OCV5-755 behavior): memory drift changes the prompt', async () => {
  const [first, second] = await respawnAcrossMemoryDrift('shadow')
  assert.match(first, /shadow before/)
  assert.match(second, /shadow after/)
  assert.notEqual(first, second)
})

test('real spawn, enforce: the respawned process gets the byte-identical prompt', async () => {
  const [first, second] = await respawnAcrossMemoryDrift('enforce')
  assert.match(first, /enforce before/)
  assert.equal(second, first)
})

test('real spawn, enforce: an effort change is explicit and rebuilds the prompt', async () => {
  process.env.OC_PROMPT_FREEZE = 'enforce'
  try {
    const sessionKey = key()
    writeMemoryIndex('- [x](memory/x.md) — effort before')
    const r = runner(sessionKey)
    const first = await spawnPrompt(r)
    writeMemoryIndex('- [y](memory/y.md) — effort after')
    r.setEffortLevel('max')
    const second = await spawnPrompt(r)
    assert.match(second, /effort after/)
    assert.notEqual(second, first)
  } finally {
    delete process.env.OC_PROMPT_FREEZE
  }
})

test('real spawn, enforce: CCB gets the session snapshot path; shadow gets none', async () => {
  process.env.OC_PROMPT_FREEZE = 'enforce'
  const sessionKey = key()
  const r = runner(sessionKey)
  await spawnPrompt(r)
  assert.equal((r as any)._ccbContextFreezeFile, freeze.ccbContextFreezePath(HOME, sessionKey))
  process.env.OC_PROMPT_FREEZE = 'shadow'
  await spawnPrompt(r)
  assert.equal((r as any)._ccbContextFreezeFile, '')
  delete process.env.OC_PROMPT_FREEZE
  const src = readFileSync(new URL('../subprocessRunner.ts', import.meta.url), 'utf8')
  assert.equal(src.split('OPENCLAUDE_CONTEXT_FREEZE_FILE: this._ccbContextFreezeFile,').length - 1, 1)
})
