/**
 * SQLite sessions store: chat projects (CRUD, soft delete / restore, templates, bindings, project instructions, session meta patch) and project assets (versions, search, pinned injection).
 *
 * Moved verbatim out of sessionsDb.ts — FINDINGS §8 (cc2), OCV5-485. sessionsDb.ts
 * imports these back and re-exports its former exports, so its import surface is unchanged.
 */
import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { assetsRevision, isUniqueConstraintError, parseBoardProjectId } from './projectContext.js'
import { getSessionsDb, escapeLikePattern } from './sessionsDb.js'

export const CHAT_PROJECT_NAME_MAX = 60

export const CHAT_PROJECT_INSTRUCTIONS_MAX = 4000

export const CHAT_PROJECT_COLOR_MAX = 24

export const CHAT_PROJECT_PER_USER_LIMIT = 100

export type ChatProject = {
  id: string
  name: string
  instructions: string | null
  color: string | null
  sortOrder: number
  createdAt: number
  updatedAt: number
  sessionCount: number
  boardProjectId: string | null
  archivedAt: number | null
  pinnedAt: number | null
  template: ChatProjectTemplate | null
}

/** Decides the default workspace of a new project; null for projects created before templates. */
export const CHAT_PROJECT_TEMPLATES = ['blank', 'repo', 'research', 'writing'] as const

export type ChatProjectTemplate = (typeof CHAT_PROJECT_TEMPLATES)[number]

export function parseChatProjectTemplate(value: unknown): ChatProjectTemplate | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null
  return typeof value === 'string' && (CHAT_PROJECT_TEMPLATES as readonly string[]).includes(value)
    ? (value as ChatProjectTemplate)
    : 'invalid'
}

export type ChatProjectCreateError =
  | 'limit_exceeded'
  | 'invalid_name'
  | 'invalid_instructions'
  | 'invalid_color'
  | 'invalid_template'

export type ChatProjectUpdateError =
  | 'not_found'
  | 'invalid_name'
  | 'invalid_instructions'
  | 'invalid_color'
  | 'invalid_sort_order'
  | 'invalid_board_project_id'
  | 'board_project_bound'
  | 'invalid_flag'

export type ChatProjectDeleteError = 'not_found'

export type ChatProjectRestoreError =
  | 'not_found'
  | 'expired'
  | 'limit_exceeded'
  | 'board_project_bound'

/** A deleted project can be restored this long after deletion. */
export const CHAT_PROJECT_RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/**
 * What a delete unlinked, kept on the project row so a restore can put it
 * back. pausedCronJobIds are the jobs the client paused (fenced) before the
 * delete; a restore hands them back to be re-enabled.
 */
export type ChatProjectDeletedManifest = {
  sessionIds: string[]
  assetIds: string[]
  pausedCronJobIds: string[]
  at: number
}

export type ChatProjectRestoreResult =
  | {
      ok: true
      project: ChatProject
      pausedCronJobIds: string[]
      relinkedSessions: number
      relinkedSessionIds: string[]
      relinkedAssets: number
    }
  | { ok: false; error: ChatProjectRestoreError }

export type DeletedChatProject = {
  id: string
  name: string
  deletedAt: number
  sessionCount: number
}

export function parseDeletedManifest(raw: unknown): ChatProjectDeletedManifest {
  try {
    const m = (
      typeof raw === 'string' ? JSON.parse(raw) : raw
    ) as Partial<ChatProjectDeletedManifest> | null
    const ids = (x: unknown) =>
      Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string') : []
    return {
      sessionIds: ids(m?.sessionIds),
      assetIds: ids(m?.assetIds),
      pausedCronJobIds: ids(m?.pausedCronJobIds),
      at: Number(m?.at) || 0,
    }
  } catch {
    return { sessionIds: [], assetIds: [], pausedCronJobIds: [], at: 0 }
  }
}

export type ChatProjectCreateResult =
  | { ok: true; project: ChatProject }
  | { ok: false; error: ChatProjectCreateError }

export type ChatProjectUpdateResult =
  | { ok: true; project: ChatProject }
  | { ok: false; error: ChatProjectUpdateError }

export type ChatProjectDeleteResult = { ok: true } | { ok: false; error: ChatProjectDeleteError }

export const PROJECT_ASSET_NAME_MAX = 200

export const PROJECT_ASSET_EXCERPT_MAX = 2000

export const PROJECT_ASSET_MIME_MAX = 128

export const PROJECT_ASSET_SESSION_ID_MAX = 128

export const PROJECT_ASSET_PER_PROJECT_LIMIT = 500

export const PROJECT_ASSET_LIST_LIMIT_DEFAULT = 200

export const PROJECT_ASSET_LIST_LIMIT_MAX = 500

export const PROJECT_ASSET_PINNED_INJECT_MAX = 20

export const PROJECT_ASSET_URL_RE = /^\/api\/media\/[0-9a-f]{64}\.[A-Za-z0-9]{1,32}$/

export const PROJECT_ASSET_CONTAINER_PREFIXES = [
  '/home/agent/.openclaude/uploads/',
  '/home/agent/.openclaude/generated/',
] as const

// biome-ignore lint/suspicious/noControlCharactersInRegex: moved verbatim from sessionsDb.ts (OCV5-485)
export const PROJECT_ASSET_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

export type ProjectAssetSource = 'upload' | 'output'

export type ProjectAsset = {
  id: string
  projectId: string | null
  source: ProjectAssetSource
  sessionId: string | null
  name: string
  url: string | null
  containerPath: string | null
  mime: string | null
  sizeBytes: number | null
  digest: string | null
  excerpt: string | null
  pinned: boolean
  createdAt: number
  updatedAt: number
  /**
   * 产出物版本数:只出现在 list 结果里,且只在同一源路径(container_path)有 >1 个
   * 未删版本时给出。list 对每个源路径只回最新版本那一行。
   */
  versionCount?: number
}

export type ProjectAssetCreateError =
  | 'limit_exceeded'
  | 'invalid_name'
  | 'invalid_source'
  | 'invalid_url'
  | 'invalid_container_path'
  | 'invalid_locator'
  | 'invalid_digest'
  | 'invalid_mime'
  | 'invalid_size'
  | 'invalid_session'
  | 'invalid_captured_at'
  | 'project_not_found'

export type ProjectAssetUpdateError =
  | 'not_found'
  | 'invalid_name'
  | 'project_not_found'
  | 'limit_exceeded'

export type ProjectAssetDeleteError = 'not_found'

export type ProjectAssetCreateResult =
  | { ok: true; asset: ProjectAsset; created: boolean }
  | { ok: false; error: ProjectAssetCreateError }

export type ProjectAssetUpdateResult =
  | { ok: true; asset: ProjectAsset }
  | { ok: false; error: ProjectAssetUpdateError }

export type ProjectAssetDeleteResult = { ok: true } | { ok: false; error: ProjectAssetDeleteError }

export type ListProjectAssetsOpts = {
  projectId: string | null
  limit?: number
}

/** Cross-project search (Cmd+K): name/excerpt substring over the caller's non-deleted assets. */
export type SearchProjectAssetsOpts = {
  q: string
  source?: ProjectAssetSource
  limit?: number
}

export const PROJECT_ASSET_SEARCH_LIMIT_DEFAULT = 20

export const PROJECT_ASSET_SEARCH_LIMIT_MAX = 50

export const PROJECT_ASSET_SEARCH_QUERY_MAX = 200

