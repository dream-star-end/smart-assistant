import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve, sep } from 'node:path'

import type { UserMediaLocation } from '../agent-sandbox/userMedia.js'

export const KNOWLEDGE_PLANET_MEDIA_MAX_FILE_BYTES = 50 * 1024 * 1024
export const KNOWLEDGE_PLANET_MEDIA_MAX_INVOCATION_BYTES = 200 * 1024 * 1024
const STALE_STAGING_MS = 60 * 60 * 1000
const INPUT_PREFIX = 'invoke-'

export interface KnowledgePlanetSealedMedia {
  path: string
  inputId: string
  filename: string
  sizeBytes: number
  sha256: string
  mimeType: string
  kind: 'image' | 'file'
}

export interface KnowledgePlanetMediaDeps {
  resolveUserMediaDirs: (userId: string) => Promise<UserMediaLocation>
  pullRemoteHostMedia?: (args: {
    hostUuid: string
    remotePath: string
  }) => Promise<Buffer | null>
  stagingRoot: string
  expectedOwnerUid?: number
}

export class KnowledgePlanetMediaError extends Error {
  readonly code = 'MEDIA_INVALID'

  constructor(message = 'Knowledge Planet media is invalid') {
    super(message)
    this.name = 'KnowledgePlanetMediaError'
  }
}

function throwMediaError(error: unknown, message: string): never {
  if (error instanceof KnowledgePlanetMediaError) throw error
  throw new KnowledgePlanetMediaError(message)
}

type UsableLocation =
  | Extract<UserMediaLocation, { kind: 'ok' }>
  | Extract<UserMediaLocation, { reason: 'remote-host' }>

interface HostMediaPath {
  hostPath: string
  baseDir: string
}

function safeBasename(value: string): boolean {
  const forbidden = Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0
    return code <= 0x1f || code === 0x7f || character === '/' || character === '\\'
  })
  return value !== '.' && value !== '..' && Array.from(value).length <= 180 && !forbidden
}

function hostPathFor(loc: UsableLocation, containerPath: string): HostMediaPath {
  const match = /^\/home\/agent\/\.openclaude\/(uploads|generated)\/([^/]+)$/.exec(containerPath)
  if (!match || !safeBasename(match[2]!)) throw new KnowledgePlanetMediaError()
  const baseDir = match[1] === 'uploads' ? loc.uploads : loc.generated
  return { baseDir, hostPath: join(baseDir, match[2]!) }
}

function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size <= 0 || size > KNOWLEDGE_PLANET_MEDIA_MAX_FILE_BYTES)
    throw new KnowledgePlanetMediaError('Knowledge Planet media exceeds the per-file limit')
}

function assertWithinBase(filePath: string, basePath: string): void {
  const file = resolve(filePath)
  const base = resolve(basePath)
  if (file !== base && !file.startsWith(base.endsWith(sep) ? base : `${base}${sep}`))
    throw new KnowledgePlanetMediaError()
}

function sniffImage(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return 'image/jpeg'
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii')))
    return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp'
  return null
}

function fileMime(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() ?? ''
  const known: Record<string, string> = {
    pdf: 'application/pdf',
    txt: 'text/plain',
    md: 'text/markdown',
    csv: 'text/csv',
    json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    zip: 'application/zip',
    gz: 'application/gzip',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
  }
  return known[extension] ?? 'application/octet-stream'
}

async function localMetadata(path: HostMediaPath): Promise<{
  sizeBytes: number
  sha256: string
  header: Buffer
}> {
  const baseStat = await lstat(path.baseDir)
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new KnowledgePlanetMediaError()
  const baseReal = await realpath(path.baseDir)
  const file = await open(path.hostPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new KnowledgePlanetMediaError()
    assertSize(before.size)
    assertWithinBase(await realpath(`/proc/self/fd/${file.fd}`), baseReal)
    const header = Buffer.alloc(Math.min(16, before.size))
    await file.read(header, 0, header.length, 0)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of file.createReadStream({ autoClose: false, start: 0 })) {
      const value = Buffer.from(chunk)
      bytes += value.length
      if (bytes > KNOWLEDGE_PLANET_MEDIA_MAX_FILE_BYTES) throw new KnowledgePlanetMediaError()
      hash.update(value)
    }
    const after = await file.stat()
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new KnowledgePlanetMediaError('Knowledge Planet media changed while being read')
    return { sizeBytes: bytes, sha256: hash.digest('hex'), header }
  } finally {
    await file.close().catch(() => {})
  }
}

