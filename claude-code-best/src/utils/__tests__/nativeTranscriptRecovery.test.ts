import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { recoverNativeTranscript } from '../nativeTranscriptRecovery.js'
import type { CcbNativeTranscriptArchive } from '../../../../packages/protocol/src/ccbTranscriptRestore.js'
const sha = (value: unknown): string => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
const sid = '60700000-0000-4000-8000-000000000001'
const binding = { peerId: 'synthetic-g607', agentId: 'main', nativeSessionId: sid }
// Public, valid 1x1 PNG. The recovery never decodes or recompresses it.
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII='
const uuid = (n: number): string => `60700000-0000-4000-8000-${String(n).padStart(12, '0')}`
const time = (n: number): string => new Date(Date.UTC(2026, 9, 24, 1, 0, 0, n)).toISOString()
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([key, value]) => [key, reverseKeys(value)]))
  return v
}
function fixture(extraRoot = false): { raw: Buffer; archive: CcbNativeTranscriptArchive; expected: any[]; metadata: any } {
  const input = { parentUuid: null, isSidechain: false, promptId: uuid(900), type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'synthetic-only-user-input-607' }] }, uuid: uuid(1), timestamp: time(0), userType: 'external', cwd: '/synthetic', sessionId: sid, version: 'fixture' }
  const metadata = { type: 'queue-operation', operation: 'enqueue', timestamp: time(2), sessionId: sid, content: 'synthetic metadata preserved' }
  const graph: any[] = [input]
  const native: any[] = []
  for (let i = 0; i < 3; i++) {
    const assistantId = uuid(10 + i), readId = uuid(20 + i), toolId = `read-${i}`
    const assistant = { parentUuid: i ? uuid(19 + i) : uuid(1), isSidechain: false, type: 'assistant', message: { id: `msg-${i}`, role: 'assistant', model: 'fixture', content: [{ type: 'thinking', thinking: `original thought ${i}`, signature: `opaque-signature-${i}` }, { type: 'tool_use', id: toolId, name: 'Read', input: { file_path: `/synthetic/${i}.png` } }] }, uuid: assistantId, timestamp: time(1 + i * 2), userType: 'external', cwd: '/synthetic', sessionId: sid, version: 'fixture' }
    // data precedes media_type, matching FileReadTool's actual serializer.
    const message = { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: [{ type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } }] }] }
    const toolUseResult = { type: 'image', file: { base64: png, type: 'image/png', originalSize: 1 } }
    const read = { parentUuid: assistantId, isSidechain: false, promptId: uuid(900), type: 'user', message, ...(extraRoot && i === 1 ? { futureMiddleField: 'MUST-NOT-DROP' } : {}), uuid: readId, timestamp: time(2 + i * 2), toolUseResult, sourceToolAssistantUUID: assistantId, userType: 'external', entrypoint: 'sdk-ts', cwd: '/synthetic', sessionId: sid, version: 'fixture', gitBranch: 'fixture', slug: 'fixture' }
    graph.push(assistant, read)
    native.push({ type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: assistantId, message: assistant.message })
    native.push({ type: 'user', session_id: sid, parent_tool_use_id: null, uuid: readId, message, tool_use_result: toolUseResult })
  }
  const rows = graph.map(v => JSON.stringify(v) + '\n')
  const a = rows[4]!, b = rows[6]!
  const cutA = a.indexOf('"data":"') + '"data":"'.length + 23
  const cutB = b.indexOf('"data":"') + '"data":"'.length + 37
  const raw = Buffer.from(rows[0]! + rows[1]! + rows[2]! + JSON.stringify(metadata) + '\n' + rows[3]! + a.slice(0, cutA) + rows[5]! + b.slice(0, cutB) + a.slice(cutA) + b.slice(cutB))
  const records = native.map((payload, ordinal) => {
    const reordered = reverseKeys(payload) as Record<string, unknown>
    return { ordinal, payload: reordered, sha256: sha(reordered) }
  })
  const archive: CcbNativeTranscriptArchive = { version: 1, binding, tapes: [{ tapeId: 'synthetic-tape', tapeSha256: sha('tape'), anchorSeq: 1, physicalRecordCount: 1, logicalRecordCount: records.length, canonicalInput: { id: uuid(1), modelText: 'synthetic-only-user-input-607', sha256: sha('synthetic-only-user-input-607') }, records }] }
  return { raw, archive, expected: graph, metadata }
}

