// Taskboard 状态机 —— 服务端强制的转移表(纯逻辑,无 I/O)。
//
// 设计意图:
//   status 与 stage 正交:status 说「卡在谁那里」,stage 说「走到哪一站」。
//   本模块只裁决 status 转移是否合法;换 stage / 写 version / 落时间线都是上层的事。
//   越权必须在这里就被拒,由 HTTP/MCP 层把 TaskboardTransitionDenied 转 403。
//   这不是写在 skill 里的君子协定(见 notes/CORRECTIONS.md §2.7、设计文档 §3)。
//
// 坑:
//   1. Actor 含 system,给熔断/循环护栏用。system 不能认领(ready→running 必须是
//      持有 lease 的 agent),也不能关单(除非 stage 显式 auto_close)、不能取消。
//   2. autoClose 由调用方作为上下文传入(真值是 PipelineStage.autoClose,已进冻结
//      契约)。本模块不臆造「最后一站 + !requireHumanAck = 自动关单」——那种推断在
//      流水线被改序后会静默失效。
//   3. 同状态自转一律拒绝。状态转移是审计事件;字段 PATCH / 续 lease 不走这里,
//      放行自转会让前端「这张卡能做什么」出现假动作,也掩盖客户端重复提交。
//   4. 终态(done/canceled)不可转出,唯一出口是人显式重开 → ready。canceled 与
//      done 对称:人都可能手滑关错单,重开比再新建一张能保住 identifier 与时间线。
//   5. agent 的 running→ready 必须 stageOnSuccess ∈ {advance, stay}:
//      advance = 推进下一站后回到待认领;stay = 留在本站等下一轮巡检。
//      wait_human 只能走 running→waiting_human,不许借 ready 绕过确认门。

import {
  type Actor,
  type OnSuccessAction,
  TICKET_STATUSES,
  TICKET_STATUS_LABEL,
  type TicketStatus,
} from './domain.js'

/** 状态中文名的唯一真值在 domain.ts;这里 re-export 给旧调用方。 */
export { TICKET_STATUS_LABEL }

export const ACTORS: readonly Actor[] = ['human', 'agent', 'system']

// ── 裁决结果 ────────────────────────────────────────────────────────────────

export const TRANSITION_DENIED_CODES = [
  'same_status',
  'not_allowed',
  'actor_denied',
  'lease_required',
  'on_success_required',
  'auto_close_required',
  'terminal_locked',
] as const
export type TransitionDeniedCode = (typeof TRANSITION_DENIED_CODES)[number]

export type TransitionVerdict =
  | { ok: true }
  | { ok: false; code: TransitionDeniedCode; reason: string }

export interface TransitionInput {
  from: TicketStatus
  to: TicketStatus
  actor: Actor
  /** 当前 stage 的 onSuccess。agent/system 走 running→ready 时必填。 */
  stageOnSuccess?: OnSuccessAction
  /** agent 认领 ready→running 时必须为 true。human 手动开工不检查。 */
  hasLease?: boolean
  /** 当前 stage 是否显式配置了自动关单。缺省视为 false。 */
  autoClose?: boolean
}

export interface TransitionRule {
  from: TicketStatus
  to: TicketStatus
  actors: readonly Actor[]
  /** 给人看的动作名,供前端渲染「这张卡现在能做什么」。 */
  label: string
  /** agent 走这条必须已取得 lease(version 由 HTTP 层另验)。 */
  requireLeaseForAgent?: boolean
  /** agent/system 走这条时,stage.onSuccess 必须落在此集合。human 打断不检查。 */
  requireOnSuccess?: readonly OnSuccessAction[]
  /** agent/system 走这条必须 autoClose。human 随时可关单。 */
  requireAutoClose?: boolean
}

// ── 转移表(机器可读,测试与前端共用这一份) ─────────────────────────────────

function closeRule(from: TicketStatus): TransitionRule {
  return {
    from,
    to: 'done',
    actors: ['human', 'agent', 'system'],
    label: '标记完成',
    requireAutoClose: true,
  }
}

function cancelRule(from: TicketStatus): TransitionRule {
  return {
    from,
    to: 'canceled',
    actors: ['human'],
    label: '取消',
  }
}

/**
 * 完整转移表。遍历它即可得到「从 from 出发、某 actor 在给定上下文下能做什么」。
 * 不含自转。终态只留「人重开 → ready」。
 */
