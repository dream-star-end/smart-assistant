/**
 * registry — 应用连接器静态目录(设计终稿 §1):provider 声明、表单字段、
 * per-action 参数 schema(TypeBox 严格,未知字段拒绝)与**结果 allowlist schema**
 * (TypeBox;Value.Clean 剥掉一切白名单外字段,再 Check)。
 *
 * v1 五 provider,零平台方开放平台注册:
 *   webdav / imap(+smtp) / notion(internal token)/ github(复用既有 OAuth,只读)/
 *   feishu(BYOA oauth2+PKCE)。
 *
 * 目录即权威:handlers / rpc / providers 全部经本表取 action 元数据,
 * 不允许散落第二份 action 清单。
 */

import { type Static, type TObject, type TSchema, Type } from '@sinclair/typebox'
import { Value } from '@sinclair/typebox/value'
import { ConnectorError } from './errors.js'

// ─── 类型 ────────────────────────────────────────────────────────────────

/** DB 内 provider(connections.provider CHECK 四值)。 */
export type DbConnectorProvider = 'webdav' | 'imap' | 'notion' | 'feishu'
/** 目录 provider(含 github 只读 adapter,不落 connections 表 —— §4)。 */
export type ConnectorProviderId = DbConnectorProvider | 'github'

export interface ConnectorFormField {
  key: string
  label: string
  type: 'text' | 'password' | 'url'
  placeholder?: string
  required: boolean
  helpText?: string
  helpUrl?: string
}

/**
 * authKind 取值(用户 API 契约的 providers[].authKind):
 *   'form'   — 多字段表单绑定(webdav / imap)
 *   'token'  — 单 token 表单绑定(notion)
 *   'oauth'  — BYOA OAuth(feishu;POST :provider/oauth/start)
 *   'github' — 复用现有 GitHub OAuth 绑定入口(不走本模块绑定)
 */
export type ConnectorAuthKind = 'form' | 'token' | 'oauth' | 'github'

export interface ConnectorActionDecl {
  id: string
  description: string
  /** false = 写操作,必须过确认门(§3)。 */
  readOnly: boolean
  /** 参数 schema(TypeBox 严格 additionalProperties:false)。 */
  params: TObject
  /** 结果 allowlist schema:Value.Clean 后 Check。 */
  result: TObject
  /** 'file' 类结果只受 6MB base64 cap 管,不受 256KB 结构化上限管(§6)。 */
  resultKind: 'json' | 'file'
  /** send 类(邮件/消息):计 per-user 日上限 50。 */
  sendClass?: boolean
}

export interface ConnectorProviderDecl {
  id: ConnectorProviderId
  label: string
  description: string
  authKind: ConnectorAuthKind
  formFields: ConnectorFormField[]
  actions: ConnectorActionDecl[]
}

// ─── 共享 schema 片段 ────────────────────────────────────────────────────

const strict = { additionalProperties: false } as const

/** base64 编码后 6MB cap(§6 文件传输)。 */
export const FILE_BASE64_MAX_CHARS = 6 * 1024 * 1024

const PathString = Type.String({ minLength: 1, maxLength: 1024 })
const EmailString = Type.String({ minLength: 3, maxLength: 254 })

// ─── webdav ──────────────────────────────────────────────────────────────

const webdavActions: ConnectorActionDecl[] = [
  {
    id: 'list_dir',
    description: '列出 WebDAV 目录内容',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object({ path: Type.Optional(PathString) }, strict),
    result: Type.Object(
      {
        path: Type.String(),
        entries: Type.Array(
          Type.Object(
            {
              name: Type.String(),
              path: Type.String(),
              isDir: Type.Boolean(),
              size: Type.Optional(Type.Number()),
              mtime: Type.Optional(Type.String()),
            },
            strict,
          ),
          { maxItems: 200 },
        ),
      },
      strict,
    ),
  },
  {
    id: 'get_file',
    description: '下载 WebDAV 文件(base64,≤6MB)',
    readOnly: true,
    resultKind: 'file',
    params: Type.Object({ path: PathString }, strict),
    result: Type.Object(
      {
        path: Type.String(),
        sizeBytes: Type.Number(),
        sha256: Type.String(),
        contentBase64: Type.String(),
      },
      strict,
    ),
  },
  {
    id: 'put_file',
    description: '上传/覆盖 WebDAV 文件(base64,≤6MB)',
    readOnly: false,
    resultKind: 'json',
    params: Type.Object(
      {
        path: PathString,
        contentBase64: Type.String({ minLength: 0, maxLength: FILE_BASE64_MAX_CHARS }),
      },
      strict,
    ),
    result: Type.Object(
      { path: Type.String(), sizeBytes: Type.Number(), sha256: Type.String() },
      strict,
    ),
  },
]

