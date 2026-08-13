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
  readFileSync,
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
  signal?: AbortSignal,
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
    if (workspaceInspectHoldForTests) await workspaceInspectHoldForTests()
    if (signal?.aborted) return err(504, 'LIST_TIMEOUT', 'list timed out')
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
          if (signal?.aborted) return err(504, 'LIST_TIMEOUT', 'list timed out')
          seen++
          if (seen > WORKSPACE_INSPECT_MAX_LIST_ENTRIES) {
            truncated = true
            truncReason = 'max_entries'
            break
          }
          const display = sanitizeName(dirent.name)
          if (!display) continue
          const child = buildListChild(rt, canonical, tfd, dirent.name, display, linux)
          const piece = Buffer.byteLength(JSON.stringify(child), 'utf8') + 1
          if (jsonBytes + piece > WORKSPACE_INSPECT_MAX_JSON_BYTES) {
            truncated = true
            truncReason = 'byte_budget'
            break
          }
          entries.push(child)
          jsonBytes += piece
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
      cwd: sanitizeName(parsed.rel) ?? '',
      entries,
      truncated,
      truncation: truncated
        ? { reason: truncReason ?? 'max_entries', omitted: 'unknown' }
        : null,
    }
    while (utf8JsonBytes(body) > WORKSPACE_INSPECT_MAX_JSON_BYTES && body.entries.length > 0) {
      body.entries.pop()
      body.truncated = true
      body.truncation = { reason: 'byte_budget', omitted: 'unknown' }
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
  rawName: string,
  displayName: string,
  linux: boolean,
): WorkspaceInspectListEntry {
  const skip = skipReasonForName(rawName) ?? skipReasonForName(displayName)
  if (skip) return { name: displayName, kind: 'skipped', reason: skip }

  const childPath = linux ? `/proc/self/fd/${parentFd}/${rawName}` : join(parentCanonical, rawName)
  let st: Stats
  try {
    st = lstatSync(childPath)
  } catch {
    return { name: displayName, kind: 'skipped', reason: 'denied' }
  }
  if (st.isSymbolicLink()) return { name: displayName, kind: 'symlink' }

  const abs = posixJoinUnder(parentCanonical, rawName)
  if (st.isDirectory()) {
    if (rt.acl.isFileBlocked(abs) || hasGitPathSegment(abs)) {
      return { name: displayName, kind: 'skipped', reason: 'denied' }
    }
    return { name: displayName, kind: 'dir' }
  }
  if (st.isFile()) {
    const prev = previewForFile(abs, rt.acl)
    return { name: displayName, kind: 'file', ...prev }
  }
  return { name: displayName, kind: 'symlink' }
}

/**
 * Hermetic git argv shared by every inspect spawn.
 * Do not add `--no-lazy-fetch`: it was added in Git 2.45, and the runtime
 * image is Debian bookworm apt Git 2.39.x. An unknown flag makes `rev-parse`
 * fail with empty stdout, which this collector must not map to a fake empty repo
 * without checking the exit code — and must not use the flag at all.
 */
export const GIT_HERMETIC_ARGS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=',
  '-c',
  'diff.external=',
  '-c',
  'core.worktree=',
  '--no-optional-locks',
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
/** Last reason `runGit` terminated the child. Tests assert entry-cap kill. */
export let lastGitKillReasonForTests: 'timeout' | 'stdout' | 'entries' | null = null
/** Tests may await this inside collect* after the workspace identity is captured. */
export let workspaceInspectHoldForTests: (() => Promise<void>) | undefined
/** Tests may shorten the HTTP/collect clocks. Production leaves this unset. */
export let inspectTimeoutOverrideForTests: { git?: number; list?: number } | undefined

export function inspectGitTimeoutMs(): number {
  return inspectTimeoutOverrideForTests?.git ?? WORKSPACE_INSPECT_GIT_TIMEOUT_MS
}

export function inspectListTimeoutMs(): number {
  return inspectTimeoutOverrideForTests?.list ?? WORKSPACE_INSPECT_LIST_TIMEOUT_MS
}

export function setWorkspaceInspectAfterObjectsFdForTests(
  fn: ((ctx: { objectsPath: string }) => void) | undefined,
): void {
  workspaceInspectAfterObjectsFdForTests = fn
}

export function setWorkspaceInspectHoldForTests(fn: (() => Promise<void>) | undefined): void {
  workspaceInspectHoldForTests = fn
}

