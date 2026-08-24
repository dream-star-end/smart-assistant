/**
 * Host-boundary ports for OCV5 project-layer migrate.
 * PG reads/writes go through a resolved-once live-read script handle.
 * Official default host path is the deployed canonical copy; worktree/test
 * must pass an explicit override. hostApply never re-resolves.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ProjectMemoryLedger,
  commitProjectSkillOverlay,
  loadProjectContext,
  paths,
  projectContextDir,
  readMemoryContent as readAllowlistedMemoryContent,
  type ApplyPorts,
  type LiveChatProject,
  type LiveSessionSnapshot,
  type ProjectLayerInventory,
  type ProjectLayerLivePorts,
} from '@openclaude/storage'

const USAGE_ROW_ID_RE = /^\d{1,20}$/

export const CANONICAL_HOST_LIVE_READ_SCRIPT =
  '/opt/openclaude/openclaude-v5-selfhost/packages/commercial/scripts/ocv5-project-layer-live-read.py'

export const CANONICAL_CONTAINER_HOME = '/home/agent/.openclaude'
export const UID3_VOLUME_DATA = '/var/lib/docker/volumes/oc-v5-data-u3/_data'
export const UID3_CONTAINER = 'oc-v5-u3'

export type LiveReadScriptKind = 'host' | 'container'

export type LiveReadHandle = {
  kind: LiveReadScriptKind
  path: string
  sha256: string
}

export function parseUsageRowId(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return String(raw)
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  return USAGE_ROW_ID_RE.test(s) ? s : null
}

export function containerToHostPath(containerPath: string): string {
  if (containerPath.startsWith(UID3_VOLUME_DATA)) return containerPath
  if (containerPath.startsWith(CANONICAL_CONTAINER_HOME)) {
    return UID3_VOLUME_DATA + containerPath.slice(CANONICAL_CONTAINER_HOME.length)
  }
  throw new Error('path_not_in_allow_roots')
}

export function hostToContainerPath(hostPath: string): string {
  if (hostPath.startsWith(CANONICAL_CONTAINER_HOME)) return hostPath
  if (hostPath.startsWith(UID3_VOLUME_DATA)) {
    return CANONICAL_CONTAINER_HOME + hostPath.slice(UID3_VOLUME_DATA.length)
  }
  throw new Error('path_not_in_allow_roots')
}

function sha256FileSync(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Official default is the deployed canonical host path only.
 * Test/worktree copies must pass `explicit` or OC_OCV5_LIVE_READ_SCRIPT.
 */
export function resolveLiveReadScript(explicit?: string): string {
  const path =
    (explicit && explicit.trim()) ||
    process.env.OC_OCV5_LIVE_READ_SCRIPT?.trim() ||
    CANONICAL_HOST_LIVE_READ_SCRIPT
  if (!existsSync(path)) throw new Error(`live_read_script_missing:${path}`)
  return path
}

export function openLiveReadHandle(opts?: {
  explicit?: string
  kind?: LiveReadScriptKind
}): LiveReadHandle {
  const path = resolveLiveReadScript(opts?.explicit)
  return {
    kind: opts?.kind ?? 'host',
    path,
    sha256: sha256FileSync(path),
  }
}