export type ProjectAssetCreateInput = {
  projectId?: unknown
  source?: unknown
  sessionId?: unknown
  name?: unknown
  url?: unknown
  containerPath?: unknown
  mime?: unknown
  size?: unknown
  digest?: unknown
  excerpt?: unknown
  pinned?: unknown
  /**
   * 产出物:容器读到这份字节时源文件的 mtime(ms)。只用来认出重放的旧登记,
   * 不落库。缺省(旧容器 / 恢复 / 回填工具)= 只和最新版本比。
   */
  capturedAt?: unknown
}

export type ProjectAssetUpdateInput = {
  pinned?: unknown
  name?: unknown
  projectId?: unknown
}

export type ParsedProjectAssetCreate = {
  projectIdPresent: boolean
  projectId: string | null
  source: ProjectAssetSource
  sessionId: string | null
  name: string
  url: string | null
  containerPath: string | null
  mime: string | null
  sizeBytes: number | null
  digest: string | null
  excerpt: string | null
  pinned: boolean
  capturedAt: number | null
}

export type ClientSessionMetaPatch = {
  title?: string
  modelId?: string
  projectId?: string | null
  pinned?: boolean
  archived?: boolean
}

export const PROJECT_INSTRUCTIONS_INJECT_MAX = 4000

/** 去掉破坏提示结构的控制字符,截断到注入上限。 */
export function sanitizeProjectInstructions(raw: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: moved verbatim from sessionsDb.ts (OCV5-485)
  const cleaned = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  return cleaned.length > PROJECT_INSTRUCTIONS_INJECT_MAX
    ? cleaned.slice(0, PROJECT_INSTRUCTIONS_INJECT_MAX)
    : cleaned
}

export type PatchClientSessionMetaResult =
  | { ok: true; updatedAt: number }
  | { ok: false; error: 'not_found' | 'project_not_found' }

export function parseChatProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.trim()
  return name.length >= 1 && name.length <= CHAT_PROJECT_NAME_MAX ? name : null
}

/** undefined = 未提供;null = 合法清空;invalid 由调用方映射 400。 */
export function parseChatProjectOptionalText(
  value: unknown,
  maxLen: number,
): { present: false } | { present: true; value: string | null } | { invalid: true } {
  if (value === undefined) return { present: false }
  if (value === null) return { present: true, value: null }
  if (typeof value !== 'string') return { invalid: true }
  const trimmed = value.trim()
  if (trimmed.length > maxLen) return { invalid: true }
  return { present: true, value: trimmed.length === 0 ? null : trimmed }
}

export function parseChatProjectSortOrder(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isSafeInteger(value))
    return null
  return value
}

export function stripProjectAssetControlChars(raw: string): string {
  return raw.replace(PROJECT_ASSET_CONTROL_CHARS, '')
}

export function parseProjectAssetName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = stripProjectAssetControlChars(value).trim()
  return name.length >= 1 && name.length <= PROJECT_ASSET_NAME_MAX ? name : null
}

export function parseProjectAssetSource(value: unknown): ProjectAssetSource | null {
  return value === 'upload' || value === 'output' ? value : null
}

export function parseProjectAssetUrl(
  value: unknown,
): { present: false } | { present: true; value: string } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (typeof value !== 'string') return { invalid: true }
  const url = value.trim()
  if (url.length === 0) return { present: false }
  return PROJECT_ASSET_URL_RE.test(url) ? { present: true, value: url } : { invalid: true }
}

export function parseProjectAssetContainerPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const path = value.trim()
  if (
    !path ||
    path.includes('..') ||
    stripProjectAssetControlChars(path) !== path ||
    /\s/.test(path)
  ) {
    return null
  }
  const matched = PROJECT_ASSET_CONTAINER_PREFIXES.some((prefix) => {
    if (!path.startsWith(prefix)) return false
    const rest = path.slice(prefix.length)
    return rest.length > 0 && !rest.includes('..')
  })
  return matched ? path : null
}

export function parseProjectAssetOptionalContainerPath(
  value: unknown,
): { present: false } | { present: true; value: string } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (typeof value !== 'string') return { invalid: true }
  if (value.trim().length === 0) return { present: false }
  const parsed = parseProjectAssetContainerPath(value)
  return parsed ? { present: true, value: parsed } : { invalid: true }
}

export function parseProjectAssetDigest(
  value: unknown,
): { present: false } | { present: true; value: string } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (typeof value !== 'string') return { invalid: true }
  const digest = value.trim().toLowerCase()
  if (digest.length === 0) return { present: false }
  return /^[0-9a-f]{64}$/.test(digest) ? { present: true, value: digest } : { invalid: true }
}

export function parseProjectAssetMime(
  value: unknown,
): { present: false } | { present: true; value: string } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (typeof value !== 'string') return { invalid: true }
  const mime = stripProjectAssetControlChars(value).trim()
  if (mime.length === 0) return { present: false }
  if (mime.length > PROJECT_ASSET_MIME_MAX || mime.includes('\n') || mime.includes('\r'))
    return { invalid: true }
  return { present: true, value: mime }
}

export function parseProjectAssetSize(
  value: unknown,
): { present: false } | { present: true; value: number } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    return { invalid: true }
  }
  return { present: true, value }
}

export function parseProjectAssetSessionId(
  value: unknown,
): { present: false } | { present: true; value: string } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (typeof value !== 'string') return { invalid: true }
  const id = stripProjectAssetControlChars(value).trim()
  if (id.length === 0) return { present: false }
  if (id.length > PROJECT_ASSET_SESSION_ID_MAX || id.includes('..') || /\s/.test(id))
    return { invalid: true }
  return { present: true, value: id }
}

export function parseProjectAssetProjectId(
  value: unknown,
): { present: false } | { present: true; value: string | null } | { invalid: true } {
  if (value === undefined) return { present: false }
  if (value === null) return { present: true, value: null }
  if (typeof value !== 'string') return { invalid: true }
  const id = value.trim()
  if (id.length === 0 || id === 'none') return { present: true, value: null }
  if (id.length < 8 || id.length > 64) return { invalid: true }
  return { present: true, value: id }
}

export function parseProjectAssetExcerpt(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const excerpt = stripProjectAssetControlChars(value).trim()
  if (!excerpt) return null
  return excerpt.length > PROJECT_ASSET_EXCERPT_MAX
    ? excerpt.slice(0, PROJECT_ASSET_EXCERPT_MAX)
    : excerpt
}

export function digestFromProjectAssetUrl(url: string): string | null {
  const m = url.match(/^\/api\/media\/([0-9a-f]{64})\./)
  return m ? m[1] : null
}

