/**
 * Container-side workspace inspect collection (git snapshot + single-level list-dir).
 * HTTP wiring lives in server.ts. This module has no host-process I/O besides the
 * injected snapshot provider.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { opendir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve as pathResolve } from 'node:path'
import {
  getSessionReposRoot,
  isValidSessionRepoId,
  type RepoSnapshot,
} from './sessionRepoWorkspace.js'
import {
  WORKSPACE_INSPECT_GIT_TIMEOUT_MS,
  WORKSPACE_INSPECT_LIST_TIMEOUT_MS,
  WORKSPACE_INSPECT_MAX_GIT_ENTRIES,
  WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES,
  WORKSPACE_INSPECT_MAX_JSON_BYTES,
  WORKSPACE_INSPECT_MAX_LIST_ENTRIES,
  WORKSPACE_INSPECT_MAX_PATH_DEPTH,
  WORKSPACE_INSPECT_PROCESS_CONCURRENCY,
  WORKSPACE_INSPECT_SKIP_NAMES,
  type WorkspaceInspectEmptyReason,
  type WorkspaceInspectErrorCode,
  type WorkspaceInspectGitEntry,
  type WorkspaceInspectGitSnapshot,
  type WorkspaceInspectGitStatus,
  type WorkspaceInspectListDirBody,
  type WorkspaceInspectListEntry,
  type WorkspaceInspectSkipReason,
  type WorkspaceInspectTruncationReason,
} from '@openclaude/protocol'

export const DEFAULT_REPOS_ROOT = getSessionReposRoot()
const MAX_REL_LEN = 4096
const SHA_RE = /^[0-9a-f]{40}$/
const VCS_NAMES = new Set(['.git', '.svn', '.hg'])
const VENDOR_NAMES = new Set<string>(WORKSPACE_INSPECT_SKIP_NAMES.filter((n) => !VCS_NAMES.has(n)))

const OPEN_DIR_FLAGS =
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW

export type InspectFileAcl = {
  isFileAllowed: (resolvedPath: string) => boolean
  isFileBlocked: (resolvedPath: string) => boolean
}

export type InspectLogger = {
  warn: (msg: string, fields?: Record<string, unknown>) => void
  info: (msg: string, fields?: Record<string, unknown>) => void
}

export type WorkspaceInspectRuntime = {
  getRepoSnapshot: (sessionId: string) => RepoSnapshot | null
  reposRoot?: string
  acl: InspectFileAcl
  log?: InspectLogger
}

export type InspectOkGit = { kind: 'ok'; status: 200; body: { ok: true; empty: false; snapshot: WorkspaceInspectGitSnapshot } }
export type InspectOkList = { kind: 'ok'; status: 200; body: WorkspaceInspectListDirBody }
export type InspectEmpty = {
  kind: 'empty'
  status: 200
  body: { ok: true; empty: true; reason: WorkspaceInspectEmptyReason; snapshot: null }
}
export type InspectErr = {
  kind: 'error'
  status: number
  body: { ok: false; error: { code: WorkspaceInspectErrorCode; message: string } }
}
export type InspectResult = InspectOkGit | InspectOkList | InspectEmpty | InspectErr

type WorkspaceIdentity = {
  selectionVersion: number
  workspaceDir: string
  dev: number | bigint
  ino: number | bigint
}

const noopLog: InspectLogger = { warn() {}, info() {} }

/** Exact path-segment `.git` (POSIX resolve, no symlink follow). `foo.git` is false. */
export function hasGitPathSegment(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  const lexical = pathResolve(p)
  for (const candidate of [p, lexical]) {
    for (const seg of candidate.split('/')) {
      if (seg === '.git') return true
    }
  }
  return false
}

export function isLinuxFdAnchorAvailable(): boolean {
  return process.platform === 'linux' && existsSync('/proc/self/fd')
}

function err(
  status: number,
  code: WorkspaceInspectErrorCode,
  message: string,
): InspectErr {
  return { kind: 'error', status, body: { ok: false, error: { code, message } } }
}

function empty(reason: WorkspaceInspectEmptyReason): InspectEmpty {
  return { kind: 'empty', status: 200, body: { ok: true, empty: true, reason, snapshot: null } }
}

const BIDI_AND_ISOLATE = new Set([
  0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
])

function sanitizeName(raw: string): string | null {
  if (raw.includes('\0')) return null
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i)
    if (c <= 0x1f || c === 0x7f || (c >= 0x80 && c <= 0x9f) || BIDI_AND_ISOLATE.has(c)) continue
    out += raw[i]
  }
  return out.length > 0 ? out : null
}

