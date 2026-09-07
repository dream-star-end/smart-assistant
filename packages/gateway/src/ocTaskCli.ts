/**
 * oc-task —— 容器内任务面板 CLI。AI 与人共用同一套 `/api/board/*`。
 *
 * 落点:platform-runtime/bin/oc-task.sh 薄壳 → 本文件(gateway TS)。
 * 鉴权不假设 `OPENCLAUDE_GATEWAY_TOKEN` 在 Bash 里存在(那是 MCP 注入的):
 *   1. env `OPENCLAUDE_GATEWAY_TOKEN`
 *   2. env `OPENCLAUDE_GATEWAY_TOKEN_FILE` 指向的文件
 *   3. `~/.openclaude/openclaude.json` 的 `gateway.accessToken`
 * 端口:env `OPENCLAUDE_GATEWAY_PORT` → 同文件 `gateway.port`。禁止写死 18790。
 *
 * 契约:单行 JSON + `schemaVersion`;退出码 0/2/3/4/5/6。
 * identifier 一律用服务端返回值,本 CLI **绝不**拼 `OCV5-<n>`。
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TASK_CLI_SCHEMA_VERSION = 1

/** 稳定退出码。help 与 skill 必须与此表一致。 */
export const TASK_CLI_EXIT = {
  ok: 0,
  usage: 2,
  unreachable: 3,
  api: 4,
  versionConflict: 5,
  leaseHeld: 6,
} as const

export const TASK_CLI_USAGE = `usage: oc-task <project|ticket|relation|run> <subcommand> [flags]

project  list [--include-archived]
         create --key KEY --name NAME [--description TEXT] [--workspace PATH] [--labels a,b]
ticket   list [--project-id ID] [--status S] [--type T] [--priority P] [--assignee A]
              [--stage-id ID] [--label L] [--q Q] [--limit N] [--offset N]
              [--ndjson] [--full]
              default output drops each ticket's \`body\` (replaced by bodyBytes) so
              wide listings stay small; --full restores it.
              stdout may be a 64KiB pipe: with --limit >8 use --ndjson (one ticket
              per line, streamed) or redirect to a file, else a single-blob JSON
              can reach the reader cut mid-string.
         get <idOrIdent>
         create --project-id ID --type bug|feature|spike|chore --title TITLE
                [--body MD] [--priority P0-P3] [--severity S] [--labels a,b] [--assignee A]
         update <idOrIdent> --expected-version N [--title T] [--body MD] [--priority P]
                [--severity S] [--labels a,b] [--assignee A] [--blocked-reason R]
         claim <idOrIdent> --expected-version N [--owner agent:<id>]
         approve <idOrIdent> --expected-version N [--owner agent:<id>]
         advance <idOrIdent> --expected-version N [--summary TEXT] [--output-md MD] [--run-id ID]
         block <idOrIdent> --expected-version N --reason TEXT
         comment <idOrIdent> --body MD [--run-id ID]
relation add <fromIdOrIdent> --to <toIdOrIdent> --kind parent|blocks|related
         remove <relationId>
run      list <ticketIdOrIdent> [--status S] [--stage-id ID] [--limit N] [--offset N]
         get <runId>

exit codes:
  0  success
  2  usage / bad arguments
  3  gateway unreachable or token/port missing
  4  API error (4xx/5xx except 409/423)
  5  version conflict (HTTP 409) — re-read then retry once
  6  lease held (HTTP 423) — someone else is running; retry is useless

identifier is server-generated. Never invent OCV5-<n>; only reuse values from get/list/create.`

type FileReader = (path: string, encoding: BufferEncoding) => string

export function parseFlags(args: string[]): {
  positional: string[]
  flags: Record<string, string>
} {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[(i += 1)] : 'true'
      flags[key] = val
    } else {
      positional.push(a)
    }
  }
  return { positional, flags }
}

function splitCsv(raw: string | undefined): string[] | undefined {
  if (!raw || raw === 'true') return undefined
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return items.length ? items : undefined
}

function optionalFlag(flags: Record<string, string>, key: string): string | undefined {
  const v = flags[key]
  if (v == null || v === 'true') return undefined
  const t = v.trim()
  return t || undefined
}