async function remoteBytes(
  loc: Extract<UserMediaLocation, { reason: 'remote-host' }>,
  path: HostMediaPath,
  pull: KnowledgePlanetMediaDeps['pullRemoteHostMedia'],
): Promise<Buffer> {
  if (!pull) throw new KnowledgePlanetMediaError('Remote Knowledge Planet media is unavailable')
  const value = await pull({ hostUuid: loc.hostUuid, remotePath: path.hostPath })
  if (!value) throw new KnowledgePlanetMediaError('Knowledge Planet media was not found')
  assertSize(value.length)
  return value
}

async function usableLocation(
  deps: KnowledgePlanetMediaDeps,
  userId: number,
): Promise<UsableLocation> {
  const loc = await deps.resolveUserMediaDirs(`c:${userId}`)
  if (loc.kind === 'ok' || (loc.kind === 'fail' && loc.reason === 'remote-host')) return loc
  throw new KnowledgePlanetMediaError(`Knowledge Planet media is unavailable: ${loc.reason}`)
}

export async function sealKnowledgePlanetMedia(input: {
  userId: number
  items: Array<{ path: string; kind: 'image' | 'file' }>
  deps: KnowledgePlanetMediaDeps
}): Promise<KnowledgePlanetSealedMedia[]> {
  if (input.items.length === 0) return []
  const loc = await usableLocation(input.deps, input.userId)
  const seen = new Set<string>()
  const sealed: KnowledgePlanetSealedMedia[] = []
  let total = 0
  for (const item of input.items) {
    if (seen.has(item.path)) throw new KnowledgePlanetMediaError('Duplicate Knowledge Planet media')
    seen.add(item.path)
    const path = hostPathFor(loc, item.path)
    let sizeBytes: number
    let sha256: string
    let header: Buffer
    if (loc.kind === 'ok') {
      try {
        const metadata = await localMetadata(path)
        ;({ sizeBytes, sha256, header } = metadata)
      } catch (error) {
        throwMediaError(error, 'Knowledge Planet media was not found or is unsafe')
      }
    } else {
      const bytes = await remoteBytes(loc, path, input.deps.pullRemoteHostMedia)
      try {
        sizeBytes = bytes.length
        sha256 = createHash('sha256').update(bytes).digest('hex')
        header = Buffer.from(bytes.subarray(0, 16))
      } finally {
        bytes.fill(0)
      }
    }
    total += sizeBytes
    if (total > KNOWLEDGE_PLANET_MEDIA_MAX_INVOCATION_BYTES)
      throw new KnowledgePlanetMediaError('Knowledge Planet media exceeds the invocation limit')
    const imageMime = sniffImage(header)
    if (item.kind === 'image' && !imageMime)
      throw new KnowledgePlanetMediaError('Knowledge Planet image type is unsupported')
    sealed.push({
      path: item.path,
      inputId: randomUUID(),
      filename: basename(path.hostPath),
      sizeBytes,
      sha256,
      mimeType: item.kind === 'image' ? imageMime! : fileMime(path.hostPath),
      kind: item.kind,
    })
  }
  return sealed
}

async function safeStagingRoot(deps: KnowledgePlanetMediaDeps): Promise<string> {
  if (!isAbsolute(deps.stagingRoot)) throw new KnowledgePlanetMediaError()
  const root = resolve(deps.stagingRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const stat = await lstat(root)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== (deps.expectedOwnerUid ?? 0) ||
    (stat.mode & 0o777) !== 0o700 ||
    (await realpath(root)) !== root
  )
    throw new KnowledgePlanetMediaError('Knowledge Planet staging root is unsafe')
  return root
}

