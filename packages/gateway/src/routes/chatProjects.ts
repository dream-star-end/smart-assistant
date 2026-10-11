/**
 * 侧栏聊天项目 HTTP 路由:/api/chat-projects、/api/chat-projects/:id、/api/chat-projects/:id/restore。
 * 从 Gateway._handleHttpAfterCommercial 原样搬出(OCV5-376 P2),见 ./httpIo.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  listChatProjects,
  createChatProject,
  isProjectContextEnabled,
  listDeletedChatProjects,
  parseChatProjectCronJobIds,
  restoreChatProject,
  updateChatProject,
  deleteChatProject,
  parseChatProjectName,
  parseChatProjectOptionalText,
  parseChatProjectSortOrder,
  CHAT_PROJECT_COLOR_MAX,
  CHAT_PROJECT_INSTRUCTIONS_MAX,
} from '@openclaude/storage'
import type { GatewayHttpIo } from './httpIo.js'

/** Returns true when the request was handled (a response was or will be sent). */
export function handleChatProjectsHttp(io: GatewayHttpIo, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  // 侧栏聊天项目(与 /api/board/projects 看板无关)。浏览器直打 gateway,与 /api/sessions/list 同平面。
  if (url.pathname === '/api/chat-projects') {
    const userId = io.getUserId(req)
    if (req.method === 'GET') {
      if (url.searchParams.get('deleted') === '1') {
        listDeletedChatProjects(userId)
          .then((projects) => io.sendJson(res, 200, { projects }))
          .catch(() => io.sendJson(res, 500, { error: 'list failed' }))
        return true
      }
      listChatProjects(userId)
        .then((projects) => io.sendJson(res, 200, { projects }))
        .catch(() => io.sendJson(res, 500, { error: 'list failed' }))
      return true
    }
    if (req.method === 'POST') {
      ;(async () => {
        let data: { name?: unknown; instructions?: unknown; color?: unknown }
        try {
          data = JSON.parse(await io.readBody(req, 16 * 1024))
        } catch {
          io.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        if (parseChatProjectName(data.name) === null) {
          io.sendJson(res, 400, { error: 'name required (1-60 chars)' })
          return
        }
        const instructions = parseChatProjectOptionalText(data.instructions, CHAT_PROJECT_INSTRUCTIONS_MAX)
        if ('invalid' in instructions) {
          io.sendJson(res, 400, { error: 'instructions invalid (max 4000 chars)' })
          return
        }
        const color = parseChatProjectOptionalText(data.color, CHAT_PROJECT_COLOR_MAX)
        if ('invalid' in color) {
          io.sendJson(res, 400, { error: 'color invalid (max 24 chars)' })
          return
        }
        // With the project layer on, every new project reserves its work-project id
        // now (the container creates that board on first use). Never client-controlled.
        const result = await createChatProject(userId, { ...data, reserveBoard: isProjectContextEnabled() })
        if (!result.ok) {
          if (result.error === 'limit_exceeded') {
            io.sendJson(res, 400, { error: 'project limit exceeded (max 100)' })
            return
          }
          io.sendJson(res, 400, { error: result.error.replace(/_/g, ' ') })
          return
        }
        io.sendJson(res, 200, { project: result.project })
      })().catch(() => io.sendJson(res, 500, { error: 'create failed' }))
      return true
    }
    io.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  const chatProjectRestore = url.pathname.match(/^\/api\/chat-projects\/([a-zA-Z0-9_-]{8,64})\/restore$/)
  if (chatProjectRestore) {
    if (req.method !== 'POST') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    restoreChatProject(io.getUserId(req), chatProjectRestore[1])
      .then((result) => {
        if (result.ok) {
          io.sendJson(res, 200, {
            project: result.project,
            pausedCronJobIds: result.pausedCronJobIds,
            relinkedSessions: result.relinkedSessions,
            relinkedSessionIds: result.relinkedSessionIds,
            relinkedAssets: result.relinkedAssets,
          })
          return
        }
        const status = result.error === 'not_found' ? 404 : result.error === 'expired' ? 410 : 409
        io.sendJson(res, status, { error: result.error.replace(/_/g, ' '), code: result.error })
      })
      .catch(() => io.sendJson(res, 500, { error: 'restore failed' }))
    return true
  }
  const chatProjectMatch = url.pathname.match(/^\/api\/chat-projects\/([a-zA-Z0-9_-]{8,64})$/)
  if (chatProjectMatch) {
    const projectId = chatProjectMatch[1]
    const userId = io.getUserId(req)
    if (req.method === 'PATCH') {
      ;(async () => {
        let data: {
          name?: unknown
          instructions?: unknown
          color?: unknown
          sortOrder?: unknown
          boardProjectId?: unknown
          archived?: unknown
          pinned?: unknown
        }
        try {
          data = JSON.parse(await io.readBody(req, 16 * 1024))
        } catch {
          io.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const hasName = data.name !== undefined
        const hasInstructions = data.instructions !== undefined
        const hasColor = data.color !== undefined
        const hasSort = data.sortOrder !== undefined
        const hasBoard = data.boardProjectId !== undefined
        const hasFlags = data.archived !== undefined || data.pinned !== undefined
        if (!hasName && !hasInstructions && !hasColor && !hasSort && !hasBoard && !hasFlags) {
          io.sendJson(res, 400, {
            error: 'name, instructions, color, sortOrder, boardProjectId, archived or pinned required',
          })
          return
        }
        if (hasName && parseChatProjectName(data.name) === null) {
          io.sendJson(res, 400, { error: 'name required (1-60 chars)' })
          return
        }
        if (hasInstructions) {
          const instructions = parseChatProjectOptionalText(data.instructions, CHAT_PROJECT_INSTRUCTIONS_MAX)
          if ('invalid' in instructions) {
            io.sendJson(res, 400, { error: 'instructions invalid (max 4000 chars)' })
            return
          }
        }
        if (hasColor) {
          const color = parseChatProjectOptionalText(data.color, CHAT_PROJECT_COLOR_MAX)
          if ('invalid' in color) {
            io.sendJson(res, 400, { error: 'color invalid (max 24 chars)' })
            return
          }
        }
        if (hasSort && parseChatProjectSortOrder(data.sortOrder) === null) {
          io.sendJson(res, 400, { error: 'sortOrder must be an integer' })
          return
        }
        const result = await updateChatProject(userId, projectId, data)
        if (!result.ok) {
          if (result.error === 'not_found') {
            io.sendJson(res, 404, { error: 'not found' })
            return
          }
          if (result.error === 'board_project_bound') {
            io.sendJson(res, 409, { error: 'board project already bound', code: 'board_project_bound' })
            return
          }
          io.sendJson(res, 400, { error: result.error.replace(/_/g, ' ') })
          return
        }
        io.sendJson(res, 200, { project: result.project })
      })().catch(() => io.sendJson(res, 500, { error: 'patch failed' }))
      return true
    }
    if (req.method === 'DELETE') {
      ;(async () => {
        // Optional body: the cron jobs the client paused (fenced) before deleting,
        // kept in the deletion manifest so a restore can hand them back.
        let paused: string[] = []
        const raw = await io.readBody(req, 16 * 1024).catch(() => '')
        if (raw.trim()) {
          let data: { pausedCronJobIds?: unknown }
          try {
            data = JSON.parse(raw)
          } catch {
            io.sendJson(res, 400, { error: 'invalid JSON' })
            return
          }
          const parsed = parseChatProjectCronJobIds(data.pausedCronJobIds)
          if (parsed === null) {
            io.sendJson(res, 400, { error: 'pausedCronJobIds invalid' })
            return
          }
          paused = parsed
        }
        const result = await deleteChatProject(userId, projectId, { pausedCronJobIds: paused })
        if (result.ok) io.sendJson(res, 200, { ok: true })
        else io.sendJson(res, 404, { error: 'not found' })
      })().catch(() => io.sendJson(res, 500, { error: 'delete failed' }))
      return true
    }
    io.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  return false
}