export function parseProjectAssetCreateInput(
  input: ProjectAssetCreateInput,
): { ok: true; value: ParsedProjectAssetCreate } | { ok: false; error: ProjectAssetCreateError } {
  const name = parseProjectAssetName(input.name)
  if (!name) return { ok: false, error: 'invalid_name' }
  const source = parseProjectAssetSource(input.source)
  if (!source) return { ok: false, error: 'invalid_source' }
  const projectId = parseProjectAssetProjectId(input.projectId)
  if ('invalid' in projectId) return { ok: false, error: 'project_not_found' }
  const url = parseProjectAssetUrl(input.url)
  if ('invalid' in url) return { ok: false, error: 'invalid_url' }
  const containerPath = parseProjectAssetOptionalContainerPath(input.containerPath)
  if ('invalid' in containerPath) return { ok: false, error: 'invalid_container_path' }
  const urlValue = url.present ? url.value : null
  const containerValue = containerPath.present ? containerPath.value : null
  if (!urlValue && !containerValue) return { ok: false, error: 'invalid_locator' }
  const digest = parseProjectAssetDigest(input.digest)
  if ('invalid' in digest) return { ok: false, error: 'invalid_digest' }
  const mime = parseProjectAssetMime(input.mime)
  if ('invalid' in mime) return { ok: false, error: 'invalid_mime' }
  const size = parseProjectAssetSize(input.size)
  if ('invalid' in size) return { ok: false, error: 'invalid_size' }
  const sessionId = parseProjectAssetSessionId(input.sessionId)
  if ('invalid' in sessionId) return { ok: false, error: 'invalid_session' }
  const capturedAt = parseProjectAssetCapturedAt(input.capturedAt)
  if ('invalid' in capturedAt) return { ok: false, error: 'invalid_captured_at' }
  let digestValue = digest.present ? digest.value : null
  if (!digestValue && urlValue) digestValue = digestFromProjectAssetUrl(urlValue)
  return {
    ok: true,
    value: {
      projectIdPresent: projectId.present,
      projectId: projectId.present ? projectId.value : null,
      source,
      sessionId: sessionId.present ? sessionId.value : null,
      name,
      url: urlValue,
      containerPath: containerValue,
      mime: mime.present ? mime.value : null,
      sizeBytes: size.present ? size.value : null,
      digest: digestValue,
      excerpt: parseProjectAssetExcerpt(input.excerpt),
      pinned: input.pinned === true,
      capturedAt: capturedAt.present ? capturedAt.value : null,
    },
  }
}

export function parseProjectAssetCapturedAt(
  value: unknown,
): { present: false } | { present: true; value: number } | { invalid: true } {
  if (value === undefined || value === null) return { present: false }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return { invalid: true }
  return { present: true, value }
}

type ChatProjectDbRow = {
  id: string
  name: string
  instructions: string | null
  color: string | null
  sort_order: number
  created_at: number
  updated_at: number
  session_count: number
  board_project_id: string | null
  archived_at: number | null
  pinned_at: number | null
  template: string | null
}

function _mapChatProjectRow(r: ChatProjectDbRow): ChatProject {
  return {
    id: r.id,
    name: r.name,
    instructions: r.instructions,
    color: r.color,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    sessionCount: r.session_count,
    boardProjectId: r.board_project_id ?? null,
    archivedAt: r.archived_at ?? null,
    pinnedAt: r.pinned_at ?? null,
    template: (() => {
      const t = parseChatProjectTemplate(r.template)
      return t === 'invalid' ? null : t
    })(),
  }
}

const CHAT_PROJECT_SELECT = `
  SELECT p.id, p.name, p.instructions, p.color, p.sort_order, p.created_at, p.updated_at,
         p.board_project_id, p.archived_at, p.pinned_at, p.template, COALESCE(c.cnt, 0) AS session_count
    FROM chat_projects p
    LEFT JOIN (
      SELECT project_id, COUNT(*) AS cnt
        FROM client_sessions
       WHERE user_id = ? AND deleted_at IS NULL AND project_id IS NOT NULL
       GROUP BY project_id
    ) c ON c.project_id = p.id
`

function _sqliteReadChatProject(
  db: Database.Database,
  userId: string,
  id: string,
): ChatProject | null {
  const row = db
    .prepare(`${CHAT_PROJECT_SELECT} WHERE p.id = ? AND p.user_id = ? AND p.deleted_at IS NULL`)
    .get(userId, id, userId) as ChatProjectDbRow | undefined
  return row ? _mapChatProjectRow(row) : null
}

export async function _sqliteListChatProjects(userId: string): Promise<ChatProject[]> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(
      `${CHAT_PROJECT_SELECT}
      WHERE p.user_id = ? AND p.deleted_at IS NULL
      ORDER BY p.sort_order ASC, p.created_at ASC`,
    )
    .all(userId, userId) as ChatProjectDbRow[]
  return rows.map(_mapChatProjectRow)
}

export async function _sqliteCreateChatProject(
  userId: string,
  input: {
    name?: unknown
    instructions?: unknown
    color?: unknown
    isResearchDefault?: unknown
    template?: unknown
    /** Reserve the work-project id now (project layer on): the container creates that board on first use. */
    reserveBoard?: boolean
  },
): Promise<ChatProjectCreateResult> {
  const name = parseChatProjectName(input.name)
  if (!name) return { ok: false, error: 'invalid_name' }
  const instructions = parseChatProjectOptionalText(
    input.instructions,
    CHAT_PROJECT_INSTRUCTIONS_MAX,
  )
  if ('invalid' in instructions) return { ok: false, error: 'invalid_instructions' }
  const color = parseChatProjectOptionalText(input.color, CHAT_PROJECT_COLOR_MAX)
  if ('invalid' in color) return { ok: false, error: 'invalid_color' }
  const template = parseChatProjectTemplate(input.template)
  if (template === 'invalid') return { ok: false, error: 'invalid_template' }
  const isDefault = input.isResearchDefault === true
  const boardProjectId = input.reserveBoard === true && !isDefault ? randomUUID() : null

  const db = await getSessionsDb()
  const now = Date.now()
  const id = randomUUID()
  const txn = db.transaction((): ChatProjectCreateResult => {
    const countRow = db
      .prepare('SELECT COUNT(*) AS n FROM chat_projects WHERE user_id = ? AND deleted_at IS NULL')
      .get(userId) as { n: number }
    if (countRow.n >= CHAT_PROJECT_PER_USER_LIMIT) return { ok: false, error: 'limit_exceeded' }
    try {
      db.prepare(`
        INSERT INTO chat_projects
          (id, user_id, name, instructions, color, sort_order, created_at, updated_at, deleted_at,
           is_research_default, template, board_project_id)
        VALUES (?, ?, ?, ?, ?, COALESCE((
          SELECT MAX(sort_order) + 1 FROM chat_projects WHERE user_id = ? AND deleted_at IS NULL
        ), 0), ?, ?, NULL, ?, ?, ?)
      `).run(
        id,
        userId,
        name,
        instructions.present ? instructions.value : null,
        color.present ? color.value : null,
        userId,
        now,
        now,
        isDefault ? 1 : 0,
        template,
        boardProjectId,
      )
    } catch (err) {
      if (isDefault && isUniqueConstraintError(err, 'idx_chat_projects_user_research_default')) {
        const existing = db
          .prepare(
            'SELECT id FROM chat_projects WHERE user_id = ? AND is_research_default = 1 AND deleted_at IS NULL',
          )
          .get(userId) as { id: string } | undefined
        if (existing) {
          const project = _sqliteReadChatProject(db, userId, existing.id)
          if (project) return { ok: true, project }
        }
      }
      throw err
    }
    const project = _sqliteReadChatProject(db, userId, id)
    if (!project) throw new Error('chat project insert vanished')
    return { ok: true, project }
  })
  return txn()
}

