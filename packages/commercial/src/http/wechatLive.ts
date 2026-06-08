/**
 * Public read-only WeChat realtime process page.
 *
 * This endpoint intentionally does not accept cookies or Bearer auth. The
 * signed `t` query param is the complete authorization for one WeChat session.
 */

import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { getClientSession } from '@openclaude/storage'

import { verifyWechatLiveToken } from '../wechat/liveShare.js'
import { MASTER_USER_PREFIX } from '../wechat/userIds.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { requireActiveAccountVerifyDb } from './requireUser.js'
import { HttpError, sendJson, setSecurityHeaders } from './util.js'

const MAX_MESSAGES = 200
const MAX_MESSAGE_TEXT_CHARS = 12_000

interface PublicWechatLiveMessage {
  id: string
  role: 'user' | 'assistant' | 'thinking' | 'event'
  text: string
  ts?: number
  toolName?: string
}

export async function handleWechatLivePage(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  _deps: CommercialHttpDeps,
): Promise<void> {
  const token = extractSingleQueryParam(req.url ?? '', 't')
  if (!token) {
    throw new HttpError(400, 'BAD_WECHAT_LIVE_TOKEN', 'invalid live link')
  }
  const nonce = randomBytes(16).toString('base64url')
  setSecurityHeaders(res)
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
    ].join('; '),
  )
  res.statusCode = 200
  res.end(renderWechatLivePage(nonce))
}

export async function handleWechatLiveSnapshot(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if (!deps.wechatLiveLinkKey || !deps.v3Supervisor) {
    throw new HttpError(503, 'WECHAT_LIVE_DISABLED', 'wechat live link not configured')
  }

  const token = extractSingleQueryParam(req.url ?? '', 't')
  const verified = verifyWechatLiveToken(deps.wechatLiveLinkKey, token)
  if (verified.kind === 'bad-request') {
    throw new HttpError(400, 'BAD_WECHAT_LIVE_TOKEN', 'invalid live link')
  }
  if (verified.kind === 'forbidden') {
    throw new HttpError(403, 'FORBIDDEN', 'invalid live link')
  }
  if (verified.kind === 'gone') {
    throw new HttpError(410, 'WECHAT_LIVE_EXPIRED', 'live link expired')
  }

  const rawUserId = verified.userId.startsWith(MASTER_USER_PREFIX)
    ? verified.userId.slice(MASTER_USER_PREFIX.length)
    : verified.userId
  const account = await requireActiveAccountVerifyDb(
    rawUserId,
    ['user', 'admin'],
    deps.v3Supervisor.pool,
  )
  if (!account) {
    throw new HttpError(403, 'FORBIDDEN', 'account not active')
  }

  const session = await getClientSession(verified.sessionId, verified.userId)
  if (!session) {
    throw new HttpError(404, 'NOT_FOUND', 'wechat session not found')
  }

  const sinceRaw = extractSingleQueryParam(req.url ?? '', 'since')
  if (sinceRaw && /^[0-9]+$/.test(sinceRaw)) {
    const since = Number.parseInt(sinceRaw, 10)
    if (Number.isSafeInteger(since) && since === session.updatedAt) {
      sendJson(res, 200, { unchanged: true, updatedAt: session.updatedAt })
      return
    }
  }

  sendJson(res, 200, {
    sessionId: session.id,
    title: session.title ?? '微信会话',
    updatedAt: session.updatedAt,
    messages: sanitizeMessages(session.messages),
  })
}

function extractSingleQueryParam(requestUrl: string, name: string): string | null {
  const qi = requestUrl.indexOf('?')
  if (qi < 0) return null
  const hi = requestUrl.indexOf('#', qi)
  const rawQuery = hi < 0 ? requestUrl.slice(qi + 1) : requestUrl.slice(qi + 1, hi)
  if (!rawQuery) return null
  let found: string | null = null
  for (const kv of rawQuery.split('&')) {
    const eq = kv.indexOf('=')
    const rawName = eq < 0 ? kv : kv.slice(0, eq)
    const decodedName = decodeQueryComponent(rawName)
    if (decodedName !== name) continue
    if (found !== null) return null
    if (eq < 0) {
      found = ''
      continue
    }
    const decodedValue = decodeQueryComponent(kv.slice(eq + 1))
    if (decodedValue === null) return null
    found = decodedValue
  }
  return found === '' ? null : found
}