function posixJoinUnder(root: string, rel: string): string {
  if (!rel) return root
  return posix.join(root, rel)
}

function isUnderRoot(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + '/')
}

export function parseSessionId(raw: unknown): string | null {
  return typeof raw === 'string' && isValidSessionRepoId(raw) ? raw : null
}

export function parseRelPath(raw: string | null | undefined): { ok: true; rel: string; segments: string[] } | { ok: false } {
  const rel = raw == null ? '' : raw
  if (typeof rel !== 'string') return { ok: false }
  if (rel.length > MAX_REL_LEN) return { ok: false }
  if (rel.includes('\\')) return { ok: false }
  if (rel.startsWith('/')) return { ok: false }
  if (/^[A-Za-z]:/.test(rel)) return { ok: false }
  for (let i = 0; i < rel.length; i++) {
    const c = rel.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return { ok: false }
  }
  if (rel === '') return { ok: true, rel: '', segments: [] }
  const segments = rel.split('/')
  if (segments.length > WORKSPACE_INSPECT_MAX_PATH_DEPTH) return { ok: false }
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return { ok: false }
  }
  return { ok: true, rel, segments }
}

function closeQuiet(fd: number | undefined): void {
  if (fd === undefined) return
  try {
    closeSync(fd)
  } catch {
    /* already closed */
  }
}

function openDirNoFollow(path: string): number {
  return openSync(path, OPEN_DIR_FLAGS)
}

function realFromFdWithPath(fd: number, originalPath: string): string {
  if (isLinuxFdAnchorAvailable()) {
    return realpathSync(`/proc/self/fd/${fd}`)
  }
  return realpathSync(originalPath)
}

function skipReasonForName(name: string): WorkspaceInspectSkipReason | null {
  if (VCS_NAMES.has(name)) return 'vcs'
  if (VENDOR_NAMES.has(name)) return 'vendor'
  return null
}

type ReadyWorkspace = {
  sessionId: string
  snap: RepoSnapshot
  realRoot: string
  identity: WorkspaceIdentity
  rootFd: number
}

async function resolveReadyWorkspace(
  rt: WorkspaceInspectRuntime,
  sessionId: string,
): Promise<ReadyWorkspace | InspectEmpty | InspectErr> {
  const snap = rt.getRepoSnapshot(sessionId)
  if (!snap) return empty('no_workspace')
  if (snap.status !== 'ready' || !snap.workspaceDir) return empty('not_ready')
  if (!snap.workspaceDir.startsWith('/')) return empty('no_workspace')

  const reposRoot = rt.reposRoot ?? workspaceInspectReposRootOverride ?? DEFAULT_REPOS_ROOT
  let realRepos: string
  try {
    realRepos = realpathSync(reposRoot)
  } catch {
    return empty('no_workspace')
  }
  const sessionPrefix = join(realRepos, sessionId)
  let realWs: string
  try {
    const lst = lstatSync(snap.workspaceDir)
    if (lst.isSymbolicLink()) return err(403, 'PATH_DENIED', 'workspace root must not be a symlink')
    if (!lst.isDirectory()) return empty('not_a_repo')
    const fd = openDirNoFollow(snap.workspaceDir)
    try {
      realWs = realFromFdWithPath(fd, snap.workspaceDir)
      closeQuiet(fd)
    } catch (e) {
      closeQuiet(fd)
      throw e
    }
  } catch {
    return empty('no_workspace')
  }
  if (!(realWs === sessionPrefix || realWs.startsWith(sessionPrefix + '/'))) {
    return empty('no_workspace')
  }

  let rootFd: number
  try {
    rootFd = openDirNoFollow(snap.workspaceDir)
  } catch {
    return empty('no_workspace')
  }
  let st: Stats
  try {
    const fdReal = realFromFdWithPath(rootFd, snap.workspaceDir)
    if (fdReal !== realWs) {
      closeQuiet(rootFd)
      return err(403, 'PATH_DENIED', 'workspace root moved')
    }
    st = fstatSync(rootFd)
  } catch {
    closeQuiet(rootFd)
    return empty('no_workspace')
  }
  return {
    sessionId,
    snap,
    realRoot: realWs,
    identity: {
      selectionVersion: snap.selectionVersion,
      workspaceDir: snap.workspaceDir,
      dev: st.dev,
      ino: st.ino,
    },
    rootFd,
  }
}

