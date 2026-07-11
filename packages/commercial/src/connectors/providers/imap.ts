/**
 * providers/imap — QQ / 163 / 通用邮箱(IMAP 读 + SMTP 发;自由域 provider)。
 *
 * 出站纪律(outboundPolicy §5):imapflow / nodemailer 不走 undici dispatcher →
 * **host=钉死 IP + tls.servername=真实主机名**;IMAP 仅 993 隐式 TLS;SMTP 465/587,
 * 587 显式 requireTLS=true(TLS 升级前不发 AUTH);禁 rejectUnauthorized:false。
 * 连接超时 10s / 总 60s;IMAP 用完即断(v1 无连接池,§10)。
 *
 * QQ/163 按域自动预设 host(presetImapConfig);通用档要求手填。
 */

import { ImapFlow } from 'imapflow'
import { createTransport } from 'nodemailer'
import { ConnectorError } from '../errors.js'
import {
  CONNECT_TIMEOUT_MS,
  type DnsResolver,
  TOTAL_TIMEOUT_MS,
  assertHostnameShape,
  assertImapPort,
  assertSmtpPort,
  resolvePinnedAddress,
} from '../outboundPolicy.js'
import type { ImapSecret } from '../store.js'
import { TEXT_FIELD_MAX_CHARS, mapFetchFailure, truncateText } from './shared.js'

export interface ImapDeps {
  resolver?: DnsResolver
  /** 测试注入:替换 ImapFlow 工厂。 */
  imapFactory?: (opts: Record<string, unknown>) => ImapClientLike
  /** 测试注入:替换 nodemailer transport 工厂。 */
  smtpFactory?: (opts: Record<string, unknown>) => SmtpTransportLike
}

/** 收窄的 ImapFlow 面(单测 mock 用)。 */
export interface ImapClientLike {
  connect(): Promise<void>
  logout(): Promise<void>
  list(): Promise<Array<{ path: string; name?: string; specialUse?: string }>>
  getMailboxLock(path: string): Promise<{ release(): void }>
  search(q: Record<string, unknown>, opts?: Record<string, unknown>): Promise<number[] | false>
  fetchOne(
    seq: string | number,
    q: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): Promise<Record<string, unknown> | false>
  fetch(
    range: string | number[] | Record<string, unknown>,
    q: Record<string, unknown>,
    opts?: Record<string, unknown>,
  ): AsyncIterable<Record<string, unknown>>
  download(
    range: string | number,
    part?: string,
    opts?: Record<string, unknown>,
  ): Promise<{ content?: NodeJS.ReadableStream } | false>
}

export interface SmtpTransportLike {
  sendMail(mail: Record<string, unknown>): Promise<{ messageId?: string; accepted?: unknown[] }>
  close(): void
}

// ─── 域名预设(QQ/163;绑定时解析) ────────────────────────────────────────

export interface ImapPreset {
  imapHost: string
  imapPort: number
  smtpHost: string
  smtpPort: number
}

const PRESETS: Record<string, ImapPreset> = {
  'qq.com': { imapHost: 'imap.qq.com', imapPort: 993, smtpHost: 'smtp.qq.com', smtpPort: 465 },
  'foxmail.com': {
    imapHost: 'imap.qq.com',
    imapPort: 993,
    smtpHost: 'smtp.qq.com',
    smtpPort: 465,
  },
  '163.com': { imapHost: 'imap.163.com', imapPort: 993, smtpHost: 'smtp.163.com', smtpPort: 465 },
  '126.com': { imapHost: 'imap.126.com', imapPort: 993, smtpHost: 'smtp.126.com', smtpPort: 465 },
}

/** 按邮箱域取预设;非预设域返回 null(通用档须手填 host)。 */
export function presetImapConfig(email: string): ImapPreset | null {
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email
    .slice(at + 1)
    .trim()
    .toLowerCase()
  return PRESETS[domain] ?? null
}

