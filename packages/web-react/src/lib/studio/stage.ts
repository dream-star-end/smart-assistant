// Which step of the six (需求 / 设定 / 镜头 / 配音 / 音乐 / 成片) the director is working on, read
// from the project view in the order the orchestrator works (decide.ts): plan → bible images →
// shots → narration → compose. Music never holds the film up, so it is never the working step.

import type { StudioPage } from './path'
import type { StudioProjectView } from './types'

export type StudioStage = Exclude<StudioPage, 'review'>

/** The step order of the project bar. */
export const STAGE_ORDER: StudioStage[] = ['brief', 'image', 'board', 'voice', 'music', 'final']

const BIBLE_KINDS = new Set(['character', 'scene', 'style'])

export function workStage(view: StudioProjectView): StudioStage {
  const { project, shots, lines, assets } = view
  const status = project.status
  const reason =
    typeof project.settings?.awaitingReason === 'string' ? project.settings.awaitingReason : null
  if (status === 'draft' || status === 'planning') return 'brief'
  if (status === 'awaiting_user' && (reason === 'approve_plan' || reason === 'budget'))
    return 'brief'
  if (status === 'composing' || status === 'done') return 'final'
  if (status === 'awaiting_user' && (reason === 'compose_failed' || reason === 'compose_pending'))
    return 'final'
  if (shots.length === 0) return 'brief'
  if (assets.some((a) => BIBLE_KINDS.has(a.kind) && !(a.locked && a.blobSha))) return 'image'
  if (shots.some((s) => s.status !== 'ready')) return 'board'
  if (lines.some((l) => !(l.status === 'ready' && l.activeTakeId))) return 'voice'
  return 'final'
}

/**
 * Where the page should go when the working step moved from `prev` to `next`: along with it only
 * if the user was on `prev`'s own page. A page they opened (or the review of a shot) stays theirs.
 */
export function followStage(
  prev: StudioStage | null,
  next: StudioStage,
  page: StudioPage,
): StudioStage | null {
  if (prev === null || prev === next || page === 'review' || page !== prev) return null
  return next
}
