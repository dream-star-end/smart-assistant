/**
 * Session resume-map lookup and durable-artifact fallback ladder.
 *
 * Extracted from `sessionSubmit.ts` (`_resumeIdFor` / `_resolveDurableResumeId`)
 * with `remote-driver-v4` (`remotev4:`) bound-resume guards alongside `cc5:`.
 */
import { isCc5ResumeId } from './engine/cc5ResumeId.js'
import {
  cursorResumeStoreExists,
  cursorSandBoxCcResumeInnerId,
  cursorSandOfficialCcResumeInnerId,
  cursorSandResumeInnerId,
  isAnyCursorSandResumeId,
  isCursorSandBoxCcResumeId,
  relocateCursorResumeStore,
} from './engine/cursorAdapter.js'
import { pickResumableId, probeResumeArtifact } from './engine/resumeArtifacts.js'
import { isRemoteV4ResumeId } from './remotePool/resumeId.js'
import { CCB_PROVIDER_TAG, normalizeEngineTag } from './resumeStore.js'
import { log } from './sessionManagerLog.js'
import type { SessionSubmitHost } from './sessionSubmit.js'

/** Return the resumable id for this session iff the persisted entry was
 *  produced by `wantProvider`. Cross-provider mismatches return undefined
 *  so we never feed a CCB session_id to codex (or vice versa).
 *
 *  Durable-artifact gate (all engines): the head id must have a transcript
 *  on disk (CCB / Cursor Sand JSONL, Codex rollout, Grok session dir, native
 *  Cursor store.db at the spawn cwd). When it does not — the CLI emitted
 *  `session_id` and died before writing, or the container was rebuilt
 *  mid-spawn — walk the per-session history ladder and promote the newest
 *  prior id whose artifact exists, instead of dropping straight to lossy
 *  history replay. Only when nothing on the ladder is resumable is the
 *  entry dropped (UI history stays visible in the DB; the engine simply has
 *  no native memory — unavoidable when every transcript is gone).
 *
 *  Native Cursor keeps its special case: a store.db missing at *this* cwd is
 *  first a hash-relocation problem, not staleness. */
export function _resumeIdFor(
  this: SessionSubmitHost,
  sessionKey: string,
  wantProvider: string,
  workspacePath?: string,
): string | undefined {
  const id = this._resumeMap.get(sessionKey)
  if (!id) return undefined
  if (isCc5ResumeId(id) || isRemoteV4ResumeId(id)) return undefined
  let tag = normalizeEngineTag(this._resumeMapProvider.get(sessionKey))
  // A false "no transcript" drop used to delete the provider and let the
  // live-session overlay save the same id back as implicit ccb. The Fast
  // transcript is still on disk; a positive Grok artifact puts the tag back.
  // An unknown probe has no path and must not retag a real ccb id.
  if (tag !== wantProvider && wantProvider === 'grok' && tag === CCB_PROVIDER_TAG) {
    const recovered = probeResumeArtifact('grok', id)
    if (recovered.exists && recovered.path) {
      this._resumeMapProvider.set(sessionKey, 'grok')
      tag = 'grok'
      this._saveResumeMap()
    }
  }
  if (tag !== wantProvider) return undefined

  if (tag === 'codex' && this.sessions.get(sessionKey)?.runner.executionBackend?.kind === 'codex-app-server-v1') {
    // The rollout lives on the remote node; the relay only resumes the thread its lane bound.
    return id
  }

  if (tag === 'cursor' && isCursorSandBoxCcResumeId(id)) {
    if (!cursorSandBoxCcResumeInnerId(id)) {
      log.warn('resume-map Cursor box Claude entry is malformed — dropping silently', {
        sessionKey,
        resumeId: id,
      })
      this._forgetResumeEntry(sessionKey)
      this._saveResumeMap()
      return undefined
    }
    // The JSONL is on the account box, not in this container.
    return id
  }

  if (tag === 'cursor' && isAnyCursorSandResumeId(id)) {
    const sandJsonlId = cursorSandResumeInnerId(id) ?? cursorSandOfficialCcResumeInnerId(id)
    if (!sandJsonlId) {
      log.warn('resume-map Cursor Sand entry is malformed — dropping silently', {
        sessionKey,
        resumeId: id,
      })
      this._forgetResumeEntry(sessionKey)
      this._saveResumeMap()
      return undefined
    }
    if (this._ccbJsonlExists(sandJsonlId)) return id
    const promoted = this._resolveDurableResumeId(sessionKey, tag, undefined, workspacePath)
    if (promoted) return promoted
    log.warn('resume-map Cursor Sand entry points to missing JSONL — dropping silently', {
      sessionKey,
      resumeId: id,
    })
    this._forgetResumeEntry(sessionKey)
    this._saveResumeMap()
    return undefined
  }

  if (tag === 'cursor') {
    if (!workspacePath) return id
    if (cursorResumeStoreExists(workspacePath, id)) return id
    // Do not drop the map: spawn cwd is the resume authority, and a
    // recomputed overlay can hash to a different chats/ dir than the live
    // CLI. Deleting here forces historical replay on the next follow-up
    // even when store.db is still on disk.
    // isolated_v1 次轮绑项目会改 spawn cwd → md5 目录对不上。旧 store 还在
    // 时迁到当前哈希再 --resume;失败才走 history 梯子;再失败才跳过 lookup。
    const relocated = relocateCursorResumeStore({
      resumeId: id,
      currentWorkspacePath: workspacePath,
      sessionKey,
    })
    if (relocated) {
      log.info('relocated Cursor resume store to current workspace', {
        sessionKey,
        resumeId: id,
        relocated: relocated.relocated,
      })
      return id
    }
    const promoted = this._resolveDurableResumeId(sessionKey, tag, undefined, workspacePath)
    if (promoted) return promoted
    log.warn('resume-map Cursor store not at this workspace — keeping map, skipping this lookup', {
      sessionKey,
      resumeId: id,
    })
    return undefined
  }

  // CCB / codex / grok / zcode: single durable-artifact gate + history ladder.
  const resolved = this._resolveDurableResumeId(sessionKey, tag, id, workspacePath)
  if (resolved) return resolved
  log.warn('resume-map entry has no durable transcript on disk — dropping silently', {
    sessionKey,
    provider: tag,
    resumeId: id,
  })
  if (tag === 'grok') this._releaseGrokResumeHead(sessionKey)
  this._forgetResumeEntry(sessionKey)
  this._saveResumeMap()
  return undefined
}