function requireIntFlag(
  flags: Record<string, string>,
  key: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const raw = optionalFlag(flags, key)
  if (raw == null) return { ok: false, message: `--${key} is required` }
  const n = Number(raw)
  if (!Number.isInteger(n)) return { ok: false, message: `--${key} must be an integer` }
  return { ok: true, value: n }
}

export interface TaskboardEndpoint {
  baseUrl: string
  token: string
}

export type EndpointResolve =
  | { ok: true; endpoint: TaskboardEndpoint }
  | { ok: false; error: string }

/**
 * 解析本容器 gateway 的 `/api/board` 回环地址与 token。
 * 不假设 MCP 注入的 env 存在;Bash 调 CLI 时必须能从 token file / openclaude.json 自举。
 */
export function resolveTaskboardEndpoint(
  env: NodeJS.ProcessEnv = process.env,
  readFile: FileReader = readFileSync,
): EndpointResolve {
  const home = env.OPENCLAUDE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.openclaude')
  const cfgPath = join(home, 'openclaude.json')

  let cfg: { gateway?: { port?: unknown; accessToken?: unknown } } | null = null
  try {
    cfg = JSON.parse(readFile(cfgPath, 'utf8')) as {
      gateway?: { port?: unknown; accessToken?: unknown }
    }
  } catch {
    cfg = null
  }

  let port: number | null = null
  const envPort = env.OPENCLAUDE_GATEWAY_PORT?.trim()
  if (envPort) {
    const n = Number(envPort)
    if (Number.isInteger(n) && n > 0 && n <= 65535) port = n
  }
  if (port == null && cfg?.gateway?.port != null) {
    const n = typeof cfg.gateway.port === 'number' ? cfg.gateway.port : Number(cfg.gateway.port)
    if (Number.isInteger(n) && n > 0 && n <= 65535) port = n
  }

  let token = env.OPENCLAUDE_GATEWAY_TOKEN?.trim() || ''
  if (!token) {
    const file = env.OPENCLAUDE_GATEWAY_TOKEN_FILE?.trim()
    if (file) {
      try {
        token = readFile(file, 'utf8').trim()
      } catch {
        token = ''
      }
    }
  }
  if (!token && typeof cfg?.gateway?.accessToken === 'string') {
    token = cfg.gateway.accessToken.trim()
  }

  if (port == null) {
    return {
      ok: false,
      error:
        'gateway port not found (set OPENCLAUDE_GATEWAY_PORT or gateway.port in openclaude.json)',
    }
  }
  if (!token) {
    return {
      ok: false,
      error:
        'gateway token not found (set OPENCLAUDE_GATEWAY_TOKEN / OPENCLAUDE_GATEWAY_TOKEN_FILE ' +
        'or gateway.accessToken in openclaude.json)',
    }
  }
  return { ok: true, endpoint: { baseUrl: `http://127.0.0.1:${port}/api/board`, token } }
}

export type TaskCliPlan =
  | { kind: 'usage'; message: string }
  | {
      kind: 'request'
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
      path: string
      query?: Record<string, string>
      body?: unknown
      /** ticket get 额外拉评论,动手前必须看返工要求。 */
      extraGets?: string[]
      /** 逐条流式输出(每行一个 item),避免单块写被 64KiB 管道缓冲截断。 */
      ndjson?: boolean
      /** 省略每条 item 的重字段(body/comments),只留 <field>Bytes 计数。 */
      slim?: boolean
    }

function usage(message = TASK_CLI_USAGE): TaskCliPlan {
  return { kind: 'usage', message }
}

function request(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: {
    query?: Record<string, string>
    body?: unknown
    extraGets?: string[]
    ndjson?: boolean
    slim?: boolean
  } = {},
): TaskCliPlan {
  return { kind: 'request', method, path, ...opts }
}

function encodeSeg(value: string): string {
  return encodeURIComponent(value)
}

function planProject(sub: string | undefined, rest: string[]): TaskCliPlan {
  const { flags } = parseFlags(rest)
  switch (sub) {
    case 'list': {
      const query: Record<string, string> = {}
      if (flags['include-archived'] === 'true') query.includeArchived = 'true'
      return request('GET', '/projects', { query })
    }
    case 'create': {
      const key = optionalFlag(flags, 'key')
      const name = optionalFlag(flags, 'name')
      if (!key || !name) return usage('project create --key KEY --name NAME')
      return request('POST', '/projects', {
        body: {
          key,
          name,
          description: optionalFlag(flags, 'description') ?? null,
          workspace: optionalFlag(flags, 'workspace') ?? null,
          labels: splitCsv(flags.labels) ?? [],
        },
      })
    }
    default:
      return usage('project list|create')
  }
}

