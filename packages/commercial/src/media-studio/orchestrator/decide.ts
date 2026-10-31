// OCV5-591 A2-1a — the orchestrator's decisions as a pure function: given the project's state,
// what should be dispatched or which status should it move to. advanceProject() applies the result
// inside one transaction under the project's advisory lock; this file has no IO and is unit tested
// on every path of the state machine (plan §2).

import type { MediaOp } from '../providers/types.js'
import { pausesProvider } from './providerFailure.js'

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
  errorCode?: string | null
  providerFailureAcknowledged?: boolean
  /** OCV5-591 A2-1b-1: the take's QA outcome (null: not judged yet). */
  qa?: DQa | null
}

export interface DQa {
  passed: boolean
  /** QA was not run for this take (switched off / no sandbox); it counts as usable. */
  skipped: boolean
  next: 'adopt' | 'redo' | 'handoff' | null
  score: number | null
  /** What a redo should avoid (the judge's issues). */
  avoid: string[]
}

export interface DShot {
  id: string
  ordinal: number
  status: 'planned' | 'generating' | 'qa' | 'needs_user' | 'ready' | 'failed'
  activeTakeId: string | null
  /** The frame the user picked as the video's start (spec.frameTakeId). */
  frameTakeId: string | null
  /** A2-1b-2: redone from an annotation — frames / videos older than these versions do not count. */
  redo?: { frame: number; video: number }
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
  /** OCV5-591 A2-1c: the compose sandbox is configured. */
  canCompose: boolean
  /** A compose task of this project is queued or leased. */
  composeQueued: boolean
  /** OCV5-591 A2-1b-1: which owner kinds are QA'd before use (absent: none). */
  qa?: { bible: boolean; shot_frame: boolean; shot_video: boolean }
  /** Bible candidates per round (OC_STUDIO_BIBLE_CANDIDATES; default 1). */
  bibleCandidates?: number
  /** Takes with a queued / leased QA task. */
  qaQueued?: string[]
}

export interface Dispatch {
  ownerKind: DTake['ownerKind']
  ownerId: string
  op: MediaOp
  /** Provider ids that already failed for this owner (excluded from the next candidate list). */
  exclude: string[]
  /** Blob inputs, e.g. the bible images for a frame or the first frame for a video. */
  inputs: Array<{ role: 'reference' | 'first_frame'; blobSha: string }>
  /** A redo after QA: what the new version should avoid (A2-1b-1). */
  avoid?: string[]
}

export type Action =
  | { type: 'enqueue_plan' }
  | { type: 'dispatch'; dispatch: Dispatch }
  | { type: 'set_status'; status: ProjectStatus; reason?: string; providerCode?: string }
  | { type: 'shot_status'; shotId: string; status: DShot['status'] }
  /** A finished video nobody adopted (the executor declined: the shot had moved on meanwhile). */
  | { type: 'adopt_video'; shotId: string; takeId: string }
  | { type: 'line_status'; lineId: string; status: DLine['status'] }
  | { type: 'note_music_skipped' }
  /** Everything is ready: the director composes the film (A2-1c). */
  | { type: 'enqueue_compose' }
  /** A finished take is judged before it is used (A2-1b-1). */
  | { type: 'dispatch_qa'; takeId: string; ownerKind: DTake['ownerKind']; ownerId: string }
  /** A bible image passed QA but is not locked yet (runQa normally locks it itself). */
  | { type: 'lock_bible'; assetId: string; takeId: string }

const BIBLE_KINDS = new Set(['character', 'scene', 'style'])

function ownerTakes(s: DState, kind: DTake['ownerKind'], ownerId: string): DTake[] {
  return s.takes.filter((t) => t.ownerKind === kind && t.ownerId === ownerId)
}

const live = (t: DTake) => t.status === 'queued' || t.status === 'running'
const ok = (t: DTake) => t.status === 'succeeded' && t.blobSha !== null
const failedProviders = (ts: DTake[]) => [
  ...new Set(ts.filter((t) => t.status === 'failed' && !pausesProvider(t.errorCode)).map((t) => t.provider)),
]

/** A shot is done only when its adopted take is a succeeded video (plan r1 P1-3). */
/** QA gates this owner kind. */
function qaOn(s: DState, kind: DTake['ownerKind']): boolean {
  return (
    (kind === 'bible' || kind === 'shot_frame' || kind === 'shot_video') && s.qa?.[kind] === true
  )
}