export function setInspectTimeoutOverrideForTests(
  value: { git?: number; list?: number } | undefined,
): void {
  inspectTimeoutOverrideForTests = value
}

export function setWorkspaceInspectReposRootOverrideForTests(value: string | undefined): void {
  workspaceInspectReposRootOverride = value
}

export function setWorkspaceInspectSnapshotOverrideForTests(
  fn: ((sessionId: string) => RepoSnapshot | null) | undefined,
): void {
  workspaceInspectSnapshotOverride = fn
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

function packedRefsHasRef(tmpGit: string, rel: string): boolean {
  try {
    const raw = readFileSync(join(tmpGit, 'packed-refs'), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue
      const sp = line.indexOf(' ')
      if (sp <= 0) continue
      const sha = line.slice(0, sp)
      const ref = line.slice(sp + 1)
      if (SHA_RE.test(sha) && ref === rel) return true
    }
  } catch {
    return false
  }
  return false
}

function writeTrustedCopy(tmpGit: string, rel: string, data: Buffer): void {
  if (!rel || rel.includes('\0') || rel.startsWith('/') || rel.includes('\\')) {
    throw new Error('bad_rel')
  }
  const segs = rel.split('/')
  if (segs.some((s) => !s || s === '.' || s === '..')) throw new Error('bad_rel')
  const dest = join(tmpGit, rel)
  const base = pathResolve(tmpGit)
  const resolved = pathResolve(dest)
  if (resolved !== base && !resolved.startsWith(base + '/')) throw new Error('escape')
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
    mkdirSync(join(tmpGit, 'refs'), { recursive: true })

    copyGitFile(gfd, gitPath, 'index', tmpGit, INDEX_FILE_MAX, budget, deadline, false)
    const packedCopied = copyGitFile(
      gfd,
      gitPath,
      'packed-refs',
      tmpGit,
      PACKED_REFS_MAX,
      budget,
      deadline,
      false,
    )
    if (head.kind === 'ref') {
      const looseCopied = copyGitFile(
        gfd,
        gitPath,
        head.rel,
        tmpGit,
        REF_FILE_MAX,
        budget,
        deadline,
        false,
      )
      if (!looseCopied && !packedRefsHasRef(tmpGit, head.rel)) throw new Error('missing')
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
  killedForEntries: boolean
  exitCode: number | null
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
  stopAfterPorcelainEntries?: number
  signal?: AbortSignal
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
    let settled = false
    const finish = (result: GitRun) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = spawn('git', args, {
        env: gitEnv(),
        stdio,
        windowsHide: true,
      })
    } catch {
      finish({
        stdout: Buffer.alloc(0),
        timedOut: false,
        truncated: false,
        killedForEntries: false,
        exitCode: null,
      })
      return
    }
    const chunks: Buffer[] = []
    let total = 0
    let truncated = false
    let timedOut = false
    let killedForEntries = false
    let terminating = false
    let stderrSeen = 0
    const stop = (reason: 'timeout' | 'stdout' | 'entries') => {
      if (terminating) return
      terminating = true
      if (reason === 'timeout') timedOut = true
      if (reason === 'stdout' || reason === 'entries') truncated = true
      if (reason === 'entries') killedForEntries = true
      lastGitKillReasonForTests = reason
      try {
        child.stdout?.destroy()
      } catch {
        /* ignore */
      }
      terminateGit(child)
    }
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs)
    const onAbort = () => stop('timeout')
    if (opts.signal?.aborted) onAbort()
    else opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (buf: Buffer) => {
      if (truncated || timedOut || killedForEntries) return
      if (total + buf.length > WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES) {
        const room = WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES - total
        if (room > 0) chunks.push(buf.subarray(0, room))
        total = WORKSPACE_INSPECT_MAX_GIT_STDOUT_BYTES
        stop('stdout')
        return
      }
      chunks.push(buf)
      total += buf.length
      if (opts.stopAfterPorcelainEntries != null) {
        const acc = Buffer.concat(chunks, total)
        const parsed = parseGitStatusZ(acc, opts.stopAfterPorcelainEntries)
        if (parsed.entries.length >= opts.stopAfterPorcelainEntries) {
          stop('entries')
        }
      }
    })
    child.stderr?.on('data', (buf: Buffer) => {
      stderrSeen += buf.length
      if (stderrSeen > STDERR_DRAIN_MAX) {
        child.stderr?.resume()
      }
    })
    child.stderr?.resume()
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      finish({
        stdout: Buffer.concat(chunks, total),
        timedOut,
        truncated,
        killedForEntries,
        exitCode: typeof code === 'number' ? code : null,
      })
    })
    child.on('error', () => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      finish({
        stdout: Buffer.concat(chunks, total),
        timedOut,
        truncated,
        killedForEntries,
        exitCode: null,
      })
    })
  })
}

