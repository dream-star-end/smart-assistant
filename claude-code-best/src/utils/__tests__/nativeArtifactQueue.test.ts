import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeArtifactInstall } from '../../../../packages/storage/src/nativeArtifactInstaller.js'
import { getSessionId, getSessionProjectDir, switchSession } from '../../bootstrap/state.js'
import * as storage from '../sessionStorage.js'

const sid = '00000000-0000-4000-8000-000000000003'
async function fixture(run: (directory: string, file: string, session: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'agentremote-ccb-artifact-'))
  const project = join(directory, 'projects', 'fixture')
  const file = join(project, `${sid}.jsonl`)
  const keys = [
    'CLAUDE_CONFIG_DIR',
    'OPENCLAUDE_TRANSCRIPT_INTEGRITY',
    'TEST_ENABLE_SESSION_PERSISTENCE',
  ]
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
  const originalSid = getSessionId()
  const originalProject = getSessionProjectDir()
  try {
    process.env.CLAUDE_CONFIG_DIR = directory
    process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY = '1'
    process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
    await mkdir(project, { recursive: true, mode: 0o700 })
    await writeFile(file, '', { mode: 0o600 })
    switchSession(sid as any, project)
    storage.resetProjectForTesting()
    storage.clearSessionMessagesCache()
    storage.setSessionFileForTesting(file)
    await run(directory, file, join(project, sid))
  } finally {
    try {
      await storage.flushSessionStorage()
    } catch {
      /* The negative producer already observed the failure. */
    }
    storage.resetProjectForTesting()
    storage.clearSessionMessagesCache()
    switchSession(originalSid, originalProject)
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    await rm(directory, { recursive: true, force: true })
  }
}
function dependency(session: string, bytes: string): NativeArtifactInstall {
  return {
    sessionDirectory: session,
    nativeSessionId: sid,
    nativeWriterLockPath: process.env.NATIVE_ARTIFACT_TEST_LOCK_PATH!,
    operationId: 'queue-op',
    artifacts: [
      {
        nativeSessionId: sid,
        relativePath: 'tool-results/call_queue.txt',
        sizeBytes: Buffer.byteLength(bytes),
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
    openSource: async function* () {
      yield Buffer.from(bytes)
    },
  }
}
test('actual CCB queue retains immutable typed dependencies and commits them before the JSONL producer resolves', async () => {
  await fixture(async (_directory, file, session) => {
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const ready = new Promise<void>((r) => {
      entered = r
    })
    const config = {
      ...dependency(session, 'original-output'),
      openSource: async function* () {
        entered()
        await gate
        yield Buffer.from('original-output')
      },
    }
    const dependencies = [config]
    let completed = false
    const writing = Promise.resolve(
      storage.appendEntryToFile(
        file,
        {
          type: 'user',
          sessionId: sid,
          uuid: 'native-result',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call_queue',
                content: 'tool-results/call_queue.txt',
              },
            ],
          },
        },
        dependencies,
      ),
    ).then(() => {
      completed = true
    })
    // Queue admission owns the dependencies and descriptors even if its caller reuses them.
    config.artifacts[0]!.sha256 = 'f'.repeat(64)
    dependencies.length = 0
    try {
      await ready
      expect(completed).toBe(false)
      expect(await readFile(file, 'utf8')).toBe('')
      release()
      await writing
      expect(await readFile(join(session, 'tool-results/call_queue.txt'), 'utf8')).toBe(
        'original-output',
      )
      expect(JSON.parse((await readFile(file, 'utf8')).trim()).uuid).toBe('native-result')
      await storage.flushSessionStorage()
    } finally {
      release()
    }
  })
})
test('actual CCB ordered producers preserve the first commit and reject a later conflicting dependency', async () => {
  await fixture(async (_directory, file, session) => {
    const first = Promise.resolve(
      storage.appendEntryToFile(file, { type: 'user', sessionId: sid, uuid: 'first' }, [
        dependency(session, 'first'),
      ]),
    )
    const second = Promise.resolve(
      storage.appendEntryToFile(file, { type: 'user', sessionId: sid, uuid: 'second' }, [
        dependency(session, 'other'),
      ]),
    )
    const results = await Promise.allSettled([first, second])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    for (const result of results)
      if (result.status === 'rejected') expect(result.reason.code).toBe('native-artifact-conflict')
    expect(JSON.parse((await readFile(file, 'utf8')).trim()).uuid).toBe('first')
    expect(await readFile(join(session, 'tool-results/call_queue.txt'), 'utf8')).toBe('first')
  })
})
test('dependency content failure rejects the actual CCB producer and public flush without persisting its reference', async () => {
  await fixture(async (_directory, file, session) => {
    const config = {
      ...dependency(session, 'expected'),
      openSource: async function* () {
        yield Buffer.from('mismatch')
      },
    }
    await expect(
      Promise.resolve(
        storage.appendEntryToFile(file, { type: 'user', sessionId: sid, uuid: 'bad-content' }, [
          config,
        ]),
      ),
    ).rejects.toMatchObject({ code: 'native-artifact-content' })
    await expect(storage.flushSessionStorage()).rejects.toMatchObject({
      code: 'native-artifact-content',
    })
    expect(await readFile(file, 'utf8')).toBe('')
  })
})

