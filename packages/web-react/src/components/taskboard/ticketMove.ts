import type { AllowedMove, Ticket, TicketMoveInfo } from '../../lib/taskboard'

export const BACKLOG_DROP_ID = 'backlog'

export function dropIdForMove(toStageId: string | null): string {
  return toStageId === null ? BACKLOG_DROP_ID : toStageId
}

export function stageIdFromDropId(dropId: string): string | null {
  return dropId === BACKLOG_DROP_ID ? null : dropId
}

export function allowedDropIds(ticket: Ticket): Set<string> {
  return new Set((ticket.allowedMoves ?? []).map((m) => dropIdForMove(m.toStageId)))
}

/** 单据当前所在列。拖动时这列是「原地」而不是非法目标。 */
export function homeDropId(ticket: Ticket): string {
  return ticket.stageId == null ? BACKLOG_DROP_ID : dropIdForMove(ticket.stageId)
}

export function moveForDestination(
  ticket: Ticket,
  toStageId: string | null,
): AllowedMove | undefined {
  return ticket.allowedMoves?.find((m) => m.toStageId === toStageId)
}

export function formatMoveSuccess(
  move: Pick<TicketMoveInfo, 'label' | 'toStageId'>,
  stageName?: string | null,
): string {
  if (move.toStageId === null) return `已${move.label}`
  const name = stageName?.trim()
  return name ? `已${move.label}到「${name}」站` : `已${move.label}`
}

export function formatConfirmSkipMessage(detail: {
  skippedStages?: Array<{ name: string }>
  abandonedStage?: { name: string } | null
}): { title: string; body: string } {
  const abandoned = detail.abandonedStage?.name
  const skipped = (detail.skippedStages ?? []).map((s) => s.name)
  const lines: string[] = []
  if (abandoned) {
    lines.push(`「${abandoned}」站的工作将被视为不需要。`)
  }
  if (skipped.length) {
    lines.push(`将跳过：${skipped.map((n) => `「${n}」`).join('、')}。`)
  }
  if (!lines.length) {
    lines.push('这次移动会跳过中间站，需要确认后再继续。')
  }
  return { title: '确认跳过阶段？', body: lines.join('\n') }
}

export function formatBlockersMessage(
  blockers: Array<{ identifier?: string; title?: string }>,
): string {
  if (!blockers.length) return '存在未解除的阻塞依赖，不能往后续站移动。'
  const names = blockers.map((b) => b.identifier || b.title || '未命名单据').join('、')
  return `依赖未解除：${names}`
}

export function formatNoIntentMessage(why?: string): string {
  const detail = why?.trim()
  return detail ? `这次拖动没有可解释的语义。${detail}` : '这次拖动没有可解释的语义，已被拒绝。'
}

export function formatRunningRunMessage(runId?: string | null): string {
  return runId
    ? `单据正在执行（run ${runId}）。取消当前 run 后再移动？`
    : '单据正在执行。取消当前 run 后再移动？'
}

export function moveOptionLabel(
  move: AllowedMove,
  stageNameById: ReadonlyMap<string, string>,
): string {
  const dest = move.toStageId === null ? '积压' : (stageNameById.get(move.toStageId) ?? '目标站')
  return `${move.label} · ${dest}`
}