// ─── 连接工厂(钉死 IP + SNI) ────────────────────────────────────────────

async function openImap(secret: ImapSecret, deps: ImapDeps): Promise<ImapClientLike> {
  assertHostnameShape(secret.imapHost)
  assertImapPort(secret.imapPort)
  const pin = await resolvePinnedAddress(secret.imapHost, deps.resolver)
  const factory =
    deps.imapFactory ??
    ((opts: Record<string, unknown>) => new ImapFlow(opts as never) as unknown as ImapClientLike)
  const client = factory({
    host: pin.ip, // 钉死 IP 建连
    port: secret.imapPort,
    secure: true, // 993 隐式 TLS
    tls: { servername: secret.imapHost, rejectUnauthorized: true }, // hostname 只作 SNI/证书校验
    auth: { user: secret.email, pass: secret.password },
    logger: false,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: TOTAL_TIMEOUT_MS,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    disableAutoIdle: true,
  })
  try {
    await client.connect()
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // imapflow 认证失败 authenticationFailed=true / response 含 NO
    if ((err as { authenticationFailed?: boolean })?.authenticationFailed || /auth/i.test(msg)) {
      throw new ConnectorError('UPSTREAM_AUTH_FAILED', 'imap login rejected')
    }
    throw mapFetchFailure(err, 'imap')
  }
  return client
}

/** 用完即断(§10);logout 失败不掩盖主错误。 */
async function withImap<T>(
  secret: ImapSecret,
  deps: ImapDeps,
  fn: (client: ImapClientLike) => Promise<T>,
): Promise<T> {
  const client = await openImap(secret, deps)
  try {
    return await fn(client)
  } finally {
    await client.logout().catch(() => {})
  }
}

// ─── 绑定期验证 ──────────────────────────────────────────────────────────

export async function verifyImapCredentials(
  secret: ImapSecret,
  deps: ImapDeps = {},
): Promise<void> {
  // SMTP 侧共用同一授权码,不再二次连接(发信失败会即时暴露)—— 绑定探活只走 IMAP。
  assertHostnameShape(secret.smtpHost)
  assertSmtpPort(secret.smtpPort)
  await withImap(secret, deps, async () => {})
}

// ─── actions ─────────────────────────────────────────────────────────────

/** envelope 形态(imapflow envelope 对象)→ 显示字符串。 */
function envAddr(list: unknown): string {
  if (!Array.isArray(list)) return ''
  return list
    .map((x) => {
      const e = x as { name?: string; address?: string }
      return e.name ? `${e.name} <${e.address ?? ''}>` : (e.address ?? '')
    })
    .filter(Boolean)
    .join(', ')
}

function envAddrArray(list: unknown): string[] {
  if (!Array.isArray(list)) return []
  return list.map((x) => (x as { address?: string }).address ?? '').filter(Boolean)
}

export async function imapListMailboxes(secret: ImapSecret, deps: ImapDeps = {}): Promise<unknown> {
  return withImap(secret, deps, async (client) => {
    const list = await client.list()
    return {
      mailboxes: list.slice(0, 200).map((m) => ({
        path: m.path,
        name: m.name ?? m.path,
        ...(m.specialUse ? { specialUse: m.specialUse } : {}),
      })),
    }
  })
}

