/**
 * openclaude-memory 的 taskboard MCP 工具实现。
 *
 * 与 reminder 一样回环打本容器 gateway(`/api/board`),token 走 MCP 注入的
 * `OPENCLAUDE_GATEWAY_TOKEN` / `*_FILE`。
 *
 * 比 create_reminder 多做的一步:从 `OPENCLAUDE_SESSION_KEY` 写入
 * ticket.originSessionKey,让「对话里一句话建单」能点回原对话。
 * 不在 tool args 里收 userId / originSessionKey / identifier。
 */
import { readFileSync } from 'node:fs'

export type TaskToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

function toolOk(msg: string): TaskToolResult {
  return { content: [{ type: 'text', text: msg }] }
}
function toolError(msg: string): TaskToolResult {
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
}

function readGatewayToken(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.OPENCLAUDE_GATEWAY_TOKEN_FILE
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim()
    } catch {
      // 与 index.ts readGatewayToken 一致:文件读失败回落 env,不崩。
    }
  }
  return env.OPENCLAUDE_GATEWAY_TOKEN || ''
}

export function gatewayBoardBase(env: NodeJS.ProcessEnv = process.env): {
  base: string
  headers: Record<string, string>
} {
  const gatewayPort = env.OPENCLAUDE_GATEWAY_PORT || '18789'
  return {
    base: `http://127.0.0.1:${gatewayPort}/api/board`,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${readGatewayToken(env)}`,
    },
  }
}

export function currentSessionKey(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OPENCLAUDE_SESSION_KEY ?? '').trim()
}

export function currentAgentRef(env: NodeJS.ProcessEnv = process.env): string {
  const id = (env.OPENCLAUDE_AGENT_ID ?? env.OC_AGENT_ID ?? '').trim()
  if (id) return id.startsWith('agent:') ? id : `agent:${id}`
  return 'agent:unidentified'
}

export interface TaskCreateArgs {
  projectId: string
  type: 'bug' | 'feature' | 'spike' | 'chore'
  title: string
  body?: string
  priority?: 'P0' | 'P1' | 'P2' | 'P3'
  severity?: 'critical' | 'major' | 'minor' | 'trivial'
  labels?: string[]
  assignee?: string
}

const CLIENT_FORBIDDEN_CREATE_KEYS = ['identifier', 'id', 'userId', 'version'] as const

function rejectClientAssignedTicketIds(args: object): TaskToolResult | null {
  const raw = args as Record<string, unknown>
  const hit = CLIENT_FORBIDDEN_CREATE_KEYS.filter((key) => key in raw)
  if (hit.length === 0) return null
  return toolError(
    `编号由服务端生成,不接受客户端指定 identifier / id / userId / version(本次含: ${hit.join(', ')})`,
  )
}

/**
 * 建单 body。identifier / version / id / userId / originSessionKey 都不从 args 收:
 * identifier 服务端生成;originSessionKey 从 MCP 进程 env 注入。
 */
export function buildCreateTicketBody(
  args: TaskCreateArgs,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, unknown> {
  const originSessionKey = currentSessionKey(env) || null
  return {
    projectId: args.projectId,
    type: args.type,
    title: args.title,
    body: args.body ?? '',
    priority: args.priority,
    severity: args.severity ?? null,
    labels: args.labels ?? [],
    assignee: args.assignee ?? null,
    reporter: currentAgentRef(env),
    source: 'chat',
    originSessionKey,
  }
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text()
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return { raw: text }
  }
}

function formatApiError(res: Response, data: any): string {
  const err = data?.error
  const code = data?.code
  const msg = typeof err === 'string' ? err : (err?.message ?? data?.raw ?? res.statusText)
  return `${res.status}${code ? ` ${code}` : ''} ${msg}`
}

export async function handleTaskCreate(
  args: TaskCreateArgs,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskToolResult> {
  const forbidden = rejectClientAssignedTicketIds(args)
  if (forbidden) return forbidden
  if (!args.projectId?.trim() || !args.type || !args.title?.trim()) {
    return toolError('projectId、type、title 必填')
  }
  const { base, headers } = gatewayBoardBase(env)
  try {
    const res = await fetchImpl(`${base}/tickets`, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildCreateTicketBody(args, env)),
    })
    const data = await readJson(res)
    if (!res.ok) return toolError(`创建任务单失败: ${formatApiError(res, data)}`)
    const ticket = data.ticket ?? data
    const ident = ticket?.identifier ?? '?'
    const version = ticket?.version ?? '?'
    const lines = [
      `✅ 已建单 \`${ident}\` v${version}: "${args.title}"`,
      `status=\`${ticket?.status ?? 'backlog'}\` type=\`${args.type}\``,
    ]
    if (ticket?.originSessionKey) lines.push(`会话: \`${ticket.originSessionKey}\``)
    lines.push('identifier 只用返回值,不要自己拼前缀。未批准(backlog)不许认领。')
    return toolOk(lines.join('\n'))
  } catch (err: any) {
    return toolError(`创建任务单失败: ${err?.message ?? String(err)}`)
  }
}

export interface TaskUpdateArgs {
  id: string
  expectedVersion: number
  title?: string
  body?: string
  priority?: 'P0' | 'P1' | 'P2' | 'P3'
  severity?: 'critical' | 'major' | 'minor' | 'trivial' | null
  labels?: string[]
  assignee?: string | null
  blockedReason?: string | null
}

