/**
 * service — 连接器执行编排(RPC/handlers 共用):
 *   - executeConnectionAction:dispatch 前重查(§2)→ 解密凭据 →(feishu 惰性刷新)
 *     → provider 执行 → 结果 allowlist Clean + 硬限。
 *   - buildWriteSummary / buildWriteDetail:确认卡摘要(≤2000)与完整详情
 *     (服务端解密 params 渲染,§3② —— 批准针对服务端存参,非工具输出截断文本)。
 *
 * 凭据永不出本层:provider 拿到的是解密后的最小凭据;结果/错误里绝无凭据。
 */

import { createHash } from 'node:crypto'
import type { Pool } from 'pg'
import { ConnectorError } from './errors.js'
import type { DnsResolver } from './outboundPolicy.js'
import {
  type ConnectorRedis,
  ensureFreshFeishuConnection,
  executeFeishu,
} from './providers/feishu.js'
import { executeGithub } from './providers/github.js'
import { executeImap } from './providers/imap.js'
import { executeNotion } from './providers/notion.js'
import { enforceResultLimits } from './providers/shared.js'
import { executeWebdav } from './providers/webdav.js'
import { type ConnectorActionDecl, cleanActionResult, getActionDecl } from './registry.js'
import {
  type ConnectionRow,
  type ImapSecret,
  type NotionSecret,
  type WebdavSecret,
  decryptConnectionSecret,
  getActiveConnection,
} from './store.js'

export interface ExecuteDeps {
  pool: Pool
  redis?: ConnectorRedis | null
  resolver?: DnsResolver
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
}

/**
 * 执行一个 action(读 or 已过确认门的写)。
 * **dispatch 前重查**:重新 SELECT 确认 active + revision 匹配(§2)。
 */
export async function executeConnectionAction(opts: {
  connectionId: string
  userId: number
  action: ConnectorActionDecl
  params: Record<string, unknown>
  /** 写路径:账本行的 connection_revision(读路径传 null 跳过 revision 比对)。 */
  expectedRevision: number | null
  /** 写路径:账本 idempotency_key(provider 支持则透传)。 */
  idempotencyKey?: string
  deps: ExecuteDeps
}): Promise<unknown> {
  const { deps } = opts
  // dispatch 前重查(每次发出第三方请求前)
  const row = await getActiveConnection(opts.connectionId, opts.userId, deps.pool)
  if (!row) throw new ConnectorError('CONNECTION_NOT_FOUND', 'connection not active')
  if (opts.expectedRevision !== null && row.revision !== opts.expectedRevision) {
    throw new ConnectorError('REVISION_MISMATCH', 'connection rebound since proposal')
  }

  const raw = await dispatchProvider(row, opts.action, opts.params, opts.idempotencyKey, deps)
  const cleaned = cleanActionResult(opts.action.result, raw)
  if (opts.action.resultKind === 'file') return cleaned // 6MB cap 已在 provider 内前置
  return enforceResultLimits(cleaned)
}

async function dispatchProvider(
  row: ConnectionRow,
  action: ConnectorActionDecl,
  params: Record<string, unknown>,
  idempotencyKey: string | undefined,
  deps: ExecuteDeps,
): Promise<unknown> {
  switch (row.provider) {
    case 'webdav': {
      const secret = decryptConnectionSecret<WebdavSecret>(row)
      return executeWebdav(secret, action.id, params, {
        resolver: deps.resolver,
        fetchImpl: deps.fetchImpl,
      })
    }
    case 'imap': {
      const secret = decryptConnectionSecret<ImapSecret>(row)
      return executeImap(secret, action.id, params, { resolver: deps.resolver })
    }
    case 'notion': {
      const secret = decryptConnectionSecret<NotionSecret>(row)
      return executeNotion(secret, action.id, params, { fetchImpl: deps.fetchImpl })
    }
    case 'feishu': {
      const fresh = await ensureFreshFeishuConnection(row, deps.pool, deps.redis ?? null, {
        fetchImpl: deps.fetchImpl,
      })
      return executeFeishu(fresh.secret.accessToken, action.id, params, idempotencyKey, {
        fetchImpl: deps.fetchImpl,
      })
    }
    default:
      throw new ConnectorError('PROVIDER_UNKNOWN', `no executor for ${row.provider as string}`)
  }
}

/** github 只读 adapter 的执行入口(无 connections 行,§4)。 */
export async function executeGithubAction(opts: {
  userId: number
  action: ConnectorActionDecl
  params: Record<string, unknown>
  deps: ExecuteDeps
}): Promise<unknown> {
  const raw = await executeGithub(opts.deps.pool, opts.userId, opts.action.id, opts.params, {
    fetchImpl: opts.deps.fetchImpl,
  })
  const cleaned = cleanActionResult(opts.action.result, raw)
  return enforceResultLimits(cleaned)
}

