/**
 * Host-boundary ports for OCV5 project-layer migrate.
 * PG reads/writes go through `host python3 …/ocv5-project-layer-live-read.py`.
 * Container never receives DATABASE_URL. Apply is gated by OPENCLAUDE_PROJECT_LAYER_APPLY.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  commitProjectSkillOverlay,
  loadProjectContext,
  projectContextDir,
  type ApplyPorts,
  type LiveChatProject,
  type LiveSessionSnapshot,
  type ProjectLayerLivePorts,
} from '@openclaude/storage'

const USAGE_ROW_ID_RE = /^\d{1,20}$/

export function parseUsageRowId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return String(raw)
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return USAGE_ROW_ID_RE.test(s) ? s : null
}

export function resolveLiveReadScript(explicit?: string): string {
  if (explicit && existsSync(explicit)) return explicit
  if (process.env.OC_OCV5_LIVE_READ_SCRIPT && existsSync(process.env.OC_OCV5_LIVE_READ_SCRIPT)) {
    return process.env.OC_OCV5_LIVE_READ_SCRIPT
  }
  const here = fileURLToPath(new URL('.', import.meta.url))
  const candidates = [
    join(here, '../scripts/ocv5-project-layer-live-read.py'),
    join(process.cwd(), 'packages/commercial/scripts/ocv5-project-layer-live-read.py'),
    '/opt/openclaude/openclaude-v5-selfhost/packages/commercial/scripts/ocv5-project-layer-live-read.py',
  ]
  const hit = candidates.find((p) => existsSync(p))
  if (hit) return hit
  throw new Error('live_read_script_missing')
}

export type LiveSnapshot = {
  generatedAt: string
  readonly: boolean
  usageBoardColumn: boolean
  sessions: LiveSessionSnapshot[]
  chatProjects: LiveChatProject[]
  usage: Array<{
    id: string
    sessionId: string | null
    parentSessionId: string | null
    boardProjectId: string | null
    source: string | null
    status?: string
  }>
  assets: Array<{
    id: string
    name: string
    sessionId: string | null
    containerPath: string | null
    digest: string | null
    projectId: string | null
    pinned?: boolean
    deletedAt?: number | null
    source?: string
  }>
  cron: Array<{
    id: string
    projectMode?: string
    boardProjectId?: string | null
    sourceSessionKey?: string
  }>
  board: { id: string; key: string; archivedAt: number | null; contextVersion: number } | null
  projectContext: {
    path: string
    exists: boolean
    contextVersion: number
    skillNames: string[]
    uid: number | null
    gid: number | null
    mode: number | null
    candidateFiles: string[]
  }
  applyModesWired?: string[]
}

export function hostBin(): string {
  return process.env.OC_HOST_BIN || '/home/agent/.local/bin/host'
}

export function runHost(args: string[], stdin: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(hostBin(), args, { stdio: ['pipe', 'pipe', 'pipe'] })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const t = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('host_timeout'))
    }, timeoutMs)
    child.stdout.on('data', (c) => out.push(c as Buffer))
    child.stderr.on('data', (c) => err.push(c as Buffer))
    child.on('error', (e) => {
      clearTimeout(t)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(t)
      const stdout = Buffer.concat(out).toString('utf8')
      const stderr = Buffer.concat(err).toString('utf8')
      if (code !== 0) {
        reject(new Error(`host_exit_${code}: ${stderr || stdout}`))
        return
      }
      resolve(stdout)
    })
    child.stdin.end(stdin)
  })
}

export async function fetchLiveSnapshot(opts: {
  sessionIds: string[]
  boardProjectId: string
  scriptPath?: string
}): Promise<LiveSnapshot> {
  const script = resolveLiveReadScript(opts.scriptPath)
  const raw = await runHost(
    ['python3', script, '--board', opts.boardProjectId, '--ids-json', '-', '--mode', 'snapshot'],
    JSON.stringify({ sessionIds: opts.sessionIds }),
  )
  const snap = JSON.parse(raw) as LiveSnapshot
  if (!Array.isArray(snap.sessions) || !Array.isArray(snap.usage)) {
    throw new Error('live_snapshot_invalid')
  }
  return snap
}

export function portsFromSnapshot(snap: LiveSnapshot): ProjectLayerLivePorts {
  const byId = new Map(snap.sessions.map((s) => [s.id, s]))
  return {
    async getBoardProject(id) {
      if (snap.board && snap.board.id === id) return snap.board
      return null
    },
    async listChatProjects() {
      return snap.chatProjects ?? []
    },
    async getSession(id) {
      return byId.get(id) ?? null
    },
    async getProjectContextVersion() {
      return snap.projectContext?.contextVersion ?? snap.board?.contextVersion ?? 0
    },
    async listNullUsage() {
      return (snap.usage ?? []).map((u) => ({
        id: u.id,
        sessionId: u.sessionId,
        parentSessionId: u.parentSessionId,
        boardProjectId: u.boardProjectId ?? null,
        source: u.source ?? null,
      }))
    },
    async listCronJobs() {
      return snap.cron ?? []
    },
  }
}

export function applyArmed(): boolean {
  return process.env.OPENCLAUDE_PROJECT_LAYER_APPLY === '1'
}

async function hostApply(mode: string, payload: unknown): Promise<unknown> {
  if (!applyArmed()) throw new Error('apply_disabled')
  const raw = await runHost(
    ['python3', resolveLiveReadScript(), '--mode', mode, '--ids-json', '-'],
    JSON.stringify(payload),
  )
  return JSON.parse(raw)
}

export function makeApplyPorts(opts: { boardProjectId: string; snapshot: LiveSnapshot }): ApplyPorts {
  const live = portsFromSnapshot(opts.snapshot)
  return {
    ...live,
    async createChatProject(name) {
      const got = (await hostApply('apply-create-facade', { name })) as { id: string }
      return { id: got.id }
    },
    async bindChatProject(id, boardProjectId) {
      await hostApply('apply-bind-facade', { chatId: id, boardProjectId })
    },
    async ensureProjectContext(boardProjectId) {
      if (!applyArmed()) throw new Error('apply_disabled')
      await mkdir(projectContextDir(boardProjectId), { recursive: true, mode: 0o750 })
      await loadProjectContext(boardProjectId)
    },
    async batchMoveSessions(input) {
      return (await hostApply('apply-move-sessions', input)) as
        | { ok: true; updated: number }
        | { ok: false; error: string; staleIds?: string[] }
    },
    async createMemoryCandidate(input) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const base = process.env.OC_GATEWAY_BASE_URL
      if (!base) throw new Error('memory_api_base_missing')
      const res = await fetch(
        `${base.replace(/\/+$/, '')}/api/board/projects/${encodeURIComponent(opts.boardProjectId)}/memories`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env.OC_GATEWAY_TOKEN || ''}`,
          },
          body: JSON.stringify({ slug: input.slug, content: input.content }),
        },
      )
      if (!res.ok) throw new Error(`memory_api_${res.status}`)
      const body = (await res.json()) as { candidate?: { id?: string; version?: number } }
      if (!body.candidate?.id) throw new Error('memory_api_no_id')
    },
    async putSkillOverlay(names, expectedVersion) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const written = await commitProjectSkillOverlay(opts.boardProjectId, names, expectedVersion, {
        actor: 'user:c:3',
      })
      if (!written.ok) throw new Error(`skill_overlay_failed:${written.error}`)
    },
    async createAsset(input) {
      const got = (await hostApply('apply-create-asset', input)) as { id: string }
      return { id: got.id, created: true }
    },
    async deleteAsset(id) {
      await hostApply('apply-delete-asset', { id })
    },
    async repairOwnership(boardProjectId, uid, gid) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const containerDir = `/home/agent/.openclaude/projects/${boardProjectId}`
      const volumeDir = `/var/lib/docker/volumes/oc-v5-data-u3/_data/projects/${boardProjectId}`
      await runHost(['mkdir', '-p', volumeDir], '')
      await runHost(['chown', '-R', `${uid}:${gid}`, volumeDir], '')
      await runHost(['chmod', '0750', volumeDir], '')
      await runHost(
        ['docker', 'exec', '-u', String(uid), 'oc-v5-u3', 'test', '-r', containerDir],
        '',
      )
    },
    async backfillUsage(input) {
      const got = (await hostApply('apply-usage-backfill', input)) as {
        rows: Array<{ id: string; oldBoardProjectId: string | null }>
      }
      return got.rows ?? []
    },
    async restoreUsage(rows) {
      const got = (await hostApply('apply-usage-restore', {
        rows,
        boardProjectId: opts.boardProjectId,
      })) as { restored: number }
      return got.restored ?? 0
    },
  }
}

export function writeManifestPath(operationId: string, home = process.env.OPENCLAUDE_HOME || ''): string {
  const base = process.env.OPENCLAUDE_GENERATED_DIR || join(home || '/home/agent/.openclaude', 'generated')
  return join(base, 'ocv5-mig-manifests', `${operationId}.json`)
}