export async function handleTaskUpdate(
  args: TaskUpdateArgs,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskToolResult> {
  if (!args.id?.trim()) return toolError('id 必填(用面板返回的 identifier 或 uuid)')
  if (!Number.isInteger(args.expectedVersion)) return toolError('expectedVersion 必填(整数)')
  const patch: Record<string, unknown> = { expectedVersion: args.expectedVersion }
  if (args.title !== undefined) patch.title = args.title
  if (args.body !== undefined) patch.body = args.body
  if (args.priority !== undefined) patch.priority = args.priority
  if (args.severity !== undefined) patch.severity = args.severity
  if (args.labels !== undefined) patch.labels = args.labels
  if (args.assignee !== undefined) patch.assignee = args.assignee
  if (args.blockedReason !== undefined) patch.blockedReason = args.blockedReason
  if (Object.keys(patch).length <= 1) return toolError('没有要修改的字段')
  const { base, headers } = gatewayBoardBase(env)
  try {
    const res = await fetchImpl(`${base}/tickets/${encodeURIComponent(args.id)}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify(patch),
    })
    const data = await readJson(res)
    if (res.status === 409) {
      return toolError(
        `版本冲突(409): ${formatApiError(res, data)}。请 task_get 重读后只重试一次,不要抢 lease。`,
      )
    }
    if (!res.ok) return toolError(`更新任务单失败: ${formatApiError(res, data)}`)
    const ticket = data.ticket ?? data
    return toolOk(`✅ 已更新 \`${ticket?.identifier ?? args.id}\` → v${ticket?.version ?? '?'}`)
  } catch (err: any) {
    return toolError(`更新任务单失败: ${err?.message ?? String(err)}`)
  }
}

export interface TaskCommentArgs {
  id: string
  body: string
  runId?: string
}

export async function handleTaskComment(
  args: TaskCommentArgs,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskToolResult> {
  if (!args.id?.trim()) return toolError('id 必填(用面板返回的 identifier 或 uuid)')
  if (!args.body?.trim()) return toolError('body 必填')
  const { base, headers } = gatewayBoardBase(env)
  try {
    const res = await fetchImpl(`${base}/tickets/${encodeURIComponent(args.id)}/comment`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        body: args.body,
        runId: args.runId ?? null,
        author: currentAgentRef(env),
      }),
    })
    const data = await readJson(res)
    if (!res.ok) return toolError(`写评论失败: ${formatApiError(res, data)}`)
    return toolOk(`✅ 已在 \`${args.id}\` 写下评论`)
  } catch (err: any) {
    return toolError(`写评论失败: ${err?.message ?? String(err)}`)
  }
}

export interface TaskListArgs {
  projectId?: string
  status?: string
  type?: string
  priority?: string
  assignee?: string
  q?: string
  limit?: number
  offset?: number
}

export async function handleTaskList(
  args: TaskListArgs = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskToolResult> {
  const { base, headers } = gatewayBoardBase(env)
  const url = new URL(`${base}/tickets`)
  for (const [k, v] of Object.entries({
    projectId: args.projectId,
    status: args.status,
    type: args.type,
    priority: args.priority,
    assignee: args.assignee,
    q: args.q,
    limit: args.limit != null ? String(args.limit) : undefined,
    offset: args.offset != null ? String(args.offset) : undefined,
  })) {
    if (v) url.searchParams.set(k, v)
  }
  try {
    const res = await fetchImpl(url.toString(), { headers })
    const data = await readJson(res)
    if (!res.ok) return toolError(`列出任务单失败: ${formatApiError(res, data)}`)
    const items = (data.items ?? []) as Array<Record<string, unknown>>
    const total = data.total ?? items.length
    if (items.length === 0) return toolOk('当前没有匹配的任务单。')
    const lines = items.map((t) => {
      const ident = t.identifier ?? t.id
      return `- \`${ident}\` [${t.status}] ${t.priority ?? ''} ${t.title ?? ''} v${t.version ?? '?'}`
    })
    return toolOk(`共 ${total} 张(本页 ${items.length}):\n${lines.join('\n')}`)
  } catch (err: any) {
    return toolError(`列出任务单失败: ${err?.message ?? String(err)}`)
  }
}

export interface TaskGetArgs {
  id: string
}

export async function handleTaskGet(
  args: TaskGetArgs,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskToolResult> {
  if (!args.id?.trim()) return toolError('id 必填(用面板返回的 identifier 或 uuid)')
  const { base, headers } = gatewayBoardBase(env)
  const id = encodeURIComponent(args.id)
  try {
    const [ticketRes, commentRes] = await Promise.all([
      fetchImpl(`${base}/tickets/${id}`, { headers }),
      fetchImpl(`${base}/tickets/${id}/comments`, { headers }),
    ])
    const ticketData = await readJson(ticketRes)
    if (!ticketRes.ok) return toolError(`读取任务单失败: ${formatApiError(ticketRes, ticketData)}`)
    const ticket = ticketData.ticket ?? ticketData
    let comments: Array<Record<string, unknown>> = []
    if (commentRes.ok) {
      const c = await readJson(commentRes)
      comments = c.items ?? []
    }
    const commentBlock =
      comments.length === 0
        ? '(无评论)'
        : comments
            .map((c) => `- ${c.authorKind}/${c.author}: ${String(c.body ?? '').slice(0, 400)}`)
            .join('\n')
    return toolOk(
      [
        `identifier: \`${ticket.identifier}\``,
        `version: ${ticket.version}`,
        `status: ${ticket.status}`,
        `type: ${ticket.type}  priority: ${ticket.priority}`,
        `title: ${ticket.title}`,
        `assignee: ${ticket.assignee ?? '—'}`,
        `originSessionKey: ${ticket.originSessionKey ?? '—'}`,
        `body:\n${ticket.body ?? ''}`,
        `comments:\n${commentBlock}`,
        ticket.status === 'backlog' ? '⚠ backlog 未批准,不许认领。' : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  } catch (err: any) {
    return toolError(`读取任务单失败: ${err?.message ?? String(err)}`)
  }
}
