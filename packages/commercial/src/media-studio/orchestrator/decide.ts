// OCV5-591 A2-1a — the orchestrator's decisions as a pure function: given the project's state,
// what should be dispatched or which status should it move to. advanceProject() applies the result
// inside one transaction under the project's advisory lock; this file has no IO and is unit tested
// on every path of the state machine (plan §2).

import type { MediaOp } from '../providers/types.js'

export const MAX_INFLIGHT_PER_PROJECT = 3

export type ProjectStatus =
  | 'draft'
  | 'planning'
  | 'running'
  | 'awaiting_user'
  | 'composing'
  | 'done'
  | 'failed'
  | 'paused'
  | 'canceled'

export interface DTake {
  id: string
  ownerKind: 'shot_frame' | 'shot_video' | 'line' | 'music' | 'bible' | 'final'
  ownerId: string
  version: number
  provider: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'
  blobSha: string | null
}

export interface DShot {
  id: string
  ordinal: number
  status: 'planned' | 'generating' | 'qa' | 'needs_user' | 'ready' | 'failed'
  activeTakeId: string | null
  /** The frame the user picked as the video's start (spec.frameTakeId). */
  frameTakeId: string | null
}

export interface DLine {
  id: string
  status: 'planned' | 'generating' | 'needs_user' | 'ready' | 'failed'
  activeTakeId: string | null
}

export interface DAsset {
  id: string
  kind: 'character' | 'scene' | 'style' | 'voice' | 'reference' | 'upload'
  locked: boolean
  blobSha: string | null
}

export interface DState {
  status: ProjectStatus
  hasPlanTask: boolean
  /** Generation tasks of this project that are queued or leased. */
  inflight: number
  shots: DShot[]
  lines: DLine[]
  assets: DAsset[]
  takes: DTake[]
  narrationVoiceId: string | null
  musicSkippedNoted: boolean
  /** Media kinds with a provider that can take work now or queue it. */
  canDispatch: { image: boolean; video: boolean; voice: boolean; music: boolean }
}

export interface Dispatch {
  ownerKind: DTake['ownerKind']
  ownerId: string
  op: MediaOp
  /** Provider ids that already failed for this owner (excluded from the next candidate list). */
  exclude: string[]
  /** Blob inputs, e.g. the bible images for a frame or the first frame for a video. */
  inputs: Array<{ role: 'reference' | 'first_frame'; blobSha: string }>
}

export type Action =
  | { type: 'enqueue_plan' }
  | { type: 'dispatch'; dispatch: Dispatch }
  | { type: 'set_status'; status: ProjectStatus; reason?: string }
  | { type: 'shot_status'; shotId: string; status: DShot['status'] }
  | { type: 'line_status'; lineId: string; status: DLine['status'] }
  | { type: 'note_music_skipped' }

const BIBLE_KINDS = new Set(['character', 'scene', 'style'])

function ownerTakes(s: DState, kind: DTake['ownerKind'], ownerId: string): DTake[] {
  return s.takes.filter((t) => t.ownerKind === kind && t.ownerId === ownerId)
}

const live = (t: DTake) => t.status === 'queued' || t.status === 'running'
const ok = (t: DTake) => t.status === 'succeeded' && t.blobSha !== null
const failedProviders = (ts: DTake[]) => [
  ...new Set(ts.filter((t) => t.status === 'failed').map((t) => t.provider)),
]

/** A shot is done only when its adopted take is a succeeded video (plan r1 P1-3). */
export function shotDone(s: DState, shot: DShot): boolean {
  if (shot.status !== 'ready' || !shot.activeTakeId) return false
  const t = s.takes.find((x) => x.id === shot.activeTakeId)
  return !!t && t.ownerKind === 'shot_video' && ok(t)
}