function decodeQueryComponent(raw: string): string | null {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '))
  } catch {
    return null
  }
}

function sanitizeMessages(messages: unknown[]): PublicWechatLiveMessage[] {
  return messages.slice(-MAX_MESSAGES).map((message, idx) => {
    const obj = isObj(message) ? message : {}
    const id = typeof obj.id === 'string' && obj.id ? obj.id : `m-${idx}`
    const normalizedRole = normalizeRole(obj.role ?? obj.type)
    const redact = normalizedRole === 'event' || hasToolPayload(message)
    const role = redact ? 'event' : normalizedRole
    return {
      id,
      role,
      text: truncate(redact ? '工具调用细节已隐藏（请回到 OpenClaude 查看完整过程）。' : extractText(message)),
      ...extractTs(obj),
      ...(redact ? extractToolName(obj) : {}),
    }
  })
}

function normalizeRole(role: unknown): PublicWechatLiveMessage['role'] {
  if (role === 'user' || role === 'assistant' || role === 'thinking') {
    return role
  }
  return 'event'
}

function hasToolPayload(message: unknown): boolean {
  if (!isObj(message)) return false
  const role = String(message.role ?? message.type ?? '').toLowerCase()
  if (role.includes('tool')) return true
  for (const key of ['tool_calls', 'toolCalls', 'tool_call', 'toolCall', 'tool_result', 'toolResult', 'tool_use_id', 'toolUseId']) {
    if (message[key] !== undefined) return true
  }
  if (message.input !== undefined || message.output !== undefined) return true
  const content = message.content
  if (Array.isArray(content)) {
    return content.some((part) => {
      if (!isObj(part)) return false
      const partKind = String(part.role ?? part.type ?? part.kind ?? '').toLowerCase()
      if (partKind.includes('tool')) return true
      return part.input !== undefined || part.output !== undefined || part.tool_calls !== undefined || part.toolCalls !== undefined
    })
  }
  return false
}

function extractText(message: unknown): string {
  if (typeof message === 'string') return message
  if (!isObj(message)) return String(message)
  if (typeof message.text === 'string') return message.text
  if (typeof message.content === 'string') return message.content
  if (Array.isArray(message.content)) {
    const parts = message.content
      .map((part) => {
        if (typeof part === 'string') return part
        if (!isObj(part)) return ''
        if (typeof part.text === 'string') return part.text
        if (typeof part.content === 'string') return part.content
        return ''
      })
      .filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }
  if (typeof message.summary === 'string') return message.summary
  return '消息内容暂无法预览，请回到 OpenClaude 查看完整过程。'
}

function extractTs(obj: Record<string, unknown>): { ts?: number } {
  const raw = obj.ts ?? obj.timestamp ?? obj.createdAt
  return typeof raw === 'number' && Number.isFinite(raw) ? { ts: raw } : {}
}

function extractToolName(obj: Record<string, unknown>): { toolName?: string } {
  const raw = obj.toolName ?? obj.name
  return typeof raw === 'string' && raw ? { toolName: raw } : {}
}

