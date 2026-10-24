// OCV5-593 FE-5 音乐 (mockups d10–d14 / m06, user 2026-10-23 20:52): the music page's pure helpers.
// Sources come from /providers (the curated catalog, My Music, an AI generator if one is ever
// configured); the soundtrack is the music take the project points at; the edit mirrors the
// server's validateMusicEdit (OCV5-591 M1) so a bad value is caught before it is sent.

import type { ProvidersView, StudioProjectView, StudioTake } from './types'

export type MusicLicense = 'CC0-1.0' | 'CC-BY-3.0' | 'CC-BY-4.0' | 'PIXABAY-CL' | 'USER-STATEMENT'

export interface MusicTrack {
  id: string
  title: string
  artist: string
  durationMs: number | null
  bpm: number | null
  moods: string[]
  genres: string[]
  vocals: boolean
  license: MusicLicense
  licenseUrl: string | null
  attributionRequired: boolean
  attributionText: string
  landingUrl: string | null
  origin: string
  previewSha: string
  metadata: { bpm: 'source' | 'measured' | 'unknown'; moods: 'source' | 'guessed' | 'unknown' }
}

export interface MusicSearchResult {
  tracks: MusicTrack[]
  next: string | null
}

export interface MusicQuery {
  text?: string
  moods?: string[]
  genres?: string[]
  bpmMin?: number
  bpmMax?: number
  minSec?: number
  maxSec?: number
  vocals?: boolean
  cursor?: string
}

export interface MusicEdit {
  gainDb?: number
  duckDb?: number
  fadeInSec?: number
  fadeOutSec?: number
  startSec?: number
  endSec?: number
  inSec?: number
  outSec?: number
  loop?: { crossfadeSec?: number }
}

/** What the server stores on a music take for the UI (license snapshot + the track card). */
export interface MusicTakeInfo {
  license: {
    source: string
    title?: string
    artist?: string
    license?: MusicLicense
    licenseUrl?: string
    attributionRequired?: boolean
    attributionText?: string
    landingUrl?: string
    verifiedAt?: string
    rightsStatement?: { statement?: string; note?: string }
  } | null
  track: MusicTrack | null
}

export const MUSIC_MOODS = ['宁静', '温暖', '轻快', '紧张', '史诗', '忧伤', '神秘'] as const
export const MUSIC_GENRES = ['钢琴', '弦乐', '管弦', '吉他', '氛围', '电子', '打击乐'] as const
export const EDIT_DEFAULTS = { gainDb: -8, duckDb: 12, fadeInSec: 1, fadeOutSec: 2.5 } as const
const MAX_LOOP_REPEATS = 24

export interface MusicSources {
  catalog: { id: string; state: string } | null
  mine: { id: string; state: string } | null
  /** An AI generator (op music.generate); none is configured in this phase. */
  ai: { id: string; state: string } | null
}

export function musicSources(view: ProvidersView | null | undefined): MusicSources {
  const providers = view?.kinds.find((k) => k.kind === 'music')?.providers ?? []
  const by = (pred: (p: (typeof providers)[number]) => boolean) => {
    const p = providers.find(pred)
    return p ? { id: p.id, state: p.state } : null
  }
  const has = (op: string) => (p: (typeof providers)[number]) =>
    p.models.some((m) => m.ops.includes(op))
  return {
    catalog: by((p) => p.id === 'music-catalog'),
    mine: by((p) => p.id === 'music-mine'),
    ai: by(has('music.generate')),
  }
}

export function musicInfo(take: StudioTake | null | undefined): MusicTakeInfo | null {
  const m = (take as (StudioTake & { music?: MusicTakeInfo | null }) | null | undefined)?.music
  return m ? { license: m.license ?? null, track: m.track ?? null } : null
}

/** The project's soundtrack: the take settings.musicTakeId names, else the newest finished one. */
export function soundtrack(view: StudioProjectView): StudioTake | null {
  const ok = view.takes.filter(
    (t) => t.ownerKind === 'music' && t.status === 'succeeded' && t.blobSha,
  )
  const id = view.project.settings?.musicTakeId
  return (
    (typeof id === 'string' ? ok.find((t) => t.id === id) : undefined) ??
    [...ok].sort((a, b) => b.version - a.version)[0] ??
    null
  )
}

/** A music take still being fetched (the user just chose a track). */
export function pendingMusic(view: StudioProjectView): StudioTake | null {
  return (
    view.takes
      .filter((t) => t.ownerKind === 'music' && (t.status === 'queued' || t.status === 'running'))
      .sort((a, b) => b.version - a.version)[0] ?? null
  )
}

export function storedEdit(view: StudioProjectView): MusicEdit {
  const e = view.project.settings?.musicEdit
  return e && typeof e === 'object' && !Array.isArray(e) ? (e as MusicEdit) : {}
}

/** "跟随镜头节奏": a tempo band for the cut's average shot length. */
export function tempoForShots(
  durations: number[],
): { min: number; max: number; avgSec: number } | null {
  const ds = durations.filter((d) => Number.isFinite(d) && d > 0)
  if (!ds.length) return null
  const avg = ds.reduce((a, b) => a + b, 0) / ds.length
  const band = avg >= 6 ? [60, 84] : avg >= 4 ? [64, 96] : avg >= 2.5 ? [90, 120] : [110, 140]
  return { min: band[0]!, max: band[1]!, avgSec: Math.round(avg * 10) / 10 }
}

/** The server's rules (compose/spec.ts validateMusicEdit), as one message for the first problem. */
export function editProblem(e: MusicEdit, filmSec: number): string | null {
  const span = (e.endSec ?? filmSec) - (e.startSec ?? 0)
  if (e.endSec !== undefined && span < 1) return '配乐在成片里至少要放 1 秒'
  if (e.outSec !== undefined && e.outSec - (e.inSec ?? 0) < 1) return '截取的片段至少 1 秒'
  if (e.loop) {
    if (e.outSec === undefined) return '循环需要先截取一段'
    const part = e.outSec - (e.inSec ?? 0)
    const xf = e.loop.crossfadeSec ?? 0
    if (xf * 2 >= part) return '交叉淡化要短于截取片段的一半'
    if (Math.ceil((span - xf) / (part - xf)) > MAX_LOOP_REPEATS)
      return `截取的片段太短，循环会超过 ${MAX_LOOP_REPEATS} 次，请截长一点`
  }
  return null
}

/** Drops values equal to the defaults so the stored edit says only what the user changed. */
export function compactEdit(e: MusicEdit): MusicEdit {
  const out: MusicEdit = {}
  for (const [k, v] of Object.entries(e) as Array<[keyof MusicEdit, unknown]>) {
    if (v === undefined) continue
    if (k in EDIT_DEFAULTS && v === EDIT_DEFAULTS[k as keyof typeof EDIT_DEFAULTS]) continue
    ;(out as Record<string, unknown>)[k] = v
  }
  return out
}

export function licenseLabel(l: MusicLicense | undefined): string {
  switch (l) {
    case 'CC0-1.0':
      return 'CC0'
    case 'CC-BY-3.0':
      return 'CC BY 3.0'
    case 'CC-BY-4.0':
      return 'CC BY 4.0'
    case 'PIXABAY-CL':
      return 'Pixabay 许可'
    case 'USER-STATEMENT':
      return '自有 / 已获授权'
    default:
      return '未知协议'
  }
}

export function mmss(sec: number | null | undefined): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
