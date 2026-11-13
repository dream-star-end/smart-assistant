/**
 * Subtitle files for the compose sandbox (OCV5-588).
 *
 * User text only ever reaches ffmpeg inside this generated ASS file — never in
 * the filter graph. Override tags (`{...}`), escapes (`\`) and control
 * characters are neutralised so a line cannot restyle or reposition itself.
 */

export interface SubtitleCue {
  startSec: number
  endSec: number
  text: string
}

const MAX_CUES = 400
const MAX_CUE_CHARS = 200

export class SubtitleError extends Error {
  readonly code = 'COMPOSE_INVALID'
  constructor(message: string) {
    super(message)
    this.name = 'SubtitleError'
  }
}

/** Neutralise ASS override syntax; keep line breaks as \N. */
export function escapeAssText(text: string): string {
  const clipped = [...text].slice(0, MAX_CUE_CHARS).join('')
  return (
    clipped
      .replace(/\r\n?/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
      .replace(/\\/g, '\\\\')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\n/g, '\\N')
  )
}

function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

function srtTime(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
}

function validate(cues: SubtitleCue[]): SubtitleCue[] {
  if (!Array.isArray(cues) || cues.length > MAX_CUES)
    throw new SubtitleError(`subtitles must have <= ${MAX_CUES} cues`)
  return cues.map((c, i) => {
    if (
      !Number.isFinite(c.startSec) ||
      !Number.isFinite(c.endSec) ||
      c.startSec < 0 ||
      c.endSec <= c.startSec ||
      c.endSec > 600
    ) {
      throw new SubtitleError(`cue ${i} has an invalid time range`)
    }
    if (typeof c.text !== 'string') throw new SubtitleError(`cue ${i} text must be a string`)
    return c
  })
}

/** Fixed house style: white text, thin dark outline, bottom centre, Noto Sans CJK SC. */
export function toAss(cues: SubtitleCue[], width: number, height: number): string {
  const list = validate(cues)
  const fontSize = Math.round(height * 0.045)
  const marginV = Math.round(height * 0.06)
  const head = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Noto Sans CJK SC,${fontSize},&H00FFFFFF,&H00FFFFFF,&H64000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,60,60,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const events = list.map(
    (c) =>
      `Dialogue: 0,${assTime(c.startSec)},${assTime(c.endSec)},Default,,0,0,0,,${escapeAssText(c.text)}`,
  )
  return `${[...head, ...events].join('\n')}\n`
}

export function toSrt(cues: SubtitleCue[]): string {
  const list = validate(cues)
  return list
    .map((c, i) => {
      const text = [...c.text]
        .slice(0, MAX_CUE_CHARS)
        .join('')
        // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
        .replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
        .replace(/\n{2,}/g, '\n')
      return `${i + 1}\n${srtTime(c.startSec)} --> ${srtTime(c.endSec)}\n${text}\n`
    })
    .join('\n')
}
