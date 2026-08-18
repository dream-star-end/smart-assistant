// 拖动语义解析 —— 纯函数,无 I/O。
//
// `/move` 落库与 board 的 `allowedMoves` **必须**走这一份,否则界面显示能拖、
// 真拖过去被拒。本模块只回答「这次拖动叫什么动作、要不要确认/理由、会跳过谁」;
// 跑着的 run、阻塞依赖、乐观锁、鉴权都由 HTTP 层在调用前后处理。
//
// 原则(用户冻结):每次拖动必须解析成可解释的命名动作,解析不出就拒绝,
// 不要按距离限制悄悄改库。

import {
  type StageKind,
  TERMINAL_STATUSES,
  TICKET_STATUS_LABEL,
  type TicketStatus,
} from './domain.js'

export const MOVE_ACTIONS = [
  'promote',
  'promote_at_stage',
  'ack_advance',
  'skip_forward',
  'send_back',
  'return_to_backlog',
  'reopen',
  'noop',
] as const
export type MoveAction = (typeof MOVE_ACTIONS)[number]

export const MOVE_ACTION_LABEL: Record<MoveAction, string> = {
  promote: '批准开工',
  promote_at_stage: '批准并指定入站',
  ack_advance: '确认过站',
  skip_forward: '跳站前进',
  send_back: '打回重做',
  return_to_backlog: '退回积压',
  reopen: '重开',
  noop: '未移动',
}

export interface MoveStageRef {
  id: string
  name: string
  kind: StageKind
  ordinal: number
}

export interface InterpretMoveInput {
  status: TicketStatus
  stageId: string | null
  pipelineId: string | null
  toStageId: string | null
  stages: readonly MoveStageRef[]
}

export interface MoveIntent {
  action: MoveAction
  label: string
  fromStageId: string | null
  toStageId: string | null
  /** 落库后的 status;noop 时等于当前 status。 */
  toStatus: TicketStatus
  /** 中间被跳过的站,不含当前站、不含目标站。 */
  skippedStages: MoveStageRef[]
  /** skip_forward 时被放弃的当前站;其它动作为 null。 */
  abandonedStage: MoveStageRef | null
  requiresReason: boolean
  requiresConfirm: boolean
  warning: string | null
}

export type InterpretMoveResult =
  | { ok: true; intent: MoveIntent }
  | {
      ok: false
      code: 'stage_pipeline_mismatch' | 'no_interpretable_intent'
      why: string
      detail?: Record<string, unknown>
    }

export interface AllowedMove {
  toStageId: string | null
  action: Exclude<MoveAction, 'noop'>
  label: string
  requiresReason: boolean
  requiresConfirm: boolean
  warning?: string
  skippedStages?: Array<{ id: string; name: string; kind: StageKind }>
  abandonedStage?: { id: string; name: string; kind: StageKind }
}

/** 目标站 kind → 拖入后的 status。gate 不占 agent,按 ready 排队。 */
export function statusForStageKind(kind: StageKind): TicketStatus {
  return kind === 'human' ? 'waiting_human' : 'ready'
}

function byOrdinal(stages: readonly MoveStageRef[]): MoveStageRef[] {
  return [...stages].sort((a, b) => a.ordinal - b.ordinal)
}

function findStage(stages: readonly MoveStageRef[], id: string | null): MoveStageRef | undefined {
  if (!id) return undefined
  return stages.find((s) => s.id === id)
}

function stagesBetween(
  stages: readonly MoveStageRef[],
  fromOrdinal: number,
  toOrdinal: number,
): MoveStageRef[] {
  const lo = Math.min(fromOrdinal, toOrdinal)
  const hi = Math.max(fromOrdinal, toOrdinal)
  return byOrdinal(stages).filter((s) => s.ordinal > lo && s.ordinal < hi)
}

function stagesBefore(stages: readonly MoveStageRef[], ordinal: number): MoveStageRef[] {
  return byOrdinal(stages).filter((s) => s.ordinal < ordinal)
}

/** kind=ai 且站名像自验/审查 —— 跳过时必须在 warning/detail 里标出来。 */
export function isAuditLikeStage(stage: Pick<MoveStageRef, 'name' | 'kind'>): boolean {
  if (stage.kind !== 'ai') return false
  return /自验|审查|review|audit/i.test(stage.name)
}

function skipWarning(skipped: readonly MoveStageRef[]): string | null {
  const audit = skipped.filter(isAuditLikeStage)
  if (audit.length === 0) return null
  return `会跳过「${audit.map((s) => s.name).join('+')}」站`
}

function skipForwardWarning(abandoned: MoveStageRef, skipped: readonly MoveStageRef[]): string {
  const parts = [`「${abandoned.name}」站的工作将被视为不需要`]
  const audit = skipWarning(skipped)
  if (audit) parts.push(audit)
  return parts.join('；')
}