describe('lossless native transcript recovery', () => {
  test('proves every interleaved byte, preserves all values/signatures/metadata, and changes only ordering', () => {
    const { raw, archive, expected, metadata } = fixture()
    const originalSha = sha(raw.toString())
    let checked = false
    const result = recoverNativeTranscript(raw, binding, archive, (entries, authority) => {
      expect(entries).toEqual(expected)
      expect(entries.filter(entry => authority.includes(String(entry.uuid))).map(entry => entry.uuid)).toEqual(authority)
      checked = true
    })
    expect(checked).toBe(true)
    expect(result.readCount).toBe(3)
    expect(result.bytes.length).toBe(raw.length)
    expect(result.fragmentCount).toBeGreaterThan(8)
    const restored = result.bytes.toString().trim().split('\n').map(row => JSON.parse(row))
    expect(restored[3]).toEqual(metadata)
    expect(restored.filter(row => row.type !== 'queue-operation')).toEqual(expected)
    expect(sha(raw.toString())).toBe(originalSha)
  })
  test('an unknown root field is retained in the original rather than silently discarded', () => {
    const { raw, archive } = fixture(true), original = Buffer.from(raw)
    expect(() => recoverNativeTranscript(raw, binding, archive, () => {})).toThrow()
    expect(raw.equals(original)).toBe(true)
  })
  test('a missing authoritative Read never produces a partial recovery', () => {
    const { raw, archive } = fixture()
    archive.tapes[0]!.records.splice(3, 1)
    expect(() => recoverNativeTranscript(raw, binding, archive, () => {})).toThrow()
  })
  test('changed image bytes are rejected even if transport hashes were recomputed', () => {
    const { raw, archive } = fixture()
    const payload = archive.tapes[0]!.records[3]!.payload as any
    payload.message.content[0].content[0].source.data = png.replace('VBOR', 'VBOS')
    payload.tool_use_result.file.base64 = payload.message.content[0].content[0].source.data
    archive.tapes[0]!.records[3]!.sha256 = sha(payload)
    expect(() => recoverNativeTranscript(raw, binding, archive, () => {})).toThrow()
  })
  test('foreign peer/SID bindings and corrupt record hashes fail before graph consumption', () => {
    const { raw, archive } = fixture()
    const other = clone(archive); other.binding.peerId = 'another-peer'
    expect(() => recoverNativeTranscript(raw, binding, other, () => { throw Error('SHOULD_NOT_CONSUME') })).toThrow()
    const bad = clone(archive); bad.tapes[0]!.records[0]!.sha256 = '0'.repeat(64)
    expect(() => recoverNativeTranscript(raw, binding, bad, () => { throw Error('SHOULD_NOT_CONSUME') })).toThrow()
  })
})

