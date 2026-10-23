// OCV5-593 FE-6: which composed film belongs to which export format, and its credits text.
// Formats match the backend (OCV5-591 A2-1c): resolution × subtitles, keyed `${res}-${subs}`.

import type {
  ExportResolution,
  ExportSubtitles,
  ExportVariant,
  FilmCredit,
  StudioProjectView,
  StudioTake,
} from './types'

export const DEFAULT_VARIANT: ExportVariant = { resolution: '1080p', subtitles: 'burn' }

export const RESOLUTIONS: Array<[ExportResolution, string]> = [
  ['1080p', '1080p'],
  ['720p', '720p'],
  ['vertical', '竖屏 9:16'],
]
export const SUBTITLE_MODES: Array<[ExportSubtitles, string]> = [
  ['burn', '字幕烧录'],
  ['srt', '.srt'],
  ['none', '无字幕'],
]

export function variantKey(v: ExportVariant): string {
  return `${v.resolution}-${v.subtitles}`
}

/** A film's format; films composed before formats existed are the default one. */
export function filmKey(t: StudioTake): string {
  if (t.final?.variantKey) return t.final.variantKey
  return t.final?.variant ? variantKey(t.final.variant) : variantKey(DEFAULT_VARIANT)
}

/** Composed films, newest first. */
export function finalFilms(view: StudioProjectView): StudioTake[] {
  return view.takes
    .filter((t) => t.ownerKind === 'final' && t.status === 'succeeded' && t.blobSha)
    .sort((a, b) => b.version - a.version)
}

/** A film still being composed for this format (queued / running). */
export function composingFilm(view: StudioProjectView, key: string): StudioTake | null {
  return (
    view.takes.find(
      (t) =>
        t.ownerKind === 'final' &&
        (t.status === 'queued' || t.status === 'running') &&
        filmKey(t) === key,
    ) ?? null
  )
}

/**
 * The film to hand out for a format. The newest film is current for its own format; another
 * format is only known current once the server said so (`reusedId`, from an export request) or
 * a film for it finished after it was asked for (`askedAfter`, the newest version at that time).
 */
export function filmFor(
  films: StudioTake[],
  key: string,
  reusedId: string | undefined,
  askedAfter: number | undefined,
): StudioTake | null {
  if (reusedId) {
    const hit = films.find((t) => t.id === reusedId)
    if (hit) return hit
  }
  if (askedAfter !== undefined) {
    const fresh = films.find((t) => t.version > askedAfter && filmKey(t) === key)
    if (fresh) return fresh
  }
  const latest = films[0]
  return latest && filmKey(latest) === key ? latest : null
}

export function variantOf(t: StudioTake | null | undefined): ExportVariant {
  return t?.final?.variant ?? DEFAULT_VARIANT
}

/** credits.txt: one block per CC BY item, the attribution exactly as the licence asks. */
export function creditsText(title: string, credits: FilmCredit[]): string {
  const head = `${title || '成片'} — 署名 / Credits`
  const blocks = credits.map((c) =>
    [`音乐：${c.title || '（无标题）'}`, c.attributionText, c.license ? `协议：${c.license}` : '']
      .filter(Boolean)
      .join('\n'),
  )
  return `${[head, ...blocks].join('\n\n')}\n`
}
