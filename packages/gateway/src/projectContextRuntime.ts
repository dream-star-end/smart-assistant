/**
 * Resolve per-turn project context for promptSlots / patrol.
 * Master is the live source for bind + pinned assets; volume PROJECT.md is
 * the bound-instructions authority after a one-time seed.
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

export interface ResolvedTurnProjectContext {
  boardProjectId: string | null
  chatProjectId: string | null
  name: string | null
  instructions: string | null
  assets: ProjectAsset[]
  assetsRevision: number
  bound: boolean
}

export interface ResolveTurnProjectContextOpts {
  sessionId?: string
  boardProjectId?: string
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  timeoutMs?: number
}

interface MasterBody {
  userId?: string
  chatProjectId?: string | null
  boardProjectId?: string | null
  name?: string | null
  instructions?: string | null
  pinnedAssets?: ProjectAsset[]
  assetsRevision?: number
}

async function fetchMaster(
  query: string,
  opts: ResolveTurnProjectContextOpts,
): Promise<MasterBody | null> {
  const env = opts.env ?? process.env
  const baseUrl = env[ENV_MASTER_URL]
  const bearer = env[ENV_CONTAINER_TOKEN]
  if (!baseUrl || !bearer) return null
  const url = `${baseUrl.replace(/\/+$/, '')}${PROJECT_CONTEXT_PATH}?${query}`
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
    if (res.statusCode !== 200) return { pinnedAssets: [], assetsRevision: 0 }
    const text = await res.body.text()
    return JSON.parse(text) as MasterBody
  } catch {
    return { pinnedAssets: [], assetsRevision: 0 }
  } finally {
    clearTimeout(timer)
  }
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
  if (boardId) {
    if (hasMaster) {
      const remote = await fetchMaster(`boardProjectId=${encodeURIComponent(boardId)}`, opts)
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
      const remote = await fetchMaster(`sessionId=${encodeURIComponent(sessionId)}`, opts)
      const boundId = remote?.boardProjectId ? parseBoardProjectId(remote.boardProjectId) : { present: false as const }
      const id = 'present' in boundId && boundId.present ? boundId.value : null
      if (id) return hydrateBound(id, remote)
      return {
        boardProjectId: null,
        chatProjectId: remote?.chatProjectId ?? null,
        name: remote?.name ?? null,
        instructions: remote?.instructions ?? null,
        assets: remote?.pinnedAssets ?? [],
        assetsRevision: Number(remote?.assetsRevision) || 0,
        bound: false,
      }
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
