/**
 * Shared `remote-driver-v4` registry loader and deterministic artifact digest calculator.
 *
 * Produces byte-for-byte identical `driverDigest` and `coreDigest` values to
 * `scripts/agent-remote/core/contract.py` (`compute_core_digest`, `load_driver`),
 * with zero per-engine branches (`AC-2`, `AC-6`).
 */
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  REMOTE_DRIVER_PROTOCOL_VERSION,
  remoteCanonicalSha256,
  type RemoteDriverAuthorityEngine,
} from '@openclaude/protocol'

const ENGINE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/
const MODULE_REL_RE = /^drivers\/[a-z0-9_]+\.py$/
const SLICE_RE = /^oc-[a-z0-9_-]+\.slice$/
const AUTHORITY_ENGINES = new Set<RemoteDriverAuthorityEngine>([
  'ccb',
  'codex',
  'grok',
  'cursor',
  'zcode',
  'antigravity',
])
const ALLOWED_ROLES = new Set([
  'provision',
  'preflight',
  'launch',
  'tool-socket',
  'stop',
  'fence-stop',
  'prove-stopped',
  'probe',
])

export interface RemoteDriverRegistryEntry {
  readonly driverId: string
  readonly engineId: string
  readonly authorityEngine: RemoteDriverAuthorityEngine
  readonly driverVersion: string
  readonly module: string
  readonly runnerMode: string
  readonly slice: string
  readonly sliceMemoryMiB: number
  readonly sliceTasksMax: number
  readonly appMemoryMiB: number
  readonly socketMemoryMiB: number
  readonly probeMemoryMiB: number
  readonly headroomMiB: number
  readonly profileMaxLanes: number
  readonly requireNodeObservation: boolean
  readonly roles: readonly string[]
  readonly driverPath: string
  readonly driverDigest: string
  readonly coreDigest: string
  readonly controllerPath: string
  readonly controllerSha256: string
}

function need(condition: unknown, code = 'REMOTE_REGISTRY_INVALID'): asserts condition {
  if (!condition) throw new Error(code)
}

export function defaultAgentRemoteRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', 'scripts', 'agent-remote')
}

export function defaultRemoteDriverRegistryPath(): string {
  return join(defaultAgentRemoteRoot(), 'drivers', 'registry.json')
}