export function publicStageRef(stage: MoveStageRef): { id: string; name: string; kind: StageKind }
export function publicStageRef(
  stage: MoveStageRef | null | undefined,
): { id: string; name: string; kind: StageKind } | null
export function publicStageRef(
  stage: MoveStageRef | null | undefined,
): { id: string; name: string; kind: StageKind } | null {
  if (!stage) return null
  return { id: stage.id, name: stage.name, kind: stage.kind }
}

function ok(
  intent: Omit<MoveIntent, 'label' | 'abandonedStage'> & {
    label?: string
    abandonedStage?: MoveStageRef | null
  },
): InterpretMoveResult {
  const action = intent.action
  return {
    ok: true,
    intent: {
      ...intent,
      abandonedStage: intent.abandonedStage ?? null,
      label: intent.label ?? MOVE_ACTION_LABEL[action],
    },
  }
}

function deny(
  code: 'stage_pipeline_mismatch' | 'no_interpretable_intent',
  why: string,
  detail?: Record<string, unknown>,
): InterpretMoveResult {
  return detail ? { ok: false, code, why, detail } : { ok: false, code, why }
}

/**
 * 把一次拖动解析成命名动作。不读库、不看 actor / version / run。
 *
 * `toStageId === null` 表示拖进积压列。
 */
export function interpretMove(input: InterpretMoveInput): InterpretMoveResult {
  const stages = byOrdinal(input.stages)
  const fromStage = findStage(stages, input.stageId)
  const toId = input.toStageId

  if (toId !== null) {
    const target = findStage(stages, toId)
    if (!target) {
      return deny('stage_pipeline_mismatch', '目标阶段不属于该单据当前流水线。', {
        toStageId: toId,
        pipelineId: input.pipelineId,
      })
    }
  }

  if (stages.length === 0 && toId !== null) {
    return deny('no_interpretable_intent', '单据未挂流水线,无法解析拖动目标。', {
      why: 'no_pipeline',
    })
  }

  // 已在积压列再拖回积压 = 未改动
  if (toId === null && input.status === 'backlog') {
    return ok({
      action: 'noop',
      fromStageId: input.stageId,
      toStageId: null,
      toStatus: 'backlog',
      skippedStages: [],
      requiresReason: false,
      requiresConfirm: false,
      warning: null,
    })
  }

  // 目标 = 当前站,且不是终态重开 / 积压批准(status 会变)
  if (
    toId !== null &&
    toId === input.stageId &&
    input.status !== 'backlog' &&
    !TERMINAL_STATUSES.has(input.status)
  ) {
    return ok({
      action: 'noop',
      fromStageId: input.stageId,
      toStageId: toId,
      toStatus: input.status,
      skippedStages: [],
      requiresReason: false,
      requiresConfirm: false,
      warning: null,
    })
  }

  const first = stages[0]
  const target = toId === null ? null : findStage(stages, toId)
  const fromIndex = fromStage ? stages.findIndex((s) => s.id === fromStage.id) : -1
  const toIndex = target ? stages.findIndex((s) => s.id === target.id) : -1
  const fromOrdinal = fromStage?.ordinal
  const toOrdinal = target?.ordinal

  // 积压列
  if (toId === null) {
    return ok({
      action: 'return_to_backlog',
      fromStageId: input.stageId,
      toStageId: null,
      toStatus: 'backlog',
      skippedStages: [],
      requiresReason: false,
      requiresConfirm: false,
      warning: null,
    })
  }

  if (!target) {
    return deny('no_interpretable_intent', '找不到目标阶段。')
  }

  // 终态 → 任意站 = 重开
  if (TERMINAL_STATUSES.has(input.status)) {
    const skipped = stagesBefore(stages, target.ordinal)
    return ok({
      action: 'reopen',
      fromStageId: input.stageId,
      toStageId: target.id,
      toStatus: statusForStageKind(target.kind),
      skippedStages: skipped,
      requiresReason: false,
      requiresConfirm: true,
      warning: skipWarning(skipped),
    })
  }

  // 积压 → 第一站 / 中间站
  if (input.status === 'backlog') {
    if (first && target.id === first.id) {
      return ok({
        action: 'promote',
        fromStageId: input.stageId,
        toStageId: target.id,
        toStatus: 'ready',
        skippedStages: [],
        requiresReason: false,
        requiresConfirm: false,
        warning: null,
      })
    }
    const skipped = first ? stagesBefore(stages, target.ordinal) : []
    return ok({
      action: 'promote_at_stage',
      fromStageId: input.stageId,
      toStageId: target.id,
      toStatus: 'ready',
      skippedStages: skipped,
      requiresReason: false,
      requiresConfirm: true,
      warning: skipWarning(skipped),
    })
  }

  if (fromOrdinal == null) {
    return deny(
      'no_interpretable_intent',
      `单据处于${TICKET_STATUS_LABEL[input.status]}(${input.status})但没有当前站,无法判断前进或打回。`,
      { why: 'missing_current_stage' },
    )
  }

  // 下一站 + 等人确认 = 确认过站(与 POST …/approve 同一条转移)。
  // 「下一站」按流水线站序数组下标,不要用 ordinal+1:用户可能把站序排成 0,2,5。
  if (fromIndex >= 0 && toIndex === fromIndex + 1 && input.status === 'waiting_human') {
    return ok({
      action: 'ack_advance',
      fromStageId: input.stageId,
      toStageId: target.id,
      toStatus: 'ready',
      skippedStages: [],
      requiresReason: false,
      requiresConfirm: false,
      warning: null,
    })
  }

  if (toIndex > fromIndex && fromIndex >= 0 && fromStage) {
    const skipped = stagesBetween(stages, fromOrdinal, target.ordinal)
    return ok({
      action: 'skip_forward',
      fromStageId: input.stageId,
      toStageId: target.id,
      toStatus: statusForStageKind(target.kind),
      skippedStages: skipped,
      abandonedStage: fromStage,
      requiresReason: false,
      // 即使中间没有站,也是在放弃当前站的工作,必须人确认。
      requiresConfirm: true,
      warning: skipForwardWarning(fromStage, skipped),
    })
  }

  if (toIndex >= 0 && fromIndex >= 0 && toIndex < fromIndex) {
    return ok({
      action: 'send_back',
      fromStageId: input.stageId,
      toStageId: target.id,
      toStatus: statusForStageKind(target.kind),
      skippedStages: [],
      requiresReason: true,
      requiresConfirm: false,
      warning: null,
    })
  }

  return deny(
    'no_interpretable_intent',
    `无法把这次拖动解释成命名动作（status=${input.status}, fromOrdinal=${fromOrdinal}, toOrdinal=${toOrdinal ?? 'null'}）。`,
    { why: 'unmapped_drag', status: input.status, fromOrdinal, toOrdinal },
  )
}