// ─── imap(含 SMTP 发信) ─────────────────────────────────────────────────

const imapActions: ConnectorActionDecl[] = [
  {
    id: 'list_mailboxes',
    description: '列出邮箱文件夹',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object({}, strict),
    result: Type.Object(
      {
        mailboxes: Type.Array(
          Type.Object(
            {
              path: Type.String(),
              name: Type.String(),
              specialUse: Type.Optional(Type.String()),
            },
            strict,
          ),
          { maxItems: 200 },
        ),
      },
      strict,
    ),
  },
  {
    id: 'search_messages',
    description: '按条件搜索邮件(主题/发件人/时间)',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object(
      {
        mailbox: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        from: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        since: Type.Optional(Type.String({ minLength: 8, maxLength: 32 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      },
      strict,
    ),
    result: Type.Object(
      {
        mailbox: Type.String(),
        messages: Type.Array(
          Type.Object(
            {
              uid: Type.Number(),
              subject: Type.String(),
              from: Type.String(),
              date: Type.Optional(Type.String()),
              seen: Type.Optional(Type.Boolean()),
            },
            strict,
          ),
          { maxItems: 50 },
        ),
      },
      strict,
    ),
  },
  {
    id: 'get_message',
    description: '读取一封邮件正文',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object(
      {
        uid: Type.Integer({ minimum: 1 }),
        mailbox: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
      },
      strict,
    ),
    result: Type.Object(
      {
        uid: Type.Number(),
        mailbox: Type.String(),
        subject: Type.String(),
        from: Type.String(),
        to: Type.Array(Type.String(), { maxItems: 100 }),
        cc: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
        date: Type.Optional(Type.String()),
        text: Type.String(),
        textTruncated: Type.Boolean(),
      },
      strict,
    ),
  },
  {
    id: 'send_email',
    description: '发送邮件(SMTP)',
    readOnly: false,
    resultKind: 'json',
    sendClass: true,
    params: Type.Object(
      {
        to: Type.Array(EmailString, { minItems: 1, maxItems: 20 }),
        cc: Type.Optional(Type.Array(EmailString, { maxItems: 20 })),
        subject: Type.String({ minLength: 1, maxLength: 500 }),
        text: Type.String({ minLength: 1, maxLength: 100_000 }),
      },
      strict,
    ),
    result: Type.Object(
      { accepted: Type.Number(), messageId: Type.Optional(Type.String()) },
      strict,
    ),
  },
]

// ─── notion ──────────────────────────────────────────────────────────────

const notionActions: ConnectorActionDecl[] = [
  {
    id: 'search',
    description: '搜索 Notion 页面/数据库',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 256 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      },
      strict,
    ),
    result: Type.Object(
      {
        results: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              object: Type.String(),
              title: Type.String(),
              url: Type.Optional(Type.String()),
              lastEditedTime: Type.Optional(Type.String()),
            },
            strict,
          ),
          { maxItems: 50 },
        ),
      },
      strict,
    ),
  },
  {
    id: 'get_page',
    description: '读取 Notion 页面内容(纯文本)',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object({ pageId: Type.String({ minLength: 8, maxLength: 64 }) }, strict),
    result: Type.Object(
      {
        id: Type.String(),
        title: Type.String(),
        url: Type.Optional(Type.String()),
        lastEditedTime: Type.Optional(Type.String()),
        text: Type.String(),
        textTruncated: Type.Boolean(),
      },
      strict,
    ),
  },
  {
    id: 'create_page',
    description: '在指定父页面下创建 Notion 页面',
    readOnly: false,
    resultKind: 'json',
    params: Type.Object(
      {
        parentPageId: Type.String({ minLength: 8, maxLength: 64 }),
        title: Type.String({ minLength: 1, maxLength: 500 }),
        content: Type.Optional(Type.String({ maxLength: 100_000 })),
      },
      strict,
    ),
    result: Type.Object({ id: Type.String(), url: Type.Optional(Type.String()) }, strict),
  },
]

// ─── github(只读 adapter,§4) ───────────────────────────────────────────

