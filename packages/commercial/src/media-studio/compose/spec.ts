/**
 * Media studio compose sandbox — typed operations → ffmpeg / ffprobe argv (OCV5-588).
 *
 * Everything that reaches the sandbox is built here from typed, range-clamped
 * input. No caller-supplied string is ever interpolated into a filter graph
 * except validated basenames under /work/in; user-visible text (subtitles) only
 * travels inside the ASS file (see ass.ts). The runner executes argv arrays
 * without a shell.
 */

export const SANDBOX_IN = '/work/in'
export const SANDBOX_OUT = '/work/out'
export const BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

export class ComposeSpecError extends Error {
  readonly code = 'COMPOSE_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'ComposeSpecError'
  }
}

export function assertBasename(name: string, what = 'file'): string {
  if (typeof name !== 'string' || !BASENAME_RE.test(name) || name.includes('..')) {
    throw new ComposeSpecError(
      `${what} must be a plain file name, got ${JSON.stringify(String(name).slice(0, 40))}`,
    )
  }
  return name
}

function finite(n: unknown, what: string): number {
  if (typeof n !== 'number' || !Number.isFinite(n))
    throw new ComposeSpecError(`${what} must be a finite number`)
  return n
}

function inRange(n: unknown, min: number, max: number, what: string): number {
  const v = finite(n, what)
  if (v < min || v > max)
    throw new ComposeSpecError(`${what} must be in [${min}, ${max}], got ${v}`)
  return v
}

