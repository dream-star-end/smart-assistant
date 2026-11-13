// OCV5-593 pure view-model helpers over the aggregate project view: per-shot state, the timeline
// layout and human-readable activity. No React, no IO — unit tested on their own.

import type { StudioEvent, StudioLine, StudioProjectView, StudioShot, StudioTake } from './types'

/** Fields the director agent (A2-1) writes into studio_shots.spec; all optional. */
export interface ShotSpec {
  title?: string
  framing?: string
  action?: string
  durationSec?: number
  /** How the first frame is made, e.g. "首帧 · GPT Image" or "续接 #2". */
  source?: string
}

export function shotSpec(shot: StudioShot): ShotSpec {
  const s = shot.spec ?? {}
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
  const dur = Number(s.durationSec)
  return {
    title: str(s.title),
    framing: str(s.framing),
    action: str(s.action),
    durationSec: Number.isFinite(dur) && dur > 0 ? dur : undefined,
    source: str(s.source),
  }
}

export const DEFAULT_SHOT_SEC = 5

export function shotSeconds(shot: StudioShot): number {
  return shotSpec(shot).durationSec ?? DEFAULT_SHOT_SEC
}

export function shotLabel(shot: StudioShot): string {
  const spec = shotSpec(shot)
  return `#${shot.ordinal + 1}${spec.title ? ` ${spec.title}` : ''}`
}

export function takesOf(
  view: StudioProjectView,
  ownerId: string,
  kinds: StudioTake['ownerKind'][],
) {
  return view.takes
    .filter((t) => t.ownerId === ownerId && kinds.includes(t.ownerKind))
    .sort((a, b) => b.version - a.version)
}

export interface ShotCardModel {
  shot: StudioShot
  spec: ShotSpec
  seconds: number
  /** The adopted take, else the newest one that produced media. */
  shown: StudioTake | null
  video: StudioTake | null
  frame: StudioTake | null
  running: StudioTake | null
  queued: boolean
  versions: number
  costCredits: number
  qaScore: number | null
  tone: 'ok' | 'needs' | 'gen' | 'queued' | 'bad' | 'planned'
  chip: string
}

export function qaScoreOf(take: StudioTake | null): number | null {
  const v = take?.qa ? Number((take.qa as Record<string, unknown>).score) : Number.NaN
  return Number.isFinite(v) ? v : null
}

export function shotCard(view: StudioProjectView, shot: StudioShot): ShotCardModel {
  const all = takesOf(view, shot.id, ['shot_video', 'shot_frame'])
  const withMedia = all.filter((t) => t.status === 'succeeded' && t.blobSha)
  const adopted = shot.activeTakeId ? (all.find((t) => t.id === shot.activeTakeId) ?? null) : null
  const video = withMedia.find((t) => t.ownerKind === 'shot_video') ?? null
  const frame = withMedia.find((t) => t.ownerKind === 'shot_frame') ?? null
  const shown = adopted?.blobSha ? adopted : (video ?? frame)
  const running = all.find((t) => t.status === 'running') ?? null
  const queued = all.some((t) => t.status === 'queued')
  const qaScore = qaScoreOf(shown)
  const versions = all.filter((t) => t.ownerKind === 'shot_video').length || all.length
  const costCredits = all.reduce((s, t) => s + (Number(t.costCredits) || 0), 0)
  const awaiting =
    typeof view.project?.settings?.awaitingReason === 'string'
      ? view.project.settings.awaitingReason
      : null
  const projectPaused =
    view.project?.status === 'paused' ||
    (view.project?.status === 'awaiting_user' && awaiting === 'provider_failure')
  const activeTask = view.takes.some((t) => t.status === 'queued' || t.status === 'running')
  let tone: ShotCardModel['tone'] = 'planned'
  let chip = '待生成'
  if (shot.status === 'needs_user') {
    tone = 'needs'
    chip = all[0]?.status === 'failed' ? '失败，需要你' : '需要你'
  } else if (shot.status === 'failed') {
    tone = 'bad'
    chip = '失败'
  } else if (shot.status === 'ready') {
    tone = 'ok'
    chip = qaScore !== null ? `通过 ${qaScore.toFixed(2)}` : '通过'
  } else if (shot.status === 'generating' || shot.status === 'qa' || running) {
    // A paused project with nothing in flight is not still generating.
    if (projectPaused && !activeTask && !running) {
      tone = 'needs'
      chip = '已暂停，需要你'
    } else {
      tone = 'gen'
      chip = shot.status === 'qa' ? '质检中' : versions > 1 ? `重拍 v${versions}` : '生成中'
    }
  } else if (queued) {
    tone = 'queued'
    chip = '排队'
  }
  return {
    shot,
    spec: shotSpec(shot),
    seconds: shotSeconds(shot),
    shown,
    video,
    frame,
    running,
    queued,
    versions,
    costCredits,
    qaScore,
    tone,
    chip,
  }
}

export interface TimelineClip {
  shot: StudioShot
  start: number
  end: number
}

export interface TimelineModel {
  total: number
  clips: TimelineClip[]
  /**
   * Voice / subtitle lines inside their shot's span, in order. With every line's real length known
   * they sit where compose puts them (`placed`); otherwise they share the shot evenly. `fits` is
   * false when the real lengths do not fit the shot (compose then asks the user).
   */
  lines: Array<{
    line: StudioLine
    start: number
    end: number
    take: StudioTake | null
    placed: boolean
    fits: boolean
  }>
  music: StudioTake | null
}

