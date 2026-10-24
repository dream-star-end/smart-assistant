// OCV5-593 media studio — mirrors the commercial /api/studio/* contract
// (packages/commercial/src/media-studio/{store,http}.ts and providers/registry.ts).

export type StudioStatus =
  | 'draft'
  | 'planning'
  | 'running'
  | 'awaiting_user'
  | 'composing'
  | 'done'
  | 'failed'
  | 'paused'
  | 'canceled'

export type StudioAspect = '16:9' | '9:16' | '1:1'

export interface StudioProject {
  id: string
  title: string
  brief: string
  status: StudioStatus
  autonomy: 'max' | 'confirm'
  aspect: StudioAspect
  fps: number
  targetSec: number
  /** bigint columns arrive as decimal strings */
  budgetCredits: string
  spentCredits: string
  reservedCredits: string
  settings: Record<string, unknown>
  rev: number
  createdAt: string
  updatedAt: string
}

export interface StudioShot {
  id: string
  ordinal: number
  spec: Record<string, unknown>
  status: 'planned' | 'generating' | 'qa' | 'needs_user' | 'ready' | 'failed'
  activeTakeId: string | null
}

export interface StudioLine {
  id: string
  shotId: string | null
  ordinal: number
  speakerAssetId: string | null
  text: string
  emotion: string | null
  speed: number | null
  status: string
  activeTakeId: string | null
}

export interface StudioAsset {
  id: string
  kind: 'character' | 'scene' | 'style' | 'voice' | 'reference' | 'upload'
  name: string
  locked: boolean
  descriptor: string | null
  blobSha: string | null
  voiceId: string | null
  meta: Record<string, unknown>
  createdAt: string
}

export interface StudioTake {
  id: string
  ownerKind: 'shot_frame' | 'shot_video' | 'line' | 'music' | 'bible' | 'final'
  ownerId: string
  version: number
  provider: string
  model: string
  op: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  errorCode: string | null
  costCredits: string
  qa: Record<string, unknown> | null
  blobSha: string | null
  createdAt: string
  finishedAt: string | null
  /** Music takes only (OCV5-591 M1): licence snapshot and track card. */
  music?: { license: Record<string, unknown> | null; track: Record<string, unknown> | null } | null
  /** The media's real length when known (OCV5-591 A2-1c-2); narration is placed by it. */
  durationMs?: number | null
  /** Final takes only (OCV5-591 A2-1c-2): export format, CC BY credits, the .srt beside the film. */
  final?: {
    variant: ExportVariant | null
    variantKey: string | null
    credits: FilmCredit[] | null
    srtSha: string | null
  } | null
}

export type ExportResolution = '1080p' | '720p' | 'vertical'
export type ExportSubtitles = 'burn' | 'srt' | 'none'
export interface ExportVariant {
  resolution: ExportResolution
  subtitles: ExportSubtitles
}

/** A CC BY item in a film and the attribution its licence asks for, verbatim. */
export interface FilmCredit {
  kind: 'music'
  title: string
  attributionText: string
  license: string
}

export interface StudioEvent {
  id: string
  ts: string
  type: string
  payload: Record<string, unknown> | null
}

export interface StudioProjectView {
  project: StudioProject
  shots: StudioShot[]
  lines: StudioLine[]
  assets: StudioAsset[]
  takes: StudioTake[]
  events: StudioEvent[]
}

export interface StudioProjectPage {
  projects: StudioProject[]
  next: string | null
}

export type MediaKind = 'image' | 'video' | 'voice' | 'music'
export type ProviderState = 'ready' | 'unconfigured' | 'disabled' | 'offline'

export interface ProviderModel {
  id: string
  label: string
  ops: string[]
  isDefault?: boolean
}

export interface ProviderInfo {
  id: string
  label: string
  state: ProviderState
  reason?: string
  models: ProviderModel[]
}

export interface ProviderKindView {
  kind: MediaKind
  state: 'ready' | 'offline' | 'unconfigured'
  reason?: string
  providers: ProviderInfo[]
}

export interface ProvidersView {
  kinds: ProviderKindView[]
}

export const ACTIVE_STATUSES: ReadonlySet<StudioStatus> = new Set([
  'planning',
  'running',
  'composing',
])