/** Usable: finished and, where QA gates it, passed (or QA was not run for it). */
export function accepted(s: DState, t: DTake): boolean {
  if (!ok(t)) return false
  if (!qaOn(s, t.ownerKind)) return true
  return t.qa?.passed === true || t.qa?.skipped === true
}

/** Finished, gated, and not judged yet. */
function awaitingQa(s: DState, t: DTake): boolean {
  return ok(t) && qaOn(s, t.ownerKind) && !t.qa
}

/** The newest judged take of an owner, if it was handed to the user and nothing came after it. */
function latestJudged(ts: DTake[]): DTake | undefined {
  const newest = [...ts].sort((a, b) => b.version - a.version)[0]
  return newest?.qa && !newest.qa.skipped ? newest : undefined
}

export function shotDone(s: DState, shot: DShot): boolean {
  if (shot.status !== 'ready' || !shot.activeTakeId) return false
  const t = s.takes.find((x) => x.id === shot.activeTakeId)
  return !!t && t.ownerKind === 'shot_video' && ok(t)
}

export function decide(s: DState): Action[] {
  if (s.status === 'planning') return s.hasPlanTask ? [] : [{ type: 'enqueue_plan' }]
  // A2-1c: composing without its task (e.g. it ended while the project was paused) re-queues one.
  if (s.status === 'composing')
    return s.canCompose && !s.composeQueued && s.inflight === 0 ? [{ type: 'enqueue_compose' }] : []
  if (s.status !== 'running') return []

  // Preflight every relevant owner before dispatching any new work. Failed services do not
  // consume a quality regeneration or silently trigger another provider (and another charge).
  const pendingFailure = (ts: DTake[]) => {
    if (ts.some(live) || ts.some((t) => accepted(s, t))) return undefined
    const last = [...ts].sort((a, b) => b.version - a.version)[0]
    return last?.status === 'failed' && !last.providerFailureAcknowledged && pausesProvider(last.errorCode)
      ? last : undefined
  }
  let failure: DTake | undefined
  for (const asset of s.assets) {
    if (BIBLE_KINDS.has(asset.kind) && !(asset.locked && asset.blobSha))
      failure ??= pendingFailure(ownerTakes(s, 'bible', asset.id))
  }
  for (const shot of s.shots) {
    if (shotDone(s, shot) || shot.status === 'needs_user' || shot.status === 'failed') continue
    const frames = ownerTakes(s, 'shot_frame', shot.id).filter((t) => t.version >= (shot.redo?.frame ?? 0) || t.id === shot.frameTakeId)
    const picked = frames.some((t) => t.id === shot.frameTakeId && ok(t))
    if (!picked) failure ??= pendingFailure(frames)
    failure ??= pendingFailure(ownerTakes(s, 'shot_video', shot.id).filter((t) => t.version >= (shot.redo?.video ?? 0)))
  }
  for (const line of s.lines) {
    if (line.status !== 'ready' && line.status !== 'needs_user' && line.status !== 'failed')
      failure ??= pendingFailure(ownerTakes(s, 'line', line.id))
  }
  if (failure) return [{ type: 'set_status', status: 'awaiting_user', reason: 'provider_failure', providerCode: failure.errorCode! }]

  const actions: Action[] = []
  let budget = Math.max(0, MAX_INFLIGHT_PER_PROJECT - s.inflight)
  const dispatch = (d: Dispatch) => {
    if (budget <= 0) return false
    budget -= 1
    actions.push({ type: 'dispatch', dispatch: d })
    return true
  }
  let blocked = false // something can never finish without the user
  const adopted = new Set<string>()
  const queuedQa = new Set(s.qaQueued ?? [])
  /** Judge a finished take (counts against the in-flight budget like a generation). */
  const judge = (t: DTake) => {
    if (queuedQa.has(t.id)) return true
    if (budget <= 0) return false
    budget -= 1
    queuedQa.add(t.id)
    actions.push({ type: 'dispatch_qa', takeId: t.id, ownerKind: t.ownerKind, ownerId: t.ownerId })
    return true
  }
  const avoidOf = (ts: DTake[]) => {
    const last = latestJudged(ts)
    return last?.qa?.next === 'redo' && last.qa.avoid.length ? { avoid: last.qa.avoid } : {}
  }

  // 1) bible: every character / scene / style asset gets one locked image.
  const bible = s.assets.filter((a) => BIBLE_KINDS.has(a.kind))
  for (const a of bible) {
    if (a.locked && a.blobSha) continue
    const ts = ownerTakes(s, 'bible', a.id)
    if (ts.some(live)) continue
    // A2-1b-1: every candidate is judged first; the best passing one is locked.
    const waiting = ts.filter((t) => awaitingQa(s, t))
    if (waiting.length) {
      for (const t of waiting) judge(t)
      continue
    }
    if (qaOn(s, 'bible')) {
      const best = ts
        .filter((t) => accepted(s, t))
        .sort((x, y) => (y.qa?.score ?? 0) - (x.qa?.score ?? 0) || y.version - x.version)[0]
      if (best) {
        actions.push({ type: 'lock_bible', assetId: a.id, takeId: best.id })
        continue
      }
      if (latestJudged(ts)?.qa?.next === 'handoff') {
        blocked = true
        continue
      }
    }
    if (!s.canDispatch.image) {
      blocked = true
      continue
    }
    const n = qaOn(s, 'bible') ? Math.max(1, Math.min(2, s.bibleCandidates ?? 1)) : 1
    for (let i = 0; i < n; i++) {
      dispatch({
        ownerKind: 'bible',
        ownerId: a.id,
        op: 'image.generate',
        exclude: failedProviders(ts),
        inputs: [],
        ...avoidOf(ts),
      })
    }
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
    // A2-1b-2: after an annotation's redo only the versions made for it count.
    const frames = ownerTakes(s, 'shot_frame', shot.id).filter(
      (t) => t.version >= (shot.redo?.frame ?? 0) || t.id === shot.frameTakeId,
    )
    const videos = ownerTakes(s, 'shot_video', shot.id).filter(
      (t) => t.version >= (shot.redo?.video ?? 0),
    )
    if (frames.some(live) || videos.some(live)) continue
    // A2-1b-1: a finished frame / video is judged before anything is built on it.
    // The user's picked frame is theirs: never judged (code r1 P1).
    const waiting = [...frames, ...videos].filter(
      (t) => awaitingQa(s, t) && t.id !== shot.frameTakeId,
    )
    if (waiting.length) {
      if (waiting.map(judge).some(Boolean) && shot.status !== 'qa')
        actions.push({ type: 'shot_status', shotId: shot.id, status: 'qa' })
      continue
    }
    // The user's pick is theirs: it skips QA (plan §1.1).
    const picked = shot.frameTakeId
      ? frames.find((t) => t.id === shot.frameTakeId && ok(t))
      : undefined
    const frame =
      picked ?? [...frames].filter((t) => accepted(s, t)).sort((a, b) => b.version - a.version)[0]
    if (!frame) {
      if (!bibleReady) continue
      if (latestJudged(frames)?.qa?.next === 'handoff') {
        blocked = true
        continue
      }
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
          ...avoidOf(frames),
        })
      ) {
        if (shot.status !== 'generating')
          actions.push({ type: 'shot_status', shotId: shot.id, status: 'generating' })
      }
      continue
    }
    // No frame picked and a finished video exists → adopt the newest one (the executor adopts
    // only into the state it was dispatched for). A picked frame always gets its own video.
    const usable = [...videos]
      .filter((t) => accepted(s, t))
      .sort((a, b) => b.version - a.version)[0]
    if (usable && !shot.frameTakeId) {
      actions.push({ type: 'adopt_video', shotId: shot.id, takeId: usable.id })
      adopted.add(shot.id)
      continue
    }
    if (!s.canDispatch.video) {
      blocked = true
      continue
    }
    if (!shot.frameTakeId && latestJudged(videos)?.qa?.next === 'handoff') {
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
        ...avoidOf(videos),
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

  const dispatched = actions.some((a) => a.type === 'dispatch' || a.type === 'dispatch_qa')
  const allShots =
    s.shots.length > 0 && s.shots.every((sh) => shotDone(s, sh) || adopted.has(sh.id))
  const allLines = s.lines.every((l) => l.status === 'ready' && l.activeTakeId)
  if (allShots && allLines && s.inflight === 0 && !dispatched) {
    // A2-1c: the director composes the film itself; without a sandbox the project waits.
    if (!s.canCompose) {
      actions.push({ type: 'set_status', status: 'awaiting_user', reason: 'compose_pending' })
    } else {
      if (!s.composeQueued) actions.push({ type: 'enqueue_compose' })
      actions.push({ type: 'set_status', status: 'composing' })
    }
  } else if (blocked && s.inflight === 0 && !dispatched) {
    actions.push({ type: 'set_status', status: 'awaiting_user', reason: 'needs_user' })
  }
  return actions
}