export async function imapSearchMessages(
  secret: ImapSecret,
  params: { mailbox?: string; text?: string; from?: string; since?: string; limit?: number },
  deps: ImapDeps = {},
): Promise<unknown> {
  const mailbox = params.mailbox ?? 'INBOX'
  const limit = params.limit ?? 20
  return withImap(secret, deps, async (client) => {
    const lock = await client.getMailboxLock(mailbox)
    try {
      const query: Record<string, unknown> = {}
      if (params.text) query.text = params.text
      if (params.from) query.from = params.from
      if (params.since) {
        const d = new Date(params.since)
        if (Number.isNaN(d.getTime())) {
          throw new ConnectorError('VALIDATION_FAILED', 'since is not a valid date')
        }
        query.since = d
      }
      if (Object.keys(query).length === 0) query.all = true
      const uids = await client.search(query, { uid: true })
      const picked = (uids === false ? [] : uids).slice(-limit).reverse()
      const messages: Array<Record<string, unknown>> = []
      for (const uid of picked) {
        const msg = await client.fetchOne(uid, { envelope: true, flags: true }, { uid: true })
        if (!msg) continue
        const env = (msg as { envelope?: Record<string, unknown> }).envelope ?? {}
        const flags = (msg as { flags?: Set<string> }).flags
        const [subject] = truncateText(String(env.subject ?? ''), 500)
        messages.push({
          uid,
          subject,
          from: envAddr(env.from),
          ...(env.date ? { date: new Date(env.date as string | Date).toISOString() } : {}),
          ...(flags ? { seen: flags.has('\\Seen') } : {}),
        })
      }
      return { mailbox, messages }
    } finally {
      lock.release()
    }
  })
}

export async function imapGetMessage(
  secret: ImapSecret,
  params: { uid: number; mailbox?: string },
  deps: ImapDeps = {},
): Promise<unknown> {
  const mailbox = params.mailbox ?? 'INBOX'
  return withImap(secret, deps, async (client) => {
    const lock = await client.getMailboxLock(mailbox)
    try {
      const msg = await client.fetchOne(
        params.uid,
        { envelope: true, bodyStructure: true },
        { uid: true },
      )
      if (!msg) throw new ConnectorError('UPSTREAM_NOT_FOUND', 'message not found')
      const env = (msg as { envelope?: Record<string, unknown> }).envelope ?? {}

      // 取纯文本 part:遍历 bodyStructure 找 text/plain,退而 text/html 剥标签
      const structure = (msg as { bodyStructure?: Record<string, unknown> }).bodyStructure
      const partPath = findTextPart(structure)
      let text = ''
      if (partPath) {
        const dl = await client.download(params.uid, partPath.part, { uid: true })
        if (dl !== false && dl.content) {
          const buf = await readStreamBounded(dl.content, 512 * 1024)
          text = buf.toString('utf8')
          if (partPath.isHtml) text = stripHtml(text)
        }
      }
      const [textOut, textTruncated] = truncateText(text, TEXT_FIELD_MAX_CHARS)
      const [subject] = truncateText(String(env.subject ?? ''), 500)
      return {
        uid: params.uid,
        mailbox,
        subject,
        from: envAddr(env.from),
        to: envAddrArray(env.to).slice(0, 100),
        ...(envAddrArray(env.cc).length > 0 ? { cc: envAddrArray(env.cc).slice(0, 100) } : {}),
        ...(env.date ? { date: new Date(env.date as string | Date).toISOString() } : {}),
        text: textOut,
        textTruncated,
      }
    } finally {
      lock.release()
    }
  })
}

interface TextPartRef {
  part: string
  isHtml: boolean
}

