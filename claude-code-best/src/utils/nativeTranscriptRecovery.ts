/** Lossless recovery for a proven interleaving of native Read records. No
 * missing bytes, field defaults, image conversion, or shortened history. */
import { createHash } from 'node:crypto'
import { request } from 'node:http'
import { lstat } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { CcbNativeTranscriptArchive, CcbTranscriptRestoreBinding } from '../../../packages/protocol/src/ccbTranscriptRestore.js'
import { SessionFileIntegrityError, type SessionReadHandle } from './sessionFileIo.js'

type Obj = Record<string, unknown>
interface Candidate { kind: 'graph' | 'metadata' | 'read'; start: number; bytes: Buffer; entry: Obj }
interface Head { start: number; headerRaw: string; header: Obj; toolId: string; role: string }
interface Fragment { candidateId: number; expectedOffset: number; fileOffset: number; length: number }
const fail = (code = 'CCB_TRANSCRIPT_RESTORE_UNPROVEN'): never => { throw new SessionFileIntegrityError(code) }
function check(condition: unknown, code?: string): asserts condition { if (!condition) fail(code) }
const object = (value: unknown): Obj => { check(value && typeof value === 'object' && !Array.isArray(value)); return value as Obj }
const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, sort((v as Obj)[k])]))
    return v
  }
  return JSON.stringify(sort(value))
}
function parseFirst(source: string): { entry: Obj; raw: string } {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < source.length; i++) {
    const c = source[i]
    if (escaped) { escaped = false; continue }
    if (inString) { if (c === '\\') escaped = true; else if (c === '"') inString = false; continue }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      if (--depth === 0) { const raw = source.slice(0, i + 1); return { entry: object(JSON.parse(raw)), raw } }
    }
  }
  return fail()
}
/** Parse only the supported, fully observed prefix. The incomplete image
 * string is never treated as data. Full byte partition below is mandatory. */