function fileSha256Regular(path: string, maxBytes = 4 * 1024 * 1024): string {
  const st = lstatSync(path)
  need(st.isFile() && !st.isSymbolicLink() && st.size > 0 && st.size <= maxBytes, 'REMOTE_ARTIFACT_UNSAFE')
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function computeRemoteCoreDigest(coreDir = join(defaultAgentRemoteRoot(), 'core')): string {
  const resolvedCore = resolve(coreDir)
  const pyFiles = readdirSync(resolvedCore)
    .filter((name) => name.endsWith('.py'))
    .sort()
  const listing: Record<string, string> = {}
  for (const name of pyFiles) {
    const full = join(resolvedCore, name)
    const st = lstatSync(full)
    if (!st.isFile() || st.isSymbolicLink()) continue
    listing[name] = fileSha256Regular(full)
  }
  need(Object.keys(listing).length >= 3, 'REMOTE_CORE_FILES_MISSING')
  return remoteCanonicalSha256({
    version: REMOTE_DRIVER_PROTOCOL_VERSION,
    coreFiles: listing,
  })
}

export function loadRemoteDriverRegistry(
  registryPath = defaultRemoteDriverRegistryPath(),
): ReadonlyMap<string, RemoteDriverRegistryEntry> {
  const resolvedRegPath = resolve(registryPath)
  const st = lstatSync(resolvedRegPath)
  need(st.isFile() && !st.isSymbolicLink() && st.size <= 512 * 1024, 'REMOTE_REGISTRY_UNSAFE')
  const agentRoot = resolve(dirname(resolvedRegPath), '..')
  const coreDir = join(agentRoot, 'core')
  const controllerPath = join(coreDir, 'controller.py')
  const controllerSha256 = fileSha256Regular(controllerPath)
  const coreDigest = computeRemoteCoreDigest(coreDir)

  const parsed = JSON.parse(readFileSync(resolvedRegPath, 'utf8')) as Record<string, unknown>
  need(
    parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      parsed.version === REMOTE_DRIVER_PROTOCOL_VERSION &&
      parsed.drivers &&
      typeof parsed.drivers === 'object' &&
      !Array.isArray(parsed.drivers),
  )
  const driversRaw = parsed.drivers as Record<string, unknown>
  const keys = Object.keys(driversRaw)
  need(keys.length >= 1 && keys.length <= 32)

  const out = new Map<string, RemoteDriverRegistryEntry>()
  const driversDir = resolve(agentRoot, 'drivers')
  for (const key of keys) {
    const raw = driversRaw[key]
    need(raw && typeof raw === 'object' && !Array.isArray(raw), 'REMOTE_REGISTRY_ENTRY_INVALID')
    const e = raw as Record<string, unknown>
    need(
      e.driverId === key &&
        typeof e.driverId === 'string' &&
        ENGINE_ID_RE.test(e.driverId) &&
        typeof e.engineId === 'string' &&
        ENGINE_ID_RE.test(e.engineId) &&
        typeof e.authorityEngine === 'string' &&
        AUTHORITY_ENGINES.has(e.authorityEngine as RemoteDriverAuthorityEngine) &&
        typeof e.driverVersion === 'string' &&
        e.driverVersion.length > 0 &&
        e.driverVersion.length <= 64 &&
        typeof e.module === 'string' &&
        MODULE_REL_RE.test(e.module) &&
        typeof e.runnerMode === 'string' &&
        e.runnerMode.length > 0 &&
        typeof e.slice === 'string' &&
        SLICE_RE.test(e.slice) &&
        Array.isArray(e.roles) &&
        e.roles.every((r) => typeof r === 'string' && ALLOWED_ROLES.has(r)),
      'REMOTE_REGISTRY_ENTRY_INVALID',
    )
    for (const numField of [
      'sliceMemoryMiB',
      'sliceTasksMax',
      'appMemoryMiB',
      'socketMemoryMiB',
      'probeMemoryMiB',
      'headroomMiB',
      'profileMaxLanes',
    ] as const) {
      const val = e[numField]
      need(typeof val === 'number' && Number.isSafeInteger(val) && val > 0, 'REMOTE_REGISTRY_RESOURCE_INVALID')
    }
    const driverPath = resolve(agentRoot, e.module)
    need(dirname(driverPath) === driversDir, 'REMOTE_DRIVER_PATH_ESCAPED')
    const driverDigest = fileSha256Regular(driverPath, 1024 * 1024)
    out.set(e.driverId, Object.freeze({
      driverId: e.driverId,
      engineId: e.engineId,
      authorityEngine: e.authorityEngine as RemoteDriverAuthorityEngine,
      driverVersion: e.driverVersion,
      module: e.module,
      runnerMode: e.runnerMode,
      slice: e.slice,
      sliceMemoryMiB: e.sliceMemoryMiB as number,
      sliceTasksMax: e.sliceTasksMax as number,
      appMemoryMiB: e.appMemoryMiB as number,
      socketMemoryMiB: e.socketMemoryMiB as number,
      probeMemoryMiB: e.probeMemoryMiB as number,
      headroomMiB: e.headroomMiB as number,
      profileMaxLanes: e.profileMaxLanes as number,
      requireNodeObservation: Boolean(e.requireNodeObservation),
      roles: Object.freeze([...(e.roles as string[])]),
      driverPath,
      driverDigest,
      coreDigest,
      controllerPath,
      controllerSha256,
    }))
  }
  return out
}

/**
 * Maps a v4 driver's `authorityEngine` to the backward-compatible legacy `engine` column on
 * `remote_agent_profiles` (`0333`: `cc | codex | antigravity | grok-build`) for rollback safety.
 */
export function legacyProfileEngineForAuthority(
  authorityEngine: RemoteDriverAuthorityEngine,
): 'cc' | 'codex' | 'antigravity' | 'grok-build' {
  switch (authorityEngine) {
    case 'codex':
      return 'codex'
    case 'antigravity':
      return 'antigravity'
    case 'grok':
      return 'grok-build'
    default:
      return 'cc'
  }
}

/**
 * Maps a v4 driver's `authorityEngine` to the backward-compatible legacy `engine` column on
 * `remote_agent_bindings` (`0335`: `cc | codex`) for rollback safety.
 */
export function legacyBindingEngineForAuthority(
  authorityEngine: RemoteDriverAuthorityEngine,
): 'cc' | 'codex' {
  return authorityEngine === 'codex' ? 'codex' : 'cc'
}