function replaceRow(raw: Buffer, original: unknown, replacement: unknown[]): Buffer {
  const text = raw.toString(), needle = JSON.stringify(original) + '\n'
  const at = text.indexOf(needle)
  if (at < 0 || text.indexOf(needle, at + 1) >= 0) throw Error('FIXTURE_ROW_NOT_UNIQUE')
  return Buffer.from(text.slice(0, at) + replacement.map(row => JSON.stringify(row) + '\n').join('') + text.slice(at + needle.length))
}
function nativeRecord(entry: any, ordinal: number): any {
  const payload = reverseKeys({ type: entry.type, session_id: sid, parent_tool_use_id: null, uuid: entry.uuid,
    message: entry.message, ...(entry.toolUseResult ? { tool_use_result: entry.toolUseResult } : {}) }) as Record<string, unknown>
  return { ordinal, payload, sha256: sha(payload) }
}
function ordinary(n: number, parent: string | null, type: 'user' | 'assistant', text: string, ms: number): any {
  return { parentUuid: parent, isSidechain: false, type, message: { role: type, ...(type === 'assistant' ? { id: `ordinary-${n}` } : {}), content: [{ type: 'text', text }] },
    uuid: uuid(n), timestamp: time(ms), cwd: '/synthetic', sessionId: sid, version: 'fixture' }
}
for (const toolName of ['Bash', 'mcp__fixture__image']) {
  test(`an intact ${toolName} result remains byte-exact alongside interleaved image Reads`, () => {
    const f = fixture(), before = clone(f.expected[3])
    const assistant = ordinary(40, uuid(20), 'assistant', '', 2)
    assistant.message.content = [{ type: 'tool_use', id: 'other-tool', name: toolName, input: {} }]
    const result = ordinary(41, uuid(40), 'user', '', 2)
    const imageTool = toolName !== 'Bash'
    result.message.content = [{ type: 'tool_result', tool_use_id: 'other-tool', content: imageTool
      ? [{ type: 'image', source: { type: 'base64', data: png, media_type: 'image/png' } }]
      : [{ type: 'text', text: 'synthetic stdout preserved' }] }]
    result.toolUseResult = imageTool ? { type: 'image', file: { base64: png, type: 'image/png', originalSize: 1 } }
      : { stdout: 'synthetic stdout preserved', stderr: '', interrupted: false }
    result.sourceToolAssistantUUID = uuid(40)
    const next = { ...before, parentUuid: uuid(41) }
    const raw = replaceRow(f.raw, before, [assistant, result, next])
    const expected = clone(f.expected); expected.splice(3, 1, assistant, result, next)
    f.archive.tapes[0]!.records.splice(2, 0, nativeRecord(assistant, 2), nativeRecord(result, 3))
    f.archive.tapes[0]!.records.forEach((record, ordinal) => { record.ordinal = ordinal })
    f.archive.tapes[0]!.logicalRecordCount = f.archive.tapes[0]!.records.length
    const restored = recoverNativeTranscript(raw, binding, f.archive, entries => { expect(entries).toEqual(expected) })
    expect(restored.bytes.toString().includes(JSON.stringify(result) + '\n')).toBe(true)
  })
}

test('all complete metadata and future footer fields are kept without projection', () => {
  const f = fixture(), metadata = { ...f.metadata, type: 'custom-title', customTitle: 'synthetic title', futureMetadata: { retained: true } }
  let raw = replaceRow(f.raw, f.metadata, [metadata])
  const read = f.expected[2], extended = { ...read, futureFooter: { retained: ['complete', 'original'] } }
  raw = replaceRow(raw, read, [extended])
  const restored = recoverNativeTranscript(raw, binding, f.archive, () => {})
  const text = restored.bytes.toString()
  expect(text.includes(JSON.stringify(metadata) + '\n')).toBe(true)
  expect(text.includes(JSON.stringify(extended) + '\n')).toBe(true)
})

test('repeated canonical user text is covered in native turn order without dropping either prompt', () => {
  const f = fixture()
  const user = ordinary(60, uuid(22), 'user', 'synthetic-only-user-input-607', 8)
  const assistant = ordinary(61, uuid(60), 'assistant', 'second turn result', 9)
  const raw = Buffer.concat([f.raw, Buffer.from(JSON.stringify(user) + '\n' + JSON.stringify(assistant) + '\n')])
  f.archive.tapes.push({ tapeId: 'second-tape', tapeSha256: sha('second-tape'), anchorSeq: 2,
    physicalRecordCount: 1, logicalRecordCount: 1,
    canonicalInput: { id: uuid(60), modelText: 'synthetic-only-user-input-607', sha256: sha('synthetic-only-user-input-607') },
    records: [nativeRecord(assistant, 0)] })
  const expected = [...f.expected, user, assistant]
  recoverNativeTranscript(raw, binding, f.archive, entries => { expect(entries).toEqual(expected) })
})

for (const flip of ['type', 'message.role']) {
  test(`a native assistant ${flip} change cannot be accepted as the original model context`, () => {
    const f = fixture(), local = ordinary(70, uuid(22), 'assistant', 'final assistant', 7)
    f.archive.tapes[0]!.records.push(nativeRecord(local, 6))
    f.archive.tapes[0]!.logicalRecordCount++
    if (flip === 'type') local.type = 'user'; else local.message.role = 'user'
    const raw = Buffer.concat([f.raw, Buffer.from(JSON.stringify(local) + '\n')])
    expect(() => recoverNativeTranscript(raw, binding, f.archive, () => {})).toThrow()
  })
}

