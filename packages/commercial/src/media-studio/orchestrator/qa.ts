// OCV5-591 A2-1b-1 — visual QA of generated first frames, clips and bible images (plan
// docs/ocv5-591-a2-1b-qa-plan.md §1). Pure parts live here: configuration, the contact sheet the
// one-image Grok vision call sees, the prompt, strict parsing and the verdict. runQa (execute.ts)
// does the IO.

import sharp from 'sharp'
import { z } from 'zod'

import type { BibleEntry, ShotSpecForPrompt } from './prompts.js'

export type QaTarget = 'frame' | 'clip' | 'bible'
export type QaOwnerKind = 'shot_frame' | 'shot_video' | 'bible'

export const QA_TARGET: Record<QaOwnerKind, QaTarget> = {
  shot_frame: 'frame',
  shot_video: 'clip',
  bible: 'bible',
}

/** The original take plus two automatic redos (plan §1.3). */
export const MAX_QA_ATTEMPTS = 3
export const QA_MIN_CONFIDENCE = 0.6
export const QA_THRESHOLDS = { character: 0.75, scene: 0.7, action: 0.7, artifacts: 0.8 } as const
type Criterion = keyof typeof QA_THRESHOLDS

/** Where in a clip the sheet's frames are taken (fractions of its length). */
export const CLIP_POINTS = [0.1, 0.35, 0.6, 0.85]
/** Grok vision takes one image of at most 6 MB (visionProxy). */
const SHEET_MAX_BYTES = 6 * 1024 * 1024

export interface QaConfig {
  /** QA runs (Grok configured and not switched off). */
  enabled: boolean
  /** Bible candidates per round (steward 2026-10-24 03:07: default 1, easy to switch to 2). */
  bibleCandidates: 1 | 2
}

export function qaConfigFromEnv(env: NodeJS.ProcessEnv, grok: boolean): QaConfig {
  const off = (env.OC_STUDIO_QA ?? '').trim().toLowerCase() === 'off'
  return {
    enabled: grok && !off,
    bibleCandidates: (env.OC_STUDIO_BIBLE_CANDIDATES ?? '').trim() === '2' ? 2 : 1,
  }
}

/** QA as the worker and the advancer see it. */
export type StudioQaDeps = QaConfig & {
  /** Worst-case credits of one QA call (Grok catalog price); null when the catalog is down. */
  maxCost?: () => Promise<bigint | null>
}

/** Which owner kinds QA gates: a clip needs the sandbox to take its frames. */
export function qaGates(deps: { qa?: QaConfig; compose?: { configured(): boolean } }): {
  bible: boolean
  shot_frame: boolean
  shot_video: boolean
} {
  const on = deps.qa?.enabled === true
  return { bible: on, shot_frame: on, shot_video: on && (deps.compose?.configured() ?? false) }
}

// ── verdict ────────────────────────────────────────────────────────────────────────────────────

const score01 = z.number().min(0).max(1)
const Verdict = z.object({
  character: score01,
  scene: score01,
  action: score01,
  artifacts: score01,
  moderation: z.enum(['pass', 'review', 'block']),
  confidence: score01,
  summary: z.string().max(400),
  issues: z
    .array(z.object({ frame: z.string().max(8).optional(), what: z.string().min(1).max(200) }))
    .max(8)
    .default([]),
})
export type QaVerdict = z.infer<typeof Verdict>

export class QaParseError extends Error {
  constructor(readonly issues: string[]) {
    super(`qa answer invalid: ${issues.join('; ')}`)
    this.name = 'QaParseError'
  }
}

