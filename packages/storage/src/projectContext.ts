/**
 * Unified project context (phase 1).
 *
 * Storage split:
 *   - Binding + live pinned assets + unbound chat instructions → sessions backend (PG/sqlite)
 *   - Bound/board instructions + skill overlay + versioned meta → volume ~/.openclaude/projects/<id>
 *   - Workspace spec → tb_project.workspace_json (taskboard sqlite; not this module)
 *
 * B2: PROJECT.md is the only write authority for bound instructions. PG
 * `chat_projects.instructions` is unbound-only (and a one-time seed source).
 * B3: ~/.openclaude/projects is DATA. It is never an allowed cwd root.
 */

import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { acquireFileLock } from './memoryShared.js'
import { paths } from './paths.js'

export const PROJECT_CONTEXT_FLAG = 'OC_PROJECT_CONTEXT'
export const PROJECT_ID_ENV = 'OPENCLAUDE_PROJECT_ID'
export const PROJECT_CONTEXT_SCHEMA_VERSION = 1
export const BOARD_PROJECT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const PROJECT_INSTRUCTIONS_MAX = 4000

export function isProjectContextEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env[PROJECT_CONTEXT_FLAG] ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

export function parseBoardProjectId(value: unknown):
  | { present: false }
  | { present: true; value: string | null }
  | { invalid: true } {
  if (value === undefined) return { present: false }
  if (value === null) return { present: true, value: null }
  if (typeof value !== 'string') return { invalid: true }
  const trimmed = value.trim()
  if (trimmed === '') return { present: true, value: null }
  if (!BOARD_PROJECT_ID_RE.test(trimmed)) return { invalid: true }
  return { present: true, value: trimmed.toLowerCase() }
}

export type ProjectWorkspace =
  | { kind: 'default' }
  | { kind: 'isolated' }
  | { kind: 'container_path'; path: string }

export function parseProjectWorkspace(raw: unknown): ProjectWorkspace | null {
  if (raw == null) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return null
    if (trimmed === 'default') return { kind: 'default' }
    if (trimmed === 'isolated') return { kind: 'isolated' }
    return { kind: 'container_path', path: trimmed }
  }
  if (typeof raw !== 'object') return null
  const obj = raw as { kind?: unknown; path?: unknown }
  if (obj.kind === 'default') return { kind: 'default' }
  if (obj.kind === 'isolated') return { kind: 'isolated' }
  if (obj.kind === 'container_path' && typeof obj.path === 'string' && obj.path.trim()) {
    return { kind: 'container_path', path: obj.path.trim() }
  }
  return null
}

export interface ProjectContextMeta {
  schemaVersion: 1
  boardProjectId: string
  key?: string
  version: number
  updatedAt: number
  instructionsSha256?: string | null
  skillOverlay: string[]
  /** Phase 2 placeholder: promotion manifest hash. Phase 1 always null. */
  promotion: { schemaVersion: 1; manifestSha256: string | null }
  instructionsSeed?: { from: 'chat_project'; at: number } | null
}

export interface ProjectContextSnapshot {
  boardProjectId: string
  version: number
  instructions: string | null
  skillOverlay: string[]
  meta: ProjectContextMeta
}

export type ProjectContextWriteResult =
  | { ok: true; snapshot: ProjectContextSnapshot }
  | { ok: false; error: 'version_conflict' | 'invalid_instructions' | 'invalid_id'; current?: number }

