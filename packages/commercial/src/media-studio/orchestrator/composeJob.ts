// OCV5-591 A2-1c — what one compose run is made of (docs/ocv5-591-a2-1c-compose-plan.md §3): the
// film's timeline from the shots, narration placed in its shots (the same placement as the web
// timeline), subtitle cues, the canvas for the project's aspect and the export format, and the
// project's music with its edit. Pure: the executor fetches the blobs and runs the sandbox.

import { type SubtitleCue, toAss, toSrt } from '../compose/ass.js'
import type { ComposeSpec, MusicEdit } from '../compose/spec.js'

export type ExportResolution = '1080p' | '720p' | 'vertical'
export type ExportSubtitles = 'burn' | 'srt' | 'none'
export interface ExportVariant {
  resolution: ExportResolution
  subtitles: ExportSubtitles
}
export const DEFAULT_VARIANT: ExportVariant = { resolution: '1080p', subtitles: 'burn' }

export function variantKey(v: ExportVariant): string {
  return `${v.resolution}-${v.subtitles}`
}

export function parseVariant(raw: unknown): ExportVariant | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const res = r.resolution
  const subs = r.subtitles
  if (res !== '1080p' && res !== '720p' && res !== 'vertical') return null
  if (subs !== 'burn' && subs !== 'srt' && subs !== 'none') return null
  return { resolution: res, subtitles: subs }
}

/** Canvas for the project's aspect and the export format; "竖屏 9:16" is always a 9:16 canvas. */
export function canvasFor(
  aspect: '16:9' | '9:16' | '1:1',
  resolution: ExportResolution,
): { width: ComposeSpec['width']; height: ComposeSpec['height'] } {
  const big = resolution !== '720p'
  const a = resolution === 'vertical' ? '9:16' : aspect
  if (a === '9:16') return big ? { width: 1080, height: 1920 } : { width: 720, height: 1280 }
  if (a === '1:1') return big ? { width: 1080, height: 1080 } : { width: 720, height: 720 }
  return big ? { width: 1920, height: 1080 } : { width: 1280, height: 720 }
}

export interface JobShot {
  id: string
  ordinal: number
  durationSec: number
  videoSha: string
  /** The video take's measured length, when known; a shot never asks for more than it has. */
  videoSec: number | null
}
export interface JobLine {
  id: string
  shotId: string | null
  ordinal: number
  text: string
  audioSha: string
  audioMime: string
  /** The line take's audio length; narration is laid out by it (plan r1 P1). */
  audioSec: number | null
}
export interface JobMusic {
  sha: string
  mime: string
  edit: MusicEdit
  license: Record<string, unknown> | null
}

export interface ComposeJob {
  spec: ComposeSpec
  /** Basename in the sandbox's /work/in → blob sha. */
  files: Record<string, string>
  /** Generated text inputs (subtitles), written next to the blobs. */
  texts: Record<string, string>
  /** A soft-subtitle file to keep next to the film (subtitles: 'srt'). */
  srt: string | null
  expectedSec: number
  /** CC BY material in the cut and its exact attribution (for the credits / d14). */
  credits: Array<{ kind: 'music'; title: string; attributionText: string; license: string }>
}

const EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
}

export class ComposeJobError extends Error {
  constructor(
    message: string,
    /** The shot whose narration does not fit (or has a line of unknown length). */
    readonly shotId: string | null = null,
  ) {
    super(message)
    this.name = 'ComposeJobError'
  }
}

const LEAD_SEC = 0.15
const GAP_SEC = 0.3