export interface ListAllowedMovesInput {
  status: TicketStatus
  stageId: string | null
  pipelineId: string | null
  stages: readonly MoveStageRef[]
  /** 有未解除的 blocks 时,往后的站不出现在可拖目标里。 */
  hasOpenBlockers?: boolean
}

/**
 * 列出这张卡能拖去的所有目标。与 interpretMove 共用同一份表。
 * 不把 noop 放进结果。blocked 且有 blocker 时隐藏前进类动作。
 */
export function listAllowedMoves(input: ListAllowedMovesInput): AllowedMove[] {
  const destIds: Array<string | null> = [...byOrdinal(input.stages).map((s) => s.id), null]
  const out: AllowedMove[] = []
  for (const toStageId of destIds) {
    const result = interpretMove({
      status: input.status,
      stageId: input.stageId,
      pipelineId: input.pipelineId,
      toStageId,
      stages: input.stages,
    })
    if (!result.ok) continue
    const intent = result.intent
    if (intent.action === 'noop') continue
    const action: Exclude<MoveAction, 'noop'> = intent.action
    const forward =
      action === 'skip_forward' ||
      action === 'ack_advance' ||
      action === 'promote' ||
      action === 'promote_at_stage' ||
      action === 'reopen'
    if (
      input.hasOpenBlockers &&
      forward &&
      action !== 'reopen' &&
      action !== 'promote' &&
      action !== 'promote_at_stage'
    ) {
      continue
    }
    const move: AllowedMove = {
      toStageId: intent.toStageId,
      action,
      label: intent.label,
      requiresReason: intent.requiresReason,
      requiresConfirm: intent.requiresConfirm,
    }
    if (intent.warning) move.warning = intent.warning
    if (intent.skippedStages.length > 0) {
      move.skippedStages = intent.skippedStages.map((s) => ({
        id: s.id,
        name: s.name,
        kind: s.kind,
      }))
    }
    const abandoned = publicStageRef(intent.abandonedStage)
    if (abandoned) move.abandonedStage = abandoned
    out.push(move)
  }
  return out
}

/** 拼进评论正文,好让目标站 agent 下次巡检经 {{comments}} 读到人的意图。 */
export function formatMoveComment(input: {
  action: MoveAction
  label: string
  fromStageName: string | null
  toStageName: string | null
  toBacklog: boolean
  reason?: string | null
  skippedStages?: readonly MoveStageRef[]
  abandonedStage?: MoveStageRef | null
}): string {
  const from = input.fromStageName ? `「${input.fromStageName}」站` : '积压'
  const to = input.toBacklog ? '积压' : input.toStageName ? `「${input.toStageName}」站` : '目标站'
  const parts = [`人工从 ${from} 移到 ${to}，动作=${input.label}`]
  const reason = input.reason?.trim()
  if (reason) parts.push(`理由=${reason}`)
  if (input.action === 'skip_forward' && input.abandonedStage) {
    parts.push(`「${input.abandonedStage.name}」站的工作由人工判定不需要`)
  }
  const skipped = input.skippedStages ?? []
  if (
    (input.action === 'promote_at_stage' || input.action === 'skip_forward') &&
    skipped.length > 0
  ) {
    parts.push(`被跳过的站（${skipped.map((s) => s.name).join('、')}）由人工判定免做`)
  }
  return `${parts.join('，')}。`
}