export function decide(s: DState): Action[] {
  if (s.status === 'planning') return s.hasPlanTask ? [] : [{ type: 'enqueue_plan' }]
  if (s.status !== 'running') return []

  const actions: Action[] = []
  let budget = Math.max(0, MAX_INFLIGHT_PER_PROJECT - s.inflight)
  const dispatch = (d: Dispatch) => {
    if (budget <= 0) return false
    budget -= 1
    actions.push({ type: 'dispatch', dispatch: d })
    return true
  }
  let blocked = false // something can never finish without the user

  // 1) bible: every character / scene / style asset gets one locked image.
  const bible = s.assets.filter((a) => BIBLE_KINDS.has(a.kind))
  for (const a of bible) {
    if (a.locked && a.blobSha) continue
    const ts = ownerTakes(s, 'bible', a.id)
    if (ts.some(live)) continue
    if (!s.canDispatch.image) {
      blocked = true
      continue
    }
    dispatch({
      ownerKind: 'bible',
      ownerId: a.id,
      op: 'image.generate',
      exclude: failedProviders(ts),
      inputs: [],
    })
  }
  const bibleReady = bible.every((a) => a.locked && a.blobSha)
  const refs = bible
    .filter((a) => a.blobSha)
    .map((a) => ({ role: 'reference' as const, blobSha: a.blobSha! }))

  // 2) shots: first frame (after the bible is locked), then the video from it.
  for (const shot of [...s.shots].sort((a, b) => a.ordinal - b.ordinal)) {
    if (shotDone(s, shot)) continue
    if (shot.status === 'needs_user' || shot.status === 'failed') {
      blocked = true
      continue
    }
    const frames = ownerTakes(s, 'shot_frame', shot.id)
    const videos = ownerTakes(s, 'shot_video', shot.id)
    if (frames.some(live) || videos.some(live)) continue
    const picked = shot.frameTakeId
      ? frames.find((t) => t.id === shot.frameTakeId && ok(t))
      : undefined
    const frame = picked ?? [...frames].filter(ok).sort((a, b) => b.version - a.version)[0]
    if (!frame) {
      if (!bibleReady) continue
      if (!s.canDispatch.image) {
        blocked = true
        continue
      }
      if (
        dispatch({
          ownerKind: 'shot_frame',
          ownerId: shot.id,
          op: 'image.generate',
          exclude: failedProviders(frames),
          inputs: refs,
        })
      ) {
        if (shot.status !== 'generating')
          actions.push({ type: 'shot_status', shotId: shot.id, status: 'generating' })
      }
      continue
    }
    // A video made from this frame that succeeded and is not adopted yet → adopt it is the
    // executor's job; here we only start one when none exists for the chosen frame.
    const fromFrame = videos.filter((v) => v.status !== 'canceled')
    const usable = fromFrame.find(ok)
    if (usable && !shot.frameTakeId) continue
    if (!s.canDispatch.video) {
      blocked = true
      continue
    }
    if (
      dispatch({
        ownerKind: 'shot_video',
        ownerId: shot.id,
        op: 'video.from_image',
        exclude: failedProviders(videos),
        inputs: [{ role: 'first_frame', blobSha: frame.blobSha! }],
      })
    ) {
      if (shot.status !== 'generating')
        actions.push({ type: 'shot_status', shotId: shot.id, status: 'generating' })
    }
  }

  // 3) lines: text-to-speech with the plan's system voice.
  for (const line of s.lines) {
    if (line.status === 'ready' && line.activeTakeId) continue
    if (line.status === 'failed' || line.status === 'needs_user') {
      blocked = true
      continue
    }
    const ts = ownerTakes(s, 'line', line.id)
    if (ts.some(live)) continue
    if (!s.canDispatch.voice || !s.narrationVoiceId) {
      blocked = true
      continue
    }
    if (
      dispatch({
        ownerKind: 'line',
        ownerId: line.id,
        op: 'voice.tts',
        exclude: failedProviders(ts),
        inputs: [],
      })
    ) {
      if (line.status !== 'generating')
        actions.push({ type: 'line_status', lineId: line.id, status: 'generating' })
    }
  }

  // 4) music: only an interface for now — note once that it is skipped (user decision).
  if (!s.canDispatch.music && !s.musicSkippedNoted) actions.push({ type: 'note_music_skipped' })

  const dispatched = actions.some((a) => a.type === 'dispatch')
  const allShots = s.shots.length > 0 && s.shots.every((sh) => shotDone(s, sh))
  const allLines = s.lines.every((l) => l.status === 'ready' && l.activeTakeId)
  if (allShots && allLines && s.inflight === 0 && !dispatched) {
    // Compose lands in A2-1c; until then the project waits for it.
    actions.push({ type: 'set_status', status: 'awaiting_user', reason: 'compose_pending' })
  } else if (blocked && s.inflight === 0 && !dispatched) {
    actions.push({ type: 'set_status', status: 'awaiting_user', reason: 'needs_user' })
  }
  return actions
}
