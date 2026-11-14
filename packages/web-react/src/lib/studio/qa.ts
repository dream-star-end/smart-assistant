// OCV5-593 FE-7a: how a take's visual QA (OCV5-591 A2-1b-1) reads to the user — its outcome,
// the reason when it was redone or handed over, the moderation verdict and the judge's issues —
// and which versions QA offered when it handed a shot over.

import type { StudioProjectView } from './types'

export type QaOutcome = 'passed' | 'redo' | 'handoff' | 'skipped'

export interface QaView {
  outcome: QaOutcome | null
  /** One line for the outcome (the backend's reason, in words). */
  outcomeText: string | null
  moderation: 'pass' | 'review' | 'block' | null
  issues: string[]
}

/** Same reasons as the backend's QA_REASON_TEXT. */
const REASON_TEXT: Record<string, string> = {
  passed: '质检通过',
  below_threshold: '质检没通过，已自动重做',
  moderation_block: '画面可能不合规，不能采用',
  moderation_review: '画面需要人工确认是否合规',
  low_confidence: 'agent 拿不准这一版好不好，交给你看',
  retries_exhausted: '自动重做了 2 次仍未通过，交给你选',
  no_improvement: '重做后没有变好，交给你选',
  unavailable: '这次没能完成质检，交给你看',
}

const SKIP_TEXT: Record<string, string> = {
  off: '质检已关闭，这一版没有质检',
  no_sandbox: '合成沙箱未配置，视频没有质检',
}

export const MODERATION_TEXT = { pass: '通过', review: '待人工复核', block: '不合规' } as const

export function qaView(qa: Record<string, unknown> | null | undefined): QaView {
  if (!qa) return { outcome: null, outcomeText: null, moderation: null, issues: [] }
  const moderation =
    qa.moderation === 'pass' || qa.moderation === 'review' || qa.moderation === 'block'
      ? qa.moderation
      : null
  const issues = (Array.isArray(qa.issues) ? qa.issues : [])
    .map((i) => (i && typeof i === 'object' ? (i as { what?: unknown }).what : null))
    .filter((w): w is string => typeof w === 'string' && w.length > 0)
    .slice(0, 5)
  if (qa.skipped === true) {
    const why = typeof qa.reason === 'string' ? qa.reason : ''
    return {
      outcome: 'skipped',
      outcomeText: SKIP_TEXT[why] ?? '这一版没有质检',
      moderation,
      issues,
    }
  }
  const outcome: QaOutcome | null =
    qa.next === 'adopt'
      ? 'passed'
      : qa.next === 'redo'
        ? 'redo'
        : qa.next === 'handoff'
          ? 'handoff'
          : null
  const reason = typeof qa.reason === 'string' ? qa.reason : outcome === 'passed' ? 'passed' : ''
  return {
    outcome,
    outcomeText: outcome ? (REASON_TEXT[reason] ?? null) : null,
    moderation,
    issues,
  }
}

/** The versions QA offered the last time it handed this shot to the user. */
export function recommendedTakes(view: StudioProjectView, shotId: string): Set<string> {
  const last = [...view.events]
    .filter((e) => e.type === 'shot.needs_user' && e.payload?.shotId === shotId)
    .sort((a, b) => Number(b.id) - Number(a.id))[0]
  const ids = last?.payload?.takeIds
  return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
}