export function parseQa(answer: string): QaVerdict {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  if (start < 0 || end <= start) throw new QaParseError(['no JSON object'])
  let raw: unknown
  try {
    raw = JSON.parse(answer.slice(start, end + 1))
  } catch {
    throw new QaParseError(['not valid JSON'])
  }
  const r = Verdict.safeParse(raw)
  if (!r.success)
    throw new QaParseError(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
  return r.data
}

/** The criteria a target is judged on (a style image has no character or scene to match). */
export function criteriaFor(
  target: QaTarget,
  assetKind?: 'character' | 'scene' | 'style',
): Criterion[] {
  if (target !== 'bible') return ['character', 'scene', 'action', 'artifacts']
  if (assetKind === 'character') return ['character', 'artifacts']
  if (assetKind === 'scene') return ['scene', 'artifacts']
  return ['artifacts']
}

export interface QaHistory {
  /** QA'd attempts of this owner before this one, since the last hand-off. */
  attempts: number
  /** Best score among them, or null. */
  bestScore: number | null
}

export type QaNext = 'adopt' | 'redo' | 'handoff'
export type QaReason =
  | 'passed'
  | 'below_threshold'
  | 'moderation_block'
  | 'moderation_review'
  | 'low_confidence'
  | 'retries_exhausted'
  | 'no_improvement'
  | 'unavailable'

export interface QaJudgement {
  passed: boolean
  score: number
  next: QaNext
  reason: QaReason
}

/**
 * The verdict (plan §1.3, r1 P1): a take passes on moderation `pass`, every criterion at its
 * threshold and confidence ≥ 0.6. Otherwise it is redone — unless that can only waste money:
 * moderation flagged it, the judge is unsure, the redos are used up, or a redo did not beat the
 * best earlier attempt. Every path leaves QA: the owner is adopted, redone or handed to the user.
 */
export function judgeQa(v: QaVerdict, criteria: Criterion[], h: QaHistory): QaJudgement {
  const score = Math.min(...criteria.map((c) => v[c]))
  const meets = criteria.every((c) => v[c] >= QA_THRESHOLDS[c])
  const out = (passed: boolean, next: QaNext, reason: QaReason): QaJudgement => ({
    passed,
    score,
    next,
    reason,
  })
  if (v.moderation === 'block') return out(false, 'handoff', 'moderation_block')
  if (v.moderation === 'review') return out(false, 'handoff', 'moderation_review')
  if (v.confidence < QA_MIN_CONFIDENCE) return out(false, 'handoff', 'low_confidence')
  if (meets) return out(true, 'adopt', 'passed')
  if (h.attempts + 1 >= MAX_QA_ATTEMPTS) return out(false, 'handoff', 'retries_exhausted')
  if (h.attempts >= 1 && h.bestScore !== null && score <= h.bestScore)
    return out(false, 'handoff', 'no_improvement')
  return out(false, 'redo', 'below_threshold')
}

export const QA_REASON_TEXT: Record<QaReason, string> = {
  passed: '质检通过',
  below_threshold: '质检没通过',
  moderation_block: '画面可能不合规，不能采用',
  moderation_review: '画面需要人工确认是否合规',
  low_confidence: 'agent 拿不准这一版好不好',
  retries_exhausted: '自动重做了 2 次仍未通过',
  no_improvement: '重做后没有变好',
  unavailable: '这次没能完成质检',
}

// ── prompt ─────────────────────────────────────────────────────────────────────────────────────

export interface QaPromptInput {
  target: QaTarget
  assetKind?: 'character' | 'scene' | 'style'
  shot?: ShotSpecForPrompt
  bible: BibleEntry[]
  /** Tile labels in sheet order, e.g. ['F1','F2','F3','F4','R1']. */
  candidates: string[]
  references: string[]
}

export function buildQaPrompt(input: QaPromptInput): string {
  const what =
    input.target === 'frame'
      ? `这是一个镜头的首帧（${input.candidates.join('、')}）`
      : input.target === 'clip'
        ? `这是同一段镜头视频按时间顺序抽出的 ${input.candidates.length} 帧（${input.candidates.join('、')}）`
        : `这是一张设定图（${input.candidates.join('、')}）`
  const refs = input.references.length
    ? `；${input.references.join('、')} 是已锁定的设定图（角色 / 场景外观以它们为准）`
    : ''
  const spec = input.shot
    ? [
        input.shot.framing && `景别：${input.shot.framing}`,
        input.shot.action && `画面：${input.shot.action}`,
      ]
        .filter(Boolean)
        .join('；')
    : ''
  const bible = input.bible
    .map(
      (b) =>
        `【${b.kind === 'character' ? '角色' : b.kind === 'scene' ? '场景' : '风格'}·${b.name}】${b.descriptor}`,
    )
    .join('\n')
  return [
    `你是影片质检员。图中每格左上角有编号：${what}${refs}。`,
    spec && `镜头要求：${spec}`,
    bible && `设定描述：\n${bible}`,
    '逐项打分（0–1，1 最好）：character 角色外观与设定是否一致（没有角色时按 1）；scene 场景与设定 / 镜头要求是否一致；action 画面动作与镜头要求是否一致（设定图按 1）；artifacts 有无畸形手脚、错乱文字、闪烁、穿模等瑕疵（1 = 没有）。',
    'moderation 内容审核：pass 合规；review 拿不准，需要人工看；block 明显违规（成人、血腥暴力、仇恨、冒用真人等）。',
    'confidence：你对这次判断有多确定（0–1）。',
    'summary：一句给用户看的中文说明（≤ 100 字）；issues：最多 5 条具体问题 {frame 编号, what 问题}，写成重画时可以避免的描述。',
    '只输出一个 JSON 对象，不要其它文字：{"character":0.0,"scene":0.0,"action":0.0,"artifacts":0.0,"moderation":"pass","confidence":0.0,"summary":"","issues":[]}',
  ]
    .filter(Boolean)
    .join('\n')
}

// ── contact sheet ──────────────────────────────────────────────────────────────────────────────

const BG = { r: 24, g: 24, b: 27, alpha: 1 }

function label(text: string): Buffer {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="40"><rect width="72" height="40" rx="6" fill="#000" fill-opacity="0.7"/><text x="36" y="28" font-family="sans-serif" font-size="24" font-weight="700" fill="#fff" text-anchor="middle">${text}</text></svg>`,
  )
}

async function tile(img: Buffer, w: number, h: number): Promise<Buffer> {
  return sharp(img).resize(w, h, { fit: 'contain', background: BG }).png().toBuffer()
}

/**
 * One JPEG for the vision call: candidates on the left (1 large, or a 2×2 grid), references in a
 * column on the right, each tile labelled F1… / R1…. Under 2048 px wide and 6 MB.
 */
export async function contactSheet(
  candidates: Buffer[],
  references: Buffer[],
): Promise<{ jpeg: Buffer; candidates: string[]; references: string[] }> {
  if (candidates.length < 1 || candidates.length > 4) throw new Error('1..4 candidates')
  const refs = references.slice(0, 3)
  const grid = candidates.length === 1 ? 1 : 2
  const cell = grid === 1 ? 1280 : 704
  const mainW = cell * grid
  const mainH = cell * Math.ceil(candidates.length / grid)
  const refSize = refs.length ? Math.min(400, Math.floor(mainH / refs.length)) : 0
  const width = mainW + (refs.length ? refSize + 16 : 0)
  const height = Math.max(mainH, refSize * refs.length)
  const layers: sharp.OverlayOptions[] = []
  const candidateLabels: string[] = []
  for (const [i, c] of candidates.entries()) {
    const left = (i % grid) * cell
    const top = Math.floor(i / grid) * cell
    layers.push({ input: await tile(c, cell, cell), left, top })
    candidateLabels.push(`F${i + 1}`)
    layers.push({ input: label(`F${i + 1}`), left: left + 8, top: top + 8 })
  }
  const refLabels: string[] = []
  for (const [i, r] of refs.entries()) {
    const left = mainW + 16
    const top = i * refSize
    layers.push({ input: await tile(r, refSize, refSize), left, top })
    refLabels.push(`R${i + 1}`)
    layers.push({ input: label(`R${i + 1}`), left: left + 8, top: top + 8 })
  }
  const canvas = sharp({ create: { width, height, channels: 3, background: BG } }).composite(layers)
  const png = await canvas.png().toBuffer()
  for (const quality of [85, 70, 55]) {
    const jpeg = await sharp(png).jpeg({ quality }).toBuffer()
    if (jpeg.length <= SHEET_MAX_BYTES)
      return { jpeg, candidates: candidateLabels, references: refLabels }
  }
  throw new Error('contact sheet over the vision size limit')
}