export function buildComposeJob(input: {
  aspect: '16:9' | '9:16' | '1:1'
  variant: ExportVariant
  shots: JobShot[]
  lines: JobLine[]
  music: JobMusic | null
}): ComposeJob {
  const shots = [...input.shots].sort((a, b) => a.ordinal - b.ordinal)
  if (shots.length === 0) throw new ComposeJobError('no shots to compose')
  const files: Record<string, string> = {}
  const texts: Record<string, string> = {}
  const clips: ComposeSpec['clips'] = []
  const span = new Map<string, { start: number; end: number }>()
  let t = 0
  for (const [i, s] of shots.entries()) {
    const len = Math.max(0.5, Math.min(s.durationSec, s.videoSec ?? s.durationSec))
    const name = `v${i}.mp4`
    files[name] = s.videoSha
    clips.push({ file: name, inSec: 0, outSec: round2(len) })
    span.set(s.id, { start: t, end: t + len })
    t += len
  }
  const total = round2(t)

  // Narration: each shot's lines one after another by their real length (plan r1 P1): the first
  // starts LEAD_SEC into the shot, the next GAP_SEC after the previous ends. Lines that do not fit
  // their shot, or whose length is unknown, are not cut short or overlapped: the job is refused.
  const voice: NonNullable<ComposeSpec['voice']> = []
  const cues: SubtitleCue[] = []
  const byShot = new Map<string, JobLine[]>()
  for (const l of [...input.lines].sort((a, b) => a.ordinal - b.ordinal)) {
    if (!l.shotId || !span.has(l.shotId)) continue
    byShot.set(l.shotId, [...(byShot.get(l.shotId) ?? []), l])
  }
  let n = 0
  for (const [shotIndex, s] of shots.entries()) {
    const group = byShot.get(s.id)
    if (!group) continue
    const sp = span.get(s.id)!
    let at = sp.start + LEAD_SEC
    for (const l of group) {
      if (l.audioSec === null || !(l.audioSec > 0))
        throw new ComposeJobError(`#${shotIndex + 1} 有一句台词的时长未知，需要重新配音`, s.id)
      const start = round2(at)
      const end = round2(at + l.audioSec)
      if (end > sp.end + 0.01) {
        const need = round2(
          group.reduce((t, x) => t + (x.audioSec ?? 0), 0) +
            LEAD_SEC +
            GAP_SEC * (group.length - 1),
        )
        throw new ComposeJobError(
          `#${shotIndex + 1} 的台词总长 ${need} 秒，超过镜头 ${round2(sp.end - sp.start)} 秒，需要改短或拆镜头`,
          s.id,
        )
      }
      const name = `l${n}.${EXT[l.audioMime] ?? 'mp3'}`
      files[name] = l.audioSha
      voice.push({ file: name, startSec: start })
      if (l.text.trim()) cues.push({ startSec: start, endSec: end, text: l.text })
      at = end + GAP_SEC
      n += 1
    }
  }

  const { width, height } = canvasFor(input.aspect, input.variant.resolution)
  let subtitles: ComposeSpec['subtitles']
  let srt: string | null = null
  if (cues.length && input.variant.subtitles === 'burn') {
    texts['subs.ass'] = toAss(cues, width, height)
    subtitles = { file: 'subs.ass', burn: true }
  } else if (cues.length && input.variant.subtitles === 'srt') {
    srt = toSrt(cues)
  }

  let music: ComposeSpec['music']
  const credits: ComposeJob['credits'] = []
  if (input.music) {
    const name = `m.${EXT[input.music.mime] ?? 'mp3'}`
    files[name] = input.music.sha
    music = { file: name, ...input.music.edit }
    const lic = input.music.license
    if (lic && lic.attributionRequired === true && typeof lic.attributionText === 'string') {
      credits.push({
        kind: 'music',
        title: typeof lic.title === 'string' ? lic.title : '',
        attributionText: lic.attributionText,
        license: typeof lic.license === 'string' ? lic.license : '',
      })
    }
  }

  const spec: ComposeSpec = {
    width,
    height,
    fps: 24,
    clips,
    transitions: { kind: 'cut' },
    ...(subtitles ? { subtitles } : {}),
    ...(voice.length ? { voice } : {}),
    ...(music ? { music } : {}),
    loudness: { targetLufs: -16 },
  }
  return { spec, files, texts, srt, expectedSec: total, credits }
}

/** Final QA from the sandbox's ffprobe JSON (plan §3.6). */
export function finalQa(
  probe: unknown,
  expectedSec: number,
): {
  durationSec: number | null
  expectedSec: number
  hasVideo: boolean
  hasAudio: boolean
  passed: boolean
} {
  const p = (probe ?? {}) as {
    format?: { duration?: unknown }
    streams?: Array<{ codec_type?: unknown }>
  }
  const d = Number(p.format?.duration)
  const durationSec = Number.isFinite(d) ? round2(d) : null
  const streams = Array.isArray(p.streams) ? p.streams : []
  const hasVideo = streams.some((s) => s.codec_type === 'video')
  const hasAudio = streams.some((s) => s.codec_type === 'audio')
  const passed = hasVideo && durationSec !== null && Math.abs(durationSec - expectedSec) <= 0.5
  return { durationSec, expectedSec, hasVideo, hasAudio, passed }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