function verifyWorkspaceUnchanged(
  rt: WorkspaceInspectRuntime,
  sessionId: string,
  started: WorkspaceIdentity,
): InspectErr | null {
  const snap = rt.getRepoSnapshot(sessionId)
  if (
    !snap ||
    snap.status !== 'ready' ||
    snap.selectionVersion !== started.selectionVersion ||
    snap.workspaceDir !== started.workspaceDir
  ) {
    return err(409, 'WORKSPACE_CHANGED', 'workspace changed during inspect')
  }
  let fd: number | undefined
  try {
    fd = openDirNoFollow(snap.workspaceDir)
    const st = fstatSync(fd)
    if (st.dev !== started.dev || st.ino !== started.ino) {
      return err(409, 'WORKSPACE_CHANGED', 'workspace inode changed')
    }
  } catch {
    return err(409, 'WORKSPACE_CHANGED', 'workspace changed during inspect')
  } finally {
    closeQuiet(fd)
  }
  return null
}

function previewForFile(absPath: string, acl: InspectFileAcl): { previewable: boolean; preview_path?: string } {
  if (hasGitPathSegment(absPath)) return { previewable: false }
  if (!acl.isFileAllowed(absPath) || acl.isFileBlocked(absPath)) return { previewable: false }
  return { previewable: true, preview_path: absPath }
}

export let lastOpendirPathForTests: string | null = null
/** Tests may point the session-repo root at a temp dir. Production leaves this unset. */
export let workspaceInspectReposRootOverride: string | undefined
/** Tests may inject snapshots without going through SessionRepoWorkspaceManager. */
export let workspaceInspectSnapshotOverride: ((sessionId: string) => RepoSnapshot | null) | undefined

export type ListDirMeta = { usedProcSelfFd: boolean }

export async function collectListDir(
  rt: WorkspaceInspectRuntime,
  sessionId: string,
  relRaw: string | null,
  meta?: ListDirMeta,
): Promise<InspectResult> {
  const parsed = parseRelPath(relRaw)
  if (!parsed.ok) return err(400, 'BAD_PATH', 'invalid path')
  if (hasGitPathSegment(parsed.rel) || parsed.segments.includes('.git')) {
    return err(403, 'PATH_DENIED', 'git directory is not listable')
  }

  const ws = await resolveReadyWorkspace(rt, sessionId)
  if (!('realRoot' in ws)) return ws
  const { realRoot, identity, rootFd } = ws
  try {
    const targetPath = parsed.rel ? posixJoinUnder(realRoot, parsed.rel) : realRoot
    if (hasGitPathSegment(targetPath)) return err(403, 'PATH_DENIED', 'git directory is not listable')

    let targetLst: Stats
    try {
      targetLst = lstatSync(targetPath)
    } catch {
      return err(404, 'NOT_FOUND', 'not found')
    }
    if (targetLst.isSymbolicLink()) return err(403, 'PATH_DENIED', 'directory symlink is not followed')
    if (!targetLst.isDirectory()) return err(400, 'BAD_PATH', 'not a directory')

    let tfd: number
    try {
      tfd = openDirNoFollow(targetPath)
    } catch {
      return err(404, 'NOT_FOUND', 'not found')
    }
    let canonical: string
    try {
      canonical = realFromFdWithPath(tfd, targetPath)
    } catch {
      closeQuiet(tfd)
      return err(404, 'NOT_FOUND', 'not found')
    }
    if (!isUnderRoot(realRoot, canonical)) {
      closeQuiet(tfd)
      return err(403, 'PATH_DENIED', 'path escapes workspace')
    }
    if (rt.acl.isFileBlocked(canonical) || hasGitPathSegment(canonical)) {
      closeQuiet(tfd)
      return err(403, 'PATH_DENIED', 'path is blocked')
    }

    const linux = isLinuxFdAnchorAvailable()
    // darwin fallback: opendir(realpath). Not a production path; V5 CI is linux.
    const dirOpenPath = linux ? `/proc/self/fd/${tfd}` : canonical
    lastOpendirPathForTests = dirOpenPath
    if (meta) meta.usedProcSelfFd = linux && dirOpenPath.startsWith('/proc/self/fd/')

    const entries: WorkspaceInspectListEntry[] = []
    let truncated = false
    let truncReason: WorkspaceInspectTruncationReason | null = null
    let jsonBytes = 64
    try {
      const dir = await opendir(dirOpenPath)
      try {
        let seen = 0
        for await (const dirent of dir) {
          if (seen >= WORKSPACE_INSPECT_MAX_LIST_ENTRIES) {
            truncated = true
            truncReason = 'max_entries'
            break
          }
          const name = sanitizeName(dirent.name)
          if (!name) continue
          const child = buildListChild(rt, canonical, tfd, name, linux)
          const piece = Buffer.byteLength(JSON.stringify(child), 'utf8') + 1
          if (jsonBytes + piece > WORKSPACE_INSPECT_MAX_JSON_BYTES) {
            truncated = true
            truncReason = 'byte_budget'
            break
          }
          entries.push(child)
          jsonBytes += piece
          seen++
        }
      } finally {
        await dir.close().catch(() => {})
      }
    } finally {
      closeQuiet(tfd)
    }

    const changed = verifyWorkspaceUnchanged(rt, sessionId, identity)
    if (changed) return changed

    const body: WorkspaceInspectListDirBody = {
      ok: true,
      empty: false,
      cwd: parsed.rel,
      entries,
      truncated,
      truncation: truncated
        ? { reason: truncReason ?? 'max_entries', omitted: 'unknown' }
        : null,
    }
    return { kind: 'ok', status: 200, body }
  } finally {
    closeQuiet(rootFd)
  }
}