/**
 * A shot's length in the cut, as compose cuts it (backend composeJob.ts, FE-6 r1 P2): the planned
 * length, capped by the active video's real length when known, and never under 0.5 s.
 */
export function clipSeconds(view: StudioProjectView, shot: StudioShot): number {
  const planned = shotSeconds(shot)
  const video = shot.activeTakeId
    ? view.takes.find((x) => x.id === shot.activeTakeId && x.ownerKind === 'shot_video')
    : undefined
  const real =
    video && typeof video.durationMs === 'number' && video.durationMs > 0
      ? video.durationMs / 1000
      : null
  return real === null ? planned : Math.max(0.5, Math.min(planned, real))
}

/** Narration layout constants shared with compose (backend orchestrator/composeJob.ts). */
export const LEAD_SEC = 0.15
export const GAP_SEC = 0.3

export function timeline(view: StudioProjectView): TimelineModel {
  const shots = [...view.shots].sort((a, b) => a.ordinal - b.ordinal)
  let t = 0
  const clips = shots.map((shot) => {
    const start = t
    t += clipSeconds(view, shot)
    return { shot, start, end: t }
  })
  const byShot = new Map(clips.map((c) => [c.shot.id, c]))
  const lines: TimelineModel['lines'] = []
  const grouped = new Map<string, StudioLine[]>()
  for (const line of [...view.lines].sort((a, b) => a.ordinal - b.ordinal)) {
    if (!line.shotId || !byShot.has(line.shotId)) continue
    grouped.set(line.shotId, [...(grouped.get(line.shotId) ?? []), line])
  }
  for (const [shotId, group] of grouped) {
    const clip = byShot.get(shotId)!
    const span = (clip.end - clip.start) / group.length
    const takes = group.map(
      (line) =>
        (line.activeTakeId && view.takes.find((x) => x.id === line.activeTakeId)) ||
        takesOf(view, line.id, ['line']).find((x) => x.status === 'succeeded' && x.blobSha) ||
        null,
    )
    const secs = takes.map((t) =>
      t && typeof t.durationMs === 'number' && t.durationMs > 0 ? t.durationMs / 1000 : null,
    )
    if (secs.every((s): s is number => s !== null)) {
      // Same layout as compose (OCV5-591 A2-1c): the first line LEAD_SEC in, then GAP_SEC apart.
      const need = secs.reduce((t, s) => t + s, 0) + LEAD_SEC + GAP_SEC * (secs.length - 1)
      const fits = need <= clip.end - clip.start + 0.01
      let at = clip.start + LEAD_SEC
      group.forEach((line, i) => {
        lines.push({ line, start: at, end: at + secs[i]!, take: takes[i]!, placed: true, fits })
        at += secs[i]! + GAP_SEC
      })
      continue
    }
    group.forEach((line, i) => {
      // Leave a small gap so neighbouring lines read as separate blocks.
      lines.push({
        line,
        start: clip.start + i * span + 0.15,
        end: clip.start + (i + 1) * span - 0.15,
        take: takes[i]!,
        placed: false,
        fits: true,
      })
    })
  }
  // OCV5-593 FE-5: the soundtrack is the take the project points at (the user's latest choice).
  const finished = view.takes.filter(
    (x) => x.ownerKind === 'music' && x.status === 'succeeded' && x.blobSha,
  )
  const chosenId = view.project.settings?.musicTakeId
  const music =
    (typeof chosenId === 'string' ? finished.find((x) => x.id === chosenId) : undefined) ??
    [...finished].sort((a, b) => b.version - a.version)[0] ??
    null
  return { total: t, clips, lines, music }
}

export function rulerTicks(total: number): number[] {
  if (total <= 0) return [0]
  const step = total <= 20 ? 2 : total <= 60 ? 5 : total <= 180 ? 15 : 30
  const out: number[] = []
  for (let s = 0; s <= total + 1e-6; s += step) out.push(s)
  return out
}

const EVENT_TEXT: Record<string, string> = {
  'project.created': '项目已创建',
  'project.paused': '已暂停',
  'project.resumed': '已继续',
  'project.canceled': '已取消',
  'plan.ready': '分镜方案已写好',
  'shot.ready': '镜头通过质检',
  'shot.needs_user': '镜头需要你看一下',
  'shot.retry': '质检未通过，已自动重拍',
  'take.failed': '生成失败',
  'voice.ready': '配音已生成',
  'compose.done': '成片已合成',
  // OCV5-591 A2-1b-1
  'qa.passed': '质检通过',
  'qa.redo': '质检未通过，已自动重做',
  'qa.needs_user': '质检后需要你看一下',
  'brief.moderation': '需求未通过内容审核',
  'brief.moderation_deferred': '需求审核待画面复核',
}

export function eventText(e: StudioEvent): string {
  const msg = e.payload && typeof e.payload.message === 'string' ? e.payload.message : ''
  return msg || EVENT_TEXT[e.type] || e.type
}

export function eventTone(e: StudioEvent): 'ok' | 'retry' | 'bad' | 'info' {
  if (/ready|done|created|passed/.test(e.type)) return 'ok'
  if (/retry|redo/.test(e.type)) return 'retry'
  if (/fail|cancel|moderation$/.test(e.type)) return 'bad'
  return 'info'
}