export function assertCanonicalReadyForApply(handle: LiveReadHandle): void {
  const allow = process.env.OC_OCV5_LIVE_READ_ALLOW_OVERRIDE === '1'
  if (handle.path !== CANONICAL_HOST_LIVE_READ_SCRIPT && !allow) {
    throw new Error('apply_requires_canonical_script')
  }
  if (!existsSync(handle.path)) throw new Error(`live_read_script_missing:${handle.path}`)
  const live = sha256FileSync(handle.path)
  if (live !== handle.sha256) throw new Error('live_read_script_hash_mismatch')
  if (handle.path === CANONICAL_HOST_LIVE_READ_SCRIPT) return
  if (!allow) throw new Error('apply_requires_canonical_script')
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

/** Coordinator runs in the uid3 container; host python must see the host path. */
export function liveReadScriptPathForHost(path: string): string {
  try {
    return containerToHostPath(path)
  } catch {
    return path
  }
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
  script: LiveReadHandle
}): Promise<LiveSnapshot> {
  const raw = await runHost(
    [
      'python3',
      liveReadScriptPathForHost(opts.script.path),
      '--board',
      opts.boardProjectId,
      '--ids-json',
      '-',
      '--mode',
      'snapshot',
    ],
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

function projectLayerApiBase(): string {
  const base = process.env.OC_PROJECT_LAYER_API_BASE || process.env.OC_GATEWAY_BASE_URL || ''
  if (!base) throw new Error('project_layer_api_base_missing')
  return base.replace(/\/+$/, '')
}

function projectLayerApiToken(): string {
  return process.env.OC_PROJECT_LAYER_API_TOKEN || process.env.OC_GATEWAY_TOKEN || ''
}

async function hostApply(
  script: LiveReadHandle,
  mode: string,
  payload: unknown,
): Promise<unknown> {
  if (!applyArmed()) throw new Error('apply_disabled')
  const raw = await runHost(
    ['python3', liveReadScriptPathForHost(script.path), '--mode', mode, '--ids-json', '-'],
    JSON.stringify(payload),
  )
  return JSON.parse(raw)
}

async function sha256HostFile(containerPath: string): Promise<string> {
  const hostPath = containerToHostPath(containerPath)
  try {
    const buf = await readFile(hostPath)
    return createHash('sha256').update(buf).digest('hex')
  } catch {
    const out = await runHost(['sha256sum', hostPath], '')
    const hex = out.trim().split(/\s+/)[0]
    if (!hex || hex.length !== 64) throw new Error('sha256_host_failed')
    return hex.toLowerCase()
  }
}

export function makeApplyPorts(opts: {
  boardProjectId: string
  snapshot: LiveSnapshot
  script: LiveReadHandle
  inventory?: ProjectLayerInventory
}): ApplyPorts {
  const live = portsFromSnapshot(opts.snapshot)
  const script = opts.script
  const allowlist = [
    ...(opts.inventory?.memories?.test_candidates ?? []),
    ...(opts.inventory?.memories?.official_promote_slugs ?? []).map((slug) => ({
      slug,
      file: `${slug}.md`,
      absPath: undefined as string | undefined,
    })),
  ]
  const oldSkills = opts.snapshot.projectContext?.skillNames ?? []

  return {
    ...live,
    async createChatProject(name) {
      const got = (await hostApply(script, 'apply-create-facade', { name })) as {
        id: string
        created?: boolean
      }
      return { id: got.id, created: got.created ?? true }
    },
    async bindChatProject(id, boardProjectId) {
      const existing = (opts.snapshot.chatProjects ?? []).find(
        (c) => c.id === id && !c.deletedAt,
      )
      if (existing && existing.boardProjectId === boardProjectId) {
        return { old: existing.boardProjectId, new: boardProjectId }
      }
      const got = (await hostApply(script, 'apply-bind-facade', {
        chatId: id,
        boardProjectId,
      })) as { old: string | null; new: string | null }
      return { old: got.old ?? null, new: got.new ?? boardProjectId }
    },
    async ensureProjectContext(boardProjectId) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const dir = projectContextDir(boardProjectId)
      const existed = existsSync(dir)
      await mkdir(dir, { recursive: true, mode: 0o750 })
      const ctx = await loadProjectContext(boardProjectId)
      return { created: !existed, version: ctx.version }
    },
    async batchMoveSessions(input) {
      return (await hostApply(script, 'apply-move-sessions', input)) as
        | {
            ok: true
            updated: number
            post: Array<{
              id: string
              projectId: string | null
              updatedAt: number
              oldProjectId?: string | null
              oldUpdatedAt?: number
            }>
          }
        | { ok: false; error: string; staleIds?: string[] }
    },
    async readMemoryContent(slug, file, expectedSha256) {
      return readAllowlistedMemoryContent({
        slug,
        file,
        expectedSha256,
        allowlist,
      })
    },
    async createMemoryCandidate(input) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const slug = input.slug.endsWith('.md') ? input.slug : `${input.slug}.md`
      const { default: Database } = await import('better-sqlite3')
      const db = new Database(paths.taskboardDb)
      try {
        const ledger = new ProjectMemoryLedger(db)
        const created = await ledger.createCandidate({
          projectId: opts.boardProjectId,
          slug,
          content: input.content,
          actor: 'agent:migration',
          sourceAgent: 'ocv5-project-layer-migrate',
        })
        if (!created.ok) throw new Error(`memory_ledger_${created.error}`)
        return {
          id: created.candidate.id,
          version: created.candidate.version ?? 1,
          hash:
            created.candidate.contentSha256 ??
            createHash('sha256').update(input.content).digest('hex'),
        }
      } finally {
        db.close()
      }
    },
    async rejectMemoryCandidate(input) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const { default: Database } = await import('better-sqlite3')
      const db = new Database(paths.taskboardDb)
      try {
        const ledger = new ProjectMemoryLedger(db)
        const rejected = ledger.reject({
          projectId: opts.boardProjectId,
          candidateId: input.id,
          expectedVersion: input.version,
          actor: 'agent:migration',
        })
        if (!rejected.ok && rejected.error !== 'not_found') {
          throw new Error(`memory_reject_${rejected.error}`)
        }
      } finally {
        db.close()
      }
    },
    async searchMemoryMarker(marker) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const needle = marker.replace(/[^A-Za-z0-9._:-]/g, ' ').trim().slice(0, 80)
      if (!needle) throw new Error('memory_search_marker_empty')
      const root = projectContextDir(opts.boardProjectId)
      const dirs = [join(root, 'memory-candidates'), join(root, 'memory')]
      let filesHit = false
      for (const dir of dirs) {
        if (!existsSync(dir)) continue
        for (const name of readdirSync(dir)) {
          if (!name.endsWith('.md')) continue
          try {
            const body = readFileSync(join(dir, name), 'utf8')
            if (body.includes(needle) || body.includes(marker.slice(0, 40))) {
              filesHit = true
              break
            }
          } catch {
            /* skip unreadable */
          }
        }
        if (filesHit) break
      }
      const out = await runHost(
        [
          'docker',
          'exec',
          '-u',
          '1000',
          '-e',
          `OPENCLAUDE_PROJECT_ID=${opts.boardProjectId}`,
          UID3_CONTAINER,
          'oc-memory',
          'project-search',
          needle,
          '--project',
          opts.boardProjectId,
        ],
        '',
      )
      return filesHit || out.includes(needle)
    },
    async putSkillOverlay(names, expectedVersion) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const existing = names.filter((name) =>
        existsSync(join(paths.sharedSkillsDir, name, 'SKILL.md')),
      )
      const missing = names.filter((name) => !existing.includes(name))
      if (missing.length) {
        process.stderr.write(`skill overlay skip missing ${missing.length}: ${missing.join(',')}\n`)
      }
      if (!existing.length) throw new Error('skill_overlay_failed:source_missing')
      const written = await commitProjectSkillOverlay(opts.boardProjectId, existing, expectedVersion, {
        actor: 'user:c:3',
      })
      if (!written.ok) throw new Error(`skill_overlay_failed:${written.error}`)
      return { old: oldSkills, new: existing }
    },
    async createAsset(input) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const digest = (await sha256HostFile(input.containerPath)).toLowerCase()
      if (input.digest && input.digest.toLowerCase() !== digest) {
        throw new Error('digest_mismatch')
      }
      const base = projectLayerApiBase()
      const res = await fetch(`${base}/api/project-assets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${projectLayerApiToken()}`,
        },
        body: JSON.stringify({
          projectId: input.projectId,
          source: input.source,
          sessionId: input.sessionId,
          name: input.name,
          containerPath: input.containerPath,
          digest,
        }),
      })
      if (!res.ok) throw new Error(`asset_api_${res.status}`)
      const body = (await res.json()) as {
        asset?: { id?: string }
        created?: boolean
        reused?: boolean
      }
      if (!body.asset?.id) throw new Error('asset_api_no_id')
      const created = body.created === true || (body.reused !== true && body.created !== false)
      return { id: body.asset.id, created, reused: !created }
    },
    async deleteAsset(id) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const base = projectLayerApiBase()
      const res = await fetch(`${base}/api/project-assets/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${projectLayerApiToken()}` },
      })
      if (!res.ok && res.status !== 404) throw new Error(`asset_delete_${res.status}`)
    },
    async repairOwnership(boardProjectId, uid, gid) {
      if (!applyArmed()) throw new Error('apply_disabled')
      const volumeProjects = `${UID3_VOLUME_DATA}/projects`
      const volumeDir = `${volumeProjects}/${boardProjectId}`
      await runHost(['mkdir', '-p', volumeDir], '')
      await runHost(['chown', `${uid}:${gid}`, volumeProjects], '')
      await runHost(['chown', '-R', `${uid}:${gid}`, volumeDir], '')
      await runHost(['chmod', '0750', volumeDir], '')
    },
    async backfillUsage(input) {
      const got = (await hostApply(script, 'apply-usage-backfill', {
        ...input,
        planned: input.planned ?? input.rowIds.length,
      })) as {
        rows: Array<{
          id: string
          oldBoardProjectId: string | null
          newBoardProjectId?: string | null
        }>
      }
      return (got.rows ?? []).map((row) => ({
        ...row,
        postBoardProjectId: row.newBoardProjectId ?? input.boardProjectId,
      }))
    },
    async restoreUsage(rows) {
      const got = (await hostApply(script, 'apply-usage-restore', {
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
