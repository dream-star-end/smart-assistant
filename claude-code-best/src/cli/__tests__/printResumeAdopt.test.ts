import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

mock.module('bun:bundle', () => ({
  feature: () => false,
}))

const { adoptLoadedPrintSessionFile } = await import('../print.js')
const { getSessionId, switchSession } = await import('src/bootstrap/state.js')
const { asSessionId } = await import('src/types/ids.js')
const {
  clearSessionMessagesCache,
  flushSessionStorage,
  recordTranscript,
  resetSessionFilePointer,
} = await import('src/utils/sessionStorage.js')
const { createSystemMessage } = await import('src/utils/messages.js')

/**
 * Print continue/resume must adopt only the loaded same-session file.
 * A system resume leaf is otherwise stuck in pendingEntries after
 * resetSessionFilePointer, and flush does not write it.
 */

let tempDir = ''
let originalConfigDir: string | undefined
let originalTestPersistence: string | undefined

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function seedSession(sessionId: string): { projectDir: string; fullPath: string } {
  const projectDir = join(tempDir, 'projects', 'loaded')
  mkdirSync(projectDir, { recursive: true })
  const fullPath = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    fullPath,
    JSON.stringify({
      type: 'user',
      uuid: `user-${sessionId}`,
      sessionId,
      parentUuid: null,
      message: { role: 'user', content: 'preserve the user goal' },
      timestamp: '2026-09-29T00:00:00.000Z',
    }) + '\n',
  )
  return { projectDir, fullPath }
}

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `print-resume-adopt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  mkdirSync(tempDir, { recursive: true })
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tempDir
  // bun test sets NODE_ENV=test, which suppresses transcript writes unless
  // this override is on. The assertion is the bytes on the loaded file.
  originalTestPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  clearSessionMessagesCache()
})

afterEach(async () => {
  await resetSessionFilePointer()
  clearSessionMessagesCache()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (originalTestPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = originalTestPersistence
  if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true })
})

describe('print resume adopts the loaded same-session file', () => {
  test('system resume leaf is flushed onto the loaded file and a repeat does not append it again', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
    const { projectDir, fullPath } = seedSession(sessionId)
    switchSession(asSessionId(sessionId), projectDir)
    await resetSessionFilePointer()
    adoptLoadedPrintSessionFile({
      forkSession: false,
      persistSession: true,
      sessionId,
      fullPath,
    })
    const leaf = createSystemMessage('resume-leaf', 'info')
    await recordTranscript([leaf])
    await flushSessionStorage()
    const once = readFileSync(fullPath, 'utf8')
    expect(once).toContain(leaf.uuid)
    expect(once.split(leaf.uuid).length - 1).toBe(1)

    await recordTranscript([leaf])
    await flushSessionStorage()
    const twice = readFileSync(fullPath, 'utf8')
    expect(twice.split(leaf.uuid).length - 1).toBe(1)
  })

  test('fork does not write the source file', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
    const { projectDir, fullPath } = seedSession(sessionId)
    const before = sha256(fullPath)
    switchSession(asSessionId(sessionId), projectDir)
    await resetSessionFilePointer()
    adoptLoadedPrintSessionFile({
      forkSession: true,
      persistSession: true,
      sessionId,
      fullPath,
    })
    await recordTranscript([createSystemMessage('fork-leaf', 'info')])
    await flushSessionStorage()
    expect(sha256(fullPath)).toBe(before)
    expect(readdirSync(projectDir)).toEqual([`${sessionId}.jsonl`])
  })

  test('fresh session does not write the source file', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
    const { projectDir, fullPath } = seedSession(sessionId)
    const before = sha256(fullPath)
    expect(getSessionId()).not.toBe(sessionId)
    await resetSessionFilePointer()
    adoptLoadedPrintSessionFile({
      forkSession: false,
      persistSession: true,
      sessionId,
      fullPath,
    })
    await recordTranscript([createSystemMessage('fresh-leaf', 'info')])
    await flushSessionStorage()
    expect(sha256(fullPath)).toBe(before)
    expect(readdirSync(projectDir)).toEqual([`${sessionId}.jsonl`])
  })

  test('nonpersistent resume does not write the source file', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4'
    const { projectDir, fullPath } = seedSession(sessionId)
    const before = sha256(fullPath)
    switchSession(asSessionId(sessionId), projectDir)
    await resetSessionFilePointer()
    adoptLoadedPrintSessionFile({
      forkSession: false,
      persistSession: false,
      sessionId,
      fullPath,
    })
    await recordTranscript([createSystemMessage('nopersist-leaf', 'info')])
    await flushSessionStorage()
    expect(sha256(fullPath)).toBe(before)
  })

  test('missing or different path does not write the source file or create another', async () => {
    const sessionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5'
    const { projectDir, fullPath } = seedSession(sessionId)
    const before = sha256(fullPath)
    switchSession(asSessionId(sessionId), projectDir)
    await resetSessionFilePointer()
    adoptLoadedPrintSessionFile({
      forkSession: false,
      persistSession: true,
      sessionId,
      fullPath: undefined,
    })
    const otherDir = join(tempDir, 'projects', 'other')
    mkdirSync(otherDir, { recursive: true })
    const otherPath = join(otherDir, `${sessionId}.jsonl`)
    writeFileSync(otherPath, readFileSync(fullPath))
    const otherBefore = sha256(otherPath)
    adoptLoadedPrintSessionFile({
      forkSession: false,
      persistSession: true,
      sessionId,
      fullPath: otherPath,
    })
    await recordTranscript([createSystemMessage('mismatch-leaf', 'info')])
    await flushSessionStorage()
    expect(sha256(fullPath)).toBe(before)
    expect(sha256(otherPath)).toBe(otherBefore)
    expect(readdirSync(projectDir)).toEqual([`${sessionId}.jsonl`])
    expect(readdirSync(otherDir)).toEqual([`${sessionId}.jsonl`])
  })
})