function readHead(source: string, start: number, byTool: Map<string, Obj>): Head | undefined {
  const messageAt = source.indexOf('"message":')
  const dataAt = source.indexOf('"data":"')
  if (messageAt < 0 || dataAt < messageAt) return undefined
  const headerRaw = source.slice(0, messageAt)
  const header = object(JSON.parse(`${headerRaw.replace(/,$/, '')}}`))
  check(!['message', 'uuid', 'timestamp', 'toolUseResult', 'sourceToolAssistantUUID', 'sessionId'].some(key => Object.hasOwn(header, key)))
  if (header.type !== 'user' || header.isSidechain !== false || typeof header.parentUuid !== 'string') return undefined
  const prefix = source.slice(0, dataAt + '"data":'.length)
  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const c of prefix) {
    if (escaped) { escaped = false; continue }
    if (inString) { if (c === '\\') escaped = true; else if (c === '"') inString = false; continue }
    if (c === '"') inString = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') { const open = stack.pop(); check((open === '{' && c === '}') || (open === '[' && c === ']')) }
  }
  check(!inString)
  const stub = object(JSON.parse(`${prefix}null${stack.reverse().map(c => c === '[' ? ']' : '}').join('')}`))
  const message = object(stub.message)
  check(message.role === 'user' && Array.isArray(message.content) && message.content.length === 1)
  const block = object((message.content as unknown[])[0])
  check(block.type === 'tool_result' && typeof block.tool_use_id === 'string' && Array.isArray(block.content) && block.content.length === 1)
  const image = object((block.content as unknown[])[0])
  const imageSource = object(image.source)
  check(image.type === 'image' && imageSource.type === 'base64' && imageSource.data === null)
  // media_type follows data in Read's real serializer; its complete value
  // is verified on the authoritative block and by the full byte partition.
  // A fake nested data key cannot classify another layout as a supported Read.
  check(byTool.has(block.tool_use_id))
  return { start, headerRaw, header, role: 'user', toolId: block.tool_use_id }
}
function readBlock(entry: Obj): Obj | undefined {
  if (entry.type !== 'user') return undefined
  const message = entry.message
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const content = (message as Obj).content
  if (!Array.isArray(content) || content.length !== 1) return undefined
  const block = content[0]
  if (!block || typeof block !== 'object' || Array.isArray(block) || (block as Obj).type !== 'tool_result') return undefined
  return block as Obj
}
function singleImageData(message: unknown): string | undefined {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return undefined
  const blocks = (message as Obj).content
  if (!Array.isArray(blocks) || blocks.length !== 1) return undefined
  const tr = object(blocks[0])
  if (tr.type !== 'tool_result' || !Array.isArray(tr.content) || tr.content.length !== 1) return undefined
  const image = object(tr.content[0])
  if (image.type !== 'image') return undefined
  const source = object(image.source)
  return source.type === 'base64' && typeof source.data === 'string' ? source.data : undefined
}
/** Streaming preflight keeps only one JSONL row plus the parent index. */
export async function transcriptNeedsRecovery(file: SessionReadHandle): Promise<boolean> {
  const { size } = await file.stat()
  let position = 0
  let fragments: Buffer[] = []
  let bad = false
  const nodes = new Map<string, { parent: unknown; sidechain: boolean; boundary: boolean }>()
  let liveSegment: Obj | undefined
  const line = (bytes: Buffer): void => {
    if (!bytes.length) return
    try {
      const entry = object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)))
      if (typeof entry.uuid === 'string' && ['user', 'assistant', 'system', 'attachment', 'progress'].includes(String(entry.type))) {
        const boundary = entry.type === 'system' && entry.subtype === 'compact_boundary'
        nodes.set(entry.uuid, { parent: entry.parentUuid, sidechain: entry.isSidechain === true, boundary })
        if (boundary) {
          const metadata = entry.compactMetadata
          const segment = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? (metadata as Obj).preservedSegment : undefined
          liveSegment = segment && typeof segment === 'object' && !Array.isArray(segment) ? segment as Obj : undefined
        }
      }
      if (readBlock(entry) && entry.toolUseResult && typeof entry.toolUseResult === 'object') {
        const result = object(entry.toolUseResult)
        if (result.type === 'image') {
          const image = singleImageData(entry.message)
          const file = object(result.file)
          // Read maps its already-processed file.base64 directly to the model
          // image; legitimate resizing happens before both copies are created.
          if (image !== undefined && image !== file.base64) bad = true
        }
      }
    } catch { bad = true }
  }
  while (position < size) {
    const chunk = Buffer.alloc(Math.min(65536, size - position))
    const { bytesRead } = await file.read(chunk, 0, chunk.length, position)
    check(bytesRead > 0, 'CCB_TRANSCRIPT_SHORT_READ')
    position += bytesRead
    // Scan each new chunk once; join a long row only at its actual LF.
    const bytes = chunk.subarray(0, bytesRead)
    let start = 0
    let at = bytes.indexOf(10)
    while (at >= 0) {
      const tail = bytes.subarray(start, at)
      if (fragments.length) {
        fragments.push(tail)
        line(Buffer.concat(fragments))
        fragments = []
      } else line(tail)
      start = at + 1
      at = bytes.indexOf(10, start)
    }
    if (start < bytes.length) fragments.push(bytes.subarray(start))
  }
  if (fragments.length) line(fragments.length === 1 ? fragments[0]! : Buffer.concat(fragments))
  let preservedHead: string | undefined
  if (liveSegment && typeof liveSegment.headUuid === 'string' && typeof liveSegment.tailUuid === 'string'
    && typeof liveSegment.anchorUuid === 'string' && nodes.has(liveSegment.anchorUuid) && nodes.has(liveSegment.headUuid)) {
    const seen = new Set<string>()
    let at: unknown = liveSegment.tailUuid
    while (typeof at === 'string' && nodes.has(at) && !seen.has(at)) {
      if (at === liveSegment.headUuid) { preservedHead = at; break }
      seen.add(at); at = nodes.get(at)!.parent
    }
  }
  for (const [id, node] of nodes) if (id !== preservedHead && !node.sidechain && !node.boundary && typeof node.parent === 'string' && !nodes.has(node.parent)) bad = true
  return bad
}

