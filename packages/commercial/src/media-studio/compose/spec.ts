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
  /** 16:9, 9:16 or 1:1 at 720 / 1080 (OCV5-591 A2-1c: studio projects and the 竖屏 export). */
  width: 720 | 1080 | 1280 | 1920
  height: 720 | 1080 | 1280 | 1920
  fps: 24 | 25 | 30
  clips: Array<{ file: string; inSec: number; outSec: number }>
  transitions?: { kind: 'cut' | 'fade'; durSec?: number }
  grade?: 'none' | 'warm' | 'cool' | 'film'
  subtitles?: { file: string; burn: boolean }
  voice?: Array<{ file: string; startSec: number; gainDb?: number }>
  music?: { file: string } & MusicEdit
  loudness?: { targetLufs: number }
}

/**
 * How the project's music is cut into the film (OCV5-591 M1, MUSIC-PLAN §3). Every field is
 * optional; with none of the placement / loop / duck-timing fields set the filter graph is exactly
 * the A0 one (whole track from 0 s, fades at both ends, fixed ducking).
 */
export interface MusicEdit {
  gainDb?: number
  /** How far the music is pulled down under narration. */
  duckDb?: number
  fadeInSec?: number
  fadeOutSec?: number
  /** Where the music starts / ends in the film (seconds of the cut). */
  startSec?: number
  endSec?: number
  /** Which part of the track is used (trim). */
  inSec?: number
  outSec?: number
  /** Repeat the trimmed part until endSec, joining repeats with a crossfade. Needs outSec. */
  loop?: { crossfadeSec?: number }
  duck?: { attackMs?: number; releaseMs?: number }
}

const MUSIC_LOOP_MAX_REPEATS = 24

/** Copies of the looped part needed to fill `span` seconds (crossfades overlap by `xf`). */
function loopRepeats(span: number, part: number, xf: number): number {
  return Math.max(1, Math.ceil((span - xf) / (part - xf)))
}
const tooManyRepeats = () =>
  new ComposeSpecError(
    `music.loop would need more than ${MUSIC_LOOP_MAX_REPEATS} repeats; use a longer part of the track`,
  )