async function gcStaging(root: string, now = Date.now()): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.name.startsWith(INPUT_PREFIX) || !entry.isDirectory() || entry.isSymbolicLink())
      continue
    const path = join(root, entry.name)
    const stat = await lstat(path).catch(() => null)
    if (stat && now - stat.mtimeMs > STALE_STAGING_MS)
      await rm(path, { recursive: true, force: true })
  }
}

async function copyLocal(
  path: HostMediaPath,
  destination: string,
): Promise<{ sizeBytes: number; sha256: string }> {
  const baseStat = await lstat(path.baseDir)
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw new KnowledgePlanetMediaError()
  const baseReal = await realpath(path.baseDir)
  const source = await open(path.hostPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  const target = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400,
  )
  try {
    const before = await source.stat()
    if (!before.isFile()) throw new KnowledgePlanetMediaError()
    assertSize(before.size)
    assertWithinBase(await realpath(`/proc/self/fd/${source.fd}`), baseReal)
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of source.createReadStream({ autoClose: false, start: 0 })) {
      const value = Buffer.from(chunk)
      bytes += value.length
      if (bytes > KNOWLEDGE_PLANET_MEDIA_MAX_FILE_BYTES) throw new KnowledgePlanetMediaError()
      hash.update(value)
      let offset = 0
      while (offset < value.length) {
        const written = await target.write(value, offset, value.length - offset)
        if (written.bytesWritten <= 0) throw new KnowledgePlanetMediaError()
        offset += written.bytesWritten
      }
    }
    await target.sync()
    const after = await source.stat()
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new KnowledgePlanetMediaError('Knowledge Planet media changed while being staged')
    return { sizeBytes: bytes, sha256: hash.digest('hex') }
  } finally {
    await Promise.all([source.close().catch(() => {}), target.close().catch(() => {})])
  }
}

export async function stageKnowledgePlanetMedia(input: {
  userId: number
  manifest: readonly KnowledgePlanetSealedMedia[]
  deps: KnowledgePlanetMediaDeps
}): Promise<{ directory: string; cleanup: () => Promise<void> } | null> {
  if (input.manifest.length === 0) return null
  const root = await safeStagingRoot(input.deps)
  await gcStaging(root)
  const directory = await mkdtemp(join(root, INPUT_PREFIX))
  const loc = await usableLocation(input.deps, input.userId)
  let total = 0
  try {
    for (const item of input.manifest) {
      if (!/^[A-Za-z0-9-]{1,64}$/.test(item.inputId)) throw new KnowledgePlanetMediaError()
      const path = hostPathFor(loc, item.path)
      const destination = join(directory, item.inputId)
      let observed: { sizeBytes: number; sha256: string }
      if (loc.kind === 'ok') {
        try {
          observed = await copyLocal(path, destination)
        } catch (error) {
          throwMediaError(error, 'Knowledge Planet media was not found or is unsafe')
        }
      } else {
        const bytes = await remoteBytes(loc, path, input.deps.pullRemoteHostMedia)
        try {
          const file = await open(
            destination,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o400,
          )
          try {
            await file.writeFile(bytes)
            await file.sync()
          } finally {
            await file.close()
          }
          observed = {
            sizeBytes: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          }
        } finally {
          bytes.fill(0)
        }
      }
      if (observed.sizeBytes !== item.sizeBytes || observed.sha256 !== item.sha256)
        throw new KnowledgePlanetMediaError('Knowledge Planet media changed after confirmation')
      total += observed.sizeBytes
      if (total > KNOWLEDGE_PLANET_MEDIA_MAX_INVOCATION_BYTES)
        throw new KnowledgePlanetMediaError('Knowledge Planet media exceeds the invocation limit')
      await chmod(destination, 0o444)
    }
    await chmod(directory, 0o555)
    return {
      directory,
      cleanup: async () => {
        await chmod(directory, 0o700).catch(() => {})
        await rm(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await chmod(directory, 0o700).catch(() => {})
    await rm(directory, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