export async function readNativeTranscriptArchive(socketPath: string, binding: CcbTranscriptRestoreBinding): Promise<CcbNativeTranscriptArchive> {
  const parent = await lstat(dirname(socketPath))
  const socket = await lstat(socketPath)
  check(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid?.() && (parent.mode & 0o777) === 0o700)
  check(socket.isSocket() && !socket.isSymbolicLink() && socket.uid === process.getuid?.() && (socket.mode & 0o777) === 0o600)
  const chunks: Buffer[] = []
  let total = 0
  let count = 0
  let complete = false
  let carry = ''
  await new Promise<void>((accept, reject) => {
    const req = request({ socketPath, path: '/restore', method: 'GET', timeout: 120000 }, res => {
      const rejectSafe = (): void => { req.destroy(); reject(new SessionFileIntegrityError('CCB_TRANSCRIPT_ARCHIVE_UNAVAILABLE')) }
      if (res.statusCode !== 200) { res.resume(); rejectSafe(); return }
      res.on('error', rejectSafe)
      res.on('data', (chunk: Buffer) => {
        try {
          carry += chunk.toString('utf8')
          let at = carry.indexOf('\n')
          while (at >= 0) {
            check(at <= 400000, 'CCB_TRANSCRIPT_ARCHIVE_INVALID')
            const frame = object(JSON.parse(carry.slice(0, at))); carry = carry.slice(at + 1)
            check(!complete, 'CCB_TRANSCRIPT_ARCHIVE_INVALID')
            if (frame.complete === true) {
              check(frame.chunks === count && frame.bytes === total && frame.sha256 === digest(Buffer.concat(chunks)), 'CCB_TRANSCRIPT_ARCHIVE_INVALID')
              complete = true
            } else {
              check(frame.index === count && typeof frame.data === 'string' && frame.data.length <= 350000 && /^[A-Za-z0-9+/]*={0,2}$/.test(frame.data), 'CCB_TRANSCRIPT_ARCHIVE_INVALID')
              const bytes = Buffer.from(frame.data as string, 'base64')
              check(bytes.toString('base64') === frame.data, 'CCB_TRANSCRIPT_ARCHIVE_INVALID')
              chunks.push(bytes); total += bytes.length; count++
            }
            at = carry.indexOf('\n')
          }
          check(carry.length <= 400000, 'CCB_TRANSCRIPT_ARCHIVE_INVALID')
        } catch { rejectSafe() }
      })
      res.once('end', () => { if (!complete || carry.length || !res.complete) rejectSafe(); else accept() })
    })
    req.once('timeout', () => req.destroy(new Error('TIMEOUT')))
    req.once('error', () => reject(new SessionFileIntegrityError('CCB_TRANSCRIPT_ARCHIVE_UNAVAILABLE')))
    req.end()
  })
  let archive: CcbNativeTranscriptArchive
  try { archive = JSON.parse(Buffer.concat(chunks).toString('utf8')) as CcbNativeTranscriptArchive } catch { return fail('CCB_TRANSCRIPT_ARCHIVE_INVALID') }
  check(archive.version === 1 && canonical(archive.binding) === canonical(binding) && Array.isArray(archive.tapes), 'CCB_TRANSCRIPT_ARCHIVE_BINDING')
  return archive
}