export function parseZStrings(buf: Buffer): { records: string[]; incomplete: boolean } {
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

export type ParsedPorcelainEntry = { xy: string; path: string }

/**
 * `git status --porcelain=v1 -z`: a rename/copy is `XY dest\\0orig\\0`.
 * Keep the destination (first path); consume the original (second) without
 * using it as the current path.
 */
export function parseGitStatusZ(
  buf: Buffer,
  maxEntries: number,
): { entries: ParsedPorcelainEntry[]; complete: boolean } {
  const { records, incomplete } = parseZStrings(buf)
  const entries: ParsedPorcelainEntry[] = []
  let i = 0
  let complete = !incomplete
  while (i < records.length && entries.length < maxEntries) {
    const rec = records[i]!
    if (rec.length < 3) {
      i++
      continue
    }
    const xy = rec.slice(0, 2)
    const dest = rec.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') {
      if (i + 1 >= records.length) {
        complete = false
        break
      }
      entries.push({ xy, path: dest })
      i += 2
      continue
    }
    entries.push({ xy, path: dest })
    i++
  }
  if (entries.length >= maxEntries && i < records.length) complete = false
  return { entries, complete }
}

export type ParsedNumstat = {
  path: string
  added: number | null
  deleted: number | null
  binary: boolean
}

/**
 * `git diff --numstat -z`: a normal record is `added\\tdeleted\\tpath\\0`.
 * A rename/copy is `added\\tdeleted\\t\\0orig\\0dest\\0` — key by dest.
 */
export function parseGitNumstatZ(buf: Buffer): { entries: ParsedNumstat[]; complete: boolean } {
  const { records, incomplete } = parseZStrings(buf)
  const entries: ParsedNumstat[] = []
  let i = 0
  let complete = !incomplete
  while (i < records.length) {
    const rec = records[i]!
    const firstTab = rec.indexOf('\t')
    const secondTab = firstTab >= 0 ? rec.indexOf('\t', firstTab + 1) : -1
    if (firstTab < 0 || secondTab < 0) {
      i++
      continue
    }
    const a = rec.slice(0, firstTab)
    const d = rec.slice(firstTab + 1, secondTab)
    const p = rec.slice(secondTab + 1)
    const binary = a === '-' && d === '-'
    const added = binary ? null : Number.parseInt(a, 10)
    const deleted = binary ? null : Number.parseInt(d, 10)
    if (p === '') {
      const orig = records[i + 1]
      const dest = records[i + 2]
      if (orig == null || dest == null) {
        complete = false
        break
      }
      entries.push({ path: dest.replace(/\\/g, '/'), added, deleted, binary })
      i += 3
      continue
    }
    entries.push({ path: p.replace(/\\/g, '/'), added, deleted, binary })
    i++
  }
  return { entries, complete }
}

function utf8JsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function gitCommandFailed(run: GitRun): boolean {
  if (run.timedOut || run.truncated || run.killedForEntries) return false
  return run.exitCode !== 0
}