/** Validates a music edit (also used by the HTTP API before it is stored). Returns a clean copy. */
export function validateMusicEdit(raw: unknown): MusicEdit {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new ComposeSpecError('music edit must be an object')
  const m = raw as Record<string, unknown>
  const known = new Set([
    'gainDb',
    'duckDb',
    'fadeInSec',
    'fadeOutSec',
    'startSec',
    'endSec',
    'inSec',
    'outSec',
    'loop',
    'duck',
    'file',
  ])
  for (const k of Object.keys(m))
    if (!known.has(k)) throw new ComposeSpecError(`music.${k} is not supported`)
  const out: MusicEdit = {}
  const opt = (k: keyof MusicEdit, lo: number, hi: number) => {
    if (m[k] !== undefined) (out as Record<string, number>)[k] = inRange(m[k], lo, hi, `music.${k}`)
  }
  opt('gainDb', -40, 6)
  opt('duckDb', 0, 30)
  opt('fadeInSec', 0, 10)
  opt('fadeOutSec', 0, 10)
  opt('startSec', 0, LIMITS.maxTotalSec)
  opt('endSec', 0, LIMITS.maxTotalSec)
  opt('inSec', 0, LIMITS.maxTotalSec)
  opt('outSec', 0, LIMITS.maxTotalSec)
  if (out.endSec !== undefined && out.endSec - (out.startSec ?? 0) < 1)
    throw new ComposeSpecError('music must play for at least 1 s (endSec after startSec)')
  if (out.outSec !== undefined && out.outSec - (out.inSec ?? 0) < 1)
    throw new ComposeSpecError('music.outSec must be at least 1 s after inSec')
  if (m.loop !== undefined) {
    if (!m.loop || typeof m.loop !== 'object' || Array.isArray(m.loop))
      throw new ComposeSpecError('music.loop must be an object')
    if (out.outSec === undefined)
      throw new ComposeSpecError('music.loop needs outSec (the part to repeat)')
    const l = m.loop as Record<string, unknown>
    const xf =
      l.crossfadeSec === undefined ? 0 : inRange(l.crossfadeSec, 0, 5, 'music.loop.crossfadeSec')
    if (xf * 2 >= out.outSec - (out.inSec ?? 0))
      throw new ComposeSpecError('music.loop.crossfadeSec must be under half the looped part')
    out.loop = { crossfadeSec: xf }
    // Known span: refuse now rather than at compose time (code r1 P1: no silent tail).
    if (out.endSec !== undefined) {
      const span = out.endSec - (out.startSec ?? 0)
      if (loopRepeats(span, out.outSec - (out.inSec ?? 0), xf) > MUSIC_LOOP_MAX_REPEATS)
        throw tooManyRepeats()
    }
  }
  if (m.duck !== undefined) {
    if (!m.duck || typeof m.duck !== 'object' || Array.isArray(m.duck))
      throw new ComposeSpecError('music.duck must be an object')
    const d = m.duck as Record<string, unknown>
    out.duck = {
      ...(d.attackMs !== undefined
        ? { attackMs: Math.round(inRange(d.attackMs, 1, 2000, 'music.duck.attackMs')) }
        : {}),
      ...(d.releaseMs !== undefined
        ? { releaseMs: Math.round(inRange(d.releaseMs, 10, 5000, 'music.duck.releaseMs')) }
        : {}),
    }
  }
  return out
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

/**
 * Music cut into the film: trim [inSec, outSec) of the track, repeat it (crossfaded) when looping,
 * cut it to the span [startSec, endSec) of the film, fade both ends of that span and delay it to
 * startSec. Every number comes from validateMusicEdit; nothing user-supplied reaches the graph raw.
 */
function musicPlacement(
  input: number,
  m: MusicEdit,
  totalSec: number,
  fadeIn: number,
  fadeOut: number,
): string[] {
  const start = Math.min(m.startSec ?? 0, Math.max(0, totalSec - 1))
  const end = Math.min(m.endSec ?? totalSec, totalSec)
  const span = Math.max(1, end - start)
  const graph: string[] = []
  const trim = `atrim=start=${num(m.inSec ?? 0)}${m.outSec !== undefined ? `:end=${num(m.outSec)}` : ''},asetpts=PTS-STARTPTS`
  graph.push(`[${input}:a:0]aresample=48000,${trim},volume=${num(m.gainDb ?? -8, 2)}dB[mtrim]`)
  let body = 'mtrim'
  if (m.loop && m.outSec !== undefined) {
    const part = m.outSec - (m.inSec ?? 0)
    const xf = m.loop.crossfadeSec ?? 0
    const repeats = loopRepeats(span, part, xf)
    // Never cap silently: a capped loop would leave the rest of the span without music.
    if (repeats > MUSIC_LOOP_MAX_REPEATS) throw tooManyRepeats()
    if (repeats > 1) {
      const copies = Array.from({ length: repeats }, (_, i) => `mrep${i}`)
      graph.push(`[mtrim]asplit=${repeats}${copies.map((c) => `[${c}]`).join('')}`)
      if (xf > 0) {
        let prev = copies[0]!
        for (let i = 1; i < repeats; i++) {
          const out = `mloop${i}`
          graph.push(`[${prev}][${copies[i]}]acrossfade=d=${num(xf)}:c1=tri:c2=tri[${out}]`)
          prev = out
        }
        body = prev
      } else {
        graph.push(`${copies.map((c) => `[${c}]`).join('')}concat=n=${repeats}:v=0:a=1[mloop]`)
        body = 'mloop'
      }
    }
  }
  const fi = Math.min(fadeIn, span / 2)
  const fo = Math.min(fadeOut, span / 2)
  const delayMs = Math.round(start * 1000)
  graph.push(
    `[${body}]atrim=end=${num(span)},afade=t=in:st=0:d=${num(fi)},afade=t=out:st=${num(Math.max(0, span - fo))}:d=${num(fo)}` +
      `${delayMs > 0 ? `,adelay=${delayMs}|${delayMs}` : ''},apad[mus]`,
  )
  return graph
}

export function buildCommand(op: ComposeOp): BuiltCommand {
  return boundThreads(buildUnbounded(op))
}

/**
 * Pin ffmpeg's thread pools (Codex Sol r1 P1): left on auto, every input opens a decoder with
 * ~one thread per host core, so 40 clips on a 16-core host need 640 threads and hit the sandbox's
 * PidsLimit 256. One decoder thread per input, two filter threads and four encoder threads keep a
 * maximal compose (40 clips + 24 voice + music) near 80 threads.
 */
function boundThreads(cmd: BuiltCommand): BuiltCommand {
  if (cmd.argv[0] !== 'ffmpeg') return cmd
  const argv: string[] = []
  cmd.argv.forEach((a, i) => {
    if (a === '-i') argv.push('-threads', '1')
    if (a === '-c:v' && cmd.argv[i + 1] === 'libx264')
      argv.push('-threads', String(ENCODER_THREADS))
    argv.push(a)
  })
  argv.splice(1, 0, '-filter_threads', '2', '-filter_complex_threads', '2')
  return { ...cmd, argv }
}

const ENCODER_THREADS = 4

/** The film's audio as the AAC encoder receives it, whatever the narration and music files are. */
export const AUDIO_OUT_FORMAT = 'sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo'

function buildUnbounded(op: ComposeOp): BuiltCommand {
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

/** 16:9, 9:16 and 1:1 canvases at 720 / 1080 (OCV5-591 A2-1c). */
const CANVASES: ReadonlyArray<readonly [number, number]> = [
  [1280, 720],
  [1920, 1080],
  [720, 1280],
  [1080, 1920],
  [720, 720],
  [1080, 1080],
]

function validateSpec(spec: ComposeSpec): void {
  if (!CANVASES.some(([w, h]) => spec.width === w && spec.height === h)) {
    throw new ComposeSpecError(
      `resolution must be one of ${CANVASES.map(([w, h]) => `${w}x${h}`).join(', ')}`,
    )
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
    validateMusicEdit(spec.music)
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
    const placed =
      m.startSec !== undefined ||
      m.endSec !== undefined ||
      m.inSec !== undefined ||
      m.outSec !== undefined ||
      m.loop
    if (!placed) {
      graph.push(
        `[${input}:a:0]aresample=48000,volume=${num(m.gainDb ?? -8, 2)}dB,` +
          `afade=t=in:st=0:d=${num(fadeIn)},afade=t=out:st=${num(Math.max(0, totalSec - fadeOut))}:d=${num(fadeOut)}[mus]`,
      )
    } else {
      graph.push(...musicPlacement(input, m, totalSec, fadeIn, fadeOut))
    }
    input += 1
    if (voiceBus) {
      const duck = m.duckDb ?? 12
      // Ducking: compress the music bed by the voice bus. ratio derived from the requested dB.
      graph.push('[vox]asplit=2[voxa][voxk]')
      graph.push(
        `[mus][voxk]sidechaincompress=threshold=0.03:ratio=${num(Math.min(20, 1 + duck / 2), 2)}:attack=${m.duck?.attackMs ?? 20}:release=${m.duck?.releaseMs ?? 400}[musd]`,
      )
      graph.push('[voxa][musd]amix=inputs=2:normalize=0:duration=longest[amix]')
      audio = 'amix'
    } else {
      audio = 'mus'
    }
  }
  if (audio) {
    const lufs = spec.loudness?.targetLufs ?? -16
    // The output format is pinned: ffmpeg rebuilds the graph when a later input's first frame
    // arrives, and by then the AAC encoder is open with the first build's layout. Left to
    // negotiation, mono 32 kHz narration made that rebuild fail ("Cannot select channel layout
    // ... format_out", INC-20261027-STUDIO-COMPOSE-CHANNEL-LAYOUT).
    graph.push(
      `[${audio}]atrim=end=${num(totalSec)},loudnorm=I=${num(lufs, 1)}:TP=-1.5:LRA=11,aresample=48000,` +
        `aformat=${AUDIO_OUT_FORMAT}[aout]`,
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