function planTicket(
  sub: string | undefined,
  rest: string[],
  env: NodeJS.ProcessEnv = process.env,
): TaskCliPlan {
  const { positional, flags } = parseFlags(rest)
  switch (sub) {
    case 'list': {
      const query: Record<string, string> = {}
      const map: Record<string, string> = {
        'project-id': 'projectId',
        status: 'status',
        type: 'type',
        priority: 'priority',
        assignee: 'assignee',
        'stage-id': 'stageId',
        label: 'label',
        q: 'q',
        limit: 'limit',
        offset: 'offset',
      }
      for (const [flag, q] of Object.entries(map)) {
        const v = optionalFlag(flags, flag)
        if (v) query[q] = v
      }
      // 默认瘦身:宽列表只用来找卡,body 交给 `ticket get`。--full 恢复原样。
      return request('GET', '/tickets', {
        query,
        ndjson: flags.ndjson === 'true',
        slim: flags.full !== 'true',
      })
    }
    case 'get': {
      const id = positional[0]
      if (!id) return usage('ticket get <idOrIdent>')
      return request('GET', `/tickets/${encodeSeg(id)}`, {
        extraGets: [`/tickets/${encodeSeg(id)}/comments`],
      })
    }
    case 'create': {
      const projectId = optionalFlag(flags, 'project-id')
      const type = optionalFlag(flags, 'type')
      const title = optionalFlag(flags, 'title')
      if (!projectId || !type || !title) {
        return usage('ticket create --project-id ID --type TYPE --title TITLE')
      }
      // 禁止客户端推导 identifier:创建请求绝不带 identifier / version / id。
      const body: Record<string, unknown> = {
        projectId,
        type,
        title,
        body: optionalFlag(flags, 'body') ?? '',
        priority: optionalFlag(flags, 'priority'),
        severity: optionalFlag(flags, 'severity') ?? null,
        labels: splitCsv(flags.labels) ?? [],
        assignee: optionalFlag(flags, 'assignee') ?? null,
      }
      const source = optionalFlag(flags, 'source')
      if (source) body.source = source
      const reporter = optionalFlag(flags, 'reporter')
      if (reporter) body.reporter = reporter
      return request('POST', '/tickets', { body })
    }
    case 'update': {
      const id = positional[0]
      const ver = requireIntFlag(flags, 'expected-version')
      if (!id) return usage('ticket update <idOrIdent> --expected-version N')
      if (!ver.ok) return usage(ver.message)
      const body: Record<string, unknown> = { expectedVersion: ver.value }
      const title = optionalFlag(flags, 'title')
      if (title != null) body.title = title
      const ticketBody = optionalFlag(flags, 'body')
      if (ticketBody != null) body.body = ticketBody
      const priority = optionalFlag(flags, 'priority')
      if (priority != null) body.priority = priority
      if ('severity' in flags) body.severity = optionalFlag(flags, 'severity') ?? null
      if ('labels' in flags) body.labels = splitCsv(flags.labels) ?? []
      if ('assignee' in flags) body.assignee = optionalFlag(flags, 'assignee') ?? null
      if ('blocked-reason' in flags) {
        body.blockedReason = optionalFlag(flags, 'blocked-reason') ?? null
      }
      return request('PATCH', `/tickets/${encodeSeg(id)}`, { body })
    }
    case 'claim': {
      const id = positional[0]
      const ver = requireIntFlag(flags, 'expected-version')
      if (!id) return usage('ticket claim <idOrIdent> --expected-version N')
      if (!ver.ok) return usage(ver.message)
      const body: Record<string, unknown> = { expectedVersion: ver.value }
      const owner = optionalFlag(flags, 'owner') ?? ambientAgentOwner(env)
      if (owner) body.owner = owner
      return request('POST', `/tickets/${encodeSeg(id)}/claim`, { body })
    }
    case 'approve': {
      const id = positional[0]
      const ver = requireIntFlag(flags, 'expected-version')
      if (!id) return usage('ticket approve <idOrIdent> --expected-version N')
      if (!ver.ok) return usage(ver.message)
      const body: Record<string, unknown> = { expectedVersion: ver.value }
      const owner = optionalFlag(flags, 'owner') ?? ambientAgentOwner(env)
      if (owner) body.owner = owner
      return request('POST', `/tickets/${encodeSeg(id)}/approve`, { body })
    }
    case 'advance': {
      const id = positional[0]
      const ver = requireIntFlag(flags, 'expected-version')
      if (!id) return usage('ticket advance <idOrIdent> --expected-version N')
      if (!ver.ok) return usage(ver.message)
      const body: Record<string, unknown> = { expectedVersion: ver.value }
      const summary = optionalFlag(flags, 'summary')
      if (summary) body.summary = summary
      const outputMd = optionalFlag(flags, 'output-md')
      if (outputMd) body.outputMd = outputMd
      const runId = optionalFlag(flags, 'run-id')
      if (runId) body.runId = runId
      const owner = ambientAgentOwner(env)
      if (owner) body.owner = owner
      return request('POST', `/tickets/${encodeSeg(id)}/advance`, { body })
    }
    case 'block': {
      const id = positional[0]
      const ver = requireIntFlag(flags, 'expected-version')
      const reason = optionalFlag(flags, 'reason')
      if (!id || !ver.ok || !reason) {
        return usage('ticket block <idOrIdent> --expected-version N --reason TEXT')
      }
      const body: Record<string, unknown> = { expectedVersion: ver.value, reason }
      const owner = ambientAgentOwner(env)
      if (owner) body.owner = owner
      return request('POST', `/tickets/${encodeSeg(id)}/block`, { body })
    }
    case 'comment': {
      const id = positional[0]
      const bodyText = optionalFlag(flags, 'body')
      if (!id || !bodyText) return usage('ticket comment <idOrIdent> --body MD')
      const body: Record<string, unknown> = { body: bodyText }
      const runId = optionalFlag(flags, 'run-id')
      if (runId) body.runId = runId
      const author = ambientAgentOwner(env)
      if (author) body.author = author
      return request('POST', `/tickets/${encodeSeg(id)}/comment`, { body })
    }
    default:
      return usage('ticket list|get|create|update|claim|approve|advance|block|comment')
  }
}