function provePartition(raw: Buffer, records: Candidate[]): { fragments: number; sha256: string } {
  check(records.length > 0 && records.length <= 4000 && records[0]!.start === 0)
  check(new Set(records.map(r => r.start)).size === records.length && records.reduce((n, r) => n + r.bytes.length, 0) === raw.length)
  const cursor = new Int32Array(records.length)
  const active: number[] = []
  const fragments: Fragment[] = []
  const failed = new Set<string>()
  const began = Date.now()
  let states = 0
  const visit = (offset: number, next: number, depth: number): boolean => {
    if (++states > 250000 || Date.now() - began > 35000 || depth > 4000) return false
    if (offset === raw.length) return next === records.length && active.length === 0
    if (next < records.length && records[next]!.start < offset) return false
    let forced = -1
    if (next < records.length && records[next]!.start === offset) { forced = next++; active.push(forced) }
    const stateKey = `${offset}|${next}|${active.map(id => `${id}:${cursor[id]}`).join(',')}`
    if (failed.has(stateKey)) { if (forced >= 0) active.pop(); return false }
    const cap = (next < records.length ? records[next]!.start : raw.length) - offset
    const choices: Array<{ id: number; length: number }> = []
    for (const id of forced >= 0 ? [forced] : active) {
      const record = records[id]!
      const limit = Math.min(cap, record.bytes.length - cursor[id]!)
      let length = 0
      while (length < limit && raw[offset + length] === record.bytes[cursor[id]! + length]) length++
      if (length) choices.push({ id, length })
    }
    choices.sort((a, b) => b.length - a.length)
    for (const choice of choices) {
      const lengths = [choice.length]
      for (let cut = choice.length - 1; cut >= Math.max(1, choice.length - 8); cut--) {
        if (active.some(id => id !== choice.id && records[id]!.bytes[cursor[id]!] === raw[offset + cut])) lengths.push(cut)
      }
      for (const length of lengths) {
        const id = choice.id
        const previous = cursor[id]!
        const activeAt = active.indexOf(id)
        cursor[id] = previous + length
        const completed = cursor[id] === records[id]!.bytes.length
        if (completed) active.splice(activeAt, 1)
        fragments.push({ candidateId: id, expectedOffset: previous, fileOffset: offset, length })
        if (visit(offset + length, next, depth + 1)) return true
        fragments.pop()
        if (completed) active.splice(activeAt, 0, id)
        cursor[id] = previous
      }
    }
    failed.add(stateKey)
    if (forced >= 0) { const index = active.indexOf(forced); if (index >= 0) active.splice(index, 1) }
    return false
  }
  check(visit(0, 0, 0))
  // Independent replay; successful heuristic search alone is never authority.
  let offset = 0
  const positions = new Int32Array(records.length)
  for (const fragment of fragments) {
    const { candidateId: id, expectedOffset, fileOffset, length } = fragment
    check(fileOffset === offset && expectedOffset === positions[id] && length > 0)
    check(raw.subarray(offset, offset + length).equals(records[id]!.bytes.subarray(expectedOffset, expectedOffset + length)))
    if (positions[id] === 0) check(offset === records[id]!.start)
    positions[id] = positions[id]! + length; offset += length
  }
  check(offset === raw.length && records.every((record, id) => positions[id] === record.bytes.length))
  return { fragments: fragments.length, sha256: digest(JSON.stringify(fragments)) }
}