test('ordinary main and sidechain recorders carry dependencies into their actual managed writers', async () => {
  for (const sidechain of [false, true])
    await fixture(async (_directory, file, session) => {
      const uuid = '00000000-0000-4000-8000-000000000010'
      const message = {
        type: 'user',
        uuid,
        timestamp: new Date(1792800000000).toISOString(),
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'synthetic output reference: tool-results/call_queue.txt' },
          ],
        },
      }
      const config = dependency(session, 'recorded-output')
      const dependencies = new Map([[uuid, [config]]])
      if (sidechain)
        await storage.recordSidechainTranscript(
          [message] as any,
          'a0123456789abcdef',
          undefined,
          dependencies,
        )
      else
        await storage.recordTranscript(
          [message] as any,
          undefined,
          undefined,
          undefined,
          true,
          dependencies,
        )
      dependencies.clear()
      await storage.flushSessionStorage()
      const target = sidechain ? join(session, 'subagents', 'agent-a0123456789abcdef.jsonl') : file
      const rows = (await readFile(target, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(rows.filter((row) => row.uuid === uuid).length).toBe(1)
      expect(await readFile(join(session, 'tool-results/call_queue.txt'), 'utf8')).toBe(
        'recorded-output',
      )
    })
})

test('dependencies for filtered or previously recorded messages fail closed instead of pretending to commit', async () => {
  await fixture(async (_directory, file, session) => {
    const uuid = '00000000-0000-4000-8000-000000000011'
    const message = {
      type: 'user',
      uuid,
      timestamp: new Date(1792800000000).toISOString(),
      message: { role: 'user', content: [{ type: 'text', text: 'already-recorded' }] },
    }
    await storage.recordTranscript([message] as any)
    const before = await readFile(file, 'utf8')
    const dependencies = new Map([[uuid, [dependency(session, 'must-not-be-silently-ignored')]]])
    await expect(
      storage.recordTranscript(
        [message] as any,
        undefined,
        undefined,
        undefined,
        false,
        dependencies,
      ),
    ).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_ARTIFACT_NOT_WRITTEN' })
    expect(await readFile(file, 'utf8')).toBe(before)
    const filteredId = '00000000-0000-4000-8000-000000000012'
    const progress = {
      type: 'progress',
      uuid: filteredId,
      timestamp: message.timestamp,
      data: { type: 'bash_progress', output: 'synthetic' },
      parentToolUseID: 'call_queue',
      toolUseID: 'progress',
    }
    const filtered = new Map([[filteredId, [dependency(session, 'filtered')]]])
    await expect(
      storage.recordTranscript([progress] as any, undefined, undefined, undefined, false, filtered),
    ).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_ARTIFACT_NOT_WRITTEN' })
    await expect(
      storage.recordSidechainTranscript(
        [progress] as any,
        'a0123456789abcdef',
        undefined,
        filtered,
      ),
    ).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_ARTIFACT_NOT_WRITTEN' })
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})