const githubActions: ConnectorActionDecl[] = [
  {
    id: 'search_issues',
    description: '搜索 GitHub issues/PR',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object(
      {
        query: Type.String({ minLength: 1, maxLength: 512 }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30 })),
      },
      strict,
    ),
    result: Type.Object(
      {
        totalCount: Type.Number(),
        items: Type.Array(
          Type.Object(
            {
              repo: Type.String(),
              number: Type.Number(),
              title: Type.String(),
              state: Type.String(),
              url: Type.String(),
              isPullRequest: Type.Boolean(),
              updatedAt: Type.Optional(Type.String()),
            },
            strict,
          ),
          { maxItems: 30 },
        ),
      },
      strict,
    ),
  },
  {
    id: 'get_issue',
    description: '读取单个 GitHub issue/PR 详情',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object(
      {
        repo: Type.String({
          minLength: 3,
          maxLength: 140,
          pattern: '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$',
        }),
        number: Type.Integer({ minimum: 1 }),
      },
      strict,
    ),
    result: Type.Object(
      {
        repo: Type.String(),
        number: Type.Number(),
        title: Type.String(),
        state: Type.String(),
        url: Type.String(),
        body: Type.String(),
        bodyTruncated: Type.Boolean(),
        labels: Type.Array(Type.String(), { maxItems: 50 }),
        updatedAt: Type.Optional(Type.String()),
        comments: Type.Optional(Type.Number()),
      },
      strict,
    ),
  },
]

// ─── feishu(BYOA) ──────────────────────────────────────────────────────

const feishuActions: ConnectorActionDecl[] = [
  {
    id: 'get_doc',
    description: '读取飞书云文档纯文本内容',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object({ docId: Type.String({ minLength: 8, maxLength: 128 }) }, strict),
    result: Type.Object(
      { docId: Type.String(), content: Type.String(), contentTruncated: Type.Boolean() },
      strict,
    ),
  },
  {
    id: 'list_calendar_events',
    description: '列出飞书日历日程',
    readOnly: true,
    resultKind: 'json',
    params: Type.Object(
      {
        calendarId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        startTime: Type.String({ minLength: 8, maxLength: 40 }),
        endTime: Type.String({ minLength: 8, maxLength: 40 }),
      },
      strict,
    ),
    result: Type.Object(
      {
        events: Type.Array(
          Type.Object(
            {
              eventId: Type.String(),
              summary: Type.String(),
              startTime: Type.Optional(Type.String()),
              endTime: Type.Optional(Type.String()),
              status: Type.Optional(Type.String()),
            },
            strict,
          ),
          { maxItems: 200 },
        ),
      },
      strict,
    ),
  },
  {
    id: 'create_calendar_event',
    description: '创建飞书日历日程',
    readOnly: false,
    resultKind: 'json',
    params: Type.Object(
      {
        calendarId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
        summary: Type.String({ minLength: 1, maxLength: 500 }),
        startTime: Type.String({ minLength: 8, maxLength: 40 }),
        endTime: Type.String({ minLength: 8, maxLength: 40 }),
        description: Type.Optional(Type.String({ maxLength: 10_000 })),
        timezone: Type.Optional(Type.String({ maxLength: 64 })),
      },
      strict,
    ),
    result: Type.Object({ eventId: Type.String(), summary: Type.String() }, strict),
  },
  {
    id: 'send_message',
    description: '发送飞书消息',
    readOnly: false,
    resultKind: 'json',
    sendClass: true,
    params: Type.Object(
      {
        receiveId: Type.String({ minLength: 1, maxLength: 256 }),
        receiveIdType: Type.Union([
          Type.Literal('open_id'),
          Type.Literal('user_id'),
          Type.Literal('union_id'),
          Type.Literal('email'),
          Type.Literal('chat_id'),
        ]),
        text: Type.String({ minLength: 1, maxLength: 10_000 }),
      },
      strict,
    ),
    result: Type.Object({ messageId: Type.String() }, strict),
  },
]

// ─── provider 声明 ───────────────────────────────────────────────────────