export const TRANSITION_TABLE: readonly TransitionRule[] = [
  // backlog:人没批准,AI 不许碰
  { from: 'backlog', to: 'ready', actors: ['human'], label: '批准开工' },
  closeRule('backlog'),
  cancelRule('backlog'),

  // ready:已批准,等认领
  {
    from: 'ready',
    to: 'running',
    actors: ['human', 'agent'],
    label: '开始执行',
    requireLeaseForAgent: true,
  },
  { from: 'ready', to: 'blocked', actors: ['human', 'system'], label: '标记受阻' },
  { from: 'ready', to: 'backlog', actors: ['human'], label: '撤回批准' },
  closeRule('ready'),
  cancelRule('ready'),

  // running:某个 run 持有 lease
  {
    from: 'running',
    to: 'waiting_human',
    actors: ['human', 'agent', 'system'],
    label: '提交确认',
  },
  {
    from: 'running',
    to: 'blocked',
    actors: ['human', 'agent', 'system'],
    label: '标记受阻',
  },
  {
    from: 'running',
    to: 'ready',
    actors: ['human', 'agent', 'system'],
    label: '回到待执行',
    requireOnSuccess: ['advance', 'stay'],
  },
  closeRule('running'),
  cancelRule('running'),

  // waiting_human:等人拍板
  { from: 'waiting_human', to: 'ready', actors: ['human'], label: '打回重做' },
  { from: 'waiting_human', to: 'running', actors: ['human'], label: '确认并继续' },
  { from: 'waiting_human', to: 'blocked', actors: ['human'], label: '标记受阻' },
  { from: 'waiting_human', to: 'backlog', actors: ['human'], label: '退回立项' },
  closeRule('waiting_human'),
  cancelRule('waiting_human'),

  // blocked:等人解开
  { from: 'blocked', to: 'ready', actors: ['human'], label: '解除受阻' },
  { from: 'blocked', to: 'waiting_human', actors: ['human'], label: '改为待确认' },
  { from: 'blocked', to: 'backlog', actors: ['human'], label: '退回立项' },
  closeRule('blocked'),
  cancelRule('blocked'),

  // 终态重开:仅 human,且只回到 ready(重新排队等认领,不直接 running)
  { from: 'done', to: 'ready', actors: ['human'], label: '重开' },
  { from: 'canceled', to: 'ready', actors: ['human'], label: '重开' },
]

const RULE_INDEX = new Map<string, TransitionRule>()
for (const rule of TRANSITION_TABLE) {
  RULE_INDEX.set(`${rule.from}>${rule.to}`, rule)
}

// ── 人话 reason ─────────────────────────────────────────────────────────────

function statusName(s: TicketStatus): string {
  return `${TICKET_STATUS_LABEL[s]}(${s})`
}

function deny(code: TransitionDeniedCode, reason: string): TransitionVerdict {
  return { ok: false, code, reason }
}

function actorDeniedReason(from: TicketStatus, to: TicketStatus, actor: Actor): string {
  if (from === 'backlog' && to === 'ready') {
    return '待立项的单据只有人能批准开工，AI 不能自行转到待执行。'
  }
  if (to === 'canceled') {
    return '取消单据只有人能做。'
  }
  if ((from === 'done' || from === 'canceled') && to === 'ready') {
    return '重开已关闭的单据只有人能做。'
  }
  if (from === 'ready' && to === 'running' && actor === 'system') {
    return '认领执行必须由持有 lease 的 agent 发起，系统角色不能代领。'
  }
  return `${actor} 不能把单据从${statusName(from)}转到${statusName(to)}。`
}

// ── 核心裁决 ────────────────────────────────────────────────────────────────

export function canTransition(input: TransitionInput): TransitionVerdict {
  const { from, to, actor } = input

  if (from === to) {
    return deny(
      'same_status',
      `状态未变化（${statusName(from)} → ${statusName(to)}）。更新字段或续租请走对应接口，不要走状态转移。`,
    )
  }

  const rule = RULE_INDEX.get(`${from}>${to}`)
  if (!rule) {
    if (from === 'done' || from === 'canceled') {
      return deny(
        'terminal_locked',
        `单据已${TICKET_STATUS_LABEL[from]}，不能再转到${statusName(to)}。人若要重开，请转到待执行(ready)。`,
      )
    }
    return deny('not_allowed', `不允许从${statusName(from)}转到${statusName(to)}。`)
  }

  if (!rule.actors.includes(actor)) {
    return deny('actor_denied', actorDeniedReason(from, to, actor))
  }

  if (rule.requireLeaseForAgent && actor === 'agent' && !input.hasLease) {
    return deny(
      'lease_required',
      'agent 从待执行进入执行中必须先取得 lease，且调用方需带 version。',
    )
  }

  if (rule.requireOnSuccess && actor !== 'human') {
    const allowed = rule.requireOnSuccess
    const got = input.stageOnSuccess
    if (!got || !allowed.includes(got)) {
      return deny(
        'on_success_required',
        `agent/系统把执行中打回待执行，仅当本阶段 onSuccess 为 advance（推进下一站）或 stay（留在本站再巡）时允许。当前为 ${got ?? '未提供'}。`,
      )
    }
  }

  if (rule.requireAutoClose && actor !== 'human' && !input.autoClose) {
    return deny(
      'auto_close_required',
      '完成状态只有人能给。AI 不能把单据标为完成（除非本阶段显式配置了 auto_close）。',
    )
  }

  return { ok: true }
}

export class TaskboardTransitionDenied extends Error {
  override readonly name = 'TaskboardTransitionDenied'
  readonly code: TransitionDeniedCode

  constructor(code: TransitionDeniedCode, reason: string) {
    super(reason)
    this.code = code
  }
}

/** 拒绝时抛 TaskboardTransitionDenied,供上层转 403。 */
export function assertTransition(input: TransitionInput): void {
  const verdict = canTransition(input)
  if (!verdict.ok) {
    throw new TaskboardTransitionDenied(verdict.code, verdict.reason)
  }
}

/**
 * 给定当前状态 + 角色 + 上下文,列出可转到的目标。
 * 前端用来渲染「这张卡现在能做什么」;与 canTransition 共用同一张表。
 */
export function listAllowedTransitions(
  from: TicketStatus,
  actor: Actor,
  ctx: Omit<TransitionInput, 'from' | 'to' | 'actor'> = {},
): TicketStatus[] {
  const out: TicketStatus[] = []
  for (const status of TICKET_STATUSES) {
    if (canTransition({ from, to: status, actor, ...ctx }).ok) out.push(status)
  }
  return out
}