export async function _sqliteUpdateChatProject(
  userId: string,
  id: string,
  input: {
    name?: unknown
    instructions?: unknown
    color?: unknown
    sortOrder?: unknown
    boardProjectId?: unknown
    archived?: unknown
    pinned?: unknown
  },
): Promise<ChatProjectUpdateResult> {
  const sets: string[] = ['updated_at = MAX(updated_at + 1, ?)']
  const params: unknown[] = [Date.now()]
  let bindGuard: string | null = null
  if (input.archived !== undefined) {
    if (typeof input.archived !== 'boolean') return { ok: false, error: 'invalid_flag' }
    sets.push(input.archived ? 'archived_at = COALESCE(archived_at, ?)' : 'archived_at = NULL')
    if (input.archived) params.push(Date.now())
  }
  if (input.pinned !== undefined) {
    if (typeof input.pinned !== 'boolean') return { ok: false, error: 'invalid_flag' }
    sets.push(input.pinned ? 'pinned_at = COALESCE(pinned_at, ?)' : 'pinned_at = NULL')
    if (input.pinned) params.push(Date.now())
  }
  if (input.name !== undefined) {
    const name = parseChatProjectName(input.name)
    if (!name) return { ok: false, error: 'invalid_name' }
    sets.push('name = ?')
    params.push(name)
  }
  if (input.instructions !== undefined) {
    const instructions = parseChatProjectOptionalText(
      input.instructions,
      CHAT_PROJECT_INSTRUCTIONS_MAX,
    )
    if ('invalid' in instructions || !instructions.present)
      return { ok: false, error: 'invalid_instructions' }
    const existing = await _sqliteGetChatProjectForUser(userId, id)
    const nextBoard =
      input.boardProjectId !== undefined
        ? parseBoardProjectId(input.boardProjectId)
        : { present: true as const, value: existing?.boardProjectId ?? null }
    const boundAfter =
      'present' in nextBoard &&
      nextBoard.present &&
      typeof nextBoard.value === 'string' &&
      nextBoard.value.length > 0
    if (!boundAfter) {
      sets.push('instructions = ?')
      params.push(instructions.value)
    }
  }
  if (input.color !== undefined) {
    const color = parseChatProjectOptionalText(input.color, CHAT_PROJECT_COLOR_MAX)
    if ('invalid' in color || !color.present) return { ok: false, error: 'invalid_color' }
    sets.push('color = ?')
    params.push(color.value)
  }
  if (input.sortOrder !== undefined) {
    const sortOrder = parseChatProjectSortOrder(input.sortOrder)
    if (sortOrder === null) return { ok: false, error: 'invalid_sort_order' }
    sets.push('sort_order = ?')
    params.push(sortOrder)
  }
  if (input.boardProjectId !== undefined) {
    const bound = parseBoardProjectId(input.boardProjectId)
    if ('invalid' in bound) return { ok: false, error: 'invalid_board_project_id' }
    if (bound.present) {
      // A project keeps its work project for life: memory, skills, cron and
      // billing history hang off that id. Only an unbound project may bind;
      // enforced in the UPDATE itself so concurrent binds cannot both win.
      if (bound.value === null) return { ok: false, error: 'board_project_bound' }
      sets.push('board_project_id = ?')
      params.push(bound.value)
      bindGuard = bound.value
    }
  }
  if (sets.length === 1) {
    const existing = await _sqliteGetChatProjectForUser(userId, id)
    return existing ? { ok: true, project: existing } : { ok: false, error: 'not_found' }
  }
  const db = await getSessionsDb()
  const txn = db.transaction((): ChatProjectUpdateResult => {
    let res: Database.RunResult
    try {
      res = db
        .prepare(
          `UPDATE chat_projects SET ${sets.join(', ')}
          WHERE id = ? AND user_id = ? AND deleted_at IS NULL${
            bindGuard ? ' AND (board_project_id IS NULL OR board_project_id = ?)' : ''
          }`,
        )
        .run(...params, id, userId, ...(bindGuard ? [bindGuard] : []))
    } catch (err) {
      if (isUniqueConstraintError(err, 'idx_chat_projects_user_board')) {
        return { ok: false, error: 'board_project_bound' }
      }
      throw err
    }
    if (res.changes === 0) {
      const exists = bindGuard
        ? db
            .prepare(
              'SELECT 1 FROM chat_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
            )
            .get(id, userId)
        : null
      return { ok: false, error: exists ? 'board_project_bound' : 'not_found' }
    }
    const project = _sqliteReadChatProject(db, userId, id)
    if (!project) return { ok: false, error: 'not_found' }
    return { ok: true, project }
  })
  return txn()
}

async function _sqliteGetChatProjectForUser(
  userId: string,
  id: string,
): Promise<ChatProject | null> {
  const db = await getSessionsDb()
  return _sqliteReadChatProject(db, userId, id)
}

