/**
 * providers/notion — internal integration token(固定域 provider,api.notion.com)。
 *
 * 出站:固定域静态白名单(assertFixedDomainUrl)+ 默认全局出口(EnvHttpProxyAgent
 * 出海;目标域可信常量)+ redirect:'error' + 总超时 60s。token 只进 Authorization 头。
 *
 * actions:search / get_page / create_page★。
 */

import { fetch as undiciFetch } from 'undici'
import { ConnectorError } from '../errors.js'
import { TOTAL_TIMEOUT_MS, assertFixedDomainUrl } from '../outboundPolicy.js'
import type { NotionSecret } from '../store.js'
import {
  MAX_UPSTREAM_JSON_BYTES,
  TEXT_FIELD_MAX_CHARS,
  mapFetchFailure,
  mapUpstreamStatus,
  readBoundedJson,
  truncateText,
} from './shared.js'

const NOTION_BASE = 'https://api.notion.com'
const NOTION_VERSION = '2022-06-28'

export interface NotionDeps {
  fetchImpl?: (input: string, init: Record<string, unknown>) => Promise<Response>
}

async function notionFetch(
  token: string,
  path: string,
  init: { method: string; body?: unknown },
  deps: NotionDeps,
): Promise<unknown> {
  const url = assertFixedDomainUrl('notion', `${NOTION_BASE}${path}`)
  const doFetch =
    deps.fetchImpl ??
    ((input: string, i: Record<string, unknown>) =>
      undiciFetch(input, i as never) as unknown as Promise<Response>)
  let res: Response
  try {
    res = await doFetch(url.toString(), {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(TOTAL_TIMEOUT_MS),
    })
  } catch (err) {
    throw mapFetchFailure(err, 'notion')
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {})
    throw mapUpstreamStatus(res.status, 'notion')
  }
  return readBoundedJson(res, MAX_UPSTREAM_JSON_BYTES, 'notion')
}

// ─── 绑定期验证:GET /v1/users/me → bot 身份 ──────────────────────────────

export interface NotionBotIdentity {
  botId: string
  workspaceName: string | null
}

export async function verifyNotionToken(
  token: string,
  deps: NotionDeps = {},
): Promise<NotionBotIdentity> {
  const me = (await notionFetch(token, '/v1/users/me', { method: 'GET' }, deps)) as {
    id?: unknown
    bot?: { workspace_name?: unknown }
  }
  if (typeof me?.id !== 'string' || me.id.length === 0) {
    throw new ConnectorError('UPSTREAM_ERROR', 'notion users/me missing id')
  }
  const wn = me.bot?.workspace_name
  return { botId: me.id, workspaceName: typeof wn === 'string' ? wn : null }
}

// ─── helpers ─────────────────────────────────────────────────────────────

function richTextPlain(rt: unknown): string {
  if (!Array.isArray(rt)) return ''
  return rt.map((x) => (x as { plain_text?: string })?.plain_text ?? '').join('')
}

function pageTitle(page: Record<string, unknown>): string {
  const props = page.properties as Record<string, { type?: string; title?: unknown }> | undefined
  if (props) {
    for (const v of Object.values(props)) {
      if (v?.type === 'title') return richTextPlain(v.title)
    }
  }
  // database 对象:title 在顶层
  if (Array.isArray((page as { title?: unknown }).title)) {
    return richTextPlain((page as { title?: unknown }).title)
  }
  return ''
}

/** page id 形状:UUID(带/不带连字符)。 */
function assertPageId(id: string): string {
  const bare = id.replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(bare)) {
    throw new ConnectorError('VALIDATION_FAILED', 'pageId must be a Notion UUID')
  }
  return id
}

// ─── actions ─────────────────────────────────────────────────────────────

