// OCV5-593 FE-2b: annotation drafts on a take (point / box / time range). Coordinates are
// normalised to the media box (0–1) so they survive any display size. Until the orchestrator's
// POST /annotations ships (A2-1) drafts live only in this tab (sessionStorage, per project).

export type AnnotationKind = 'point' | 'box' | 'range'

export interface AnnotationDraft {
  id: string
  takeId: string
  kind: AnnotationKind
  /** point: x,y; box: x,y,w,h — all 0–1 of the media box. */
  x?: number
  y?: number
  w?: number
  h?: number
  /** seconds into the take (images: 0). */
  tStart: number
  tEnd?: number
  text: string
  createdAt: number
}

export const ANNOTATION_TEXT_MAX = 1000
export const MIN_BOX = 0.02

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/** Box from two drag corners (any direction); null when it is too small to mean anything. */
export function boxFromDrag(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number; w: number; h: number } | null {
  const x1 = clamp01(Math.min(a.x, b.x))
  const y1 = clamp01(Math.min(a.y, b.y))
  const x2 = clamp01(Math.max(a.x, b.x))
  const y2 = clamp01(Math.max(a.y, b.y))
  if (x2 - x1 < MIN_BOX || y2 - y1 < MIN_BOX) return null
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 }
}

export function rangeFromDrag(
  a: number,
  b: number,
  duration: number,
): { tStart: number; tEnd: number } | null {
  if (!(duration > 0)) return null
  const s = Math.min(Math.max(0, Math.min(a, b)), duration)
  const e = Math.min(Math.max(0, Math.max(a, b)), duration)
  return e - s >= 0.2 ? { tStart: s, tEnd: e } : null
}

function fmt(sec: number): string {
  const m = Math.floor(sec / 60)
  return `${String(m).padStart(2, '0')}:${(sec - m * 60).toFixed(1).padStart(4, '0')}`
}

export function annotationLabel(d: AnnotationDraft): string {
  const kind = d.kind === 'point' ? '点' : d.kind === 'box' ? '框选' : '时间段'
  const t = d.tEnd !== undefined ? `${fmt(d.tStart)}–${fmt(d.tEnd)}` : fmt(d.tStart)
  return `${kind} · ${t}`
}

const storageKey = (projectId: string) => `oc.studio.annotationDrafts.${projectId}`

function valid(d: unknown): d is AnnotationDraft {
  if (!d || typeof d !== 'object') return false
  const o = d as Record<string, unknown>
  return (
    typeof o.id === 'string' &&
    typeof o.takeId === 'string' &&
    (o.kind === 'point' || o.kind === 'box' || o.kind === 'range') &&
    typeof o.tStart === 'number' &&
    typeof o.text === 'string'
  )
}

export function loadDrafts(projectId: string): AnnotationDraft[] {
  try {
    const raw = sessionStorage.getItem(storageKey(projectId))
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter(valid).map((d) => ({ ...d, text: d.text.slice(0, ANNOTATION_TEXT_MAX) }))
      : []
  } catch {
    return []
  }
}

export function saveDrafts(projectId: string, drafts: AnnotationDraft[]): void {
  try {
    if (drafts.length) sessionStorage.setItem(storageKey(projectId), JSON.stringify(drafts))
    else sessionStorage.removeItem(storageKey(projectId))
  } catch {
    // Private mode / quota: drafts simply stay in memory for this view.
  }
}

let seq = 0
export function newDraftId(now = Date.now()): string {
  seq = (seq + 1) % 1_000_000
  return `d${now.toString(36)}${seq.toString(36)}`
}