export async function _sqliteDeleteChatProject(
  userId: string,
  id: string,
  opts: { pausedCronJobIds?: string[] } = {},
): Promise<ChatProjectDeleteResult> {
  const db = await getSessionsDb()
  const now = Date.now()
  const txn = db.transaction((): ChatProjectDeleteResult => {
    const live = db
      .prepare('SELECT 1 FROM chat_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL')
      .get(id, userId)
    if (!live) return { ok: false, error: 'not_found' }
    // Mark deleted first: from here no new session/asset can be filed into it.
    db.prepare(
      `UPDATE chat_projects SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    ).run(now, now, id, userId)
    // The manifest is exactly the set these UPDATEs unlinked.
    const sessionIds = (
      db
        .prepare(
          `UPDATE client_sessions SET project_id = NULL, updated_at = MAX(updated_at + 1, ?)
        WHERE user_id = ? AND project_id = ? AND deleted_at IS NULL RETURNING id`,
        )
        .all(now, userId, id) as Array<{ id: string }>
    ).map((r) => r.id)
    const assetIds = (
      db
        .prepare(
          `UPDATE project_assets SET project_id = NULL, updated_at = MAX(updated_at + 1, ?)
        WHERE user_id = ? AND project_id = ? AND deleted_at IS NULL RETURNING id`,
        )
        .all(now, userId, id) as Array<{ id: string }>
    ).map((r) => r.id)
    const manifest: ChatProjectDeletedManifest = {
      sessionIds,
      assetIds,
      pausedCronJobIds: opts.pausedCronJobIds ?? [],
      at: now,
    }
    db.prepare('UPDATE chat_projects SET deleted_manifest = ? WHERE id = ? AND user_id = ?').run(
      JSON.stringify(manifest),
      id,
      userId,
    )
    return { ok: true }
  })
  return txn()
}

export async function _sqliteListDeletedChatProjects(
  userId: string,
): Promise<DeletedChatProject[]> {
  const db = await getSessionsDb()
  const since = Date.now() - CHAT_PROJECT_RESTORE_WINDOW_MS
  const rows = db
    .prepare(
      `SELECT id, name, deleted_at, deleted_manifest FROM chat_projects
      WHERE user_id = ? AND deleted_at IS NOT NULL AND deleted_at >= ? AND is_research_default = 0
      ORDER BY deleted_at DESC`,
    )
    .all(userId, since) as Array<{
    id: string
    name: string
    deleted_at: number
    deleted_manifest: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    deletedAt: r.deleted_at,
    sessionCount: parseDeletedManifest(r.deleted_manifest).sessionIds.length,
  }))
}

export async function _sqliteRestoreChatProject(
  userId: string,
  id: string,
): Promise<ChatProjectRestoreResult> {
  const db = await getSessionsDb()
  const now = Date.now()
  const txn = db.transaction((): ChatProjectRestoreResult => {
    const row = db
      .prepare(
        `SELECT deleted_at, deleted_manifest, board_project_id FROM chat_projects
        WHERE id = ? AND user_id = ? AND deleted_at IS NOT NULL`,
      )
      .get(id, userId) as
      | { deleted_at: number; deleted_manifest: string | null; board_project_id: string | null }
      | undefined
    if (!row) return { ok: false, error: 'not_found' }
    if (now - row.deleted_at > CHAT_PROJECT_RESTORE_WINDOW_MS)
      return { ok: false, error: 'expired' }
    const count = db
      .prepare('SELECT COUNT(*) AS n FROM chat_projects WHERE user_id = ? AND deleted_at IS NULL')
      .get(userId) as { n: number }
    if (count.n >= CHAT_PROJECT_PER_USER_LIMIT) return { ok: false, error: 'limit_exceeded' }
    if (row.board_project_id) {
      const taken = db
        .prepare(
          'SELECT 1 FROM chat_projects WHERE user_id = ? AND board_project_id = ? AND deleted_at IS NULL',
        )
        .get(userId, row.board_project_id)
      if (taken) return { ok: false, error: 'board_project_bound' }
    }
    const manifest = parseDeletedManifest(row.deleted_manifest)
    db.prepare(
      `UPDATE chat_projects SET deleted_at = NULL, deleted_manifest = NULL, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? AND user_id = ?`,
    ).run(now, id, userId)
    // Only items still ungrouped come back; anything the user moved since stays where it is.
    const relinkedSessionIds: string[] = []
    const relinkSession = db.prepare(
      `UPDATE client_sessions SET project_id = ?, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? AND user_id = ? AND project_id IS NULL AND deleted_at IS NULL`,
    )
    for (const sid of manifest.sessionIds) {
      if (relinkSession.run(id, now, sid, userId).changes > 0) relinkedSessionIds.push(sid)
    }
    let relinkedAssets = 0
    const relinkAsset = db.prepare(
      `UPDATE project_assets SET project_id = ?, updated_at = MAX(updated_at + 1, ?)
        WHERE id = ? AND user_id = ? AND project_id IS NULL AND deleted_at IS NULL`,
    )
    for (const aid of manifest.assetIds)
      relinkedAssets += relinkAsset.run(id, now, aid, userId).changes
    const project = _sqliteReadChatProject(db, userId, id)
    if (!project) throw new Error('restored chat project vanished')
    return {
      ok: true,
      project,
      pausedCronJobIds: manifest.pausedCronJobIds,
      relinkedSessions: relinkedSessionIds.length,
      relinkedSessionIds,
      relinkedAssets,
    }
  })
  return txn()
}

export async function _sqlitePatchClientSessionMeta(
  id: string,
  userId: string,
  patch: ClientSessionMetaPatch,
): Promise<PatchClientSessionMetaResult> {
  const db = await getSessionsDb()
  const now = Date.now()
  const txn = db.transaction((): PatchClientSessionMetaResult => {
    const ownedSession = db
      .prepare(
        'SELECT 1 AS ok FROM client_sessions WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
      )
      .get(id, userId) as { ok: number } | undefined
    if (!ownedSession) return { ok: false, error: 'not_found' }
    if (patch.projectId !== undefined && patch.projectId !== null) {
      const owned = db
        .prepare(
          'SELECT 1 AS ok FROM chat_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
        )
        .get(patch.projectId, userId) as { ok: number } | undefined
      if (!owned) return { ok: false, error: 'project_not_found' }
    }
    const sets: string[] = ['updated_at = MAX(updated_at + 1, ?)']
    const params: unknown[] = [now]
    if (patch.title !== undefined) {
      sets.push('title = ?')
      params.push(patch.title)
    }
    if (patch.modelId !== undefined) {
      sets.push('model_id = ?')
      params.push(patch.modelId)
    }
    if (patch.projectId !== undefined) {
      sets.push('project_id = ?')
      params.push(patch.projectId)
    }
    if (patch.pinned !== undefined) {
      sets.push('pinned = ?')
      params.push(patch.pinned ? 1 : 0)
    }
    if (patch.archived !== undefined) {
      sets.push('archived_at = ?')
      params.push(patch.archived ? now : null)
    }
    const row = db
      .prepare(
        `UPDATE client_sessions SET ${sets.join(', ')}
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL
        RETURNING updated_at`,
      )
      .get(...params, id, userId) as { updated_at: number } | undefined
    if (!row) return { ok: false, error: 'not_found' }
    // OCV5-624 / UX C02: outputs registered while the session was ungrouped (or in
    // another project) keep project_assets.project_id frozen at create time. Moving
    // the session must rehome those rows or ProjectHome stays empty and search
    // still labels them「未分类」.
    if (patch.projectId !== undefined) {
      db.prepare(
        `UPDATE project_assets SET project_id = ?, updated_at = MAX(updated_at + 1, ?)
          WHERE user_id = ? AND session_id = ? AND deleted_at IS NULL`,
      ).run(patch.projectId, now, userId, id)
    }
    return { ok: true, updatedAt: row.updated_at }
  })
  return txn()
}

export async function _sqliteGetSessionProjectInstructions(
  sessionId: string,
): Promise<string | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare(`
    SELECT p.instructions
      FROM client_sessions cs
      JOIN chat_projects p ON p.id = cs.project_id AND p.user_id = cs.user_id
     WHERE cs.id = ? AND cs.deleted_at IS NULL AND p.deleted_at IS NULL
  `)
    .get(sessionId) as { instructions: string | null } | undefined
  if (!row?.instructions) return null
  const cleaned = sanitizeProjectInstructions(row.instructions).trim()
  return cleaned.length > 0 ? cleaned : null
}

export type ChatProjectRuntimeBind = {
  userId: string
  chatProjectId: string
  boardProjectId: string | null
  name: string
  instructions: string | null
  template?: ChatProjectTemplate | null
}

function _bindTemplate(raw: string | null | undefined): ChatProjectTemplate | null {
  const t = parseChatProjectTemplate(raw)
  return t === 'invalid' ? null : t
}

export async function _sqliteGetChatProjectBindBySessionId(
  sessionId: string,
): Promise<ChatProjectRuntimeBind | null> {
  const db = await getSessionsDb()
  const row = db
    .prepare(`
    SELECT cs.user_id AS user_id, p.id AS chat_project_id, p.board_project_id AS board_project_id,
           p.name AS name, p.instructions AS instructions, p.template AS template
      FROM client_sessions cs
      JOIN chat_projects p ON p.id = cs.project_id AND p.user_id = cs.user_id
     WHERE cs.id = ? AND cs.deleted_at IS NULL AND p.deleted_at IS NULL
  `)
    .get(sessionId) as
    | {
        user_id: string
        chat_project_id: string
        board_project_id: string | null
        name: string
        instructions: string | null
        template: string | null
      }
    | undefined
  if (!row) return null
  return {
    userId: row.user_id,
    chatProjectId: row.chat_project_id,
    boardProjectId: row.board_project_id ?? null,
    name: row.name,
    instructions: row.instructions,
    template: _bindTemplate(row.template),
  }
}

export async function _sqliteGetChatProjectBindByBoardProjectId(
  userId: string,
  boardProjectId: string,
): Promise<ChatProjectRuntimeBind | null> {
  const parsed = parseBoardProjectId(boardProjectId)
  if (!('present' in parsed) || !parsed.present || !parsed.value) return null
  const db = await getSessionsDb()
  const row = db
    .prepare(`
    SELECT user_id, id, board_project_id, name, instructions, template
      FROM chat_projects
     WHERE user_id = ? AND board_project_id = ? AND deleted_at IS NULL
  `)
    .get(userId, parsed.value) as
    | {
        user_id: string
        id: string
        board_project_id: string | null
        name: string
        instructions: string | null
        template: string | null
      }
    | undefined
  if (!row) return null
  return {
    userId: row.user_id,
    chatProjectId: row.id,
    boardProjectId: row.board_project_id ?? null,
    name: row.name,
    instructions: row.instructions,
    template: _bindTemplate(row.template),
  }
}

export type PinnedAssetsPage = { assets: ProjectAsset[]; revision: number }

export async function _sqliteListPinnedProjectAssetsForChatProject(
  userId: string,
  chatProjectId: string | null,
): Promise<PinnedAssetsPage> {
  const db = await getSessionsDb()
  const rows = db
    .prepare(
      `${PROJECT_ASSET_SELECT}
      WHERE user_id = ? AND deleted_at IS NULL AND pinned = 1 AND project_id IS ?
        AND ${SQLITE_ASSET_IS_LATEST_VERSION}
      ORDER BY created_at DESC
      LIMIT ?`,
    )
    .all(userId, chatProjectId, PROJECT_ASSET_PINNED_INJECT_MAX) as ProjectAssetDbRow[]
  const assets = rows.map(_mapProjectAssetRow)
  return { assets, revision: assetsRevision(assets) }
}

type ProjectAssetDbRow = {
  id: string
  project_id: string | null
  source: string
  session_id: string | null
  name: string
  url: string | null
  container_path: string | null
  mime: string | null
  size_bytes: number | null
  digest: string | null
  excerpt: string | null
  pinned: number | boolean
  created_at: number
  updated_at: number
}

const PROJECT_ASSET_SELECT = `
  SELECT id, project_id, source, session_id, name, url, container_path, mime,
         size_bytes, digest, excerpt, pinned, created_at, updated_at
    FROM project_assets
`

/**
 * 「是该源路径的最新版本」(上传与无源路径的行恒为真)。注入常用资产时只认最新版本,
 * 旧数据里残留的旧版本 pinned 不会被注入。顺序与 list 的 created_at DESC, id DESC 一致。
 */
const SQLITE_ASSET_IS_LATEST_VERSION = `NOT EXISTS (
  SELECT 1 FROM project_assets newer
   WHERE project_assets.source = 'output' AND project_assets.container_path IS NOT NULL
     AND newer.user_id = project_assets.user_id AND newer.deleted_at IS NULL
     AND newer.source = 'output' AND newer.project_id IS project_assets.project_id
     AND newer.container_path = project_assets.container_path
     AND (newer.created_at > project_assets.created_at
          OR (newer.created_at = project_assets.created_at AND newer.id > project_assets.id)))`

/** list 折叠版本用的分组键;SQLite / PG 同一表达式。 */
export const PROJECT_ASSET_VERSION_GROUP_SQL =
  "CASE WHEN source = 'output' AND container_path IS NOT NULL THEN 'p:' || container_path ELSE 'i:' || id END"

/** versionCount 只在有多个版本时出现,单版本的行形状与以前一致。 */
export function withVersionCount(asset: ProjectAsset, count: number): ProjectAsset {
  return Number.isFinite(count) && count > 1 ? { ...asset, versionCount: count } : asset
}

function _mapProjectAssetRow(r: ProjectAssetDbRow): ProjectAsset {
  return {
    id: r.id,
    projectId: r.project_id ?? null,
    source: r.source === 'output' ? 'output' : 'upload',
    sessionId: r.session_id ?? null,
    name: r.name,
    url: r.url ?? null,
    containerPath: r.container_path ?? null,
    mime: r.mime ?? null,
    sizeBytes: r.size_bytes ?? null,
    digest: r.digest ?? null,
    excerpt: r.excerpt ?? null,
    pinned: r.pinned === 1 || r.pinned === true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function _sqliteReadProjectAsset(
  db: Database.Database,
  userId: string,
  id: string,
): ProjectAsset | null {
  const row = db
    .prepare(`${PROJECT_ASSET_SELECT} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`)
    .get(id, userId) as ProjectAssetDbRow | undefined
  return row ? _mapProjectAssetRow(row) : null
}

function _sqliteOwnedChatProjectExists(
  db: Database.Database,
  userId: string,
  projectId: string,
): boolean {
  const row = db
    .prepare(
      'SELECT 1 AS ok FROM chat_projects WHERE id = ? AND user_id = ? AND deleted_at IS NULL',
    )
    .get(projectId, userId) as { ok: number } | undefined
  return !!row
}

function _sqliteCountProjectAssets(
  db: Database.Database,
  userId: string,
  projectId: string | null,
): number {
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM project_assets WHERE user_id = ? AND deleted_at IS NULL AND project_id IS ?',
    )
    .get(userId, projectId) as { n: number }
  return row.n
}

/** 同一项目里某个产出源路径的最新未删版本(无则 null)。 */
function _sqliteLatestOutputVersion(
  db: Database.Database,
  userId: string,
  projectId: string | null,
  containerPath: string,
): ProjectAsset | null {
  const row = db
    .prepare(
      `${PROJECT_ASSET_SELECT}
      WHERE user_id = ? AND deleted_at IS NULL AND source = 'output' AND project_id IS ? AND container_path = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    )
    .get(userId, projectId, containerPath) as ProjectAssetDbRow | undefined
  return row ? _mapProjectAssetRow(row) : null
}

/**
 * 去重规则(PG 侧 pgFindDuplicateAsset 同构):
 *   - 带字节副本的产出(output + containerPath + digest):先与该源路径的**最新**版本比。
 *     digest 相同 = 同一版本(返回它);不同 = 新版本(返回 null,由调用方插入)。
 *     A→B→A 会得到第三个版本,「恢复旧版本」也是同一条路:用旧 digest 再登记一次。
 *     例外是重放:登记带 capturedAt(源文件 mtime),且它不晚于最新版本的 created_at,
 *     而这个 digest 已是某个旧版本 —— 那是早先那次登记的重发(响应丢了、队列补发),
 *     返回那个旧版本,不出新版本。真的又写回 A 时 mtime 晚于最新版本,照常出新版本。
 *   - 其它(上传、旧容器只报路径的产出):同 (user, project, source, digest),
 *     digest 空则同 container_path,与以前一致。
 */
function _sqliteFindDuplicateAsset(
  db: Database.Database,
  userId: string,
  projectId: string | null,
  source: ProjectAssetSource,
  digest: string | null,
  containerPath: string | null,
  capturedAt: number | null,
): ProjectAsset | null {
  if (source === 'output' && containerPath && digest) {
    const latest = _sqliteLatestOutputVersion(db, userId, projectId, containerPath)
    if (!latest) return null
    if (latest.digest === digest) return latest
    if (capturedAt !== null && capturedAt <= latest.createdAt) {
      const row = db
        .prepare(
          `${PROJECT_ASSET_SELECT}
          WHERE user_id = ? AND deleted_at IS NULL AND source = 'output' AND project_id IS ?
            AND container_path = ? AND digest = ?
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        )
        .get(userId, projectId, containerPath, digest) as ProjectAssetDbRow | undefined
      if (row) return _mapProjectAssetRow(row)
    }
    return null
  }
  if (digest) {
    const row = db
      .prepare(
        `${PROJECT_ASSET_SELECT}
        WHERE user_id = ? AND deleted_at IS NULL AND source = ? AND project_id IS ? AND digest = ?
        LIMIT 1`,
      )
      .get(userId, source, projectId, digest) as ProjectAssetDbRow | undefined
    return row ? _mapProjectAssetRow(row) : null
  }
  if (containerPath) {
    const row = db
      .prepare(
        `${PROJECT_ASSET_SELECT}
        WHERE user_id = ? AND deleted_at IS NULL AND source = ? AND project_id IS ? AND container_path = ?
        LIMIT 1`,
      )
      .get(userId, source, projectId, containerPath) as ProjectAssetDbRow | undefined
    return row ? _mapProjectAssetRow(row) : null
  }
  return null
}

function _sqliteResolveAssetProjectId(
  db: Database.Database,
  userId: string,
  parsed: ParsedProjectAssetCreate,
): { ok: true; projectId: string | null } | { ok: false; error: ProjectAssetCreateError } {
  let projectId = parsed.projectIdPresent ? parsed.projectId : null
  if (!parsed.projectIdPresent && parsed.sessionId) {
    const sess = db
      .prepare(
        'SELECT user_id, project_id FROM client_sessions WHERE id = ? AND deleted_at IS NULL',
      )
      .get(parsed.sessionId) as { user_id: string; project_id: string | null } | undefined
    if (sess?.user_id === userId) projectId = sess.project_id ?? null
  }
  if (projectId !== null && !_sqliteOwnedChatProjectExists(db, userId, projectId)) {
    return { ok: false, error: 'project_not_found' }
  }
  return { ok: true, projectId }
}

export async function _sqliteListProjectAssets(
  userId: string,
  opts: ListProjectAssetsOpts,
): Promise<ProjectAsset[]> {
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(PROJECT_ASSET_LIST_LIMIT_MAX, Math.floor(opts.limit))
      : PROJECT_ASSET_LIST_LIMIT_DEFAULT
  const db = await getSessionsDb()
  // 产出物按源路径折叠成一条(最新版本)并带版本数;上传与无源路径的行各自成组。
  const rows = db
    .prepare(
      `SELECT id, project_id, source, session_id, name, url, container_path, mime,
            size_bytes, digest, excerpt, pinned, created_at, updated_at, version_count
       FROM (
         SELECT *,
                ROW_NUMBER() OVER (PARTITION BY ${PROJECT_ASSET_VERSION_GROUP_SQL}
                                   ORDER BY created_at DESC, id DESC) AS version_rank,
                COUNT(*) OVER (PARTITION BY ${PROJECT_ASSET_VERSION_GROUP_SQL}) AS version_count
           FROM project_assets
          WHERE user_id = ? AND deleted_at IS NULL AND project_id IS ?
       ) AS versioned
      WHERE version_rank = 1
      ORDER BY created_at DESC
      LIMIT ?`,
    )
    .all(userId, opts.projectId, limit) as Array<ProjectAssetDbRow & { version_count: number }>
  return rows.map((r) => withVersionCount(_mapProjectAssetRow(r), Number(r.version_count)))
}

export async function _sqliteListProjectAssetVersions(
  userId: string,
  assetId: string,
): Promise<ProjectAsset[] | null> {
  const db = await getSessionsDb()
  const asset = _sqliteReadProjectAsset(db, userId, assetId)
  if (!asset) return null
  if (asset.source !== 'output' || !asset.containerPath) return [asset]
  const rows = db
    .prepare(
      `${PROJECT_ASSET_SELECT}
      WHERE user_id = ? AND deleted_at IS NULL AND source = 'output' AND project_id IS ? AND container_path = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    )
    .all(
      userId,
      asset.projectId,
      asset.containerPath,
      PROJECT_ASSET_PER_PROJECT_LIMIT,
    ) as ProjectAssetDbRow[]
  return rows.map(_mapProjectAssetRow)
}

export async function _sqliteSearchProjectAssets(
  userId: string,
  opts: SearchProjectAssetsOpts,
): Promise<ProjectAsset[]> {
  const q = typeof opts.q === 'string' ? opts.q.trim().slice(0, PROJECT_ASSET_SEARCH_QUERY_MAX) : ''
  if (!q) return []
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(PROJECT_ASSET_SEARCH_LIMIT_MAX, Math.floor(opts.limit))
      : PROJECT_ASSET_SEARCH_LIMIT_DEFAULT
  const like = `%${escapeLikePattern(q)}%`
  const sourceSql = opts.source === 'upload' || opts.source === 'output' ? ' AND source = ?' : ''
  const params: unknown[] = [userId, userId, like, like]
  if (sourceSql) params.push(opts.source)
  params.push(limit)
  const db = await getSessionsDb()
  // SQLite LIKE is ASCII case-insensitive by default; CJK has no case.
  // Outputs fold to their latest version (per project and source path), as in listProjectAssets.
  const rows = db
    .prepare(
      `${PROJECT_ASSET_SELECT}
      WHERE user_id = ? AND deleted_at IS NULL
        AND id IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY project_id, ${PROJECT_ASSET_VERSION_GROUP_SQL}
                                          ORDER BY created_at DESC, id DESC) AS version_rank
              FROM project_assets WHERE user_id = ? AND deleted_at IS NULL
          ) WHERE version_rank = 1
        )
        AND (name LIKE ? ESCAPE '\\' OR COALESCE(excerpt, '') LIKE ? ESCAPE '\\')${sourceSql}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    )
    .all(...params) as ProjectAssetDbRow[]
  return rows.map(_mapProjectAssetRow)
}

export async function _sqliteCreateProjectAsset(
  userId: string,
  input: ProjectAssetCreateInput,
): Promise<ProjectAssetCreateResult> {
  const parsed = parseProjectAssetCreateInput(input)
  if (!parsed.ok) return parsed
  const db = await getSessionsDb()
  const now = Date.now()
  const id = randomUUID()
  const txn = db.transaction((): ProjectAssetCreateResult => {
    const resolved = _sqliteResolveAssetProjectId(db, userId, parsed.value)
    if (!resolved.ok) return resolved
    const { projectId } = resolved
    const dup = _sqliteFindDuplicateAsset(
      db,
      userId,
      projectId,
      parsed.value.source,
      parsed.value.digest,
      parsed.value.containerPath,
      parsed.value.capturedAt,
    )
    if (dup) return { ok: true, asset: dup, created: false }
    if (_sqliteCountProjectAssets(db, userId, projectId) >= PROJECT_ASSET_PER_PROJECT_LIMIT) {
      return { ok: false, error: 'limit_exceeded' }
    }
    // 同一源路径的版本按 created_at 排序,新版本严格晚于上一版(同毫秒也不并列)。
    // 带 capturedAt 的产出版本以「文件写成的时间」为 created_at(不晚于现在):重放判断
    // 拿 capturedAt 和它比,比的是同一种时间;补发队列晚到的登记不会把之后的真实重写挤成「重放」。
    // 「常用」只挂在最新版本上:新版本(登记或恢复)继承上一版的 pinned,旧版本一律取消。
    const versionBase =
      parsed.value.source === 'output' && parsed.value.capturedAt !== null
        ? Math.min(parsed.value.capturedAt, now)
        : now
    let createdAt = versionBase
    let pinned = parsed.value.pinned
    if (parsed.value.source === 'output' && parsed.value.containerPath) {
      const latest = _sqliteLatestOutputVersion(db, userId, projectId, parsed.value.containerPath)
      if (latest) {
        createdAt = Math.max(versionBase, latest.createdAt + 1)
        pinned = pinned || latest.pinned
        db.prepare(
          `UPDATE project_assets SET pinned = 0, updated_at = MAX(updated_at + 1, ?)
            WHERE user_id = ? AND deleted_at IS NULL AND source = 'output' AND project_id IS ?
              AND container_path = ? AND pinned = 1`,
        ).run(now, userId, projectId, parsed.value.containerPath)
      }
    }
    // 只插索引行,绝不写/删磁盘文件(内容寻址,可能被其它消息/资产共用)。
    db.prepare(`
      INSERT INTO project_assets (
        id, user_id, project_id, source, session_id, name, url, container_path,
        mime, size_bytes, digest, excerpt, pinned, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      id,
      userId,
      projectId,
      parsed.value.source,
      parsed.value.sessionId,
      parsed.value.name,
      parsed.value.url,
      parsed.value.containerPath,
      parsed.value.mime,
      parsed.value.sizeBytes,
      parsed.value.digest,
      parsed.value.excerpt,
      pinned ? 1 : 0,
      createdAt,
      Math.max(now, createdAt),
    )
    const asset = _sqliteReadProjectAsset(db, userId, id)
    if (!asset) throw new Error('project asset insert vanished')
    return { ok: true, asset, created: true }
  })
  return txn()
}

export async function _sqliteUpdateProjectAsset(
  userId: string,
  assetId: string,
  patch: ProjectAssetUpdateInput,
): Promise<ProjectAssetUpdateResult> {
  const sets: string[] = ['updated_at = MAX(updated_at + 1, ?)']
  const params: unknown[] = [Date.now()]
  let nextProjectId: { present: true; value: string | null } | undefined
  if (patch.name !== undefined) {
    const name = parseProjectAssetName(patch.name)
    if (!name) return { ok: false, error: 'invalid_name' }
    sets.push('name = ?')
    params.push(name)
  }
  if (patch.pinned !== undefined) {
    if (typeof patch.pinned !== 'boolean') return { ok: false, error: 'invalid_name' }
    sets.push('pinned = ?')
    params.push(patch.pinned ? 1 : 0)
  }
  if (patch.projectId !== undefined) {
    const parsed = parseProjectAssetProjectId(patch.projectId)
    if ('invalid' in parsed) return { ok: false, error: 'project_not_found' }
    nextProjectId = { present: true, value: parsed.present ? parsed.value : null }
    sets.push('project_id = ?')
    params.push(nextProjectId.value)
  }
  if (sets.length === 1) {
    const db = await getSessionsDb()
    const existing = _sqliteReadProjectAsset(db, userId, assetId)
    return existing ? { ok: true, asset: existing } : { ok: false, error: 'not_found' }
  }
  const db = await getSessionsDb()
  const txn = db.transaction((): ProjectAssetUpdateResult => {
    const existing = _sqliteReadProjectAsset(db, userId, assetId)
    if (!existing) return { ok: false, error: 'not_found' }
    if (nextProjectId) {
      if (
        nextProjectId.value !== null &&
        !_sqliteOwnedChatProjectExists(db, userId, nextProjectId.value)
      ) {
        return { ok: false, error: 'project_not_found' }
      }
      if (nextProjectId.value !== existing.projectId) {
        if (
          _sqliteCountProjectAssets(db, userId, nextProjectId.value) >=
          PROJECT_ASSET_PER_PROJECT_LIMIT
        ) {
          return { ok: false, error: 'limit_exceeded' }
        }
      }
    }
    const res = db
      .prepare(
        `UPDATE project_assets SET ${sets.join(', ')}
        WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
      )
      .run(...params, assetId, userId)
    if (res.changes === 0) return { ok: false, error: 'not_found' }
    const asset = _sqliteReadProjectAsset(db, userId, assetId)
    if (!asset) return { ok: false, error: 'not_found' }
    return { ok: true, asset }
  })
  return txn()
}

export async function _sqliteDeleteProjectAsset(
  userId: string,
  assetId: string,
): Promise<ProjectAssetDeleteResult> {
  const db = await getSessionsDb()
  const now = Date.now()
  // 软删只标 deleted_at,绝不 unlink 磁盘文件。
  const res = db
    .prepare(
      `UPDATE project_assets
        SET deleted_at = ?, updated_at = MAX(updated_at + 1, ?)
      WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, assetId, userId)
  return res.changes === 0 ? { ok: false, error: 'not_found' } : { ok: true }
}

export async function _sqliteListPinnedProjectAssetsForSession(
  sessionId: string,
): Promise<ProjectAsset[]> {
  const db = await getSessionsDb()
  const sess = db
    .prepare('SELECT user_id, project_id FROM client_sessions WHERE id = ? AND deleted_at IS NULL')
    .get(sessionId) as { user_id: string; project_id: string | null } | undefined
  if (!sess) return []
  const rows = db
    .prepare(
      `${PROJECT_ASSET_SELECT}
      WHERE user_id = ? AND deleted_at IS NULL AND pinned = 1 AND project_id IS ?
        AND ${SQLITE_ASSET_IS_LATEST_VERSION}
      ORDER BY created_at DESC
      LIMIT ?`,
    )
    .all(
      sess.user_id,
      sess.project_id ?? null,
      PROJECT_ASSET_PINNED_INJECT_MAX,
    ) as ProjectAssetDbRow[]
  return rows.map(_mapProjectAssetRow)
}

/**
 * project_search (agent tool): one chat project's non-deleted assets, matched by
 * name or excerpt substring. Outputs fold to their latest version first, so an
 * older version's text never surfaces. The caller resolves the chat project
 * from a verified identity; this only adds the user_id scope on top.
 */
export type SearchChatProjectAssetsOpts = {
  q: string
  source?: ProjectAssetSource
  limit?: number
}

export const PROJECT_ASSET_PROJECT_SEARCH_LIMIT_DEFAULT = 8

export const PROJECT_ASSET_PROJECT_SEARCH_LIMIT_MAX = 20

export const PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX = 200

/** Shared by both backends: null = nothing to search (empty query). */
export function normalizeChatProjectAssetSearch(
  opts: SearchChatProjectAssetsOpts,
): { like: string; limit: number; source: ProjectAssetSource | null } | null {
  const q =
    typeof opts.q === 'string' ? opts.q.trim().slice(0, PROJECT_ASSET_PROJECT_SEARCH_QUERY_MAX) : ''
  if (!q) return null
  const limit =
    typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0
      ? Math.min(PROJECT_ASSET_PROJECT_SEARCH_LIMIT_MAX, Math.floor(opts.limit))
      : PROJECT_ASSET_PROJECT_SEARCH_LIMIT_DEFAULT
  const source = opts.source === 'upload' || opts.source === 'output' ? opts.source : null
  return { like: `%${escapeLikePattern(q)}%`, limit, source }
}

export async function _sqliteSearchChatProjectAssets(
  userId: string,
  chatProjectId: string,
  opts: SearchChatProjectAssetsOpts,
): Promise<ProjectAsset[]> {
  const norm = normalizeChatProjectAssetSearch(opts)
  if (!norm || !chatProjectId) return []
  const params: unknown[] = [userId, chatProjectId, norm.like, norm.like]
  if (norm.source) params.push(norm.source)
  params.push(norm.limit)
  const db = await getSessionsDb()
  // SQLite LIKE is ASCII case-insensitive by default; CJK has no case.
  const rows = db
    .prepare(
      `SELECT id, project_id, source, session_id, name, url, container_path, mime,
            size_bytes, digest, excerpt, pinned, created_at, updated_at
       FROM (
         SELECT *,
                ROW_NUMBER() OVER (PARTITION BY ${PROJECT_ASSET_VERSION_GROUP_SQL}
                                   ORDER BY created_at DESC, id DESC) AS version_rank
           FROM project_assets
          WHERE user_id = ? AND deleted_at IS NULL AND project_id = ?
       ) AS versioned
      WHERE version_rank = 1
        AND (name LIKE ? ESCAPE '\\' OR COALESCE(excerpt, '') LIKE ? ESCAPE '\\')${norm.source ? ' AND source = ?' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT ?`,
    )
    .all(...params) as ProjectAssetDbRow[]
  return rows.map(_mapProjectAssetRow)
}