function emptyMeta(boardProjectId: string, key?: string): ProjectContextMeta {
  return {
    schemaVersion: 1,
    boardProjectId,
    key,
    version: 0,
    updatedAt: Date.now(),
    instructionsSha256: null,
    skillOverlay: [],
    promotion: { schemaVersion: 1, manifestSha256: null },
    instructionsSeed: null,
  }
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function assertBoardId(id: string): string {
  const parsed = parseBoardProjectId(id)
  if (!('present' in parsed) || !parsed.present || !parsed.value) {
    throw new Error(`invalid boardProjectId: ${id}`)
  }
  return parsed.value
}

export function projectContextDir(boardProjectId: string): string {
  return paths.projectDir(assertBoardId(boardProjectId))
}

export function projectSkillsDir(boardProjectId: string): string {
  return paths.projectSkillsDir(assertBoardId(boardProjectId))
}

export function projectIdSpawnEnv(projectId: string | null | undefined): Record<string, string> {
  const id = typeof projectId === 'string' ? projectId.trim() : ''
  if (!id || !BOARD_PROJECT_ID_RE.test(id)) return {}
  return { [PROJECT_ID_ENV]: id.toLowerCase() }
}

async function withProjectLock<T>(boardProjectId: string, fn: () => Promise<T>): Promise<T> {
  const id = assertBoardId(boardProjectId)
  mkdirSync(paths.projectDir(id), { recursive: true, mode: 0o700 })
  const release = await acquireFileLock(paths.projectLock(id))
  try {
    return await fn()
  } finally {
    await release()
  }
}

function parseMeta(raw: string, boardProjectId: string): ProjectContextMeta {
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectContextMeta>
    if (parsed.schemaVersion !== 1) return emptyMeta(boardProjectId)
    const version = Number(parsed.version)
    return {
      schemaVersion: 1,
      boardProjectId,
      key: typeof parsed.key === 'string' ? parsed.key : undefined,
      version: Number.isFinite(version) && version >= 0 ? Math.floor(version) : 0,
      updatedAt: Number(parsed.updatedAt) || Date.now(),
      instructionsSha256:
        typeof parsed.instructionsSha256 === 'string' ? parsed.instructionsSha256 : null,
      skillOverlay: Array.isArray(parsed.skillOverlay)
        ? parsed.skillOverlay.filter((n): n is string => typeof n === 'string')
        : [],
      promotion: {
        schemaVersion: 1,
        manifestSha256:
          parsed.promotion && typeof parsed.promotion.manifestSha256 === 'string'
            ? parsed.promotion.manifestSha256
            : null,
      },
      instructionsSeed: parsed.instructionsSeed?.from === 'chat_project'
        ? { from: 'chat_project', at: Number(parsed.instructionsSeed.at) || Date.now() }
        : null,
    }
  } catch {
    return emptyMeta(boardProjectId)
  }
}

async function readMetaUnlocked(boardProjectId: string): Promise<ProjectContextMeta> {
  const id = assertBoardId(boardProjectId)
  try {
    const raw = await readFile(paths.projectMeta(id), 'utf8')
    return parseMeta(raw, id)
  } catch {
    return emptyMeta(id)
  }
}

