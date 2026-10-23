import { test, expect } from 'bun:test'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import * as storage from '../sessionStorage.js'
import { withSessionFile, flushSessionFileIo } from '../sessionFileIo.js'
import { switchSession, getSessionId, getSessionProjectDir } from '../../bootstrap/state.js'

const sid = '60700000-0000-4000-8000-000000004000'
const uuid = (n: number) => `60700000-0000-4000-8000-${String(n).padStart(12, '0')}`

test('producer admission, queue backpressure, metadata and tombstones all commit before terminal flush', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'g607-queue-')), projectDir = join(directory, 'projects', 'fixture'), file = join(projectDir, `${sid}.jsonl`)
  const keys = ['CLAUDE_CONFIG_DIR', 'OPENCLAUDE_TRANSCRIPT_INTEGRITY', 'TEST_ENABLE_SESSION_PERSISTENCE']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalSid = getSessionId(), originalProject = getSessionProjectDir()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { entered = r })
  let holder: Promise<void> | undefined
  try {
    process.env.CLAUDE_CONFIG_DIR = directory; process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY = '1'; process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await mkdir(projectDir, { recursive: true, mode: 0o700 }); await writeFile(file, '', { mode: 0o600 })
    switchSession(sid as any, projectDir); storage.resetProjectForTesting(); storage.clearSessionMessagesCache(); storage.setSessionFileForTesting(file)
    holder = withSessionFile(file, { projectsDir: join(directory, 'projects'), sessionId: sid, requireKernelLock: true }, false, async () => { entered(); await gate })
    await ready
    const original = Array.from({ length: 1105 }, (_, i) => ({ type: i % 2 ? 'assistant' : 'user', uuid: uuid(i + 1), timestamp: new Date(1792800000000 + i).toISOString(),
      message: { role: i % 2 ? 'assistant' : 'user', ...(i % 2 ? { id: `model-${i}` } : {}), content: [{ type: 'text', text: `synthetic exact row ${i}` }] } }))
    const admitted = original.slice(), recording = storage.recordTranscript(admitted as any, undefined, undefined, undefined, true)
    admitted.length = 0 // Admission owns membership even if the caller clears its array.
    const title = storage.saveCustomTitle(sid as any, 'synthetic newest title', file)
    const orphan = { parentUuid: null, isSidechain: false, type: 'user', uuid: uuid(3000), timestamp: new Date(1792800005000).toISOString(), sessionId: sid,
      message: { role: 'user', content: [{ type: 'text', text: 'orphan that will be removed' }] } }
    const append = storage.appendEntryToFile(file, orphan)
    const removal = storage.removeTranscriptMessage(uuid(3000) as any)
    storage.reAppendSessionMetadata()
    let flushed = false
    const flush = storage.flushSessionStorage().then(() => { flushed = true })
    await Promise.resolve(); await Promise.resolve(); expect(flushed).toBe(false)
    release(); await holder
    await Promise.all([recording, title, append, removal, flush])
    const rows = (await readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const messages = rows.filter(row => row.type === 'user' || row.type === 'assistant')
    expect(messages.length).toBe(original.length)
    expect(messages.map(row => row.uuid)).toEqual(original.map(row => row.uuid))
    expect(messages.map(row => row.message)).toEqual(original.map(row => row.message))
    expect(rows.filter(row => row.type === 'custom-title').at(-1)?.customTitle).toBe('synthetic newest title')
    expect(flushed).toBe(true)
  } finally {
    release?.(); await holder?.catch(() => {}); await flushSessionFileIo()
    storage.resetProjectForTesting(); storage.clearSessionMessagesCache(); switchSession(originalSid, originalProject)
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(directory, { recursive: true, force: true })
  }
})