function buildListChild(
  rt: WorkspaceInspectRuntime,
  parentCanonical: string,
  parentFd: number,
  name: string,
  linux: boolean,
): WorkspaceInspectListEntry {
  const skip = skipReasonForName(name)
  if (skip) return { name, kind: 'skipped', reason: skip }

  const childPath = linux ? `/proc/self/fd/${parentFd}/${name}` : join(parentCanonical, name)
  let st: Stats
  try {
    st = lstatSync(childPath)
  } catch {
    return { name, kind: 'skipped', reason: 'denied' }
  }
  if (st.isSymbolicLink()) return { name, kind: 'symlink' }

  const abs = posixJoinUnder(parentCanonical, name)
  if (st.isDirectory()) {
    if (rt.acl.isFileBlocked(abs) || hasGitPathSegment(abs)) {
      return { name, kind: 'skipped', reason: 'denied' }
    }
    return { name, kind: 'dir' }
  }
  if (st.isFile()) {
    const prev = previewForFile(abs, rt.acl)
    return { name, kind: 'file', ...prev }
  }
  return { name, kind: 'symlink' }
}

const GIT_HERMETIC_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
  '-c',
  'core.worktree=',
  '--no-optional-locks',
  '--no-lazy-fetch',
] as const

const OPEN_FILE_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK
const HEAD_FILE_MAX = 256
const REF_FILE_MAX = 256
const PACKED_REFS_MAX = 2 * 1024 * 1024
const INDEX_FILE_MAX = 8 * 1024 * 1024
const PREPARE_TOTAL_MAX = 10 * 1024 * 1024
const STDERR_DRAIN_MAX = 64 * 1024
const GIT_TERM_GRACE_MS = 200
const REF_SEGMENT_RE = /^[A-Za-z0-9._-]+$/
const TRUSTED_GITDIR_PREFIX = 'oc-inspect-git-'

/** Tests may swap `.git/objects` after ofd is opened. Production leaves this unset. */
export let workspaceInspectAfterObjectsFdForTests: ((ctx: { objectsPath: string }) => void) | undefined
export let lastTrustedGitDirForTests: string | null = null

export function setWorkspaceInspectAfterObjectsFdForTests(
  fn: ((ctx: { objectsPath: string }) => void) | undefined,
): void {
  workspaceInspectAfterObjectsFdForTests = fn
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
    PAGER: 'cat',
  }
}

function throwIfDeadline(deadline: number): void {
  if (Date.now() >= deadline) {
    const e = new Error('prepare_timeout')
    e.name = 'PrepareTimeout'
    throw e
  }
}

function childEntryPath(parentFd: number, parentPath: string, name: string): string {
  if (isLinuxFdAnchorAvailable()) return `/proc/self/fd/${parentFd}/${name}`
  return join(parentPath, name)
}

function openChildNoFollow(
  parentFd: number,
  parentPath: string,
  name: string,
  asDir: boolean,
): number {
  if (!name || name.includes('/') || name === '.' || name === '..') {
    throw new Error('bad_seg')
  }
  const p = childEntryPath(parentFd, parentPath, name)
  const st = lstatSync(p)
  if (st.isSymbolicLink()) throw new Error('symlink')
  return openSync(p, asDir ? OPEN_DIR_FLAGS : OPEN_FILE_FLAGS)
}

