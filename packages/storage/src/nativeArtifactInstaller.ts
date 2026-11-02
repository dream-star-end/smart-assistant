/** Installs operation-bound native tool output before the real JSONL mutation.
 * Source transport authentication and the target binding belong to the caller;
 * no sender-supplied absolute paths, URLs, or lease booleans are accepted. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { remoteCanonical, requireRemote, validateRemote } from '@openclaude/protocol/agentRemote'
import { type NativeArtifact, NativeArtifactSchema } from '@openclaude/protocol/agentRemoteNative'
import { nativeToolArtifactPathAllowed } from '@openclaude/protocol/agentRemoteState'
import { assertNativeWriterLock } from './nativeWriterLock.js'
import {
  type SessionFileLeaseCapability,
  assertSessionFileAlias,
  assertSessionFileLease,
} from './sessionFileIo.js'

export interface NativeArtifactInstall {
  /** Resolved from the authenticated Worker binding, never the incoming frame. */
  readonly sessionDirectory: string
  readonly nativeSessionId: string
  readonly nativeWriterLockPath: string
  readonly operationId: string
  /** Trusted synchronous Writer fence; never a function received from JSON. */
  readonly assertCurrentBinding?: () => undefined
  readonly artifacts: readonly NativeArtifact[]
  /** Authenticated bytes for this operation/descriptor; large files are streamed. */
  readonly openSource: (artifact: Readonly<NativeArtifact>) => AsyncIterable<Uint8Array>
}
export function nativeArtifactManifestHash(artifacts: readonly NativeArtifact[]): string {
  return createHash('sha256')
    .update(
      `agent-remote-native-artifacts-v1\n${remoteCanonical([...artifacts].sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)))}`,
    )
    .digest('hex')
}
const active = new Set<string>()
function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await file.sync()
  } finally {
    await file.close()
  }
}
async function directory(path: string, privateMode = false): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await lstat(path)
  requireRemote(
    stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & (privateMode ? 0o077 : 0o022)) === 0 &&
      (await realpath(path)) === path,
    'native-artifact-directory',
  )
  // Retrying an existing directory must finish a predecessor's interrupted mkdir.
  await syncDirectory(path)
  await syncDirectory(dirname(path))
}
async function writeAll(file: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset)
    requireRemote(bytesWritten > 0, 'native-artifact-short-write')
    offset += bytesWritten
  }
}
async function verifyInstalled(path: string, artifact: NativeArtifact): Promise<void> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const initial = await file.stat()
    requireRemote(
      initial.isFile() &&
        initial.nlink === 1 &&
        initial.uid === process.getuid?.() &&
        (initial.mode & 0o022) === 0 &&
        initial.size === artifact.sizeBytes,
      'native-artifact-file',
    )
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(131072)
    let size = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, size)
      if (!bytesRead) break
      size += bytesRead
      requireRemote(size <= artifact.sizeBytes, 'native-artifact-size')
      hash.update(buffer.subarray(0, bytesRead))
    }
    const final = await file.stat()
    const named = await lstat(path)
    requireRemote(
      size === artifact.sizeBytes &&
        hash.digest('hex') === artifact.sha256 &&
        initial.dev === final.dev &&
        initial.ino === final.ino &&
        initial.size === final.size &&
        initial.mtimeMs === final.mtimeMs &&
        initial.ctimeMs === final.ctimeMs &&
        !named.isSymbolicLink() &&
        named.dev === final.dev &&
        named.ino === final.ino,
      'native-artifact-conflict',
    )
    // A preceding process may have linked the file and crashed before syncing.
    await file.sync()
  } finally {
    await file.close()
  }
  await syncDirectory(dirname(path))
}
export async function installNativeArtifacts(
  capability: SessionFileLeaseCapability,
  options: NativeArtifactInstall,
): Promise<{ artifactManifestHash: string }> {
  const identity = assertSessionFileLease(capability)
  const sessionId = options.nativeSessionId
  const sessionDirectory = options.sessionDirectory
  const writerLockPath = options.nativeWriterLockPath
  const operationId = options.operationId
  const openSource = options.openSource
  const assertCurrentBinding = options.assertCurrentBinding
  requireRemote(
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sessionId) &&
      identity.sessionId === sessionId,
    'native-artifact-session',
  )
  const subpath = relative(identity.projectsDir, sessionDirectory).split('/')
  requireRemote(
    resolve(sessionDirectory) === sessionDirectory &&
      subpath.length === 2 &&
      /^[A-Za-z0-9_-]+$/.test(subpath[0]!) &&
      subpath[1] === sessionId,
    'native-artifact-target',
  )
  const main = join(dirname(sessionDirectory), `${sessionId}.jsonl`)
  const actual = relative(identity.projectsDir, identity.filePath).split('/')
  const isMain = actual.length === 2 && actual[1] === `${sessionId}.jsonl`
  const isSidechain =
    actual.length === 4 &&
    actual[1] === sessionId &&
    actual[2] === 'subagents' &&
    /^agent-a(?:[A-Za-z0-9_-]{1,96}-)?[a-f0-9]{16}\.jsonl$/.test(actual[3]!)
  requireRemote(
    /^[A-Za-z0-9_-]+$/.test(actual[0]!) && (isMain || isSidechain),
    'native-artifact-transcript-scope',
  )
  const boundTranscript = isMain ? main : join(sessionDirectory, 'subagents', actual[3]!)
  requireRemote(
    resolve(writerLockPath) === writerLockPath &&
      basename(writerLockPath) === `${sessionId}.lock` &&
      /^[A-Za-z0-9_.:-]{1,160}$/.test(operationId),
    'native-artifact-binding',
  )
  const assertLive = () => {
    requireRemote(assertCurrentBinding?.() === undefined, 'native-artifact-binding-guard')
    assertSessionFileLease(capability)
    assertNativeWriterLock(writerLockPath)
  }
  assertLive()
  requireRemote(options.artifacts.length <= 2048, 'native-artifact-manifest-bound')
  const artifacts = options.artifacts.map((artifact) => {
    validateRemote<NativeArtifact>(NativeArtifactSchema, artifact)
    requireRemote(
      artifact.nativeSessionId === sessionId &&
        nativeToolArtifactPathAllowed(artifact.relativePath),
      'native-artifact-path',
    )
    return Object.freeze({ ...artifact })
  })
  requireRemote(
    new Set(artifacts.map((artifact) => artifact.relativePath)).size === artifacts.length,
    'native-artifact-duplicate',
  )
  if (!artifacts.length) {
    if (identity.filePath !== boundTranscript)
      await assertSessionFileAlias(capability, boundTranscript)
    assertLive()
    return { artifactManifestHash: nativeArtifactManifestHash(artifacts) }
  }
  const key = `${sessionDirectory}\n${operationId}`
  requireRemote(!active.has(key), 'native-artifact-concurrent-install')
  active.add(key)
  try {
    await directory(identity.projectsDir)
    await directory(dirname(sessionDirectory))
    await directory(sessionDirectory)
    if (identity.filePath !== boundTranscript)
      await assertSessionFileAlias(capability, boundTranscript)
    await directory(identity.stagingDirectory, true)
    const directories = new Set<string>()
    for (const artifact of artifacts) {
      assertLive()
      const target = join(sessionDirectory, artifact.relativePath)
      let parent = sessionDirectory
      for (const component of artifact.relativePath.split('/').slice(0, -1)) {
        parent = join(parent, component)
        if (!directories.has(parent)) {
          await directory(parent)
          directories.add(parent)
        }
      }
      const name = createHash('sha256')
        .update(`${operationId}\n${artifact.relativePath}`)
        .digest('hex')
      const stage = join(identity.stagingDirectory, `${name}.stage`)
      // Recover the exact link-before-unlink crash window. Only this operation's
      // private stage may be removed, and a second link must be this target inode.
      try {
        const stale = await lstat(stage)
        requireRemote(
          stale.isFile() &&
            !stale.isSymbolicLink() &&
            stale.uid === process.getuid?.() &&
            (stale.mode & 0o777) === 0o600,
          'native-artifact-stage',
        )
        if (stale.nlink !== 1) {
          const named = await lstat(target)
          requireRemote(
            stale.nlink === 2 &&
              named.isFile() &&
              !named.isSymbolicLink() &&
              stale.dev === named.dev &&
              stale.ino === named.ino,
            'native-artifact-stage-links',
          )
        }
        assertLive()
        await unlink(stage)
        await syncDirectory(identity.stagingDirectory)
      } catch (error) {
        if (!missing(error)) throw error
      }
      try {
        await lstat(target)
        await verifyInstalled(target, artifact)
        continue
      } catch (error) {
        if (!missing(error)) throw error
      }
      const file = await open(
        stage,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        const hash = createHash('sha256')
        let size = 0
        for await (const value of openSource(artifact)) {
          assertSessionFileLease(capability)
          requireRemote(value instanceof Uint8Array, 'native-artifact-chunk')
          const bytes = Buffer.from(value)
          size += bytes.byteLength
          requireRemote(
            Number.isSafeInteger(size) && size <= artifact.sizeBytes,
            'native-artifact-size',
          )
          hash.update(bytes)
          await writeAll(file, bytes)
        }
        requireRemote(
          size === artifact.sizeBytes && hash.digest('hex') === artifact.sha256,
          'native-artifact-content',
        )
        await file.sync()
      } finally {
        await file.close()
      }
      try {
        assertLive()
        try {
          await link(stage, target)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      } finally {
        await unlink(stage)
        await syncDirectory(identity.stagingDirectory)
      }
      await verifyInstalled(target, artifact)
    }
    assertLive()
    return { artifactManifestHash: nativeArtifactManifestHash(artifacts) }
  } finally {
    active.delete(key)
  }
}