function planRelation(sub: string | undefined, rest: string[]): TaskCliPlan {
  const { positional, flags } = parseFlags(rest)
  switch (sub) {
    case 'add': {
      const from = positional[0]
      const to = optionalFlag(flags, 'to')
      const kind = optionalFlag(flags, 'kind')
      if (!from || !to || !kind) {
        return usage('relation add <fromIdOrIdent> --to <toIdOrIdent> --kind parent|blocks|related')
      }
      return request('POST', `/tickets/${encodeSeg(from)}/relations`, {
        body: { toTicketId: to, kind },
      })
    }
    case 'remove': {
      const id = positional[0]
      if (!id) return usage('relation remove <relationId>')
      return request('DELETE', `/relations/${encodeSeg(id)}`)
    }
    default:
      return usage('relation add|remove')
  }
}

function planRun(sub: string | undefined, rest: string[]): TaskCliPlan {
  const { positional, flags } = parseFlags(rest)
  switch (sub) {
    case 'list': {
      const id = positional[0]
      if (!id) return usage('run list <ticketIdOrIdent>')
      const query: Record<string, string> = {}
      const status = optionalFlag(flags, 'status')
      if (status) query.status = status
      const stageId = optionalFlag(flags, 'stage-id')
      if (stageId) query.stageId = stageId
      const limit = optionalFlag(flags, 'limit')
      if (limit) query.limit = limit
      const offset = optionalFlag(flags, 'offset')
      if (offset) query.offset = offset
      return request('GET', `/tickets/${encodeSeg(id)}/runs`, { query })
    }
    case 'get': {
      const id = positional[0]
      if (!id) return usage('run get <runId>')
      return request('GET', `/runs/${encodeSeg(id)}`)
    }
    default:
      return usage('run list|get')
  }
}

export function ambientAgentOwner(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = (env.OPENCLAUDE_AGENT_ID ?? env.OC_AGENT_ID ?? '').trim()
  if (!id) return undefined
  return id.startsWith('agent:') ? id : `agent:${id}`
}