export const CONNECTOR_PROVIDERS: Readonly<Record<ConnectorProviderId, ConnectorProviderDecl>> = {
  webdav: {
    id: 'webdav',
    label: 'WebDAV 网盘',
    description: '坚果云 / Nextcloud / 通用 WebDAV:浏览目录、读写文件。',
    authKind: 'form',
    formFields: [
      {
        key: 'serverUrl',
        label: '服务器地址',
        type: 'url',
        placeholder: 'https://dav.jianguoyun.com/dav/',
        required: true,
        helpText: '必须是 https 地址;坚果云为 https://dav.jianguoyun.com/dav/',
      },
      { key: 'username', label: '账号', type: 'text', required: true },
      {
        key: 'password',
        label: '应用密码',
        type: 'password',
        required: true,
        helpText: '在网盘的安全设置里生成的应用专用密码(非登录密码)',
        helpUrl: 'https://help.jianguoyun.com/?p=2064',
      },
    ],
    actions: webdavActions,
  },
  imap: {
    id: 'imap',
    label: '邮箱(IMAP/SMTP)',
    description: 'QQ / 163 / 通用邮箱:搜索、读信、发信(发信需确认)。',
    authKind: 'form',
    formFields: [
      { key: 'email', label: '邮箱地址', type: 'text', required: true },
      {
        key: 'password',
        label: '授权码',
        type: 'password',
        required: true,
        helpText: '邮箱设置里开启 IMAP/SMTP 后生成的授权码(非登录密码)',
      },
      {
        key: 'imapHost',
        label: 'IMAP 服务器',
        type: 'text',
        required: false,
        helpText: 'QQ/163 邮箱自动填充;其他邮箱手填,端口固定 993',
      },
      {
        key: 'smtpHost',
        label: 'SMTP 服务器',
        type: 'text',
        required: false,
        helpText: 'QQ/163 邮箱自动填充;其他邮箱手填',
      },
      {
        key: 'smtpPort',
        label: 'SMTP 端口',
        type: 'text',
        required: false,
        helpText: '465(SSL)或 587(STARTTLS);默认 465',
      },
    ],
    actions: imapActions,
  },
  notion: {
    id: 'notion',
    label: 'Notion',
    description: '搜索、读取与创建 Notion 页面(需 internal integration token)。',
    authKind: 'token',
    formFields: [
      {
        key: 'token',
        label: 'Integration Token',
        type: 'password',
        required: true,
        helpText: '在 Notion 创建 internal integration 并把目标页面 share 给它',
        helpUrl: 'https://www.notion.so/my-integrations',
      },
    ],
    actions: notionActions,
  },
  github: {
    id: 'github',
    label: 'GitHub',
    description: '搜索 / 读取 issues 与 PR(v1 只读;复用现有 GitHub 绑定)。',
    authKind: 'github',
    formFields: [],
    actions: githubActions,
  },
  feishu: {
    id: 'feishu',
    label: '飞书(自建应用)',
    description: '企业自建应用 BYOA:读文档、日历与发消息(写操作需确认)。',
    authKind: 'oauth',
    formFields: [
      {
        key: 'clientId',
        label: 'App ID',
        type: 'text',
        required: true,
        helpText: '飞书开放平台 → 你的企业自建应用 → 凭证与基础信息',
        helpUrl: 'https://open.feishu.cn/app',
      },
      { key: 'clientSecret', label: 'App Secret', type: 'password', required: true },
    ],
    actions: feishuActions,
  },
}

export const DB_PROVIDER_IDS: readonly DbConnectorProvider[] = [
  'webdav',
  'imap',
  'notion',
  'feishu',
]

export function isDbProvider(id: string): id is DbConnectorProvider {
  return (DB_PROVIDER_IDS as readonly string[]).includes(id)
}

export function getProviderDecl(id: string): ConnectorProviderDecl | null {
  return (CONNECTOR_PROVIDERS as Record<string, ConnectorProviderDecl>)[id] ?? null
}

export function getActionDecl(providerId: string, actionId: string): ConnectorActionDecl | null {
  const p = getProviderDecl(providerId)
  if (!p) return null
  return p.actions.find((a) => a.id === actionId) ?? null
}

// ─── 校验 helpers ────────────────────────────────────────────────────────

/**
 * 参数严格校验:未知字段拒绝(additionalProperties:false),类型/边界不符拒绝。
 * 通过 → 返回原对象(TypeBox Check 不改值)。失败 → VALIDATION_FAILED。
 */
export function validateActionParams<T extends TObject>(schema: T, params: unknown): Static<T> {
  const value = params ?? {}
  if (!Value.Check(schema, value)) {
    const first = Value.Errors(schema, value).First()
    throw new ConnectorError(
      'VALIDATION_FAILED',
      `params invalid at ${first?.path ?? '?'}: ${first?.message ?? 'schema mismatch'}`,
    )
  }
  return value as Static<T>
}

/**
 * 结果 allowlist 收口:Clean(剥白名单外字段)→ Check。
 * 结果由我方 provider 代码构造,Check 失败=编程错误 → INTERNAL。
 */
export function cleanActionResult<T extends TSchema>(schema: T, result: unknown): Static<T> {
  const cleaned = Value.Clean(schema, structuredClone(result))
  if (!Value.Check(schema, cleaned)) {
    const first = Value.Errors(schema, cleaned).First()
    throw new ConnectorError(
      'INTERNAL',
      `action result failed allowlist schema at ${first?.path ?? '?'}`,
    )
  }
  return cleaned as Static<T>
}