function openNested(
  rootFd: number,
  rootPath: string,
  rel: string,
  asDir: boolean,
): number {
  const segs = rel.split('/')
  let parentFd = rootFd
  let parentPath = rootPath
  const intermediates: number[] = []
  try {
    for (let i = 0; i < segs.length; i++) {
      const last = i === segs.length - 1
      const child = openChildNoFollow(parentFd, parentPath, segs[i]!, last ? asDir : true)
      if (parentFd !== rootFd) intermediates.push(parentFd)
      parentFd = child
      parentPath = isLinuxFdAnchorAvailable() ? `/proc/self/fd/${child}` : join(parentPath, segs[i]!)
    }
    return parentFd
  } catch (e) {
    if (parentFd !== rootFd) closeQuiet(parentFd)
    throw e
  } finally {
    for (const fd of intermediates) closeQuiet(fd)
  }
}

function readFdRegular(fd: number, max: number, budget: { used: number }): Buffer {
  const st = fstatSync(fd)
  if (!st.isFile()) throw new Error('not_file')
  if (st.size > max) throw new Error('too_big')
  if (budget.used + st.size > PREPARE_TOTAL_MAX) throw new Error('too_big')
  const buf = Buffer.alloc(Number(st.size))
  let off = 0
  while (off < buf.length) {
    const n = readSync(fd, buf, off, buf.length - off, off)
    if (n <= 0) break
    off += n
  }
  budget.used += off
  return buf.subarray(0, off)
}

function writeTrustedCopy(tmpGit: string, rel: string, data: Buffer): void {
  const dest = join(tmpGit, rel)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, data)
}

/** Exported for HEAD-contract unit tests. */
export function parseGitHead(buf: Buffer): { kind: 'sha'; sha: string } | { kind: 'ref'; rel: string } | null {
  let s = buf.toString('utf8')
  if (s.endsWith('\n')) s = s.slice(0, -1)
  if (/[\n\r]/.test(s)) return null
  if (/^[ \t]/.test(s) || /[ \t]$/.test(s)) return null
  if (SHA_RE.test(s)) return { kind: 'sha', sha: s }
  if (!s.startsWith('ref: refs/')) return null
  const rest = s.slice('ref: refs/'.length)
  if (!rest) return null
  const segs = rest.split('/')
  for (const seg of segs) {
    if (!seg || seg === '.' || seg === '..' || !REF_SEGMENT_RE.test(seg)) return null
  }
  return { kind: 'ref', rel: `refs/${rest}` }
}

function copyGitFile(
  gfd: number,
  gitPath: string,
  rel: string,
  tmpGit: string,
  max: number,
  budget: { used: number },
  deadline: number,
  required: boolean,
): boolean {
  throwIfDeadline(deadline)
  let fd: number | undefined
  try {
    fd = openNested(gfd, gitPath, rel, false)
  } catch {
    if (required) throw new Error('missing')
    return false
  }
  try {
    const data = readFdRegular(fd, max, budget)
    writeTrustedCopy(tmpGit, rel, data)
    return true
  } finally {
    closeQuiet(fd)
  }
}

type TrustedGitDir = { tmpGit: string; ofd: number; objectsReal: string }