export function planTaskCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): TaskCliPlan {
  const [cmd, sub, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return usage()
  switch (cmd) {
    case 'project':
      return planProject(sub, rest)
    case 'ticket':
      return planTicket(sub, rest, env)
    case 'relation':
      return planRelation(sub, rest)
    case 'run':
      return planRun(sub, rest)
    default:
      return usage()
  }
}

export function wrapSuccess(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return { schemaVersion: TASK_CLI_SCHEMA_VERSION, ...(payload as Record<string, unknown>) }
  }
  return { schemaVersion: TASK_CLI_SCHEMA_VERSION, data: payload }
}

/**
 * 宽列表里按体积排前几名的字段。省掉正文后 50 张卡从 ~105KB 降到几 KB,
 * 但保留 `<field>Bytes` 让调用方知道「这里本来有东西,去 ticket get 拿」。
 */
export const LIST_HEAVY_FIELDS = ['body', 'comments', 'outputMd'] as const

/** 去掉重字段,换成字节数。非对象原样返回。 */
export function slimListItem(item: unknown): unknown {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item
  const src = item as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    if ((LIST_HEAVY_FIELDS as readonly string[]).includes(k) && v != null) {
      const text = typeof v === 'string' ? v : JSON.stringify(v)
      out[`${k}Bytes`] = Buffer.byteLength(text, 'utf8')
      continue
    }
    out[k] = v
  }
  return out
}

/**
 * 从 list 响应里摘出条目数组(服务端用 `items`,历史上也见过 `tickets`/裸数组),
 * 其余键作为信封留给 ndjson 的头行。
 */
export function splitListPayload(payload: unknown): {
  key: string | null
  items: unknown[]
  envelope: Record<string, unknown>
} {
  if (Array.isArray(payload)) return { key: null, items: payload, envelope: {} }
  if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>
    for (const key of ['items', 'tickets', 'data']) {
      if (Array.isArray(rec[key])) {
        const envelope: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(rec)) if (k !== key) envelope[k] = v
        return { key, items: rec[key] as unknown[], envelope }
      }
    }
  }
  return { key: null, items: [], envelope: {} }
}

/**
 * NDJSON 行序列:第一行是信封(`kind:"meta"`),随后每张卡一行。
 * 每行都能独立 JSON.parse —— 这是 64KB 截断下唯一还能救的形状:
 * 读端丢的只会是最后一行,前面 N-1 行仍然完整可用。
 */
export function buildNdjsonLines(payload: unknown, opts: { slim?: boolean } = {}): string[] {
  const { key, items, envelope } = splitListPayload(payload)
  const lines: string[] = [
    JSON.stringify({
      schemaVersion: TASK_CLI_SCHEMA_VERSION,
      kind: 'meta',
      itemsKey: key,
      count: items.length,
      slim: opts.slim === true,
      ...envelope,
    }),
  ]
  for (const item of items) {
    lines.push(JSON.stringify({ kind: 'item', item: opts.slim ? slimListItem(item) : item }))
  }
  return lines
}

/** 对 list 响应整体套用瘦身,保持信封结构不变。 */
export function slimListPayload(payload: unknown): unknown {
  const { key, items } = splitListPayload(payload)
  const slimmed = items.map(slimListItem)
  if (key == null) return Array.isArray(payload) ? slimmed : payload
  return { ...(payload as Record<string, unknown>), [key]: slimmed }
}

export function wrapError(error: string, code?: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemaVersion: TASK_CLI_SCHEMA_VERSION,
    ok: false,
    error,
  }
  if (code) out.code = code
  return out
}

export function exitCodeForHttp(status: number, apiCode?: string): number {
  if (status === 409 || apiCode === 'version_conflict') return TASK_CLI_EXIT.versionConflict
  if (status === 423 || apiCode === 'lease_held') return TASK_CLI_EXIT.leaseHeld
  return TASK_CLI_EXIT.api
}

/**
 * 写 stdout 并等它真的落地。
 *
 * 根因(OCV5-165):stdout 指向管道时是**异步**的,内核管道缓冲只有 64KiB。
 * 原实现在 `main()` 里直接 `process.exit(code)`,进程在超出 64KiB 的尾部被
 * flush 之前就没了 —— 读端拿到的 JSON 正好在 65536 字节处断在字符串中间
 * (butler weekly-kpi 的 `Unterminated string ... char 52350` 就是这个)。
 * 重定向到文件时 stdout 是同步的,所以同一条命令写文件 105KB 完好无损。
 */
