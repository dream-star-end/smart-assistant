/**
 * Resolve per-turn project context for promptSlots / patrol.
 * Master is the live source for bind + pinned assets; volume PROJECT.md is
 * the bound-instructions authority after a one-time seed.
 *
 * A failed master read is never treated as "this chat has no project": that
 * used to drop the binding, the instructions and the project cwd silently.
 * The read is retried once; if it still fails the result carries
 * `unavailable` and server.ts holds the turn before dispatch. A failed read
 * says nothing about membership, and a chat can be moved into a project at
 * any time, so no earlier "not in a project" answer can stand in for it.
 *
 * The prompt builder reads again when a runner spawns. Every turn passes the
 * server's read first and is held if that read fails, so a spawn always has
 * a successful read from its own turn: `reuseLastOnFailure` falls back to it
 * instead of building a prompt without the project.
 */
import {
  getChatProjectBindByBoardProjectId,
  getChatProjectBindBySessionId,
  isProjectContextEnabled,
  listPinnedProjectAssetsForChatProject,
  loadProjectContext,
  parseBoardProjectId,
  seedProjectInstructionsIfEmpty,
  type ProjectAsset,
} from '@openclaude/storage'
import { request as undiciRequest } from 'undici'

import { PROJECT_CONTEXT_PATH } from '@openclaude/protocol'
export { PROJECT_CONTEXT_PATH }
const ENV_MASTER_URL = 'OPENCLAUDE_V3_MASTER_BASE_URL'
const ENV_CONTAINER_TOKEN = 'OPENCLAUDE_V3_CONTAINER_TOKEN'
const FETCH_TIMEOUT_MS = 5_000
const FETCH_ATTEMPTS = 2
/** Session → latest successful session-scoped resolution (for reuseLastOnFailure). */
const LAST_RESOLVED_MAX = 2_000
const lastResolved = new Map<string, ResolvedTurnProjectContext>()

export type ProjectContextUnavailableReason =
  | 'timeout'
  | 'http_error'
  | 'network'
  | 'bad_response'
  /** The project's work project could not be created/read in this container. */
  | 'board_unavailable'

export interface ResolvedTurnProjectContext {
  boardProjectId: string | null
  chatProjectId: string | null
  name: string | null
  instructions: string | null
  assets: ProjectAsset[]
  assetsRevision: number
  bound: boolean
  /** Set when the master could not be read and the session is or may be in a project. */
  unavailable?: ProjectContextUnavailableReason
}

export interface ResolveTurnProjectContextOpts {
  sessionId?: string
  boardProjectId?: string
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  timeoutMs?: number
  /** Prompt building only: on a failed read, use this session's latest successful resolution. */
  reuseLastOnFailure?: boolean
}

interface MasterBody {
  userId?: string
  chatProjectId?: string | null
  boardProjectId?: string | null
  name?: string | null
  instructions?: string | null
  template?: string | null
  pinnedAssets?: ProjectAsset[]
  assetsRevision?: number
}

/** New boards of these templates get their own folder; blank and pre-template projects use the default workspace. */
const ISOLATED_TEMPLATES = new Set(['repo', 'research', 'writing'])

/**
 * The chat project reserved this work-project id in the master database; the
 * board lives in this container and is created here on first use. Only when
 * the master told us the project (name known) — a trusted cron override
 * without a master answer must already point at an existing board.
 */
async function ensureBoardForProject(boardProjectId: string, remote: MasterBody | null): Promise<boolean> {
  if (!remote?.name) return true
  try {
    const { ensureProjectById, getTaskboardDb } = await import('./taskboard/db/index.js')
    ensureProjectById(getTaskboardDb(), {
      id: boardProjectId,
      name: remote.name,
      workspaceSpec: remote.template && ISOLATED_TEMPLATES.has(remote.template) ? { kind: 'isolated' } : null,
    })
    return true
  } catch {
    return false
  }
}

type MasterRead = { ok: true; body: MasterBody } | { ok: false; reason: ProjectContextUnavailableReason }