// ─── 确认卡摘要 / 完整详情(§3) ──────────────────────────────────────────

function ellipsize(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`
}

/** 摘要(≤2000;确认卡首屏)。由**服务端校验后的 params** 生成,非模型自由文本。 */
export function buildWriteSummary(
  provider: string,
  action: string,
  params: Record<string, unknown>,
  accountHint: string,
): string {
  const hint = accountHint ? `(${ellipsize(accountHint, 60)})` : ''
  switch (`${provider}/${action}`) {
    case 'webdav/put_file': {
      const path = String(params.path ?? '')
      const size = Buffer.from(String(params.contentBase64 ?? ''), 'base64').length
      return ellipsize(`向 WebDAV${hint} 写入文件 ${path}(${size} 字节)`, 2000)
    }
    case 'imap/send_email': {
      const to = Array.isArray(params.to) ? (params.to as string[]) : []
      const cc = Array.isArray(params.cc) ? (params.cc as string[]) : []
      const subject = String(params.subject ?? '')
      const rcpt = cc.length > 0 ? `${to.join('、')}(抄送 ${cc.length} 人)` : to.join('、')
      return ellipsize(`用邮箱${hint} 发送邮件给 ${rcpt},主题「${subject}」`, 2000)
    }
    case 'notion/create_page': {
      const title = String(params.title ?? '')
      return ellipsize(
        `在 Notion${hint} 页面 ${String(params.parentPageId ?? '')} 下创建页面「${title}」`,
        2000,
      )
    }
    case 'feishu/create_calendar_event': {
      const summary = String(params.summary ?? '')
      return ellipsize(
        `在飞书${hint} 日历创建日程「${summary}」(${String(params.startTime ?? '')} ~ ${String(params.endTime ?? '')})`,
        2000,
      )
    }
    case 'feishu/send_message': {
      const text = String(params.text ?? '')
      return ellipsize(
        `用飞书${hint} 向 ${String(params.receiveIdType ?? '')}:${String(params.receiveId ?? '')} 发送消息:「${ellipsize(text, 200)}」`,
        2000,
      )
    }
    case 'knowledge-planet/create_topic': {
      const text = String(params.text ?? '')
      const media = Array.isArray(params.mediaManifest) ? params.mediaManifest : []
      return ellipsize(
        `用知识星球${hint}在星球 ${String(params.groupId ?? '')} 发布主题（${media.filter((item) => (item as Record<string, unknown>)?.kind === 'image').length} 张图片、${media.filter((item) => (item as Record<string, unknown>)?.kind === 'file').length} 个附件）：「${ellipsize(text, 300)}」`,
        2000,
      )
    }
    case 'knowledge-planet/create_comment': {
      const text = String(params.text ?? '')
      const reply = params.repliedCommentId ? `，回复评论 ${String(params.repliedCommentId)}` : ''
      return ellipsize(
        `用知识星球${hint}在主题 ${String(params.topicId ?? '')}${reply} 发布评论：「${ellipsize(text, 300)}」`,
        2000,
      )
    }
    case 'knowledge-planet/edit_topic':
      return ellipsize(
        `用知识星球${hint}完整编辑主题 ${String(params.topicId ?? '')}：「${ellipsize(String(params.text ?? ''), 300)}」`,
        2000,
      )
    case 'knowledge-planet/delete_topic':
      return ellipsize(
        `用知识星球${hint}永久删除主题 ${String(params.topicId ?? '')}（不可撤销）`,
        2000,
      )
    case 'knowledge-planet/delete_comment':
      return ellipsize(
        `用知识星球${hint}永久删除主题 ${String(params.topicId ?? '')} 下的评论 ${String(params.commentId ?? '')}（不可撤销）`,
        2000,
      )
    case 'knowledge-planet/set_topic_like':
      return ellipsize(
        `用知识星球${hint}把主题 ${String(params.topicId ?? '')} 设置为${params.liked === true ? '已点赞' : '未点赞'}`,
        2000,
      )
    case 'knowledge-planet/set_comment_like':
      return ellipsize(
        `用知识星球${hint}把评论 ${String(params.commentId ?? '')} 设置为${params.liked === true ? '已点赞' : '未点赞'}`,
        2000,
      )
    default:
      return ellipsize(`${provider} 写操作 ${action}`, 2000)
  }
}

/**
 * 完整详情(GET /api/connectors/confirmations/:id 的 detail;per-action 结构化):
 * 邮件=全部收件人/抄送/标题/**完整正文**;文件=路径/大小/SHA256;
 * 日历=全字段含时区;消息=对象+全文(§3②)。
 */
export function buildWriteDetail(
  provider: string,
  action: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  switch (`${provider}/${action}`) {
    case 'webdav/put_file': {
      const bytes = Buffer.from(String(params.contentBase64 ?? ''), 'base64')
      return {
        kind: 'file',
        path: String(params.path ?? ''),
        sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    }
    case 'imap/send_email':
      return {
        kind: 'email',
        to: Array.isArray(params.to) ? params.to : [],
        cc: Array.isArray(params.cc) ? params.cc : [],
        subject: String(params.subject ?? ''),
        text: String(params.text ?? ''), // 完整正文,不截断
      }
    case 'notion/create_page':
      return {
        kind: 'notion_page',
        parentPageId: String(params.parentPageId ?? ''),
        title: String(params.title ?? ''),
        content: String(params.content ?? ''),
      }
    case 'feishu/create_calendar_event':
      return {
        kind: 'calendar_event',
        calendarId: params.calendarId ?? null,
        summary: String(params.summary ?? ''),
        startTime: String(params.startTime ?? ''),
        endTime: String(params.endTime ?? ''),
        description: String(params.description ?? ''),
        timezone: String(params.timezone ?? 'Asia/Shanghai'),
      }
    case 'feishu/send_message':
      return {
        kind: 'message',
        receiveId: String(params.receiveId ?? ''),
        receiveIdType: String(params.receiveIdType ?? ''),
        text: String(params.text ?? ''), // 全文
      }
    case 'knowledge-planet/create_topic':
      return {
        kind: 'knowledge_planet_topic',
        groupId: String(params.groupId ?? ''),
        text: String(params.text ?? ''),
        media: Array.isArray(params.mediaManifest) ? params.mediaManifest : [],
      }
    case 'knowledge-planet/create_comment':
      return {
        kind: 'knowledge_planet_comment',
        topicId: String(params.topicId ?? ''),
        repliedCommentId: params.repliedCommentId ?? null,
        text: String(params.text ?? ''),
        media: Array.isArray(params.mediaManifest) ? params.mediaManifest : [],
      }
    case 'knowledge-planet/edit_topic':
      return {
        kind: 'knowledge_planet_topic_edit',
        groupId: String(params.groupId ?? ''),
        topicId: String(params.topicId ?? ''),
        previousText:
          (params.editSnapshot as Record<string, unknown> | undefined)?.previousText ?? '',
        text: String(params.text ?? ''),
        preserveExistingMedia: params.preserveExistingMedia !== false,
        existingImageIds:
          (params.editSnapshot as Record<string, unknown> | undefined)?.imageIds ?? [],
        existingFileIds:
          (params.editSnapshot as Record<string, unknown> | undefined)?.fileIds ?? [],
        media: Array.isArray(params.mediaManifest) ? params.mediaManifest : [],
        warning: '知识星球主题编辑是完整替换；最终校验与写入之间仍存在极短竞态窗口。',
      }
    case 'knowledge-planet/delete_topic':
      return {
        kind: 'knowledge_planet_delete_topic',
        topicId: String(params.topicId ?? ''),
        preview: (params.deleteSnapshot as Record<string, unknown> | undefined)?.preview ?? '',
        irreversible: true,
      }
    case 'knowledge-planet/delete_comment':
      return {
        kind: 'knowledge_planet_delete_comment',
        topicId: String(params.topicId ?? ''),
        commentId: String(params.commentId ?? ''),
        preview: (params.deleteSnapshot as Record<string, unknown> | undefined)?.preview ?? '',
        irreversible: true,
      }
    case 'knowledge-planet/set_topic_like':
      return {
        kind: 'knowledge_planet_topic_like',
        topicId: String(params.topicId ?? ''),
        liked: params.liked === true,
      }
    case 'knowledge-planet/set_comment_like':
      return {
        kind: 'knowledge_planet_comment_like',
        commentId: String(params.commentId ?? ''),
        liked: params.liked === true,
      }
    default:
      // 兜底:原样返回(params 本身已过严格 schema,无凭据)
      return { kind: 'params', params }
  }
}

/** action 存在性 + 读写面校验的便捷入口(供 rpc/handlers 复用)。 */
export function requireAction(provider: string, actionId: string): ConnectorActionDecl {
  const decl = getActionDecl(provider, actionId)
  if (!decl) throw new ConnectorError('ACTION_UNKNOWN', `${provider} has no action ${actionId}`)
  return decl
}