export interface WritableLike {
  write(chunk: string, cb: (err?: Error | null) => void): unknown
  on(event: 'error', listener: (err: NodeJS.ErrnoException) => void): unknown
}

export function isEpipe(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'EPIPE'
}

export interface StreamWriter {
  /** 写一段;返回 false 表示管道已断、本次(及后续)被跳过。 */
  write(chunk: string): Promise<boolean>
  writeJson(obj: unknown): Promise<boolean>
  /** 逐行写;管道一断立即停,不再对断了的管道写剩下 N 行。 */
  writeLines(lines: string[]): Promise<boolean>
  readonly broken: boolean
  readonly fatal: NodeJS.ErrnoException | null
}

/**
 * 把 stdout 包成「EPIPE 安全」的写入器。
 *
 * 为什么必须显式监听 `'error'`:`process.stdout.write(chunk, cb)` 的 cb 拿到 err 之前,
 * stream 自身会先 emit `'error'`;没有 listener 的 `'error'` 在 node 里就是
 * **uncaught exception** → 直接 crash(`node:events:497 throw er`)。
 * 所以 `| head -1` 这类读端提前关闭的场景,只包 promise 的 reject 是兜不住的
 * (OCV5-165 返工 1 实测:`--ndjson --full | head -1` pipestatus=1、stderr 18 行)。
 *
 * 约定:**EPIPE 视为正常收尾**(读端不要了),退出码保持命令本身的码(成功即 0),
 * 与 `head`/`yes` 等 coreutils 管道行为一致;非 EPIPE 的写错误记进 `fatal` 上抛。
 */
export function createStreamWriter(stream: WritableLike): StreamWriter {
  let broken = false
  let fatal: NodeJS.ErrnoException | null = null

  stream.on('error', (err) => {
    if (isEpipe(err)) broken = true
    else fatal = err
  })

  const w: StreamWriter = {
    get broken() {
      return broken
    },
    get fatal() {
      return fatal
    },
    async write(chunk: string): Promise<boolean> {
      if (broken) return false // 管道已断:静默跳过,别再往里写
      if (fatal) throw fatal
      const err = await new Promise<Error | null | undefined>((resolve) => {
        try {
          stream.write(chunk, resolve)
        } catch (e) {
          resolve(e as Error) // 极端情况:write 同步抛
        }
      })
      if (err) {
        if (isEpipe(err)) {
          broken = true
          return false
        }
        fatal = err as NodeJS.ErrnoException
        throw err
      }
      if (fatal) throw fatal // 'error' 事件在 cb 之后到
      return !broken
    },
    async writeJson(obj: unknown): Promise<boolean> {
      return w.write(`${JSON.stringify(obj)}\n`)
    },
    async writeLines(lines: string[]): Promise<boolean> {
      for (const line of lines) {
        if (!(await w.write(`${line}\n`))) return false // 断了就立刻停
      }
      return true
    },
  }
  return w
}

/** 进程级 stdout 写入器(懒建,建时即挂 'error' listener)。 */
let stdoutWriter: StreamWriter | null = null
function out(): StreamWriter {
  if (!stdoutWriter) stdoutWriter = createStreamWriter(process.stdout as unknown as WritableLike)
  return stdoutWriter
}

async function writeJson(obj: unknown): Promise<void> {
  await out().writeJson(obj)
}

/** 逐行写 NDJSON,每行独立成条;背压由 write 的 callback 承担,EPIPE 立即止写。 */
async function writeNdjson(lines: string[]): Promise<void> {
  await out().writeLines(lines)
}

function writeErr(msg: string): void {
  process.stderr.write(`oc-task: ${msg}\n`)
}

function buildUrl(base: string, path: string, query?: Record<string, string>): string {
  const url = new URL(`${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`)
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, v)
    }
  }
  return url.toString()
}

export interface TaskFetchResult {
  ok: boolean
  status: number
  json: unknown
  unreachable?: boolean
}