/**
 * Engine-agnostic durable-artifact fallback. When the mapped head id has no
 * durable transcript on disk, walk the per-session history ladder and promote
 * the newest id that positively exists. Returns the id to resume with, or
 * undefined when nothing on the ladder is resumable (caller then falls back
 * to history replay exactly as before).
 *
 * Head ids whose artifact is *unknown* (engine we cannot probe, unreadable fs)
 * are returned as-is — conservative, same as `_ccbJsonlExists`.
 */
export function _resolveDurableResumeId(
  this: SessionSubmitHost,
  sessionKey: string,
  provider: string,
  head: string | undefined,
  workspacePath?: string,
  opts?: {
    /** Id the engine just rejected at runtime — never re-pick it even if its
     *  artifact looks present (non-empty file ≠ resumable conversation). */
    exclude?: string
    /** Default true: steer the live adapter via setResumeSessionId. Pass
     *  false when the caller IS the engine (codex resolveResumeFallback runs
     *  inside the kernel's own attach path and sets threadId itself). */
    syncRunner?: boolean
  },
): string | undefined {
  const exclude = opts?.exclude
  const rejected = this._resumeRejectedIds.get(sessionKey)
  const history = (this._resumeMapHistory.get(sessionKey) ?? []).filter(
    (h) => h !== exclude && h !== head && !rejected?.has(h),
  )
  const headCandidate = head && head !== exclude && !rejected?.has(head) ? head : undefined
  const picked = pickResumableId(provider, headCandidate, history, {
    workspacePath,
  })
  if (!picked) return undefined
  if (picked.fromHistory) {
    log.warn('resume-map head has no durable transcript — promoting prior id from history', {
      sessionKey,
      provider,
      staleId: head ?? exclude ?? null,
      promotedId: picked.id,
      artifact: picked.probe.path,
    })
    // Promote in place: the dead head is dropped (not kept in history — it
    // has nothing to resume), the promoted id becomes head, remaining
    // history keeps only ids older than the promoted one.
    const idx = history.indexOf(picked.id)
    this._resumeMap.set(sessionKey, picked.id)
    this._resumeHeadPromotedFromHistory.set(sessionKey, picked.id)
    this._resumeMapProvider.set(sessionKey, provider)
    this._resumeMapHistory.set(sessionKey, history.slice(idx + 1))
    // Sync the live session BEFORE saving: _saveResumeMap overlays live
    // sessions onto the map, so an unsynced session.ccbSessionId would write
    // the dead head straight back (review B2). The runner must follow too,
    // otherwise the next spawn still --resumes the dead id.
    const live = this.sessions.get(sessionKey)
    if (live && live.providerTag === provider) {
      live.ccbSessionId = picked.id
      if (opts?.syncRunner !== false) live.runner.setResumeSessionId?.(picked.id)
    }
    this._saveResumeMap()
  }
  return picked.id
}