export function recoverNativeTranscript(
  raw: Buffer, binding: CcbTranscriptRestoreBinding, archive: CcbNativeTranscriptArchive,
  validateGraph: (entries: Obj[], authoritativeUuids: string[]) => void,
): { bytes: Buffer; sourceSha256: string; targetSha256: string; readCount: number; fragmentCount: number; fragmentManifestSha256: string; archiveSha256: string } {
  check(archive.version === 1 && canonical(archive.binding) === canonical(binding))
  const sid = binding.nativeSessionId
  const text = raw.toString('utf8')
  check(Buffer.from(text).equals(raw))
  const byUuid = new Map<string, Obj>()
  const byTool = new Map<string, Obj>()
  const authority: string[] = []
  for (let t = 0; t < archive.tapes.length; t++) {
    const tape = archive.tapes[t]!
    check(t === 0 || tape.anchorSeq > archive.tapes[t - 1]!.anchorSeq)
    check(tape.canonicalInput.sha256 === digest(tape.canonicalInput.modelText))
    for (let r = 0; r < tape.records.length; r++) {
      const record = tape.records[r]!
      const native = object(record.payload)
      check(record.sha256 === digest(JSON.stringify(native)) && (r === 0 || record.ordinal > tape.records[r - 1]!.ordinal))
      check(native.session_id === sid && native.parent_tool_use_id == null)
      // Other layouts keep their full native boundary in the archive, but
      // this recovery must not invent compacted transcript envelopes.
      check(native.type !== 'system')
      check(typeof native.uuid === 'string' && !byUuid.has(native.uuid))
      byUuid.set(native.uuid as string, native); authority.push(native.uuid as string)
    }
  }
  const readCalls = new Set<string>()
  for (const native of byUuid.values()) {
    if (native.type !== 'assistant') continue
    const content = object(native.message).content
    check(Array.isArray(content))
    for (const value of content) {
      const block = object(value)
      if (block.type === 'tool_use' && block.name === 'Read') {
        check(typeof block.id === 'string' && !readCalls.has(block.id))
        readCalls.add(block.id)
      }
    }
  }
  for (const native of byUuid.values()) {
    const block = readBlock(native)
    if (block && typeof block.tool_use_id === 'string' && readCalls.has(block.tool_use_id)
      && native.tool_use_result && object(native.tool_use_result).type === 'image') {
      check(!byTool.has(block.tool_use_id))
      const imageData = singleImageData(native.message)
      check(typeof imageData === 'string' && imageData === object(object(native.tool_use_result).file).base64)
      byTool.set(block.tool_use_id, native)
    }
  }
  check(byTool.size > 0)
  const intact: Candidate[] = []
  const completeReads: Candidate[] = []
  const heads: Head[] = []
  let lineByte = 0
  for (const line of text.split('\n')) {
    const lineBytes = Buffer.byteLength(line)
    if (!line) { lineByte++; continue }
    let metadata = false
    try {
      const entry = object(JSON.parse(line))
      if (!['user', 'assistant', 'system', 'attachment', 'progress'].includes(String(entry.type))) {
        check(raw[lineByte + lineBytes] === 10)
        intact.push({ kind: 'metadata', start: lineByte, bytes: raw.subarray(lineByte, lineByte + lineBytes + 1), entry }); metadata = true
      }
    } catch { /* Broken Read lines are classified below; coverage must close. */ }
    if (!metadata) for (let from = 0;;) {
      const at = line.indexOf('{"parentUuid":', from)
      if (at < 0) break
      from = at + 1
      const source = line.slice(at)
      const start = lineByte + Buffer.byteLength(line.slice(0, at))
      try {
        const parsed = parseFirst(source)
        const entry = parsed.entry
        if (entry.sessionId === sid) {
          const end = start + Buffer.byteLength(parsed.raw)
          check(raw[end] === 10)
          const block = readBlock(entry)
          if (block && typeof block.tool_use_id === 'string' && byTool.has(block.tool_use_id)) {
            completeReads.push({ kind: 'read', start, bytes: raw.subarray(start, end + 1), entry })
          } else {
            intact.push({ kind: 'graph', start, bytes: raw.subarray(start, end + 1), entry })
          }
        }
      } catch { /* No parsed prefix is accepted without the partition proof. */ }
      try { const head = readHead(source, start, byTool); if (head) heads.push(head) } catch { /* Unsupported start remains uncovered and fails partition. */ }
    }
    lineByte += lineBytes + 1
  }
  const localByUuid = new Map(intact.filter(x => x.kind === 'graph').map(x => [x.entry.uuid, x.entry]))
  const ownsRead = (entry: Obj, toolId: string): boolean => {
    const parent = localByUuid.get(entry.parentUuid)
    if (parent?.type !== 'assistant' || entry.sourceToolAssistantUUID !== entry.parentUuid) return false
    const content = object(parent.message).content
    return Array.isArray(content) && content.some(value => {
      const block = object(value)
      return block.type === 'tool_use' && block.name === 'Read' && block.id === toolId
    })
  }
  const good = completeReads.filter(record => {
    const entry = record.entry
    const block = readBlock(entry)!
    const native = byUuid.get(String(entry.uuid))
    return typeof block.tool_use_id === 'string' && ownsRead(entry, block.tool_use_id)
      && native && canonical(entry.message) === canonical(native.message)
      && canonical(entry.toolUseResult) === canonical(native.tool_use_result)
      && singleImageData(entry.message) === object(object(entry.toolUseResult).file).base64
  })
  check(good.length > 0)
  const goodStarts = new Set(good.map(record => record.start))
  const damagedHeads = heads.filter(head => !goodStarts.has(head.start))
  const coveredTools = [...good.map(record => String(readBlock(record.entry)!.tool_use_id)), ...damagedHeads.map(head => head.toolId)]
  check(coveredTools.length === byTool.size && new Set(coveredTools).size === coveredTools.length)
  const templates = new Map<string, string[]>()
  const templateKey = (path: string[], value: Obj): string => `${JSON.stringify(path)}\0${JSON.stringify(Object.keys(value).sort())}`
  const collect = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) { for (const item of value) collect(item, [...path, '[]']); return }
    if (value && typeof value === 'object') {
      const v = value as Obj
      const key = templateKey(path, v)
      const order = Object.keys(v)
      const prior = templates.get(key)
      check(!prior || canonical(prior) === canonical(order))
      templates.set(key, order)
      for (const child of order) collect(v[child], [...path, child])
    }
  }
  for (const { entry } of good) { collect(entry.message, ['message']); collect(entry.toolUseResult, ['toolUseResult']) }
  const reorder = (value: unknown, path: string[]): unknown => {
    if (Array.isArray(value)) return value.map(v => reorder(v, [...path, '[]']))
    if (value && typeof value === 'object') {
      const v = value as Obj
      const order = templates.get(templateKey(path, v))
      check(order)
      return Object.fromEntries(order!.map(key => [key, reorder(v[key], [...path, key])]))
    }
    return value
  }
  const records = [...intact, ...good]
  const uuidTimes = new Set<string>()
  for (const head of damagedHeads) {
    const native = byTool.get(head.toolId)!
    const parent = localByUuid.get(head.header.parentUuid)
    check(parent?.type === 'assistant')
    const content = object(parent!.message).content
    check(Array.isArray(content) && content.some(block => {
      const b = object(block); return b.type === 'tool_use' && b.name === 'Read' && b.id === head.toolId
    }))
    const mid = `"uuid":${JSON.stringify(native.uuid)},"timestamp":`
    const middleAt = text.indexOf(mid)
    check(middleAt >= 0 && text.indexOf(mid, middleAt + 1) < 0)
    const time = /^("(?:[^"\\]|\\.)*"),"toolUseResult":/.exec(text.slice(middleAt + mid.length))
    check(time)
    const timestamp = JSON.parse(time![1]!) as unknown
    check(typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) && !uuidTimes.has(timestamp))
    uuidTimes.add(timestamp as string)
    const foot = `"sourceToolAssistantUUID":${JSON.stringify(head.header.parentUuid)}`
    const footerAt = text.indexOf(foot)
    const end = text.indexOf('\n', footerAt)
    check(footerAt >= 0 && end >= 0 && text.indexOf(foot, footerAt + 1) < 0)
    const footerRaw = text.slice(footerAt, end)
    const footer = object(JSON.parse(`{${footerRaw}`))
    check(!['parentUuid', 'isSidechain', 'promptId', 'type', 'message', 'uuid', 'timestamp', 'toolUseResult'].some(key => Object.hasOwn(footer, key)))
    check(footer.sessionId === sid && footer.sourceToolAssistantUUID === head.header.parentUuid)
    const message = reorder(native.message, ['message'])
    const result = reorder(native.tool_use_result, ['toolUseResult'])
    check(canonical(message) === canonical(native.message) && canonical(result) === canonical(native.tool_use_result))
    const body = `${head.headerRaw}"message":${JSON.stringify(message)},${mid}${time![1]},"toolUseResult":${JSON.stringify(result)},${footerRaw}`
    const entry = object(JSON.parse(body))
    check(entry.type === 'user' && entry.uuid === native.uuid && entry.parentUuid === head.header.parentUuid
      && canonical(entry.message) === canonical(message) && canonical(entry.toolUseResult) === canonical(result))
    records.push({ kind: 'read', start: head.start, bytes: Buffer.from(`${body}\n`), entry })
  }
  records.sort((a, b) => a.start - b.start)
  check(records.every(record => record.bytes[record.bytes.length - 1] === 10))
  const partition = provePartition(raw, records)
  const graph = records.filter(r => r.kind !== 'metadata')
  check(graph.every(r => typeof r.entry.uuid === 'string' && typeof r.entry.timestamp === 'string' && Number.isFinite(Date.parse(r.entry.timestamp))))
  check(new Set(graph.map(r => r.entry.uuid)).size === graph.length)
  for (const record of graph) {
    const native = byUuid.get(String(record.entry.uuid))
    if (native) {
      const localMessage = object(record.entry.message)
      const nativeMessage = object(native.message)
      check(record.entry.type === native.type && localMessage.role === nativeMessage.role)
      if (native.type === 'assistant') check(localMessage.id === nativeMessage.id)
      check(canonical(localMessage.content) === canonical(nativeMessage.content))
    }
  }
  // Check the complete original parent graph, including intact non-native
  // branches. The model chain's orphan recovery deliberately tolerates dead
  // branches, so chain length is not a cycle detector.
  const parentIndex = new Map(graph.map(record => [String(record.entry.uuid), record.entry.parentUuid]))
  const completed = new Set<string>()
  for (const id of parentIndex.keys()) {
    const visiting = new Set<string>()
    let at: unknown = id
    while (typeof at === 'string' && parentIndex.has(at) && !completed.has(at)) {
      check(!visiting.has(at), 'CCB_TRANSCRIPT_RESTORE_CYCLE')
      visiting.add(at); at = parentIndex.get(at)
    }
    for (const uuid of visiting) completed.add(uuid)
  }
  graph.sort((a, b) => String(a.entry.timestamp).localeCompare(String(b.entry.timestamp)) || a.start - b.start)
  const graphIndex = new Map(graph.map((record, index) => [record.entry.uuid, index]))
  const isToolResult = (entry: Obj): boolean => {
    const content = object(entry.message).content
    return Array.isArray(content) && content.some(block => block && typeof block === 'object' && !Array.isArray(block) && (block as Obj).type === 'tool_result')
  }
  let previousInput = -1
  let previousNative = -1
  const seenInput = new Map<string, { index: number; digest: string }>()
  for (let t = 0; t < archive.tapes.length; t++) {
    const tape = archive.tapes[t]!
    const needle = tape.canonicalInput.modelText
    check(needle.length > 0)
    const known = seenInput.get(tape.canonicalInput.id)
    if (known) { check(known.digest === tape.canonicalInput.sha256); continue }
    const firstNative = tape.records[0]?.payload.uuid
    let upper = firstNative ? graphIndex.get(firstNative) : undefined
    if (upper === undefined) {
      for (let later = t + 1; later < archive.tapes.length && upper === undefined; later++) {
        const id = archive.tapes[later]!.records[0]?.payload.uuid
        if (id) upper = graphIndex.get(id)
      }
    }
    const lower = Math.max(previousInput, previousNative)
    const found = graph.findIndex((record, index) => {
      const entry = record.entry
      if (index <= lower || index >= (upper ?? graph.length) || entry.type !== 'user' || isToolResult(entry) || entry.isMeta === true) return false
      const content = object(entry.message).content
      const texts = typeof content === 'string' ? [content] : Array.isArray(content)
        ? content.filter(x => x && typeof x === 'object' && !Array.isArray(x) && (x as Obj).type === 'text').map(x => object(x).text).filter((x): x is string => typeof x === 'string') : []
      return texts.some(text => text.includes(needle))
    })
    check(found >= 0)
    previousInput = found
    seenInput.set(tape.canonicalInput.id, { index: found, digest: tape.canonicalInput.sha256 })
    const lastNative = tape.records[tape.records.length - 1]?.payload.uuid
    if (lastNative) { const index = graphIndex.get(lastNative); check(index !== undefined); previousNative = index }
  }

  validateGraph(graph.map(r => r.entry), authority)
  // Retain every metadata record and its original slot/order. Only graph
  // records need their proven chronological order after append interleaving.
  let next = 0
  const bytes = Buffer.concat(records.map(r => r.kind === 'metadata' ? r.bytes : graph[next++]!.bytes))
  check(bytes.length === raw.length)
  return { bytes, sourceSha256: digest(raw), targetSha256: digest(bytes), readCount: byTool.size,
    fragmentCount: partition.fragments, fragmentManifestSha256: partition.sha256, archiveSha256: digest(JSON.stringify(archive)) }
}