test('legitimate local usage and stop_reason changes preserve the whole local assistant', () => {
  const f = fixture(), original = clone(f.expected[1])
  const local = { ...original, message: { ...original.message, usage: { input_tokens: 123, output_tokens: 45 }, stop_reason: 'tool_use' } }
  const raw = replaceRow(f.raw, original, [local])
  recoverNativeTranscript(raw, binding, f.archive, entries => {
    expect((entries.find(entry => entry.uuid === local.uuid)!.message as any).usage.input_tokens).toBe(123)
    expect((entries.find(entry => entry.uuid === local.uuid)!.message as any).stop_reason).toBe('tool_use')
  })
})

for (const cyclic of [false, true]) {
  test(`a complete non-native ${cyclic ? 'cycle is rejected' : 'dead branch is retained'}`, () => {
    const f = fixture(), first = ordinary(80, cyclic ? uuid(81) : null, 'user', 'extra local branch', -2)
    const second = ordinary(81, uuid(80), 'assistant', 'extra local result', -1)
    let raw = Buffer.concat([f.raw, Buffer.from(JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n')])
    if (cyclic) {
      const input = clone(f.expected[0]); input.parentUuid = uuid(80)
      raw = replaceRow(raw, f.expected[0], [input])
      expect(() => recoverNativeTranscript(raw, binding, f.archive, () => {})).toThrow()
    } else {
      recoverNativeTranscript(raw, binding, f.archive, entries => {
        expect(entries.some(entry => entry.uuid === first.uuid)).toBe(true)
        expect(entries.some(entry => entry.uuid === second.uuid)).toBe(true)
      })
    }
  })
}

test('the managed loader automatically restores once, keeps every hard link, and persists a private byte receipt', async () => {
  const { mkdtemp, mkdir, writeFile, link, stat, readFile, readdir, rm, chmod } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os'), { join } = await import('node:path')
  const { createServer } = await import('node:http'), { once } = await import('node:events')
  const storage = await import('../sessionStorage.js'), io = await import('../sessionFileIo.js')
  const directory = await mkdtemp(join(tmpdir(), 'g607-auto-restore-'))
  const keys = ['CLAUDE_CONFIG_DIR', 'OPENCLAUDE_TRANSCRIPT_INTEGRITY', 'OPENCLAUDE_TRANSCRIPT_RECOVERY_SOCKET', 'OPENCLAUDE_TRANSCRIPT_RECOVERY_PEER', 'OPENCLAUDE_TRANSCRIPT_RECOVERY_AGENT']
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  const f = fixture(), archiveBytes = Buffer.from(JSON.stringify(f.archive)), socketPath = join(directory, 'restore.sock')
  let calls = 0
  let frameMode: 'missing-end' | 'bad-sha' | 'good' = 'missing-end'
  const server = createServer((_req, res) => {
    calls++
    res.setHeader('content-type', 'application/x-ndjson')
    let chunks = 0
    for (let offset = 0; offset < archiveBytes.length; offset += 4096) res.write(JSON.stringify({ index: chunks++, data: archiveBytes.subarray(offset, offset + 4096).toString('base64') }) + '\n')
    if (frameMode === 'missing-end') res.end()
    else res.end(JSON.stringify({ complete: true, chunks, bytes: archiveBytes.length, sha256: frameMode === 'bad-sha' ? '0'.repeat(64) : createHash('sha256').update(archiveBytes).digest('hex') }) + '\n')
  })
  server.listen(socketPath); await once(server, 'listening'); await chmod(socketPath, 0o600)
  try {
    process.env.CLAUDE_CONFIG_DIR = directory; process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY = '1'
    process.env.OPENCLAUDE_TRANSCRIPT_RECOVERY_SOCKET = socketPath
    process.env.OPENCLAUDE_TRANSCRIPT_RECOVERY_PEER = binding.peerId; process.env.OPENCLAUDE_TRANSCRIPT_RECOVERY_AGENT = binding.agentId
    const projects = join(directory, 'projects'), file = join(projects, 'cwd-a', `${sid}.jsonl`), alias = join(projects, 'cwd-b', `${sid}.jsonl`)
    await mkdir(join(projects, 'cwd-a'), { recursive: true, mode: 0o700 }); await mkdir(join(projects, 'cwd-b'), { mode: 0o700 })
    await writeFile(file, f.raw, { mode: 0o600 }); await link(file, alias)
    const inode = (await stat(file)).ino
    storage.resetProjectForTesting(); storage.clearSessionMessagesCache()
    for (const mode of ['missing-end', 'bad-sha'] as const) {
      frameMode = mode
      await expect(storage.loadTranscriptFile(alias)).rejects.toMatchObject({ code: 'CCB_TRANSCRIPT_RESTORE_UNPROVEN' })
      expect((await readFile(file)).equals(f.raw)).toBe(true)
      expect((await readFile(alias)).equals(f.raw)).toBe(true)
      expect((await stat(file)).ino).toBe(inode)
    }
    frameMode = 'good'
    const loaded = await storage.loadTranscriptFile(alias)
    expect(loaded.messages.size).toBe(f.expected.length)
    expect([...loaded.messages.values()].map(entry => entry.uuid)).toEqual(f.expected.map(entry => entry.uuid))
    expect((await stat(file)).ino).toBe(inode); expect((await stat(alias)).ino).toBe(inode)
    const restored = await readFile(file)
    expect(restored.length).toBe(f.raw.length)
    expect(restored.toString().trim().split('\n').map(row => JSON.parse(row)).filter(row => row.type !== 'queue-operation')).toEqual(f.expected)
    const dirs = await readdir(join(projects, '.oc-transcript-integrity')), tx = join(projects, '.oc-transcript-integrity', dirs[0]!)
    const receipt = JSON.parse(await readFile(join(tx, 'restore-receipt.json'), 'utf8'))
    expect(receipt.sourceSha256).toBe(createHash('sha256').update(f.raw).digest('hex'))
    expect(receipt.targetSha256).toBe(createHash('sha256').update(restored).digest('hex'))
    expect(receipt.verifiedReadCount).toBe(3)
    expect((await readFile(join(tx, `source-${receipt.sourceSha256}.blob`))).equals(f.raw)).toBe(true)
    expect((await stat(join(tx, 'restore-receipt.json'))).mode & 0o777).toBe(0o600)
    await storage.loadTranscriptFile(file)
    expect(calls).toBe(3)
    const next = ordinary(95, uuid(22), 'user', 'continue after automatic recovery', 10)
    await io.appendSessionFile(alias, JSON.stringify(next) + '\n', { projectsDir: projects, sessionId: sid, requireKernelLock: true })
    const continued = await storage.loadTranscriptFile(file)
    expect(continued.messages.get(uuid(95) as any)).toEqual(next)
    expect(calls).toBe(3)
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await io.flushSessionFileIo(); storage.resetProjectForTesting(); storage.clearSessionMessagesCache()
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value
    await rm(directory, { recursive: true, force: true })
  }
})

test('invalid UTF-8 inside otherwise valid JSON enters recovery instead of silently changing model text', async () => {
  const { transcriptNeedsRecovery } = await import('../nativeTranscriptRecovery.js')
  const valid = Buffer.from(JSON.stringify(ordinary(100, null, 'user', 'synthetic-original-text', 1)) + '\n')
  const invalid = Buffer.from(valid); invalid[invalid.indexOf(Buffer.from('original'))] = 0xff
  const handle = (bytes: Buffer): any => ({ stat: async () => ({ size: bytes.length }), read: async (target: Buffer, offset: number, length: number, position: number) => {
    const count = Math.min(length, bytes.length - position); bytes.copy(target, offset, position, position + count); return { bytesRead: count, buffer: target }
  } })
  expect(await transcriptNeedsRecovery(handle(valid))).toBe(false)
  expect(await transcriptNeedsRecovery(handle(invalid))).toBe(true)
})
