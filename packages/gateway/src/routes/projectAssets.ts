/**
 * 聊天项目资产 HTTP 路由:/api/project-assets 及其子路径(上传参考资料、会话产出物索引、版本)。
 * 从 Gateway._handleHttpAfterCommercial 原样搬出(OCV5-376 P2),见 ./httpIo.ts。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  parseOptionalPositiveInt,
  listProjectAssets,
  searchProjectAssets,
  PROJECT_ASSET_SEARCH_LIMIT_DEFAULT,
  PROJECT_ASSET_SEARCH_LIMIT_MAX,
  PROJECT_ASSET_SEARCH_QUERY_MAX,
  listProjectAssetVersions,
  createProjectAsset,
  updateProjectAsset,
  deleteProjectAsset,
  parseProjectAssetName,
  parseProjectAssetSource,
  parseProjectAssetUrl,
  parseProjectAssetOptionalContainerPath,
  parseProjectAssetProjectId,
  PROJECT_ASSET_PER_PROJECT_LIMIT,
} from '@openclaude/storage'
import { tryExtractProjectAssetExcerpt } from '../projectAssetCollector.js'
import type { GatewayHttpIo } from './httpIo.js'

/** Returns true when the request was handled (a response was or will be sent). */
export function handleProjectAssetsHttp(io: GatewayHttpIo, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  // 聊天项目资产(上传参考资料 + 会话产出物索引)。浏览器直打 gateway,与 /api/chat-projects 同平面。
  if (url.pathname === '/api/project-assets') {
    const userId = io.getUserId(req)
    if (req.method === 'GET') {
      // ?q= switches to a cross-project search (Cmd+K): every non-deleted
      // asset of this user, in any project or ungrouped, by name/excerpt.
      const rawQ = url.searchParams.get('q')
      if (rawQ !== null && rawQ.trim() !== '') {
        const rawSource = url.searchParams.get('source')
        if (rawSource !== null && rawSource !== '' && rawSource !== 'upload' && rawSource !== 'output') {
          io.sendJson(res, 400, { error: 'invalid source' })
          return true
        }
        const source = rawSource === 'upload' || rawSource === 'output' ? rawSource : undefined
        const limit = parseOptionalPositiveInt(
          url.searchParams.get('limit'),
          PROJECT_ASSET_SEARCH_LIMIT_DEFAULT,
          PROJECT_ASSET_SEARCH_LIMIT_MAX,
        )
        searchProjectAssets(userId, { q: rawQ.trim().slice(0, PROJECT_ASSET_SEARCH_QUERY_MAX), source, limit })
          .then((assets) => io.sendJson(res, 200, { assets }))
          .catch(() => io.sendJson(res, 500, { error: 'search failed' }))
        return true
      }
      const rawProjectId = url.searchParams.get('projectId')
      const projectId = rawProjectId === null || rawProjectId === '' || rawProjectId === 'none'
        ? null
        : rawProjectId
      if (projectId !== null && (projectId.length < 8 || projectId.length > 64)) {
        io.sendJson(res, 400, { error: 'invalid projectId' })
        return true
      }
      listProjectAssets(userId, { projectId })
        .then((assets) => io.sendJson(res, 200, { assets }))
        .catch(() => io.sendJson(res, 500, { error: 'list failed' }))
      return true
    }
    if (req.method === 'POST') {
      ;(async () => {
        let data: {
          projectId?: unknown
          source?: unknown
          sessionId?: unknown
          name?: unknown
          url?: unknown
          containerPath?: unknown
          mime?: unknown
          size?: unknown
          digest?: unknown
        }
        try {
          data = JSON.parse(await io.readBody(req, 16 * 1024))
        } catch {
          io.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        if (parseProjectAssetName(data.name) === null) {
          io.sendJson(res, 400, { error: 'name required (1-200 chars)' })
          return
        }
        if (parseProjectAssetSource(data.source) === null) {
          io.sendJson(res, 400, { error: "source must be 'upload' or 'output'" })
          return
        }
        const urlField = parseProjectAssetUrl(data.url)
        if ('invalid' in urlField) {
          io.sendJson(res, 400, { error: 'invalid url' })
          return
        }
        const containerPath = parseProjectAssetOptionalContainerPath(data.containerPath)
        if ('invalid' in containerPath) {
          io.sendJson(res, 400, { error: 'invalid containerPath' })
          return
        }
        if (!urlField.present && !containerPath.present) {
          io.sendJson(res, 400, { error: 'url or containerPath required' })
          return
        }
        let excerpt: string | null = null
        try {
          excerpt = await tryExtractProjectAssetExcerpt({
            source: typeof data.source === 'string' ? data.source : '',
            mime: typeof data.mime === 'string' ? data.mime : null,
            url: urlField.present ? urlField.value : null,
            containerPath: containerPath.present ? containerPath.value : null,
            name: typeof data.name === 'string' ? data.name : null,
          })
        } catch {
          excerpt = null
        }
        const result = await createProjectAsset(userId, { ...data, excerpt })
        if (!result.ok) {
          if (result.error === 'limit_exceeded') {
            io.sendJson(res, 400, { error: `asset limit exceeded (max ${PROJECT_ASSET_PER_PROJECT_LIMIT})` })
            return
          }
          if (result.error === 'project_not_found') {
            io.sendJson(res, 404, { error: 'project not found' })
            return
          }
          io.sendJson(res, 400, { error: result.error.replace(/_/g, ' ') })
          return
        }
        io.sendJson(res, 200, {
          asset: result.asset,
          created: result.created,
          reused: !result.created,
        })
      })().catch(() => io.sendJson(res, 500, { error: 'create failed' }))
      return true
    }
    io.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }
  // 产出物版本:同一源路径的全部版本(新→旧),以及把某个旧版本恢复成最新版本。
  // 恢复 = 用旧版本的 digest/url 再登记一行(新 created_at),从不改写或删除已有版本。
  const projectAssetVersionsMatch = url.pathname.match(/^\/api\/project-assets\/([a-zA-Z0-9_-]{8,64})\/versions$/)
  if (projectAssetVersionsMatch) {
    const userId = io.getUserId(req)
    if (req.method !== 'GET') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    listProjectAssetVersions(userId, projectAssetVersionsMatch[1]!)
      .then((versions) => versions
        ? io.sendJson(res, 200, { versions })
        : io.sendJson(res, 404, { error: 'not found' }))
      .catch(() => io.sendJson(res, 500, { error: 'list failed' }))
    return true
  }
  const projectAssetRestoreMatch = url.pathname.match(/^\/api\/project-assets\/([a-zA-Z0-9_-]{8,64})\/restore$/)
  if (projectAssetRestoreMatch) {
    const userId = io.getUserId(req)
    if (req.method !== 'POST') {
      io.sendJson(res, 405, { error: 'method not allowed' })
      return true
    }
    const assetId = projectAssetRestoreMatch[1]!
    ;(async () => {
      const versions = await listProjectAssetVersions(userId, assetId)
      const target = versions?.find((v) => v.id === assetId)
      if (!target) {
        io.sendJson(res, 404, { error: 'not found' })
        return
      }
      if (target.source !== 'output' || !target.containerPath || !target.url || !target.digest) {
        io.sendJson(res, 400, { error: 'version has no stored copy' })
        return
      }
      const result = await createProjectAsset(userId, {
        source: 'output',
        projectId: target.projectId,
        sessionId: target.sessionId,
        name: target.name,
        url: target.url,
        containerPath: target.containerPath,
        mime: target.mime,
        size: target.sizeBytes,
        digest: target.digest,
        excerpt: target.excerpt,
      })
      if (!result.ok) {
        if (result.error === 'limit_exceeded') {
          io.sendJson(res, 400, { error: `asset limit exceeded (max ${PROJECT_ASSET_PER_PROJECT_LIMIT})` })
          return
        }
        if (result.error === 'project_not_found') {
          io.sendJson(res, 404, { error: 'project not found' })
          return
        }
        io.sendJson(res, 400, { error: result.error.replace(/_/g, ' ') })
        return
      }
      // created=false: this version is already the newest one.
      io.sendJson(res, 200, { asset: result.asset, created: result.created })
    })().catch(() => io.sendJson(res, 500, { error: 'restore failed' }))
    return true
  }
  const projectAssetMatch = url.pathname.match(/^\/api\/project-assets\/([a-zA-Z0-9_-]{8,64})$/)
  if (projectAssetMatch) {
    const assetId = projectAssetMatch[1]
    const userId = io.getUserId(req)
    if (req.method === 'PATCH') {
      ;(async () => {
        let data: { pinned?: unknown; name?: unknown; projectId?: unknown }
        try {
          data = JSON.parse(await io.readBody(req, 16 * 1024))
        } catch {
          io.sendJson(res, 400, { error: 'invalid JSON' })
          return
        }
        const hasPinned = data.pinned !== undefined
        const hasName = data.name !== undefined
        const hasProject = data.projectId !== undefined
        if (!hasPinned && !hasName && !hasProject) {
          io.sendJson(res, 400, { error: 'pinned, name or projectId required' })
          return
        }
        if (hasName && parseProjectAssetName(data.name) === null) {
          io.sendJson(res, 400, { error: 'name required (1-200 chars)' })
          return
        }
        if (hasPinned && typeof data.pinned !== 'boolean') {
          io.sendJson(res, 400, { error: 'pinned must be boolean' })
          return
        }
        if (hasProject) {
          const projectId = parseProjectAssetProjectId(data.projectId)
          if ('invalid' in projectId) {
            io.sendJson(res, 400, { error: 'invalid projectId' })
            return
          }
        }
        const result = await updateProjectAsset(userId, assetId, data)
        if (!result.ok) {
          if (result.error === 'not_found') {
            io.sendJson(res, 404, { error: 'not found' })
            return
          }
          if (result.error === 'project_not_found') {
            io.sendJson(res, 404, { error: 'project not found' })
            return
          }
          if (result.error === 'limit_exceeded') {
            io.sendJson(res, 400, { error: `asset limit exceeded (max ${PROJECT_ASSET_PER_PROJECT_LIMIT})` })
            return
          }
          io.sendJson(res, 400, { error: result.error.replace(/_/g, ' ') })
          return
        }
        io.sendJson(res, 200, { asset: result.asset })
      })().catch(() => io.sendJson(res, 500, { error: 'patch failed' }))
      return true
    }
    if (req.method === 'DELETE') {
      deleteProjectAsset(userId, assetId)
        .then((result) => result.ok
          ? io.sendJson(res, 200, { ok: true })
          : io.sendJson(res, 404, { error: 'not found' }))
        .catch(() => io.sendJson(res, 500, { error: 'delete failed' }))
      return true
    }
    io.sendJson(res, 405, { error: 'method not allowed' })
    return true
  }

  return false
}