function confineGitPath(
  realRoot: string,
  rawRel: string,
  acl: InspectFileAcl,
): { path: string; previewable: boolean; preview_path?: string } | null {
  if (hasGitPathSegment(rawRel) || rawRel.split('/').includes('.git')) return null
  const display = sanitizeName(rawRel.replace(/\\/g, '/'))
  if (!display) return null
  const abs = posixJoinUnder(realRoot, rawRel)
  if (!isUnderRoot(realRoot, pathResolve(abs))) return null
  try {
    const st = lstatSync(abs)
    if (st.isSymbolicLink()) return { path: display, previewable: false }
    if (st.isFile()) {
      const real = realpathSync(abs)
      if (!isUnderRoot(realRoot, real)) return null
      const prev = previewForFile(real, acl)
      return { path: display, previewable: prev.previewable, preview_path: prev.preview_path }
    }
  } catch {
    return { path: display, previewable: false }
  }
  return { path: display, previewable: false }
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
  signal?: AbortSignal,
): Promise<InspectResult> {
  const ws = await resolveReadyWorkspace(rt, sessionId)
  if (!('realRoot' in ws)) return ws
  const { realRoot, identity, rootFd } = ws
  let gfd: number | undefined
  let prepared: TrustedGitDir | undefined
  try {
    if (workspaceInspectHoldForTests) await workspaceInspectHoldForTests()
    if (signal?.aborted) return err(504, 'GIT_TIMEOUT', 'git timed out')
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

    const deadline = Date.now() + inspectGitTimeoutMs()
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
    const run = (extra: string[], stopAfterPorcelainEntries?: number) =>
      runGit({
        wfd: rootFd,
        gfd: gitFd,
        ofd: trusted.ofd,
        workTreePath,
        tmpGit: trusted.tmpGit,
        extra,
        timeoutMs: remain(),
        stopAfterPorcelainEntries,
        signal,
      })

    const headRun = await run(['rev-parse', 'HEAD'])
    if (headRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')
    const sha = headRun.stdout.toString("utf8").trim()
    if (headRun.exitCode !== 0 || !SHA_RE.test(sha)) return empty('not_a_repo')

    const branchRun = await run(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branchRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')
    const branchRaw = sanitizeName(branchRun.stdout.toString('utf8').trim().replace(/\0/g, '')) ?? 'HEAD'
    const detached = branchRun.exitCode !== 0 || branchRaw === 'HEAD'
    const branch = detached ? null : branchRaw

    const statusRun = await run(
      ['status', '-z', '--porcelain=v1', '-unormal', '--ignore-submodules=all'],
      WORKSPACE_INSPECT_MAX_GIT_ENTRIES,
    )
    if (statusRun.timedOut) return err(504, 'GIT_TIMEOUT', 'git timed out')
    if (gitCommandFailed(statusRun)) return empty('not_a_repo')

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

    const stdoutLimited =
      (statusRun.truncated && !statusRun.killedForEntries) || numstatRun.truncated
    const statusParsed = parseGitStatusZ(statusRun.stdout, WORKSPACE_INSPECT_MAX_GIT_ENTRIES)
    const numParsed = parseGitNumstatZ(numstatRun.stdout)

    const numstat = new Map<string, { added: number | null; deleted: number | null; binary: boolean }>()
    const numstatComplete = numParsed.complete && !numstatRun.truncated && !gitCommandFailed(numstatRun)
    for (const rec of numParsed.entries) {
      if (hasGitPathSegment(rec.path) || rec.path.split('/').includes('.git')) continue
      numstat.set(rec.path, { added: rec.added, deleted: rec.deleted, binary: rec.binary })
    }

    const entries: WorkspaceInspectGitEntry[] = []
    for (const rec of statusParsed.entries) {
      const confined = confineGitPath(realRoot, rec.path, rt.acl)
      if (!confined) continue
      const st = mapPorcelainStatus(rec.xy)
      const ns = numstat.get(rec.path.replace(/\\/g, '/')) ?? numstat.get(confined.path)
      const binary = ns?.binary === true
      const prev = st === 'deleted' ? { previewable: false } : confined
      entries.push({
        path: confined.path,
        status: st,
        added: binary ? null : (ns?.added ?? null),
        deleted: binary ? null : (ns?.deleted ?? null),
        binary,
        previewable: prev.previewable,
        ...('preview_path' in prev && prev.preview_path ? { preview_path: prev.preview_path } : {}),
      })
    }

    let truncated = false
    let truncReason: WorkspaceInspectTruncationReason | null = null
    if (stdoutLimited) {
      truncated = true
      truncReason = 'stdout_limit'
    } else if (
      statusRun.killedForEntries ||
      (entries.length >= WORKSPACE_INSPECT_MAX_GIT_ENTRIES && !statusParsed.complete)
    ) {
      truncated = true
      truncReason = 'max_entries'
    }

    const diffOk = numstatComplete && !stdoutLimited
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
      entries,
      truncated,
      truncation: truncated
        ? { reason: truncReason ?? 'max_entries', omitted: 'unknown' }
        : null,
    }
    const body = { ok: true as const, empty: false as const, snapshot }
    while (utf8JsonBytes(body) > WORKSPACE_INSPECT_MAX_JSON_BYTES && snapshot.entries.length > 0) {
      snapshot.entries.pop()
      snapshot.truncated = true
      snapshot.truncation = { reason: 'byte_budget', omitted: 'unknown' }
    }
    return { kind: 'ok', status: 200, body }
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
  lastGitKillReasonForTests = null
  workspaceInspectHoldForTests = undefined
  inspectTimeoutOverrideForTests = undefined
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
