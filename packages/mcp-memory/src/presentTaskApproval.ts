/**
 * 对话内任务单人工审批卡。Agent 只负责投递;点选由用户浏览器以 human actor
 * 调 /api/board,done 仍不属于 AI。
 *
 * 与 present_options 一样 detached:校验后立刻返回,不等用户、不代点。
 */

import { gatewayBoardBase, type TaskToolResult } from './taskboardMcp.js'

export const TASK_APPROVAL_STATUSES = ['backlog', 'waiting_human'] as const
export type TaskApprovalStatus = (typeof TASK_APPROVAL_STATUSES)[number]

export type PresentTaskApprovalPayload = {
  id: string
  prompt?: string
}

export type TaskApprovalSnapshot = {
  kind: 'task_approval'
  id: string
  identifier: string
  title: string
  status: string
  version: number
  type?: string
  priority?: string
  prompt?: string
}

const MAX_PROMPT = 2000

function toolOk(msg: string): TaskToolResult {
  return { content: [{ type: 'text', text: msg }] }
}
function toolError(msg: string): TaskToolResult {
  return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function shouldListPresentTaskApproval(delegationDepth: number): boolean {
  return delegationDepth <= 0
}

export function normalizePresentTaskApproval(raw: unknown): PresentTaskApprovalPayload | null {
  const rec = asRecord(raw)
  if (!rec) return null
  const idRaw = rec.id ?? rec.identifier
  if (typeof idRaw !== 'string') return null
  const id = idRaw.trim()
  if (!id || id.length > 80) return null
  if (rec.prompt !== undefined && rec.prompt !== null && typeof rec.prompt !== 'string') {
    return null
  }
  const prompt =
    typeof rec.prompt === 'string' && rec.prompt.trim().length > 0 ? rec.prompt.trim() : undefined
  if (prompt && prompt.length > MAX_PROMPT) return null
  return prompt ? { id, prompt } : { id }
}

function isApprovalStatus(status: unknown): status is TaskApprovalStatus {
  return status === 'backlog' || status === 'waiting_human'
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

function formatSnapshot(snapshot: TaskApprovalSnapshot): string {
  const action =
    snapshot.status === 'backlog' ? '批准开工 / 暂不批准' : '通过 / 打回'
  const promptLine = snapshot.prompt ? `提问: ${snapshot.prompt}\n` : ''
  return [
    `已投递审批卡 \`${snapshot.identifier}\` [${snapshot.status}] v${snapshot.version}。`,
    promptLine.trimEnd(),
    `立刻结束本回合,不要让用户去打开任务面板,不要轮询。用户点「${action}」会以用户本人身份改单据,并作为下一条普通消息到达。`,
    '',
    JSON.stringify(snapshot),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export async function handlePresentTaskApproval(
  args: unknown,
  ctx: { delegationDepth: number },
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<TaskToolResult> {
  if (ctx.delegationDepth > 0) {
    return toolOk(
      JSON.stringify({
        status: 'skipped',
        reason:
          'subagent has no interactive user — decide yourself, or list numbered options in your final report',
      }),
    )
  }
  const payload = normalizePresentTaskApproval(args)
  if (!payload) {
    return toolError('present_task_approval 参数无效:需要 {id}(面板返回的 identifier 或 uuid),prompt 可选')
  }
  const { base, headers } = gatewayBoardBase(env)
  const id = encodeURIComponent(payload.id)
  try {
    const res = await fetchImpl(`${base}/tickets/${id}`, { headers })
    const data = await readJson(res)
    if (!res.ok) return toolError(`读取任务单失败: ${formatApiError(res, data)}`)
    const ticket = (data.ticket ?? data) as Record<string, unknown>
    const identifier = String(ticket.identifier ?? payload.id)
    const status = ticket.status
    if (!isApprovalStatus(status)) {
      return toolError(
        `单据 \`${identifier}\` 当前 status=\`${String(status ?? '')}\`,只有 backlog(立项批准)或 waiting_human(验收通过)才能投递审批卡`,
      )
    }
    const snapshot: TaskApprovalSnapshot = {
      kind: 'task_approval',
      id: identifier,
      identifier,
      title: String(ticket.title ?? ''),
      status,
      version: typeof ticket.version === 'number' ? ticket.version : 0,
      ...(typeof ticket.type === 'string' ? { type: ticket.type } : {}),
      ...(typeof ticket.priority === 'string' ? { priority: ticket.priority } : {}),
      ...(payload.prompt ? { prompt: payload.prompt } : {}),
    }
    return toolOk(formatSnapshot(snapshot))
  } catch (err: any) {
    return toolError(`投递审批卡失败: ${err?.message ?? String(err)}`)
  }
}
