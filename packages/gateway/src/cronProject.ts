/**
 * Cron job project semantics: follow_session (default) vs fixed snapshot.
 * Missing fields on disk = follow_session. Fire fail-closes on missing/archived fixed targets.
 */
import { BOARD_PROJECT_ID_RE } from '@openclaude/storage'
import type { CronJob } from './cron.js'

export type CronProjectMode = 'follow_session' | 'fixed'

export type CronProjectResolution =
  | { ok: true; boardProjectId: string | null; mode: CronProjectMode; source: string }
  | { ok: false; mode: CronProjectMode; reason: string }

export function normalizeCronProject(job: Pick<CronJob, 'projectMode' | 'boardProjectId'>): {
  projectMode: CronProjectMode
  boardProjectId: string | null
} {
  const mode = job.projectMode === 'fixed' ? 'fixed' : 'follow_session'
  if (mode !== 'fixed') return { projectMode: 'follow_session', boardProjectId: null }
  const id = typeof job.boardProjectId === 'string' ? job.boardProjectId.trim() : ''
  return { projectMode: 'fixed', boardProjectId: BOARD_PROJECT_ID_RE.test(id) ? id : null }
}

export type CronProjectPorts = {
  getBoardProject(id: string): Promise<{ id: string; archivedAt: number | null } | null>
  getSessionBoardProject(sessionId: string): Promise<string | null>
}

export function originSessionIdFromKey(sourceSessionKey: string | undefined): string | null {
  if (!sourceSessionKey) return null
  const m = /:webchat:dm:([A-Za-z0-9_-]{1,64})$/.exec(sourceSessionKey)
  return m ? m[1] : null
}

export async function resolveCronFireProject(
  job: CronJob,
  ports: CronProjectPorts,
): Promise<CronProjectResolution> {
  const norm = normalizeCronProject(job)
  if (norm.projectMode === 'fixed') {
    if (!norm.boardProjectId) {
      return { ok: false, mode: 'fixed', reason: 'fixed_project_missing' }
    }
    const board = await ports.getBoardProject(norm.boardProjectId)
    if (!board) return { ok: false, mode: 'fixed', reason: 'fixed_project_missing' }
    if (board.archivedAt) return { ok: false, mode: 'fixed', reason: 'fixed_project_archived' }
    return { ok: true, boardProjectId: board.id, mode: 'fixed', source: 'job_fixed' }
  }
  const originId = originSessionIdFromKey(job.sourceSessionKey)
  if (!originId) {
    return { ok: true, boardProjectId: null, mode: 'follow_session', source: 'follow_no_origin' }
  }
  const live = await ports.getSessionBoardProject(originId)
  return {
    ok: true,
    boardProjectId: live,
    mode: 'follow_session',
    source: 'follow_session',
  }
}

export async function filterCronJobsForBoard(
  jobs: CronJob[],
  boardProjectId: string,
  ports: CronProjectPorts,
): Promise<CronJob[]> {
  const wantNone = boardProjectId === 'none'
  const want = wantNone ? null : boardProjectId.trim().toLowerCase()
  const out: CronJob[] = []
  for (const job of jobs) {
    const resolved = await resolveCronFireProject(job, ports)
    if (!resolved.ok) continue
    const got = resolved.boardProjectId ? resolved.boardProjectId.toLowerCase() : null
    if (wantNone ? got === null : got === want) out.push(job)
  }
  return out
}

export async function deriveFixedBoardProjectId(
  ports: CronProjectPorts,
  candidate: string | null | undefined,
): Promise<string | null> {
  const id = typeof candidate === 'string' ? candidate.trim() : ''
  if (!BOARD_PROJECT_ID_RE.test(id)) return null
  const board = await ports.getBoardProject(id)
  if (!board || board.archivedAt) return null
  return board.id
}
