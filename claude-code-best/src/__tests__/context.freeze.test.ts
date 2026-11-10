/**
 * OCV5-755: a respawned OpenClaude CCB process for the same session reuses the
 * conversation-start context snapshot, so the cached prompt prefix survives a
 * process restart; the date still advances through the tail date_change.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  getLastEmittedDate,
  resetStateForTests,
  setOriginalCwd,
  setProjectRoot,
} from '../bootstrap/state'
import { getLocalISODate } from '../constants/common'
import { getSystemContext, getUserContext, setSystemPromptInjection } from '../context'
import { getDateChangeAttachments } from '../utils/attachments'
import { clearMemoryFileCaches } from '../utils/claudemd'
import { __resetContextFreezeForTests } from '../utils/openclaudeContextFreeze'
import { cleanupTempDir, createTempDir, writeTempFile } from '../../tests/mocks/file-system'

let tempDir = ''
let snapshot = ''
let freezeOn = false

/** Gateway hands this session's snapshot to the next process. */
function useSnapshot(): void {
  freezeOn = true
  process.env.OPENCLAUDE_CONTEXT_FREEZE_FILE = snapshot
}

/** What a fresh process does: nothing memoized, nothing in bootstrap state. */
function respawn(): void {
  __resetContextFreezeForTests()
  if (freezeOn) process.env.OPENCLAUDE_CONTEXT_FREEZE_FILE = snapshot
  resetStateForTests()
  setOriginalCwd(tempDir)
  setProjectRoot(tempDir)
  clearMemoryFileCaches()
  getUserContext.cache.clear?.()
  getSystemContext.cache.clear?.()
}

beforeEach(async () => {
  freezeOn = false
  tempDir = await createTempDir('context-freeze-')
  snapshot = join(tempDir, 'session.ccb.json')
  setSystemPromptInjection(null)
  respawn()
})

afterEach(async () => {
  freezeOn = false
  delete process.env.OPENCLAUDE_CONTEXT_FREEZE_FILE
  respawn()
  if (tempDir) await cleanupTempDir(tempDir)
})

describe('OpenClaude context freeze', () => {
  test('without the env each process reads live CLAUDE.md (pre-OCV5-755 behavior)', async () => {
    await writeTempFile(tempDir, 'CLAUDE.md', 'rules v1')
    const first = await getUserContext()
    await writeTempFile(tempDir, 'CLAUDE.md', 'rules v2')
    respawn()
    const second = await getUserContext()
    expect(first.claudeMd).toContain('rules v1')
    expect(second.claudeMd).toContain('rules v2')
  })

  test('a respawned process reuses the snapshot even after CLAUDE.md changed', async () => {
    useSnapshot()
    await writeTempFile(tempDir, 'CLAUDE.md', 'rules v1')
    const first = await getUserContext()
    await writeTempFile(tempDir, 'CLAUDE.md', 'rules v2')
    respawn()
    const second = await getUserContext()
    expect(second).toEqual(first)
    expect(second.claudeMd).toContain('rules v1')
  })

  test('the frozen git status survives a respawn', async () => {
    useSnapshot()
    writeFileSync(snapshot, JSON.stringify({ v: 1, systemContext: { gitStatus: 'Recent commits:\nabc autosave 1' } }))
    respawn()
    expect(await getSystemContext()).toEqual({ gitStatus: 'Recent commits:\nabc autosave 1' })
  })

  test('the first process records its context for the next one', async () => {
    useSnapshot()
    await writeTempFile(tempDir, 'CLAUDE.md', 'rules v1')
    const ctx = await getUserContext()
    await getSystemContext()
    const saved = JSON.parse(readFileSync(snapshot, 'utf8'))
    expect(saved.v).toBe(1)
    expect(saved.userContext).toEqual(ctx)
    expect(saved.localDate).toBe(getLocalISODate())
    expect(saved.systemContext).toEqual({})
  })

  test('a frozen older date keeps the prefix and announces today at the tail', async () => {
    useSnapshot()
    writeFileSync(
      snapshot,
      JSON.stringify({
        v: 1,
        userContext: { currentDate: "Today's date is 2000-01-01." },
        localDate: '2000-01-01',
      }),
    )
    respawn()
    const ctx = await getUserContext()
    expect(ctx.currentDate).toBe("Today's date is 2000-01-01.")
    expect(getLastEmittedDate()).toBe('2000-01-01')
    expect(getDateChangeAttachments([])).toEqual([{ type: 'date_change', newDate: getLocalISODate() }])
  })

  test('an unreadable snapshot falls back to live values', async () => {
    useSnapshot()
    writeFileSync(snapshot, 'not json')
    await writeTempFile(tempDir, 'CLAUDE.md', 'live rules')
    respawn()
    const ctx = await getUserContext()
    expect(ctx.claudeMd).toContain('live rules')
  })

  test('the snapshot path is not inherited by tool subprocesses', async () => {
    useSnapshot()
    respawn()
    await getSystemContext()
    expect(process.env.OPENCLAUDE_CONTEXT_FREEZE_FILE).toBeUndefined()
    // ...yet this process keeps using it after its caches are cleared.
    writeFileSync(snapshot, JSON.stringify({ v: 1, systemContext: { gitStatus: 'kept' } }))
    getSystemContext.cache.clear?.()
    expect(await getSystemContext()).toEqual({ gitStatus: 'kept' })
  })
})