/** Readback only: the actual Writer derives these paths from its native session,
 * holds that UUID flock and all transcript group locks through the final commit. */
export async function verifyNativeArtifactSet(options: {
  readonly projectsDirectory: string
  readonly sessionDirectory: string
  readonly nativeSessionId: string
  readonly nativeWriterLockPath: string
  readonly artifacts: readonly NativeArtifact[]
}): Promise<{ artifactManifestHash: string }> {
  const { projectsDirectory, sessionDirectory, nativeSessionId, nativeWriterLockPath } = options
  const parts = relative(projectsDirectory, sessionDirectory).split('/')
  requireRemote(
    resolve(projectsDirectory) === projectsDirectory &&
      resolve(sessionDirectory) === sessionDirectory &&
      parts.length === 2 &&
      /^[A-Za-z0-9_-]+$/.test(parts[0]!) &&
      parts[1] === nativeSessionId &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(nativeSessionId) &&
      resolve(nativeWriterLockPath) === nativeWriterLockPath &&
      basename(nativeWriterLockPath) === `${nativeSessionId}.lock`,
    'native-artifact-binding',
  )
  const artifacts = options.artifacts.map((artifact) => {
    validateRemote<NativeArtifact>(NativeArtifactSchema, artifact)
    requireRemote(
      artifact.nativeSessionId === nativeSessionId &&
        nativeToolArtifactPathAllowed(artifact.relativePath),
      'native-artifact-path',
    )
    return Object.freeze({ ...artifact })
  })
  requireRemote(
    new Set(artifacts.map((artifact) => artifact.relativePath)).size === artifacts.length,
    'native-artifact-duplicate',
  )
  const seen = new Set<string>()
  const inspect = async (path: string) => {
    if (seen.has(path)) return
    const stat = await lstat(path)
    requireRemote(
      stat.isDirectory() &&
        !stat.isSymbolicLink() &&
        stat.uid === process.getuid?.() &&
        (stat.mode & 0o022) === 0 &&
        (await realpath(path)) === path,
      'native-artifact-directory',
    )
    seen.add(path)
  }
  assertNativeWriterLock(nativeWriterLockPath)
  if (artifacts.length) {
    await inspect(projectsDirectory)
    await inspect(dirname(sessionDirectory))
    await inspect(sessionDirectory)
  }
  for (const artifact of artifacts) {
    assertNativeWriterLock(nativeWriterLockPath)
    let parent = sessionDirectory
    for (const component of artifact.relativePath.split('/').slice(0, -1)) {
      parent = join(parent, component)
      await inspect(parent)
    }
    await verifyInstalled(join(sessionDirectory, artifact.relativePath), artifact)
  }
  assertNativeWriterLock(nativeWriterLockPath)
  return { artifactManifestHash: nativeArtifactManifestHash(artifacts) }
}
