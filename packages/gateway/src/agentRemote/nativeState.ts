import { createHash, randomUUID } from 'node:crypto'
/** Linux native-session checkpoint operations. Call under flock --no-fork.
 * Only session-owned transcript files are copied; credentials/config are excluded.
 */
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { remoteCanonical, requireRemote, validateRemote } from '@openclaude/protocol/agentRemote'
import {
  type NativeCheckpoint,
  type NativeCheckpointIdentity,
  NativeCheckpointIdentitySchema,
  checkpointMatchesIdentity,
  nativeCheckpointId,
  nativeSessionPathAllowed,
  verifyNativeCheckpoint,
} from '@openclaude/protocol/agentRemoteState'

type Fingerprint = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }
const sameFile = (a: Fingerprint, b: Fingerprint) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs
function fingerprint(path: string): Fingerprint {
  return lstatSync(path, { bigint: true })
}
function syncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}
function privateRoot(path: string): void {
  requireRemote(isAbsolute(path), 'native-root-absolute')
  const created = mkdirSync(path, { recursive: true, mode: 0o700 })
  if (created) {
    let current = path
    while (true) {
      syncDirectory(current)
      if (current === dirname(created)) break
      current = dirname(current)
    }
  }
  const stat = lstatSync(path)
  requireRemote(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      realpathSync(path) === path &&
      (stat.mode & 0o077) === 0,
    'native-root-private',
  )
}
function pathStat(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
function safePath(root: string, name: string, createParents = false): string {
  const target = join(root, name)
  requireRemote(
    relative(root, target) === name &&
      !name.includes('\\') &&
      !name.split('/').some((part) => !part || part === '.' || part === '..'),
    'native-relative-path',
  )
  let current = root
  const parts = name.split('/')
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    if (createParents && !pathStat(current)) {
      mkdirSync(current, { mode: 0o700 })
      syncDirectory(current)
      syncDirectory(dirname(current))
    }
    requireRemote(
      lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(),
      'native-path-symlink',
    )
  }
  if (pathStat(target))
    requireRemote(
      lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(),
      'native-path-symlink',
    )
  return target
}
function hashFile(path: string): { sha256: string; sizeBytes: number } {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(131072)
  let sizeBytes = 0
  try {
    let bytes: number
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes))
      sizeBytes += bytes
    }
  } finally {
    closeSync(descriptor)
  }
  return { sha256: hash.digest('hex'), sizeBytes }
}
/** The actual Node process must own the exclusive flock (not a TTL or JSON claim). */
export function assertNativeWriterLock(path: string): void {
  requireRemote(process.platform === 'linux', 'native-lock-platform')
  const stat = lstatSync(path, { bigint: true })
  requireRemote(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n, 'native-lock-file')
  const major = ((stat.dev & 0xfff00n) >> 8n) | ((stat.dev & 0xfffff00000000000n) >> 32n)
  const minor = (stat.dev & 0xffn) | ((stat.dev & 0xffffff00000n) >> 12n)
  const held = readFileSync('/proc/locks', 'utf8')
    .split('\n')
    .some((line) => {
      const fields = line.trim().split(/\s+/)
      if (fields[1] !== 'FLOCK' || fields[3] !== 'WRITE' || Number(fields[4]) !== process.pid)
        return false
      const identity = fields[5]?.split(':')
      return (
        identity?.length === 3 &&
        BigInt(`0x${identity[0]}`) === major &&
        BigInt(`0x${identity[1]}`) === minor &&
        identity[2] === String(stat.ino)
      )
    })
  requireRemote(held, 'native-lock-not-held')
}
function verifyTranscript(path: string, identity: NativeCheckpointIdentity, head: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const buffer = Buffer.alloc(65536)
  let pending = ''
  let lastUuid = ''
  let records = 0
  try {
    let bytes: number
    while ((bytes = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      pending += decoder.decode(buffer.subarray(0, bytes), { stream: true })
      requireRemote(Buffer.byteLength(pending, 'utf8') <= 64 * 1024 * 1024, 'native-line-bound')
      let boundary: number
      while ((boundary = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, boundary)
        pending = pending.slice(boundary + 1)
        if (!line.trim()) continue
        const value = JSON.parse(line)
        requireRemote(
          value && typeof value === 'object' && !Array.isArray(value),
          'native-transcript-shape',
        )
        if (value.sessionId !== undefined)
          requireRemote(value.sessionId === identity.nativeSessionId, 'native-session-mismatch')
        if (typeof value.uuid === 'string') lastUuid = value.uuid
        records++
      }
    }
    pending += decoder.decode()
    requireRemote(!pending.trim() && records > 0 && lastUuid === head, 'native-boundary-mismatch')
  } finally {
    closeSync(descriptor)
  }
}
export interface NativeCheckpointRequest {
  identity: NativeCheckpointIdentity
  bindingRevision: number
  authority: NativeCheckpoint['authority']
  transcriptRelativePath: string
  createdAtMs: number
}
export class NativeStateRepository {
  constructor(
    readonly options: {
      nativeRoot: string
      stateRoot: string
      maxSnapshotBytes?: number
      /** Tests inject interruption/append here. No wire/env configuration accepts it. */
      beforePublish?: () => void
    },
  ) {
    privateRoot(options.nativeRoot)
    privateRoot(options.stateRoot)
    privateRoot(join(options.stateRoot, 'objects'))
    privateRoot(join(options.stateRoot, 'staging'))
    privateRoot(join(options.stateRoot, 'locks'))
  }
  private sessionKey(identity: NativeCheckpointIdentity): string {
    validateRemote<NativeCheckpointIdentity>(NativeCheckpointIdentitySchema, identity)
    // stateRoot is the shared supervisor-owned root for this native volume.
    // Business aliases must use the SAME physical writer lock and restore marker.
    return identity.nativeSessionId
  }
  lockPath(identity: NativeCheckpointIdentity): string {
    return join(this.options.stateRoot, 'locks', `${this.sessionKey(identity)}.lock`)
  }
  markerPath(identity: NativeCheckpointIdentity): string {
    return join(this.options.stateRoot, `restore-${this.sessionKey(identity)}.json`)
  }
  /** Trusted supervisor creates once, then mounts locks read-only to the Worker.
   * Never replace/unlink a lock inode, even after its last writer exits.
   */
  prepareLock(identity: NativeCheckpointIdentity): string {
    const path = this.lockPath(identity)
    try {
      const descriptor = openSync(
        path,
        constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      syncDirectory(dirname(path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    requireRemote(
      lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && statSync(path).nlink === 1,
      'native-lock-file',
    )
    return path
  }
  /** Trusted checkpoint/restore task, never a user-controlled executable/RPC. */
  stateTaskCommand(identity: NativeCheckpointIdentity, executable: string, args: string[]) {
    return {
      executable: '/usr/bin/flock',
      args: ['--nonblock', '--no-fork', this.prepareLock(identity), executable, ...args],
    }
  }
  /** Static shell, data in positional args; exec preserves flock FD in the real writer. */
  writerCommand(
    identity: NativeCheckpointIdentity,
    executable: string,
    args: string[],
  ): { executable: string; args: string[] } {
    return {
      executable: '/usr/bin/flock',
      args: [
        '--nonblock',
        '--no-fork',
        this.prepareLock(identity),
        '/bin/sh',
        '-c',
        'if [ -e "$1" ] || [ -L "$1" ]; then exit 73; fi; shift; exec "$@"',
        'agent-remote-native',
        this.markerPath(identity),
        executable,
        ...args,
      ],
    }
  }
  private filesFor(request: NativeCheckpointRequest): string[] {
    const { nativeRoot } = this.options
    requireRemote(
      nativeSessionPathAllowed(request.transcriptRelativePath, request.identity.nativeSessionId) &&
        request.transcriptRelativePath.endsWith(`${request.identity.nativeSessionId}.jsonl`),
      'checkpoint-path',
    )
    safePath(nativeRoot, request.transcriptRelativePath)
    const selectedProject = request.transcriptRelativePath.split('/')[1]
    for (const project of readdirSync(join(nativeRoot, 'projects'), { withFileTypes: true })) {
      if (project.name === selectedProject) continue
      requireRemote(!project.isSymbolicLink(), 'native-path-symlink')
      if (project.isDirectory())
        requireRemote(
          !pathStat(
            join(nativeRoot, 'projects', project.name, `${request.identity.nativeSessionId}.jsonl`),
          ),
          'native-project-alias',
        )
    }
    const files = [request.transcriptRelativePath]
    const sessionDirectory = request.transcriptRelativePath.slice(0, -'.jsonl'.length)
    const directory = join(nativeRoot, sessionDirectory)
    if (pathStat(directory)) {
      requireRemote(
        lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
        'native-path-symlink',
      )
      const walk = (prefix: string) => {
        for (const entry of readdirSync(join(nativeRoot, prefix), { withFileTypes: true })) {
          const name = `${prefix}/${entry.name}`
          requireRemote(
            !entry.isSymbolicLink() &&
              nativeSessionPathAllowed(
                name,
                request.identity.nativeSessionId,
                entry.isDirectory() ? 'directory' : 'file',
              ),
            'checkpoint-path',
          )
          if (entry.isDirectory()) walk(name)
          else {
            requireRemote(entry.isFile(), 'native-file-kind')
            files.push(name)
          }
        }
      }
      walk(sessionDirectory)
    }
    requireRemote(files.length <= 2048, 'native-file-count')
    return files.sort()
  }
  async checkpoint(
    request: NativeCheckpointRequest,
    publish: (manifest: NativeCheckpoint) => Promise<unknown>,
  ): Promise<NativeCheckpoint> {
    const lock = this.prepareLock(request.identity)
    assertNativeWriterLock(lock)
    requireRemote(!pathStat(this.markerPath(request.identity)), 'native-restore-incomplete')
    const names = this.filesFor(request)
    const fingerprints = new Map<string, Fingerprint>()
    const staging = join(this.options.stateRoot, 'staging', randomUUID())
    mkdirSync(staging, { mode: 0o700 })
    let renamed = false
    try {
      let total = 0
      const files: NativeCheckpoint['files'] = []
      for (const name of names) {
        const source = safePath(this.options.nativeRoot, name)
        const before = fingerprint(source)
        total += Number(before.size)
        requireRemote(
          total <= (this.options.maxSnapshotBytes ?? 1024 * 1024 * 1024),
          'native-snapshot-quota',
        )
        fingerprints.set(name, before)
        const destination = safePath(staging, name, true)
        const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
        const output = openSync(
          destination,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o400,
        )
        const hash = createHash('sha256')
        const buffer = Buffer.alloc(131072)
        let sizeBytes = 0
        try {
          requireRemote(
            sameFile(before, fstatSync(input, { bigint: true })),
            'native-source-changed',
          )
          let bytes: number
          while ((bytes = readSync(input, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, bytes))
            sizeBytes += bytes
            let offset = 0
            while (offset < bytes) offset += writeSync(output, buffer, offset, bytes - offset)
          }
          fsyncSync(output)
          requireRemote(
            BigInt(sizeBytes) === before.size &&
              sameFile(before, fstatSync(input, { bigint: true })),
            'native-source-changed',
          )
        } finally {
          closeSync(input)
          closeSync(output)
        }
        files.push({ relativePath: name, sizeBytes, sha256: hash.digest('hex') })
      }
      verifyTranscript(
        safePath(staging, request.transcriptRelativePath),
        request.identity,
        request.authority.nativeHeadUuid,
      )
      const semantic: Omit<NativeCheckpoint, 'checkpointId'> = {
        schemaVersion: 1,
        ...request.identity,
        bindingRevision: request.bindingRevision,
        authority: request.authority,
        createdAtMs: request.createdAtMs,
        transcriptRelativePath: request.transcriptRelativePath,
        files,
      }
      const manifest: NativeCheckpoint = { ...semantic, checkpointId: nativeCheckpointId(semantic) }
      verifyNativeCheckpoint(manifest)
      const manifestPath = join(staging, 'manifest.json')
      writeFileSync(manifestPath, `${remoteCanonical(manifest)}\n`, { flag: 'wx', mode: 0o400 })
      const descriptor = openSync(manifestPath, constants.O_RDONLY)
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      const directories = new Set<string>([staging])
      for (const name of names) {
        let current = dirname(join(staging, name))
        while (current.startsWith(staging)) {
          directories.add(current)
          if (current === staging) break
          current = dirname(current)
        }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length))
        syncDirectory(directory)
      this.options.beforePublish?.()
      requireRemote(
        remoteCanonical(this.filesFor(request)) === remoteCanonical(names),
        'native-source-changed',
      )
      for (const [name, before] of fingerprints)
        requireRemote(
          sameFile(before, fingerprint(safePath(this.options.nativeRoot, name))),
          'native-source-changed',
        )
      assertNativeWriterLock(lock)
      const target = join(this.options.stateRoot, 'objects', manifest.checkpointId)
      if (existsSync(target)) {
        this.read(manifest.checkpointId, request.identity)
        rmSync(staging, { recursive: true })
      } else {
        renameSync(staging, target)
        syncDirectory(dirname(target))
        syncDirectory(join(this.options.stateRoot, 'staging'))
      }
      renamed = true
      // Pointer only becomes visible after all immutable content is fsynced.
      await publish(structuredClone(manifest))
      assertNativeWriterLock(lock)
      return manifest
    } finally {
      if (!renamed && existsSync(staging)) rmSync(staging, { recursive: true })
    }
  }
  read(checkpointId: string, expected: NativeCheckpointIdentity): NativeCheckpoint {
    requireRemote(/^[a-f0-9]{64}$/.test(checkpointId), 'checkpoint-id')
    const object = join(this.options.stateRoot, 'objects', checkpointId)
    requireRemote(
      lstatSync(object).isDirectory() && !lstatSync(object).isSymbolicLink(),
      'checkpoint-object',
    )
    const manifestPath = safePath(object, 'manifest.json')
    const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    verifyNativeCheckpoint(manifest)
    checkpointMatchesIdentity(manifest, expected)
    requireRemote(manifest.checkpointId === checkpointId, 'checkpoint-id')
    for (const file of manifest.files) {
      const actual = hashFile(safePath(object, file.relativePath))
      requireRemote(
        actual.sha256 === file.sha256 && actual.sizeBytes === file.sizeBytes,
        'checkpoint-file-corrupt',
      )
    }
    verifyTranscript(
      safePath(object, manifest.transcriptRelativePath),
      expected,
      manifest.authority.nativeHeadUuid,
    )
    return manifest
  }
  /** Restore requires a lock and an explicit existing-authority pointer. The marker
   * blocks a new Writer after interruption until the same restore completes.
   */
  async restore(
    checkpointId: string,
    expected: NativeCheckpointIdentity,
    committed: (manifest: NativeCheckpoint) => Promise<unknown>,
  ): Promise<NativeCheckpoint> {
    const lock = this.prepareLock(expected)
    assertNativeWriterLock(lock)
    const manifest = this.read(checkpointId, expected)
    const marker = this.markerPath(expected)
    const markerStat = pathStat(marker)
    if (markerStat) {
      requireRemote(markerStat.isFile() && !markerStat.isSymbolicLink(), 'native-restore-marker')
      requireRemote(
        JSON.parse(readFileSync(marker, 'utf8')).checkpointId === checkpointId,
        'native-restore-conflict',
      )
    } else {
      writeFileSync(marker, remoteCanonical({ checkpointId }), { flag: 'wx', mode: 0o600 })
      const descriptor = openSync(marker, constants.O_RDONLY)
      try {
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      syncDirectory(dirname(marker))
    }
    const object = join(this.options.stateRoot, 'objects', checkpointId)
    for (const file of manifest.files) {
      const target = safePath(this.options.nativeRoot, file.relativePath, true)
      if (existsSync(target)) {
        const actual = hashFile(target)
        requireRemote(
          actual.sha256 === file.sha256 && actual.sizeBytes === file.sizeBytes,
          'native-state-conflict',
        )
        continue
      }
      // Only this component's crash leftovers for a listed target may be removed,
      // under the durable restore marker and the same physical writer lock.
      for (const name of readdirSync(dirname(target))) {
        const prefix = `${file.relativePath.split('/').at(-1)}.agent-remote-`
        if (name.startsWith(prefix) && /^[a-f0-9-]{36}$/.test(name.slice(prefix.length))) {
          const orphan = join(dirname(target), name)
          const stat = lstatSync(orphan)
          requireRemote(stat.isFile() && !stat.isSymbolicLink(), 'native-restore-orphan')
          unlinkSync(orphan)
          syncDirectory(dirname(orphan))
        }
      }
      const temporary = `${target}.agent-remote-${randomUUID()}`
      const input = openSync(
        safePath(object, file.relativePath),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      )
      const output = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      const buffer = Buffer.alloc(131072)
      try {
        let bytes: number
        while ((bytes = readSync(input, buffer, 0, buffer.length, null)) > 0) {
          let offset = 0
          while (offset < bytes) offset += writeSync(output, buffer, offset, bytes - offset)
        }
        fsyncSync(output)
      } finally {
        closeSync(input)
        closeSync(output)
      }
      requireRemote(!pathStat(target), 'native-state-conflict')
      renameSync(temporary, target)
      syncDirectory(dirname(target))
    }
    const actualNames = this.filesFor({
      identity: expected,
      bindingRevision: manifest.bindingRevision,
      authority: manifest.authority,
      transcriptRelativePath: manifest.transcriptRelativePath,
      createdAtMs: manifest.createdAtMs,
    })
    requireRemote(
      remoteCanonical(actualNames) ===
        remoteCanonical(manifest.files.map((file) => file.relativePath)),
      'native-state-extra-files',
    )
    for (const file of manifest.files) {
      const actual = hashFile(safePath(this.options.nativeRoot, file.relativePath))
      requireRemote(
        actual.sha256 === file.sha256 && actual.sizeBytes === file.sizeBytes,
        'native-state-conflict',
      )
    }
    verifyTranscript(
      safePath(this.options.nativeRoot, manifest.transcriptRelativePath),
      expected,
      manifest.authority.nativeHeadUuid,
    )
    assertNativeWriterLock(lock)
    await committed(structuredClone(manifest))
    assertNativeWriterLock(lock)
    unlinkSync(marker)
    syncDirectory(dirname(marker))
    return manifest
  }
}