async function fetchMasterOnce(url: string, bearer: string, opts: ResolveTurnProjectContextOpts): Promise<MasterRead> {
  const fetcher = opts.fetcher ?? undiciRequest
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetcher(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearer}` },
      signal: controller.signal,
    })
    if (res.statusCode !== 200) {
      await res.body.text().catch(() => '')
      return { ok: false, reason: 'http_error' }
    }
    const text = await res.body.text()
    const body = JSON.parse(text) as unknown
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, reason: 'bad_response' }
    return { ok: true, body: body as MasterBody }
  } catch (err) {
    if (controller.signal.aborted) return { ok: false, reason: 'timeout' }
    if (err instanceof SyntaxError) return { ok: false, reason: 'bad_response' }
    return { ok: false, reason: 'network' }
  } finally {
    clearTimeout(timer)
  }
}

async function fetchMaster(query: string, opts: ResolveTurnProjectContextOpts): Promise<MasterRead | null> {
  const env = opts.env ?? process.env
  const baseUrl = env[ENV_MASTER_URL]
  const bearer = env[ENV_CONTAINER_TOKEN]
  if (!baseUrl || !bearer) return null
  const url = `${baseUrl.replace(/\/+$/, '')}${PROJECT_CONTEXT_PATH}?${query}`
  let last: MasterRead = { ok: false, reason: 'network' }
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    last = await fetchMasterOnce(url, bearer, opts)
    if (last.ok) return last
  }
  return last
}

function rememberResolved(sessionId: string, value: ResolvedTurnProjectContext): ResolvedTurnProjectContext {
  lastResolved.delete(sessionId)
  lastResolved.set(sessionId, value)
  if (lastResolved.size > LAST_RESOLVED_MAX) {
    const oldest = lastResolved.keys().next().value
    if (oldest !== undefined) lastResolved.delete(oldest)
  }
  return value
}

/** Test seam. */
export function _resetProjectContextCacheForTest(): void {
  lastResolved.clear()
}

async function hydrateBound(
  boardProjectId: string,
  remote: MasterBody | null,
): Promise<ResolvedTurnProjectContext> {
  if (remote?.instructions) {
    await seedProjectInstructionsIfEmpty(boardProjectId, remote.instructions, remote.name ?? undefined)
  } else {
    await seedProjectInstructionsIfEmpty(boardProjectId, null, remote?.name ?? undefined)
  }
  const local = await loadProjectContext(boardProjectId)
  return {
    boardProjectId,
    chatProjectId: remote?.chatProjectId ?? null,
    name: remote?.name ?? null,
    instructions: local.instructions,
    assets: remote?.pinnedAssets ?? [],
    assetsRevision: Number(remote?.assetsRevision) || 0,
    bound: true,
  }
}

export async function resolveTurnProjectContext(
  opts: ResolveTurnProjectContextOpts,
): Promise<ResolvedTurnProjectContext | null> {
  if (!isProjectContextEnabled(opts.env ?? process.env)) return null
  const sessionId = opts.sessionId?.trim()
  const boardParsed = opts.boardProjectId ? parseBoardProjectId(opts.boardProjectId) : { present: false as const }
  const boardId =
    'present' in boardParsed && boardParsed.present && boardParsed.value ? boardParsed.value : null

  const env = opts.env ?? process.env
  const hasMaster = Boolean(env[ENV_MASTER_URL] && env[ENV_CONTAINER_TOKEN])

  // Trusted override (cron fixed / explicit board) wins over session bind.
  // The board id and PROJECT.md are local here, so a failed master read only
  // costs the pinned-asset index; the run still has its project.
  if (boardId) {
    if (hasMaster) {
      const read = await fetchMaster(`boardProjectId=${encodeURIComponent(boardId)}`, opts)
      const remote = read?.ok ? read.body : null
      // Only a board the master knows as a chat project's is created here.
      if (remote?.chatProjectId) await ensureBoardForProject(boardId, remote)
      return hydrateBound(boardId, remote)
    }
    const userId = process.env.OC_USER_ID?.trim() || 'default'
    const bind =
      (await getChatProjectBindByBoardProjectId(userId, boardId)) ??
      (userId !== 'default' ? await getChatProjectBindByBoardProjectId('default', boardId) : null)
    const pinned = bind
      ? await listPinnedProjectAssetsForChatProject(bind.userId, bind.chatProjectId)
      : { assets: [] as ProjectAsset[], revision: 0 }
    return hydrateBound(boardId, {
      chatProjectId: bind?.chatProjectId ?? null,
      boardProjectId: boardId,
      name: bind?.name ?? null,
      instructions: bind?.instructions ?? null,
      pinnedAssets: pinned.assets,
      assetsRevision: pinned.revision,
    })
  }

  if (hasMaster) {
    if (sessionId) {
      const read = await fetchMaster(`sessionId=${encodeURIComponent(sessionId)}`, opts)
      if (read && !read.ok) {
        const last = opts.reuseLastOnFailure ? lastResolved.get(sessionId) : undefined
        if (last) return last
        return {
          boardProjectId: null,
          chatProjectId: null,
          name: null,
          instructions: null,
          assets: [],
          assetsRevision: 0,
          bound: false,
          unavailable: read.reason,
        }
      }
      const remote = read?.ok ? read.body : null
      const boundId = remote?.boardProjectId ? parseBoardProjectId(remote.boardProjectId) : { present: false as const }
      const id = 'present' in boundId && boundId.present ? boundId.value : null
      if (id) {
        if (!(await ensureBoardForProject(id, remote))) {
          return {
            boardProjectId: null,
            chatProjectId: remote?.chatProjectId ?? null,
            name: remote?.name ?? null,
            instructions: null,
            assets: [],
            assetsRevision: 0,
            bound: false,
            unavailable: 'board_unavailable',
          }
        }
        return rememberResolved(sessionId, await hydrateBound(id, remote))
      }
      return rememberResolved(sessionId, {
        boardProjectId: null,
        chatProjectId: remote?.chatProjectId ?? null,
        name: remote?.name ?? null,
        instructions: remote?.instructions ?? null,
        assets: remote?.pinnedAssets ?? [],
        assetsRevision: Number(remote?.assetsRevision) || 0,
        bound: false,
      })
    }
    return null
  }

  // Personal / test: local sqlite backend.
  if (sessionId) {
    const bind = await getChatProjectBindBySessionId(sessionId)
    if (!bind) return null
    const pinned = await listPinnedProjectAssetsForChatProject(bind.userId, bind.chatProjectId)
    if (bind.boardProjectId) {
      return hydrateBound(bind.boardProjectId, {
        chatProjectId: bind.chatProjectId,
        boardProjectId: bind.boardProjectId,
        name: bind.name,
        instructions: bind.instructions,
        pinnedAssets: pinned.assets,
        assetsRevision: pinned.revision,
      })
    }
    return {
      boardProjectId: null,
      chatProjectId: bind.chatProjectId,
      name: bind.name,
      instructions: bind.instructions,
      assets: pinned.assets,
      assetsRevision: pinned.revision,
      bound: false,
    }
  }
  return null
}