export async function taskboardFetch(
  endpoint: TaskboardEndpoint,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
): Promise<TaskFetchResult> {
  const url = buildUrl(endpoint.baseUrl, path, opts.query)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 30_000)
  try {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${endpoint.token}`,
        ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: ctl.signal,
    })
    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      json = { raw: text }
    }
    return { ok: res.ok, status: res.status, json }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 0, json: { error: msg }, unreachable: true }
  } finally {
    clearTimeout(timer)
  }
}

function apiErrorText(json: unknown, fallback: string): { error: string; code?: string } {
  if (json && typeof json === 'object') {
    const rec = json as Record<string, unknown>
    const err = rec.error
    const code = typeof rec.code === 'string' ? rec.code : undefined
    if (typeof err === 'string') return { error: err, code }
    if (err && typeof err === 'object') {
      const inner = err as Record<string, unknown>
      const msg = typeof inner.message === 'string' ? inner.message : fallback
      return { error: msg, code: typeof inner.code === 'string' ? inner.code : code }
    }
  }
  return { error: fallback }
}

async function execute(plan: Extract<TaskCliPlan, { kind: 'request' }>): Promise<number> {
  const resolved = resolveTaskboardEndpoint()
  if (!resolved.ok) {
    await writeJson(wrapError(resolved.error))
    writeErr(resolved.error)
    return TASK_CLI_EXIT.unreachable
  }
  const primary = await taskboardFetch(resolved.endpoint, plan.method, plan.path, {
    query: plan.query,
    body: plan.body,
  })
  if (primary.unreachable) {
    const msg = apiErrorText(primary.json, 'gateway unreachable').error
    await writeJson(wrapError(msg))
    writeErr(msg)
    return TASK_CLI_EXIT.unreachable
  }
  if (!primary.ok) {
    const { error, code } = apiErrorText(primary.json, `HTTP ${primary.status}`)
    await writeJson(wrapError(error, code))
    writeErr(`${primary.status} ${code ?? ''} ${error}`.trim())
    return exitCodeForHttp(primary.status, code)
  }

  let payload: unknown = primary.json
  if (plan.extraGets?.length) {
    const extras: Record<string, unknown> = {}
    for (const extra of plan.extraGets) {
      const got = await taskboardFetch(resolved.endpoint, 'GET', extra)
      if (got.ok) {
        const key = extra.endsWith('/comments') ? 'comments' : extra.split('/').pop() || 'extra'
        extras[key] = got.json
      }
    }
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      payload = { ...(payload as Record<string, unknown>), ...extras }
    }
  }
  if (plan.ndjson) {
    await writeNdjson(buildNdjsonLines(payload, { slim: plan.slim }))
    return TASK_CLI_EXIT.ok
  }
  await writeJson(wrapSuccess(plan.slim ? slimListPayload(payload) : payload))
  return TASK_CLI_EXIT.ok
}

export async function runTaskCli(argv: string[]): Promise<number> {
  const [cmd] = argv
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    await out().write(`${TASK_CLI_USAGE}\n`)
    return TASK_CLI_EXIT.ok
  }
  const plan = planTaskCommand(argv)
  if (plan.kind === 'usage') {
    await writeJson(wrapError(plan.message))
    writeErr(plan.message)
    return TASK_CLI_EXIT.usage
  }
  return execute(plan)
}

/**
 * 设置退出码而**不**调用 `process.exit()`:让 node 把 stdout 排空后自然退出。
 * `process.exit()` 会丢掉管道里还没 flush 的部分(见 createStreamWriter 的根因注释)。
 */
function finish(code: number): void {
  process.exitCode = code
}

async function main(): Promise<void> {
  out() // 先建写入器 = 先挂 stdout 'error' listener,早于任何写
  const code = await runTaskCli(process.argv.slice(2))
  // 读端提前关闭(`| head -1`)不是本命令的失败:按 coreutils 惯例仍以本身的码收尾。
  finish(code)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (e) => {
    if (isEpipe(e)) {
      finish(TASK_CLI_EXIT.ok) // 读端不要了,不是错误
      return
    }
    const msg = e instanceof Error ? e.message : String(e)
    try {
      await writeJson(wrapError(msg))
    } catch {
      /* stdout 已断(EPIPE):错误仍走 stderr */
    }
    writeErr(msg)
    finish(TASK_CLI_EXIT.unreachable)
  })
}