async function writeFileAtomic(target: string, body: string, mode = 0o600): Promise<void> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.tmp-${randomUUID()}`
  await writeFile(tmp, body, { encoding: 'utf8', mode })
  chmodSync(tmp, mode)
  await rename(tmp, target)
}

async function persistMetaUnlocked(meta: ProjectContextMeta): Promise<void> {
  await writeFileAtomic(paths.projectMeta(meta.boardProjectId), `${JSON.stringify(meta, null, 2)}\n`)
}

/** Monotonic bump for official instruction/memory/skill/workspace changes. */
export async function incrementProjectContextVersion(boardProjectId: string): Promise<number> {
  const id = assertBoardId(boardProjectId)
  return withProjectLock(id, async () => {
    const meta = await readMetaUnlocked(id)
    const next: ProjectContextMeta = {
      ...meta,
      version: meta.version + 1,
      updatedAt: Date.now(),
    }
    await persistMetaUnlocked(next)
    return next.version
  })
}

export async function loadProjectContext(boardProjectId: string): Promise<ProjectContextSnapshot> {
  const id = assertBoardId(boardProjectId)
  return withProjectLock(id, async () => {
    const meta = await readMetaUnlocked(id)
    let instructions: string | null = null
    try {
      const raw = await readFile(paths.projectInstructionsFile(id), 'utf8')
      const trimmed = clipProjectInstructions(raw)
      instructions = trimmed ? trimmed : null
    } catch {
      instructions = null
    }
    return { boardProjectId: id, version: meta.version, instructions, skillOverlay: meta.skillOverlay, meta }
  })
}

export function clipProjectInstructions(raw: string): string {
  const cleaned = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<!-- oc-project-instructions:(start|end) -->/g, '')
  const trimmed = cleaned.trim()
  return trimmed.length > PROJECT_INSTRUCTIONS_MAX ? trimmed.slice(0, PROJECT_INSTRUCTIONS_MAX) : trimmed
}

export async function writeProjectInstructions(
  boardProjectId: string,
  instructions: string | null,
  expectedVersion: number,
  opts: { seedFromChat?: boolean; key?: string } = {},
): Promise<ProjectContextWriteResult> {
  const parsed = parseBoardProjectId(boardProjectId)
  if (!('present' in parsed) || !parsed.present || !parsed.value) {
    return { ok: false, error: 'invalid_id' }
  }
  const id = parsed.value
  if (instructions != null && typeof instructions !== 'string') {
    return { ok: false, error: 'invalid_instructions' }
  }
  const body = instructions == null ? '' : clipProjectInstructions(instructions)
  if (instructions != null && instructions.trim() !== '' && !body) {
    return { ok: false, error: 'invalid_instructions' }
  }
  return withProjectLock(id, async () => {
    const meta = await readMetaUnlocked(id)
    if (meta.version !== expectedVersion) {
      return { ok: false, error: 'version_conflict', current: meta.version }
    }
    const file = paths.projectInstructionsFile(id)
    if (body) await writeFileAtomic(file, `${body}\n`)
    else {
      try {
        await rm(file, { force: true })
      } catch {
        /* absent is fine */
      }
    }
    const next: ProjectContextMeta = {
      ...meta,
      key: opts.key ?? meta.key,
      version: meta.version + 1,
      updatedAt: Date.now(),
      instructionsSha256: body ? sha256Hex(body) : null,
      instructionsSeed: opts.seedFromChat
        ? { from: 'chat_project', at: Date.now() }
        : meta.instructionsSeed,
    }
    await persistMetaUnlocked(next)
    return {
      ok: true,
      snapshot: {
        boardProjectId: id,
        version: next.version,
        instructions: body || null,
        skillOverlay: next.skillOverlay,
        meta: next,
      },
    }
  })
}

/**
 * One-time seed: copy unbound chat instructions into PROJECT.md iff the file
 * is still empty. Not a dual-write loop — later PG edits are ignored.
 */
export async function seedProjectInstructionsIfEmpty(
  boardProjectId: string,
  sourceInstructions: string | null | undefined,
  key?: string,
): Promise<ProjectContextSnapshot> {
  const current = await loadProjectContext(boardProjectId)
  if (current.instructions) return current
  const body = sourceInstructions ? clipProjectInstructions(sourceInstructions) : ''
  if (!body) {
    if (key && !current.meta.key) {
      await withProjectLock(boardProjectId, async () => {
        const meta = await readMetaUnlocked(boardProjectId)
        if (!meta.key) {
          meta.key = key
          await persistMetaUnlocked(meta)
        }
      })
    }
    return current
  }
  const written = await writeProjectInstructions(boardProjectId, body, current.version, {
    seedFromChat: true,
    key,
  })
  if (written.ok) return written.snapshot
  return loadProjectContext(boardProjectId)
}

export async function setProjectSkillOverlay(
  boardProjectId: string,
  names: string[],
  expectedVersion: number,
): Promise<ProjectContextWriteResult> {
  const parsed = parseBoardProjectId(boardProjectId)
  if (!('present' in parsed) || !parsed.present || !parsed.value) {
    return { ok: false, error: 'invalid_id' }
  }
  const id = parsed.value
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))]
  return withProjectLock(id, async () => {
    const meta = await readMetaUnlocked(id)
    if (meta.version !== expectedVersion) {
      return { ok: false, error: 'version_conflict', current: meta.version }
    }
    const next: ProjectContextMeta = {
      ...meta,
      version: meta.version + 1,
      updatedAt: Date.now(),
      skillOverlay: unique,
    }
    await persistMetaUnlocked(next)
    let instructions: string | null = null
    try {
      instructions = clipProjectInstructions(await readFile(paths.projectInstructionsFile(id), 'utf8')) || null
    } catch {
      instructions = null
    }
    return {
      ok: true,
      snapshot: {
        boardProjectId: id,
        version: next.version,
        instructions,
        skillOverlay: next.skillOverlay,
        meta: next,
      },
    }
  })
}

export interface CwdResolution {
  ok: true
  cwd: string
  spec: ProjectWorkspace
}

export interface CwdRejection {
  ok: false
  error:
    | 'escaped_prefix'
    | 'symlink_escape'
    | 'not_directory'
    | 'project_data_root'
    | 'relative_path'
    | 'invalid_id'
  detail: string
}

const FORBIDDEN_DATA_SEGMENTS = ['git-creds', 'projects']

function homeRealpath(): string {
  return existsSync(paths.home) ? realpathSync(paths.home) : resolve(paths.home)
}

export function allowedWorkspaceRoots(home = paths.home): string[] {
  return [join(home, 'workspace'), join(home, 'repos')]
}

function isForbiddenDataPath(real: string, homeReal: string): boolean {
  const dataRoot = join(homeReal, 'projects')
  if (real === dataRoot || real.startsWith(dataRoot + sep)) return true
  for (const seg of FORBIDDEN_DATA_SEGMENTS) {
    const p = join(homeReal, seg)
    if (real === p || real.startsWith(p + sep)) return true
  }
  return false
}

export function resolveProjectCwd(
  spec: ProjectWorkspace | null | undefined,
  boardProjectId: string,
  env: NodeJS.ProcessEnv = process.env,
): CwdResolution | CwdRejection {
  const parsed = parseBoardProjectId(boardProjectId)
  if (!('present' in parsed) || !parsed.present || !parsed.value) {
    return { ok: false, error: 'invalid_id', detail: 'boardProjectId is not a uuid' }
  }
  const id = parsed.value
  const effective: ProjectWorkspace = spec ?? { kind: 'default' }
  if (effective.kind === 'default') {
    const ws = env.OPENCLAUDE_DEFAULT_WORKSPACE?.trim()
    const cwd = ws && existsSync(ws) ? ws : process.cwd()
    return { ok: true, cwd, spec: effective }
  }
  if (effective.kind === 'isolated') {
    const dir = paths.workspaceProjectDir(id)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const real = realpathSync(dir)
    const check = assertAllowedCwd(real)
    if (!check.ok) return check
    return { ok: true, cwd: real, spec: effective }
  }
  return resolveContainerPathCwd(effective.path)
}

export function assertAllowedCwd(candidate: string): CwdResolution | CwdRejection {
  if (!isAbsolute(candidate)) {
    return { ok: false, error: 'relative_path', detail: candidate }
  }
  let real: string
  try {
    real = realpathSync(candidate)
  } catch {
    return { ok: false, error: 'not_directory', detail: candidate }
  }
  const homeReal = homeRealpath()
  if (isForbiddenDataPath(real, homeReal)) {
    return { ok: false, error: 'project_data_root', detail: real }
  }
  const allowed = allowedWorkspaceRoots(homeReal)
  const ok = allowed.some((root) => {
    const rootReal = existsSync(root) ? realpathSync(root) : resolve(root)
    return real === rootReal || real.startsWith(rootReal + sep)
  })
  if (!ok) return { ok: false, error: 'escaped_prefix', detail: real }
  return { ok: true, cwd: real, spec: { kind: 'container_path', path: real } }
}

function resolveContainerPathCwd(inputPath: string): CwdResolution | CwdRejection {
  if (!isAbsolute(inputPath)) {
    return { ok: false, error: 'relative_path', detail: inputPath }
  }
  let lexical = resolve(inputPath)
  let real: string
  try {
    if (!existsSync(lexical)) {
      return { ok: false, error: 'not_directory', detail: lexical }
    }
    real = realpathSync(lexical)
  } catch {
    return { ok: false, error: 'symlink_escape', detail: inputPath }
  }
  if (real !== lexical && dirname(real) !== dirname(lexical)) {
    // realpath already collapses; still reject if it left allowed roots
  }
  const allowed = assertAllowedCwd(real)
  if (!allowed.ok) {
    if (allowed.error === 'escaped_prefix' && existsSync(inputPath)) {
      try {
        const st = realpathSync(inputPath)
        if (st !== inputPath) return { ok: false, error: 'symlink_escape', detail: inputPath }
      } catch {
        return { ok: false, error: 'symlink_escape', detail: inputPath }
      }
    }
    return allowed
  }
  return allowed
}

export function assetsRevision(assets: Array<{ updatedAt?: number; createdAt?: number }>): number {
  let max = 0
  for (const a of assets) {
    const n = Number(a.updatedAt ?? a.createdAt ?? 0)
    if (Number.isFinite(n) && n > max) max = n
  }
  return max
}

/** Copy a shared skill directory into the project overlay (no global sidecar mutation). */
export async function copySkillIntoProjectOverlay(
  boardProjectId: string,
  skillName: string,
  sourceDir: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const id = assertBoardId(boardProjectId)
  const destRoot = paths.projectSkillsDir(id)
  const dest = join(destRoot, skillName)
  if (!isAbsolute(sourceDir) || !existsSync(sourceDir)) {
    return { ok: false, error: 'source_missing' }
  }
  const realSource = realpathSync(sourceDir)
  mkdirSync(destRoot, { recursive: true, mode: 0o700 })
  await rm(dest, { recursive: true, force: true })
  await cpDir(realSource, dest)
  try {
    await rm(join(dest, '.openclaude-agent-scope.json'), { force: true })
  } catch {
    /* overlay is visible to the run agent without global sidecar */
  }
  return { ok: true }
}

async function cpDir(src: string, dest: string): Promise<void> {
  const { cp } = await import('node:fs/promises')
  await cp(src, dest, { recursive: true, dereference: true })
}

export function isUniqueConstraintError(err: unknown, indexHint: string): boolean {
  const anyErr = err as { code?: string; message?: string }
  if (anyErr?.code === 'SQLITE_CONSTRAINT_UNIQUE' || anyErr?.code === '23505') return true
  const msg = String(anyErr?.message ?? err)
  return msg.includes(indexHint) || msg.toLowerCase().includes('unique constraint')
}