function prepareTrustedGitDir(
  gfd: number,
  gitPath: string,
  deadline: number,
): TrustedGitDir {
  throwIfDeadline(deadline)
  const tmpGit = mkdtempSync(join(tmpdir(), TRUSTED_GITDIR_PREFIX))
  lastTrustedGitDirForTests = tmpGit
  const budget = { used: 0 }
  let ofd: number | undefined
  try {
    const headFd = openNested(gfd, gitPath, 'HEAD', false)
    let headBuf: Buffer
    try {
      headBuf = readFdRegular(headFd, HEAD_FILE_MAX, budget)
    } finally {
      closeQuiet(headFd)
    }
    const head = parseGitHead(headBuf)
    if (!head) throw new Error('bad_head')
    writeTrustedCopy(tmpGit, 'HEAD', headBuf)

    copyGitFile(gfd, gitPath, 'index', tmpGit, INDEX_FILE_MAX, budget, deadline, false)
    copyGitFile(gfd, gitPath, 'packed-refs', tmpGit, PACKED_REFS_MAX, budget, deadline, false)
    if (head.kind === 'ref') {
      copyGitFile(gfd, gitPath, head.rel, tmpGit, REF_FILE_MAX, budget, deadline, true)
    }

    throwIfDeadline(deadline)
    ofd = openNested(gfd, gitPath, 'objects', true)
    const objectsPath = join(gitPath, 'objects')
    workspaceInspectAfterObjectsFdForTests?.({ objectsPath })
    const objectsReal = isLinuxFdAnchorAvailable()
      ? realpathSync(`/proc/self/fd/${ofd}`)
      : realpathSync(objectsPath)
    mkdirSync(join(tmpGit, 'objects', 'info'), { recursive: true })
    const alternates = isLinuxFdAnchorAvailable() ? '/proc/self/fd/5\n' : `${objectsReal}\n`
    writeFileSync(join(tmpGit, 'objects', 'info', 'alternates'), alternates)
    writeFileSync(
      join(tmpGit, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = false\n\thooksPath = /dev/null\n',
    )
    return { tmpGit, ofd, objectsReal }
  } catch (e) {
    closeQuiet(ofd)
    try {
      rmSync(tmpGit, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    throw e
  }
}

type GitRun = {
  stdout: Buffer
  timedOut: boolean
  truncated: boolean
}

function terminateGit(child: ChildProcess): void {
  try {
    child.kill('SIGTERM')
  } catch {
    /* ignore */
  }
  setTimeout(() => {
    try {
      child.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  }, GIT_TERM_GRACE_MS).unref?.()
}

async function runGit(opts: {
  wfd: number
  gfd: number
  ofd: number
  workTreePath: string
  tmpGit: string
  extra: string[]
  timeoutMs: number
}): Promise<GitRun> {
  const linux = isLinuxFdAnchorAvailable()
  const prefix = [
    `--git-dir=${opts.tmpGit}`,
    `--work-tree=${linux ? '/proc/self/fd/3' : opts.workTreePath}`,
    ...GIT_HERMETIC_ARGS,
  ]
  const args = [...prefix, ...opts.extra]
  const stdio: Array<'ignore' | 'pipe' | number> = linux
    ? ['ignore', 'pipe', 'pipe', opts.wfd, opts.gfd, opts.ofd]
    : ['ignore', 'pipe', 'pipe']

  return await new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn('git', args, {
        env: gitEnv(),
        stdio,
        windowsHide: true,
      })
    } catch {
      resolve({ stdout: Buffer.alloc(0), timedOut: false, truncated: false })
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    let timedOut = false
    let stderrSeen = 0
    const timer = setTimeout(() => {
      timedOut = true
      terminateGit(child)
    }, opts.timeoutMs)
    child.stdout?.on('data', (buf: Buffer) => {
      if (truncated || timedOut) return
      if (total + buf.length > WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES) {
        const room = WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES - total
        if (room > 0) chunks.push(buf.subarray(0, room))
        total = WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES
        truncated = true
        terminateGit(child)
        return
      }
      chunks.push(buf)
      total += buf.length
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderrSeen += buf.length
      if (stderrSeen > STDERR_DRAIN_MAX) {
        child.stderr?.resume()
      }
    })
    child.stderr?.resume()
    child.on('close', () => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.concat(chunks, total), timedOut, truncated })
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ stdout: Buffer.alloc(0), timedOut, truncated })
    })
  })
}

function parseZStrings(buf: Buffer): { records: string[]; incomplete: boolean } {
  const records: string[] = []
  let start = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) {
      records.push(buf.subarray(start, i).toString('utf8'))
      start = i + 1
    }
  }
  const incomplete = start < buf.length
  return { records, incomplete }
}

function mapPorcelainStatus(xy: string): WorkspaceInspectGitStatus {
  const x = xy[0] ?? ' '
  const y = xy[1] ?? ' '
  if (x === '?' || y === '?') return 'untracked'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'C' || y === 'C') return 'copied'
  if (x === 'U' || y === 'U' || x === 'A' && y === 'A') return 'unmerged'
  if (x === 'A' || y === 'A') return 'added'
  if (x === 'D' && y === 'D') return 'deleted'
  if (x === 'D' || y === 'D') return 'deleted'
  return 'modified'
}