/** bodyStructure 深度优先找 text/plain(优先)或 text/html。 */
export function findTextPart(structure: unknown): TextPartRef | null {
  let html: TextPartRef | null = null
  const walk = (node: unknown): TextPartRef | null => {
    if (!node || typeof node !== 'object') return null
    const n = node as {
      type?: string
      part?: string
      childNodes?: unknown[]
    }
    const type = (n.type ?? '').toLowerCase()
    if (type === 'text/plain') return { part: n.part ?? '1', isHtml: false }
    if (type === 'text/html' && !html) html = { part: n.part ?? '1', isHtml: true }
    if (Array.isArray(n.childNodes)) {
      for (const c of n.childNodes) {
        const found = walk(c)
        if (found) return found
      }
    }
    return null
  }
  const plain = walk(structure)
  if (plain) return plain
  if (html) return html
  // 单体非 multipart 消息:imapflow 用 part 'TEXT' 下载正文
  const rootType = ((structure as { type?: string })?.type ?? '').toLowerCase()
  if (rootType.startsWith('text/')) return { part: 'TEXT', isHtml: rootType === 'text/html' }
  return null
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

async function readStreamBounded(stream: NodeJS.ReadableStream, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    total += chunk.length
    if (total > maxBytes) break // 正文超限:截断即可(读操作,非安全边界)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/**
 * send_email(SMTP)。**"可能已发出"异常一律 unknown**:transport 层在 DATA 阶段
 * 之后的超时/断连无法断定未送达 → 抛 maybeDelivered 标记,由调用方 finalize 成
 * unknown,绝不盲重试(§3 护栏)。
 */
export async function imapSendEmail(
  secret: ImapSecret,
  params: { to: string[]; cc?: string[]; subject: string; text: string },
  deps: ImapDeps = {},
): Promise<unknown> {
  assertHostnameShape(secret.smtpHost)
  assertSmtpPort(secret.smtpPort)
  const pin = await resolvePinnedAddress(secret.smtpHost, deps.resolver)
  const factory =
    deps.smtpFactory ??
    ((opts: Record<string, unknown>) =>
      createTransport(opts as never) as unknown as SmtpTransportLike)
  const transport = factory({
    host: pin.ip, // 钉死 IP
    port: secret.smtpPort,
    secure: secret.smtpPort === 465, // 465 隐式 TLS
    requireTLS: secret.smtpPort === 587, // 587:STARTTLS 前不发 AUTH
    auth: { user: secret.email, pass: secret.password },
    tls: { servername: secret.smtpHost, rejectUnauthorized: true },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: TOTAL_TIMEOUT_MS,
  })
  try {
    const info = await transport.sendMail({
      from: secret.email,
      to: params.to.join(', '),
      ...(params.cc && params.cc.length > 0 ? { cc: params.cc.join(', ') } : {}),
      subject: params.subject,
      text: params.text,
    })
    return {
      accepted: Array.isArray(info.accepted) ? info.accepted.length : params.to.length,
      ...(info.messageId ? { messageId: info.messageId } : {}),
    }
  } catch (err) {
    const e = err as { responseCode?: number; code?: string; command?: string }
    // 认证/策略类失败(信封阶段,未进 DATA)→ 确定未发出 → failed
    if (e.responseCode === 535 || e.responseCode === 534 || e.code === 'EAUTH') {
      throw new ConnectorError('UPSTREAM_AUTH_FAILED', 'smtp auth rejected')
    }
    if (typeof e.responseCode === 'number' && e.responseCode >= 500 && e.command !== 'DATA') {
      throw new ConnectorError('UPSTREAM_ERROR', `smtp rejected (${e.responseCode})`)
    }
    // DATA 之后 / 传输层断连:可能已发出 → unknown
    const ambiguous = new ConnectorError('UPSTREAM_ERROR', 'smtp outcome ambiguous')
    ;(ambiguous as ConnectorError & { maybeDelivered?: boolean }).maybeDelivered = true
    throw ambiguous
  } finally {
    try {
      transport.close()
    } catch {
      /* ignore */
    }
  }
}

export async function executeImap(
  secret: ImapSecret,
  action: string,
  params: Record<string, unknown>,
  deps: ImapDeps = {},
): Promise<unknown> {
  switch (action) {
    case 'list_mailboxes':
      return imapListMailboxes(secret, deps)
    case 'search_messages':
      return imapSearchMessages(secret, params as never, deps)
    case 'get_message':
      return imapGetMessage(secret, params as never, deps)
    case 'send_email':
      return imapSendEmail(secret, params as never, deps)
    default:
      throw new ConnectorError('ACTION_UNKNOWN', `imap has no action ${action}`)
  }
}