/** Fixed-precision formatting so no exponent / locale artefacts reach ffmpeg. */
export function num(n: number, digits = 3): string {
  const s = n.toFixed(digits)
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

const inPath = (name: string) => `${SANDBOX_IN}/${assertBasename(name)}`
const outPath = (name: string) => `${SANDBOX_OUT}/${assertBasename(name, 'output')}`

export type ComposeOp =
  | { op: 'probe'; file: string }
  | { op: 'frames'; file: string; times: number[] }
  | { op: 'filmstrip'; file: string; durationSec: number; count: number; height: number }
  | { op: 'waveform_pcm'; file: string }
  | { op: 'compose'; spec: ComposeSpec }

export interface ComposeSpec {
  width: 1280 | 1920
  height: 720 | 1080
  fps: 24 | 25 | 30
  clips: Array<{ file: string; inSec: number; outSec: number }>
  transitions?: { kind: 'cut' | 'fade'; durSec?: number }
  grade?: 'none' | 'warm' | 'cool' | 'film'
  subtitles?: { file: string; burn: boolean }
  voice?: Array<{ file: string; startSec: number; gainDb?: number }>
  music?: {
    file: string
    gainDb?: number
    duckDb?: number
    fadeInSec?: number
    fadeOutSec?: number
  }
  loudness?: { targetLufs: number }
}

export interface BuiltCommand {
  /** argv[0] is the binary inside the sandbox image. */
  argv: string[]
  timeoutMs: number
  /** Total disk reservation for this step: per-file cap × outputs. */
  maxOutputBytes: number
  /** Per-output byte cap (-fs for streams; bounded by scaling for single images). */
  perFileCapBytes: number
  /** Files the runner must find in /work/out afterwards (basenames). */
  outputs: string[]
  /** ffprobe writes JSON to stdout instead of a file. */
  stdoutJson?: boolean
}

export const OUTPUT_CAP = {
  final: 512 * 1024 * 1024,
  image: 20 * 1024 * 1024,
  pcm: 16 * 1024 * 1024,
} as const

export const LIMITS = {
  maxFrames: 12,
  maxFilmstrip: 24,
  maxClips: 40,
  maxVoice: 60,
  maxClipSec: 60,
  maxTotalSec: 600,
} as const

const GRADES: Record<NonNullable<ComposeSpec['grade']>, string | null> = {
  none: null,
  warm: 'eq=saturation=1.06:gamma_r=1.04:gamma_b=0.97',
  cool: 'eq=saturation=1.02:gamma_r=0.97:gamma_b=1.05',
  film: 'eq=contrast=1.05:saturation=0.92,curves=preset=increase_contrast',
}

export function buildCommand(op: ComposeOp): BuiltCommand {
  switch (op.op) {
    case 'probe':
      return {
        argv: [
          'ffprobe',
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          inPath(op.file),
        ],
        timeoutMs: 30_000,
        maxOutputBytes: 0,
        perFileCapBytes: 0,
        outputs: [],
        stdoutJson: true,
      }
    case 'frames': {
      if (!Array.isArray(op.times) || op.times.length < 1 || op.times.length > LIMITS.maxFrames) {
        throw new ComposeSpecError(`frames needs 1..${LIMITS.maxFrames} time points`)
      }
      const argv = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
      const outputs: string[] = []
      op.times.forEach((t, i) => {
        const sec = inRange(t, 0, LIMITS.maxTotalSec, `times[${i}]`)
        const name = `frame-${i}.png`
        argv.push('-ss', num(sec), '-i', inPath(op.file))
        outputs.push(name)
      })
      op.times.forEach((_t, i) => {
        argv.push(
          '-map',
          `${i}:v:0`,
          // PNG (image2) cannot be capped by -fs: bound the pixels instead. 1920x1920 rgb24 is at
          // most ~11 MB uncompressed, well under OUTPUT_CAP.image (code r1 P1-5).
          '-vf',
          'scale=w=1920:h=1920:force_original_aspect_ratio=decrease',
          '-pix_fmt',
          'rgb24',
          '-frames:v',
          '1',
          '-fs',
          String(OUTPUT_CAP.image),
          outPath(`frame-${i}.png`),
        )
      })
      return {
        argv,
        timeoutMs: 60_000,
        outputs,
        maxOutputBytes: OUTPUT_CAP.image * op.times.length,
        perFileCapBytes: OUTPUT_CAP.image,
      }
    }
    case 'filmstrip': {
      const dur = inRange(op.durationSec, 0.5, LIMITS.maxTotalSec, 'durationSec')
      const count = Math.trunc(inRange(op.count, 2, LIMITS.maxFilmstrip, 'count'))
      const height = Math.trunc(inRange(op.height, 32, 360, 'height'))
      return {
        argv: [
          'ffmpeg',
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-t',
          num(dur),
          '-i',
          inPath(op.file),
          '-vf',
          // Each tile ≤ 640x360 → ≤ 24 × 640 × 360 rgb24 ≈ 16.6 MB, under OUTPUT_CAP.image.
          `fps=${num(count / dur, 4)},scale=w=640:h=${height}:force_original_aspect_ratio=decrease,tile=${count}x1`,
          '-pix_fmt',
          'rgb24',
          '-frames:v',
          '1',
          '-fs',
          String(OUTPUT_CAP.image),
          outPath('filmstrip.png'),
        ],
        timeoutMs: 60_000,
        maxOutputBytes: OUTPUT_CAP.image,
        perFileCapBytes: OUTPUT_CAP.image,
        outputs: ['filmstrip.png'],
      }
    }
    case 'waveform_pcm':
      // 8 kHz mono s16le; peaks are computed in node from the raw file.
      return {
        argv: [
          'ffmpeg',
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-y',
          '-t',
          String(LIMITS.maxTotalSec),
          '-i',
          inPath(op.file),
          '-vn',
          '-ac',
          '1',
          '-ar',
          '8000',
          '-f',
          's16le',
          '-fs',
          String(OUTPUT_CAP.pcm),
          outPath('pcm.raw'),
        ],
        timeoutMs: 60_000,
        maxOutputBytes: OUTPUT_CAP.pcm,
        perFileCapBytes: OUTPUT_CAP.pcm,
        outputs: ['pcm.raw'],
      }
    case 'compose':
      return buildCompose(op.spec)
  }
}

function validateSpec(spec: ComposeSpec): void {
  if (
    !(spec.width === 1280 && spec.height === 720) &&
    !(spec.width === 1920 && spec.height === 1080)
  ) {
    throw new ComposeSpecError('resolution must be 1280x720 or 1920x1080')
  }
  if (![24, 25, 30].includes(spec.fps)) throw new ComposeSpecError('fps must be 24, 25 or 30')
  if (!Array.isArray(spec.clips) || spec.clips.length < 1 || spec.clips.length > LIMITS.maxClips) {
    throw new ComposeSpecError(`clips must have 1..${LIMITS.maxClips} entries`)
  }
  let total = 0
  spec.clips.forEach((c, i) => {
    assertBasename(c.file, `clips[${i}].file`)
    const a = inRange(c.inSec, 0, LIMITS.maxTotalSec, `clips[${i}].inSec`)
    const b = inRange(c.outSec, 0, LIMITS.maxTotalSec, `clips[${i}].outSec`)
    if (b - a < 0.5 || b - a > LIMITS.maxClipSec)
      throw new ComposeSpecError(`clips[${i}] length must be 0.5..${LIMITS.maxClipSec}s`)
    total += b - a
  })
  if (total > LIMITS.maxTotalSec)
    throw new ComposeSpecError(`total length must be <= ${LIMITS.maxTotalSec}s`)
  if (spec.transitions) {
    if (!['cut', 'fade'].includes(spec.transitions.kind))
      throw new ComposeSpecError('transition kind must be cut or fade')
    if (spec.transitions.durSec !== undefined)
      inRange(spec.transitions.durSec, 0.2, 1, 'transitions.durSec')
  }
  if (spec.grade !== undefined && !(spec.grade in GRADES))
    throw new ComposeSpecError('unknown grade preset')
  if (spec.subtitles) assertBasename(spec.subtitles.file, 'subtitles.file')
  if (spec.voice) {
    if (!Array.isArray(spec.voice) || spec.voice.length > LIMITS.maxVoice)
      throw new ComposeSpecError(`voice must have <= ${LIMITS.maxVoice} entries`)
    spec.voice.forEach((v, i) => {
      assertBasename(v.file, `voice[${i}].file`)
      inRange(v.startSec, 0, LIMITS.maxTotalSec, `voice[${i}].startSec`)
      if (v.gainDb !== undefined) inRange(v.gainDb, -30, 12, `voice[${i}].gainDb`)
    })
  }
  if (spec.music) {
    assertBasename(spec.music.file, 'music.file')
    if (spec.music.gainDb !== undefined) inRange(spec.music.gainDb, -40, 6, 'music.gainDb')
    if (spec.music.duckDb !== undefined) inRange(spec.music.duckDb, 0, 30, 'music.duckDb')
    if (spec.music.fadeInSec !== undefined) inRange(spec.music.fadeInSec, 0, 10, 'music.fadeInSec')
    if (spec.music.fadeOutSec !== undefined)
      inRange(spec.music.fadeOutSec, 0, 10, 'music.fadeOutSec')
  }
  if (spec.loudness) inRange(spec.loudness.targetLufs, -30, -10, 'loudness.targetLufs')
}

function buildCompose(spec: ComposeSpec): BuiltCommand {
  validateSpec(spec)
  const { width: W, height: H, fps } = spec
  const argv = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y']
  const graph: string[] = []
  let input = 0

  // video inputs: one per clip (trim inside the graph keeps argv simple and exact)
  const clipLabels: string[] = []
  const durations: number[] = []
  for (const c of spec.clips) {
    argv.push('-t', num(c.outSec), '-i', inPath(c.file))
    const d = c.outSec - c.inSec
    durations.push(d)
    const l = `v${input}`
    graph.push(
      `[${input}:v:0]trim=start=${num(c.inSec)}:end=${num(c.outSec)},setpts=PTS-STARTPTS,` +
        `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=${fps},format=yuv420p[${l}]`,
    )
    clipLabels.push(l)
    input += 1
  }

  let video: string
  let totalSec = durations.reduce((a, b) => a + b, 0)
  const fade = spec.transitions?.kind === 'fade' && clipLabels.length > 1
  if (!fade) {
    graph.push(
      `${clipLabels.map((l) => `[${l}]`).join('')}concat=n=${clipLabels.length}:v=1:a=0[vcat]`,
    )
    video = 'vcat'
  } else {
    const dur = Math.min(spec.transitions?.durSec ?? 0.4, ...durations.map((d) => d / 2))
    let prev = clipLabels[0]!
    let offset = durations[0]! - dur
    for (let i = 1; i < clipLabels.length; i++) {
      const out = i === clipLabels.length - 1 ? 'vcat' : `x${i}`
      graph.push(
        `[${prev}][${clipLabels[i]}]xfade=transition=fade:duration=${num(dur)}:offset=${num(offset)}[${out}]`,
      )
      prev = out
      offset += durations[i]! - dur
    }
    totalSec -= dur * (clipLabels.length - 1)
    video = 'vcat'
  }
  const grade = GRADES[spec.grade ?? 'none']
  if (grade) {
    graph.push(`[${video}]${grade}[vg]`)
    video = 'vg'
  }
  if (spec.subtitles?.burn) {
    graph.push(
      `[${video}]subtitles=filename=${inPath(spec.subtitles.file)}:fontsdir=/usr/share/fonts[vs]`,
    )
    video = 'vs'
  }

  // audio
  const voiceLabels: string[] = []
  for (const [i, v] of (spec.voice ?? []).entries()) {
    argv.push('-t', String(LIMITS.maxTotalSec), '-i', inPath(v.file))
    const delayMs = Math.round(v.startSec * 1000)
    graph.push(
      `[${input}:a:0]aresample=48000,volume=${num(v.gainDb ?? 0, 2)}dB,adelay=${delayMs}|${delayMs}[a${i}]`,
    )
    voiceLabels.push(`a${i}`)
    input += 1
  }
  let voiceBus: string | null = null
  if (voiceLabels.length > 0) {
    graph.push(
      `${voiceLabels.map((l) => `[${l}]`).join('')}amix=inputs=${voiceLabels.length}:normalize=0:dropout_transition=0,apad[vox]`,
    )
    voiceBus = 'vox'
  }
  let audio: string | null = voiceBus
  if (spec.music) {
    argv.push('-t', String(LIMITS.maxTotalSec), '-i', inPath(spec.music.file))
    const m = spec.music
    const fadeIn = m.fadeInSec ?? 1
    const fadeOut = m.fadeOutSec ?? 2.5
    graph.push(
      `[${input}:a:0]aresample=48000,volume=${num(m.gainDb ?? -8, 2)}dB,` +
        `afade=t=in:st=0:d=${num(fadeIn)},afade=t=out:st=${num(Math.max(0, totalSec - fadeOut))}:d=${num(fadeOut)}[mus]`,
    )
    input += 1
    if (voiceBus) {
      const duck = m.duckDb ?? 12
      // Ducking: compress the music bed by the voice bus. ratio derived from the requested dB.
      graph.push('[vox]asplit=2[voxa][voxk]')
      graph.push(
        `[mus][voxk]sidechaincompress=threshold=0.03:ratio=${num(Math.min(20, 1 + duck / 2), 2)}:attack=20:release=400[musd]`,
      )
      graph.push('[voxa][musd]amix=inputs=2:normalize=0:duration=longest[amix]')
      audio = 'amix'
    } else {
      audio = 'mus'
    }
  }
  if (audio) {
    const lufs = spec.loudness?.targetLufs ?? -16
    graph.push(
      `[${audio}]atrim=end=${num(totalSec)},loudnorm=I=${num(lufs, 1)}:TP=-1.5:LRA=11,aresample=48000[aout]`,
    )
    audio = 'aout'
  }

  argv.push('-filter_complex', graph.join(';'), '-map', `[${video}]`)
  if (audio) argv.push('-map', `[${audio}]`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  else argv.push('-an')
  argv.push(
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-t',
    num(totalSec),
    '-fs',
    String(OUTPUT_CAP.final),
    '-movflags',
    '+faststart',
    outPath('final.mp4'),
  )
  // Soft subtitles (burn=false) are delivered as an .srt written by node (ass.ts toSrt), not muxed.
  return {
    argv,
    timeoutMs: 600_000,
    outputs: ['final.mp4'],
    maxOutputBytes: OUTPUT_CAP.final,
    perFileCapBytes: OUTPUT_CAP.final,
  }
}

/** Peaks from 8 kHz s16le mono PCM: max |sample| per bucket, normalised to 0..1. */
export function peaksFromPcm(pcm: Buffer, buckets: number): number[] {
  const n = Math.max(1, Math.min(4000, Math.trunc(buckets)))
  const samples = Math.floor(pcm.length / 2)
  const out = new Array<number>(n).fill(0)
  if (samples === 0) return out
  const per = samples / n
  for (let b = 0; b < n; b++) {
    const start = Math.floor(b * per)
    const end = Math.max(start + 1, Math.floor((b + 1) * per))
    let peak = 0
    for (let s = start; s < end && s < samples; s++) {
      const v = Math.abs(pcm.readInt16LE(s * 2))
      if (v > peak) peak = v
    }
    out[b] = Math.round((peak / 32768) * 1000) / 1000
  }
  return out
}