export async function collectGitSnapshot(
  rt: WorkspaceInspectRuntime,
  sessionId: string,
): Promise<InspectResult> {
  const ws = await resolveReadyWorkspace(rt, sessionId)
  if (!('realRoot' in ws)) return ws
  const { realRoot, identity, rootFd } = ws
  let gfd: number | undefined
  let prepared: TrustedGitDir | undefined
  try {
    const gitPath = join(realRoot, '.git')
    let gitLst: Stats
    try {
      gitLst = lstatSync(gitPath)
    } catch {
      return empty('not_a_repo')
    }
    if (gitLst.isSymbolicLink()) return err(403, 'PATH_DENIED', 'git dir must not be a symlink')
    if (gitLst.isFile()) return empty('not_a_repo')
    if (!gitLst.isDirectory()) return empty('not_a_repo')
    try {
      gfd = openDirNoFollow(gitPath)
    } catch {
      return empty('not_a_repo')
    }

    const deadline = Date.now() + WORKSPACE_INSPECT_GIT_TIMEOUT_MS
    try {
      prepared = prepareTrustedGitDir(gfd, gitPath, deadline)
    } catch (e) {
      if ((e as Error).name === 'PrepareTimeout') return err(504, 'GIT_TIMEOUT', 'git timed out')
      return empty('not_a_repo')
    }
    if (gfd === undefined || prepared === undefined) return empty('not_a_repo')
    const gitFd = gfd
    const trusted = prepared

    const workTreePath = isLinuxFdAnchorAvailable() ? `/proc/self/fd/3` : realRoot
    const remain = () => Math.max(1, deadline - Date.now())
    const run = (extra: string[]) =>
      runGit({
        wfd: rootFd,
        gfd: gitFd,
        ofd: trusted.ofd,
        workTreePath,
        tmpGit: trusted.tmpGit,
        extra,
        timeoutMs: remain(),
      })

    const headRun = await run(['rev-parse', 'HEAD'])
    if (headRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')
    const sha = headRun.stdout.toString('utf8').trim()
    if (!SHA_RE.test(sha)) return empty('not_a_repo')

    const branchRun = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')
    const branchRaw = sanitizeName(branchRun.stdout.toString('utf8').trim().replace(/\0/g, '')) ?? 'HEAD'
    const detached = branchRaw === 'HEAD'
    const branch = detached ? null : branchRaw

    const statusRun = await run(['status', '-z', '--porcelain=v1', '-unormal', '--ignore-submodules=all'])
    if (statusRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')

    const numstatRun = await run([
      'diff',
      '--numstat',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=all',
      '-z',
      'HEAD',
    ])
    if (numstatRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')

    const stdoutLimited = statusRun.truncated || numstatRun.truncated
    const statusParsed = parseZStrings(statusRun.stdout)
    const numParsed = parseZStrings(numstatRun.stdout)

    const numstat = new Map<string, { added: number | null; deleted: number | null; binary: boolean }>()
    let numstatComplete = !numParsed.incomplete && !numstatRun.truncated
    // numstat -z: "added\tdeleted\tpath\0" but renamed paths can be split. Treat each
    // NUL field; skip incomplete trailing record.
    for (const rec of numParsed.records) {
      if (!rec) continue
      const firstTab = rec.indexOf('\t')
      const secondTab = rec.indexOf('\t', firstTab + 1)
      if (firstTab < 0 || secondTab < 0) continue
      const a = rec.slice(0, firstTab)
      const d = rec.slice(firstTab + 1, secondTab)
      let p = rec.slice(secondTab + 1)
      if (p.startsWith('\0') || p.includes('\0')) continue
      p = p.replace(/\\/g, '/')
      if (hasGitPathSegment(p) || p.split('/').includes('.git')) continue
      const binary = a === '-' && d === '-'
      numstat.set(p, {
        added: binary ? null : Number.parseInt(a, 10),
        deleted: binary ? null : Number.parseInt(d, 10),
        binary,
      })
    }

    const entries: WorkspaceInspectGitEntry[] = []
    let i = 0
    const recs = statusParsed.records
    let statusComplete = !statusParsed.incomplete && !statusRun.truncated
    while (i < recs.length && entries.length < WORKSPACE_INSPECT_MAX_GIT_ENTRIES) {
      const rec = recs[i]!
      if (rec.length < 3) {
        i++
        continue
      }
      const xy = rec.slice(0, 2)
      let pathRel = rec.slice(3)
      if (xy[0] === 'R' || xy[0] === 'C') {
        const orig = pathRel
        i++
        const next = recs[i]
        if (next == null) {
          statusComplete = false
          break
        }
        pathRel = next
        void orig
      }
      i++
      const clean = sanitizeName(pathRel.replace(/\\/g, '/'))
      if (!clean) continue
      if (hasGitPathSegment(clean) || clean.split('/').includes('.git')) continue
      const abs = posixJoinUnder(realRoot, clean)
      if (!isUnderRoot(realRoot, pathResolve(abs))) continue
      const st = mapPorcelainStatus(xy)
      const ns = numstat.get(clean)
      const binary = ns?.binary === true
      const prev = st === 'deleted' ? { previewable: false } : previewForFile(abs, rt.acl)
      entries.push({
        path: clean,
        status: st,
        added: binary ? null : (ns?.added ?? null),
        deleted: binary ? null : (ns?.deleted ?? null),
        binary,
        previewable: prev.previewable,
        ...(prev.preview_path ? { preview_path: prev.preview_path } : {}),
      })
    }
    if (entries.length >= WORKSPACE_INSPECT_MAX_GIT_ENTRIES && i < recs.length) {
      statusComplete = false
    }

    let truncated = false
    let truncReason: WorkspaceInspectTruncationReason | null = null
    if (stdoutLimited) {
      truncated = true
      truncReason = 'stdout_limit'
    } else if (entries.length >= WORKSPACE_INSPECT_MAX_GIT_ENTRIES) {
      truncated = true
      truncReason = 'max_entries'
    }

    let jsonBytes = 128
    const kept: WorkspaceInspectGitEntry[] = []
    for (const e of entries) {
      const piece = Buffer.byteLength(JSON.stringify(e), 'utf8') + 1
      if (jsonBytes + piece > WORKSPACE_INSPECT_MAX_JSON_BYTES) {
        truncated = true
        truncReason = 'byte_budget'
        break
      }
      kept.push(e)
      jsonBytes += piece
    }

    const diffOk = numstatComplete && !stdoutLimited && truncReason !== 'stdout_limit'
    let added = 0
    let deleted = 0
    if (diffOk) {
      for (const v of numstat.values()) {
        if (v.added != null) added += v.added
        if (v.deleted != null) deleted += v.deleted
      }
    }

    const changed = verifyWorkspaceUnchanged(rt, sessionId, identity)
    if (changed) return changed

    const snapshot: WorkspaceInspectGitSnapshot = {
      live_head: { authority: 'live', branch, sha, detached },
      diff: diffOk ? { added, deleted } : null,
      entries: kept,
      truncated,
      truncation: truncated
        ? { reason: truncReason ?? 'max_entries', omitted: 'unknown' }
        : null,
    }
    return { kind: 'ok', status: 200, body: { ok: true, empty: false, snapshot } }
  } finally {
    closeQuiet(prepared?.ofd)
    if (prepared?.tmpGit) {
      try {
        rmSync(prepared.tmpGit, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
    closeQuiet(gfd)
    closeQuiet(rootFd)
  }
}

type Slot = { sessionId: string }
const processSlots: Slot[] = []
const sessionHeld = new Set<string>()

export function tryAcquireInspect(sessionId: string): 'ok' | 'session' | 'process' {
  if (sessionHeld.has(sessionId)) return 'session'
  if (processSlots.length >= WORKSPACE_INSPECT_PROCESS_CONCURRENCY) return 'process'
  sessionHeld.add(sessionId)
  processSlots.push({ sessionId })
  return 'ok'
}

export function releaseInspect(sessionId: string): void {
  sessionHeld.delete(sessionId)
  const idx = processSlots.findIndex((s) => s.sessionId === sessionId)
  if (idx >= 0) processSlots.splice(idx, 1)
}

export function resetInspectLimiterForTests(): void {
  processSlots.length = 0
  sessionHeld.clear()
}

export function withInspectLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<InspectErr | T> {
  const gate = tryAcquireInspect(sessionId)
  if (gate !== 'ok') {
    return Promise.resolve(err(429, 'IN_FLIGHT', 'inspect already in flight'))
  }
  return fn().finally(() => releaseInspect(sessionId))
}

export function httpStatusForTimeout(kind: 'git' | 'list'): { status: 504; code: WorkspaceInspectErrorCode } {
  return kind === 'git'
    ? { status: 504, code: 'GIT_TIMEOUT' }
    : { status: 504, code: 'LIST_TIMEOUT' }
}

export async function withTimeout<T>(
  ms: number,
  kind: 'git' | 'list',
  fn: () => Promise<T>,
): Promise<T | InspectErr> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      fn(),
      new Promise<InspectErr>((resolve) => {
        timer = setTimeout(() => {
          const t = httpStatusForTimeout(kind)
          resolve(err(t.status, t.code, `${kind} timed out`))
        }, ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export { WORKSPACE_INSPECT_LIST_TIMEOUT_MS, WORKSPACE_INSPECT_GIT_TIMEOUT_MS }