function truncate(text: string): string {
  if (text.length <= MAX_MESSAGE_TEXT_CHARS) return text
  return `${text.slice(0, MAX_MESSAGE_TEXT_CHARS)}\n…`
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function renderWechatLivePage(nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>OpenClaude 微信实时过程</title>
  <style nonce="${nonce}">
    :root{color-scheme:light;background:#f6f7f9;color:#16181d;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0}.shell{max-width:760px;margin:0 auto;padding:18px 14px 28px}
    .top{position:sticky;top:0;z-index:2;margin:0 -14px 12px;padding:12px 14px;background:rgba(246,247,249,.92);backdrop-filter:blur(10px);border-bottom:1px solid #e7e9ee}
    h1{margin:0 0 4px;font-size:18px;line-height:1.3}.sub{font-size:13px;color:#666d7a}.state{margin-top:8px;font-size:13px;color:#35705f}
    .actions{display:flex;gap:8px;margin-top:10px}.actions a{display:none;padding:7px 10px;border:1px solid #d7dae2;border-radius:8px;color:#1f4f8f;text-decoration:none;background:#fff;font-size:13px}
    .msg{margin:10px 0;padding:11px 12px;border:1px solid #e1e4ea;border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(10,20,40,.04)}
    .role{font-size:12px;color:#697180;margin-bottom:6px}.text{white-space:pre-wrap;word-break:break-word;font-size:14px;line-height:1.58}
    .thinking{background:#fffaf0;border-color:#eadfc7}.event{background:#f3f7ff;border-color:#d8e4fb}.assistant{background:#fff}.user{background:#f7fff9;border-color:#d8eadc}
    .empty,.error{padding:18px 12px;border:1px dashed #ccd2dd;border-radius:10px;color:#697180;background:#fff;text-align:center}.error{color:#9a3412;border-color:#fed7aa;background:#fff7ed}
  </style>
</head>
<body>
  <main class="shell">
    <header class="top">
      <h1>OpenClaude 微信实时过程</h1>
      <div class="sub">只读页面，不需要登录；最终结果仍会发回微信。</div>
      <div id="state" class="state">正在连接…</div>
      <div class="actions"><a id="full" href="#" rel="nofollow">登录打开完整会话</a></div>
    </header>
    <section id="list"><div class="empty">等待第一条过程消息…</div></section>
  </main>
  <script nonce="${nonce}">
    const token = new URLSearchParams(location.search).get('t') || '';
    const state = document.getElementById('state');
    const list = document.getElementById('list');
    const full = document.getElementById('full');
    let since = '';
    function label(role){return role === 'user' ? '你' : role === 'assistant' ? '助手' : role === 'thinking' ? '思考' : '事件'}
    function setState(text){state.textContent = text}
    function render(messages){
      list.textContent = '';
      if (!messages.length) {
        const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '等待第一条过程消息…'; list.appendChild(empty); return;
      }
      for (const msg of messages) {
        const card = document.createElement('article'); card.className = 'msg ' + (msg.role || 'event');
        const role = document.createElement('div'); role.className = 'role'; role.textContent = label(msg.role) + (msg.toolName ? ' · ' + msg.toolName : '');
        const text = document.createElement('div'); text.className = 'text'; text.textContent = msg.text || '';
        card.append(role, text); list.appendChild(card);
      }
    }
    async function poll(){
      if (!token) { list.innerHTML = '<div class="error">链接缺少访问凭证。</div>'; setState('无法打开'); return; }
      try {
        const qs = new URLSearchParams({ t: token }); if (since) qs.set('since', since);
        const resp = await fetch('/api/wechat/live?' + qs.toString(), { cache: 'no-store' });
        if (!resp.ok) { throw new Error(resp.status === 410 ? '链接已过期，请在微信里重新发起任务。' : '读取失败：' + resp.status); }
        const data = await resp.json();
        if (!data.unchanged) {
          since = String(data.updatedAt || '');
          render(Array.isArray(data.messages) ? data.messages : []);
          if (data.sessionId) { full.href = '/?session=' + encodeURIComponent(data.sessionId); full.style.display = 'inline-flex'; }
        }
        setState('已同步 ' + new Date().toLocaleTimeString());
      } catch (err) {
        const box = document.createElement('div'); box.className = 'error'; box.textContent = err && err.message ? err.message : '读取失败';
        list.textContent = ''; list.appendChild(box); setState('连接异常');
      } finally {
        setTimeout(poll, 2200);
      }
    }
    poll();
  </script>
</body>
</html>`
}