export async function notionSearch(
  secret: NotionSecret,
  params: { query: string; limit?: number },
  deps: NotionDeps = {},
): Promise<unknown> {
  const body = { query: params.query, page_size: params.limit ?? 20 }
  const data = (await notionFetch(secret.token, '/v1/search', { method: 'POST', body }, deps)) as {
    results?: unknown[]
  }
  const results = (Array.isArray(data.results) ? data.results : []).slice(0, 50).map((r) => {
    const page = r as Record<string, unknown>
    const [title] = truncateText(pageTitle(page) || '(untitled)', 500)
    return {
      id: String(page.id ?? ''),
      object: String(page.object ?? ''),
      title,
      ...(typeof page.url === 'string' ? { url: page.url } : {}),
      ...(typeof page.last_edited_time === 'string'
        ? { lastEditedTime: page.last_edited_time }
        : {}),
    }
  })
  return { results }
}

export async function notionGetPage(
  secret: NotionSecret,
  params: { pageId: string },
  deps: NotionDeps = {},
): Promise<unknown> {
  const pageId = assertPageId(params.pageId)
  const page = (await notionFetch(
    secret.token,
    `/v1/pages/${encodeURIComponent(pageId)}`,
    { method: 'GET' },
    deps,
  )) as Record<string, unknown>

  // 首屏 100 块拉正文纯文本(v1 不分页深挖;够 AI 读)
  const blocks = (await notionFetch(
    secret.token,
    `/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
    { method: 'GET' },
    deps,
  )) as { results?: unknown[] }
  const lines: string[] = []
  for (const b of Array.isArray(blocks.results) ? blocks.results : []) {
    const block = b as Record<string, unknown>
    const type = String(block.type ?? '')
    const payload = block[type] as { rich_text?: unknown } | undefined
    const text = richTextPlain(payload?.rich_text)
    if (text) lines.push(text)
  }
  const [text, textTruncated] = truncateText(lines.join('\n'), TEXT_FIELD_MAX_CHARS)
  const [title] = truncateText(pageTitle(page) || '(untitled)', 500)
  return {
    id: String(page.id ?? pageId),
    title,
    ...(typeof page.url === 'string' ? { url: page.url } : {}),
    ...(typeof page.last_edited_time === 'string' ? { lastEditedTime: page.last_edited_time } : {}),
    text,
    textTruncated,
  }
}

export async function notionCreatePage(
  secret: NotionSecret,
  params: { parentPageId: string; title: string; content?: string },
  deps: NotionDeps = {},
): Promise<unknown> {
  const parentId = assertPageId(params.parentPageId)
  // 内容按空行分段 → paragraph 块;单块 ≤2000 字符(Notion 上限),最多 100 块
  const children: unknown[] = []
  if (params.content) {
    for (const para of params.content.split(/\n{2,}/)) {
      const trimmed = para.trim()
      if (!trimmed) continue
      for (let i = 0; i < trimmed.length && children.length < 100; i += 2000) {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: trimmed.slice(i, i + 2000) } }],
          },
        })
      }
      if (children.length >= 100) break
    }
  }
  const body = {
    parent: { page_id: parentId },
    properties: {
      title: { title: [{ type: 'text', text: { content: params.title.slice(0, 500) } }] },
    },
    ...(children.length > 0 ? { children } : {}),
  }
  const created = (await notionFetch(
    secret.token,
    '/v1/pages',
    { method: 'POST', body },
    deps,
  )) as Record<string, unknown>
  if (typeof created.id !== 'string') {
    throw new ConnectorError('UPSTREAM_ERROR', 'notion create page returned no id')
  }
  return {
    id: created.id,
    ...(typeof created.url === 'string' ? { url: created.url } : {}),
  }
}

export async function executeNotion(
  secret: NotionSecret,
  action: string,
  params: Record<string, unknown>,
  deps: NotionDeps = {},
): Promise<unknown> {
  switch (action) {
    case 'search':
      return notionSearch(secret, params as never, deps)
    case 'get_page':
      return notionGetPage(secret, params as never, deps)
    case 'create_page':
      return notionCreatePage(secret, params as never, deps)
    default:
      throw new ConnectorError('ACTION_UNKNOWN', `notion has no action ${action}`)
  }
}
