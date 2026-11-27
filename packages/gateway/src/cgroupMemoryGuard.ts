/**
 * Container cgroup memory watermark & active resident runner cap guardrails (OCV5-825, OCV5-923).
 *
 * Reads cgroup v2 (`memory.current` / `memory.max` / `memory.stat`) with fallback
 * to cgroup v1 (`memory.usage_in_bytes` / `memory.limit_in_bytes` / `memory.stat`),
 * computing working-set memory (`max(0, current - reclaimableCache)`) using the
 * Docker/Kubernetes formula (`inactive_file` on v2; `total_inactive_file` or
 * `inactive_file` on v1). Returns `null` (safe no-op) when running outside a
 * memory-limited cgroup (e.g., dev hosts, macOS, unlimited containers, or
 * unreadable procfs/sysfs).
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DEFAULT_MEMORY_PRESSURE_RATIO = 0.75
export const DEFAULT_MAX_RESIDENT_RUNNERS = 6

/** Cgroup v1 reports ~8 EiB (9223372036854771712) when unlimited; treat >=1 PiB as unlimited. */
const CGROUP_UNLIMITED_SENTINEL = 1n << 50n

export const DEFAULT_CGROUP_V2_CURRENT_PATH = '/sys/fs/cgroup/memory.current'
export const DEFAULT_CGROUP_V2_MAX_PATH = '/sys/fs/cgroup/memory.max'
export const DEFAULT_CGROUP_V2_STAT_PATH = '/sys/fs/cgroup/memory.stat'
export const DEFAULT_CGROUP_V1_CURRENT_PATH = '/sys/fs/cgroup/memory/memory.usage_in_bytes'
export const DEFAULT_CGROUP_V1_MAX_PATH = '/sys/fs/cgroup/memory/memory.limit_in_bytes'
export const DEFAULT_CGROUP_V1_STAT_PATH = '/sys/fs/cgroup/memory/memory.stat'

const V2_INACTIVE_FILE_RE = /^inactive_file[ \t]+(\d+)[ \t\r]*$/m
const V1_TOTAL_INACTIVE_FILE_RE = /^total_inactive_file[ \t]+(\d+)[ \t\r]*$/m
const V1_INACTIVE_FILE_RE = /^inactive_file[ \t]+(\d+)[ \t\r]*$/m

export interface CgroupMemoryReading {
  /** Working-set bytes: max(0, rawCurrentBytes - reclaimableCacheBytes). */
  readonly currentBytes: number
  readonly maxBytes: number
  readonly ratio: number
  readonly version: 'v2' | 'v1'
  /** Raw cgroup memory.current / memory.usage_in_bytes before subtracting reclaimable cache. */
  readonly rawCurrentBytes?: number
  /** Reclaimable file cache subtracted (v2: inactive_file; v1: total_inactive_file ?? inactive_file). */
  readonly reclaimableCacheBytes?: number
}

export interface CgroupMemoryPaths {
  v2CurrentPath?: string
  v2MaxPath?: string
  v2StatPath?: string
  v1CurrentPath?: string
  v1MaxPath?: string
  v1StatPath?: string
}

/**
 * Parse reclaimable page cache bytes from cgroup `memory.stat` using the
 * Docker / Kubernetes working-set formula:
 * - cgroup v2: `inactive_file`
 * - cgroup v1: `total_inactive_file` (preferred), falling back to `inactive_file`
 *
 * Returns `0n` when missing, empty, or malformed.
 */
export function parseReclaimableFileCacheBytes(
  statRaw: string,
  version: 'v2' | 'v1',
): bigint {
  if (!statRaw) return 0n
  const match =
    version === 'v2'
      ? V2_INACTIVE_FILE_RE.exec(statRaw)
      : (V1_TOTAL_INACTIVE_FILE_RE.exec(statRaw) ?? V1_INACTIVE_FILE_RE.exec(statRaw))
  if (!match?.[1]) return 0n
  try {
    const value = BigInt(match[1])
    return value >= 0n && Number.isFinite(Number(value)) ? value : 0n
  } catch {
    return 0n
  }
}

function parseCgroupPair(
  currentRaw: string,
  maxRaw: string,
  version: 'v2' | 'v1',
  statRaw?: string | null,
): CgroupMemoryReading | null {
  const maxTrimmed = maxRaw.trim()
  if (!maxTrimmed || maxTrimmed === 'max') return null
  const currentTrimmed = currentRaw.trim()
  if (!/^\d+$/.test(currentTrimmed) || !/^\d+$/.test(maxTrimmed)) return null
  const rawCurrent = BigInt(currentTrimmed)
  const max = BigInt(maxTrimmed)
  if (max <= 0n || max >= CGROUP_UNLIMITED_SENTINEL || rawCurrent < 0n) return null

  const reclaimable = statRaw ? parseReclaimableFileCacheBytes(statRaw, version) : 0n
  // Clamp non-atomic read skew between memory.current and memory.stat to 0n.
  const workingSet = rawCurrent > reclaimable ? rawCurrent - reclaimable : 0n

  const currentNum = Number(workingSet)
  const rawCurrentNum = Number(rawCurrent)
  const reclaimableNum = Number(reclaimable)
  const maxNum = Number(max)
  if (
    !Number.isFinite(currentNum) ||
    !Number.isFinite(rawCurrentNum) ||
    !Number.isFinite(reclaimableNum) ||
    !Number.isFinite(maxNum) ||
    maxNum <= 0
  ) {
    return null
  }
  return {
    currentBytes: currentNum,
    maxBytes: maxNum,
    ratio: currentNum / maxNum,
    version,
    rawCurrentBytes: rawCurrentNum,
    reclaimableCacheBytes: reclaimableNum,
  }
}

function resolveStatPath(
  explicitStatPath: string | undefined,
  customCurrentPath: string | undefined,
  customMaxPath: string | undefined,
  defaultStatPath: string,
): string {
  if (explicitStatPath !== undefined) return explicitStatPath
  const customAnchor = customCurrentPath ?? customMaxPath
  if (customAnchor !== undefined) return join(dirname(customAnchor), 'memory.stat')
  return defaultStatPath
}

async function tryReadPair(
  currentPath: string,
  maxPath: string,
  statPath: string,
  version: 'v2' | 'v1',
): Promise<CgroupMemoryReading | null> {
  try {
    const [cur, max, stat] = await Promise.all([
      readFile(currentPath, 'utf8'),
      readFile(maxPath, 'utf8'),
      readFile(statPath, 'utf8').catch(() => null),
    ])
    return parseCgroupPair(cur, max, version, stat)
  } catch {
    return null
  }
}

function tryReadPairSync(
  currentPath: string,
  maxPath: string,
  statPath: string,
  version: 'v2' | 'v1',
): CgroupMemoryReading | null {
  try {
    const cur = readFileSync(currentPath, 'utf8')
    const max = readFileSync(maxPath, 'utf8')
    let stat: string | null = null
    try {
      stat = readFileSync(statPath, 'utf8')
    } catch {
      stat = null
    }
    return parseCgroupPair(cur, max, version, stat)
  } catch {
    return null
  }
}

export async function readCgroupMemoryUsage(
  paths?: CgroupMemoryPaths,
): Promise<CgroupMemoryReading | null> {
  const v2 = await tryReadPair(
    paths?.v2CurrentPath ?? DEFAULT_CGROUP_V2_CURRENT_PATH,
    paths?.v2MaxPath ?? DEFAULT_CGROUP_V2_MAX_PATH,
    resolveStatPath(
      paths?.v2StatPath,
      paths?.v2CurrentPath,
      paths?.v2MaxPath,
      DEFAULT_CGROUP_V2_STAT_PATH,
    ),
    'v2',
  )
  if (v2) return v2
  return tryReadPair(
    paths?.v1CurrentPath ?? DEFAULT_CGROUP_V1_CURRENT_PATH,
    paths?.v1MaxPath ?? DEFAULT_CGROUP_V1_MAX_PATH,
    resolveStatPath(
      paths?.v1StatPath,
      paths?.v1CurrentPath,
      paths?.v1MaxPath,
      DEFAULT_CGROUP_V1_STAT_PATH,
    ),
    'v1',
  )
}

export function readCgroupMemoryUsageSync(
  paths?: CgroupMemoryPaths,
): CgroupMemoryReading | null {
  const v2 = tryReadPairSync(
    paths?.v2CurrentPath ?? DEFAULT_CGROUP_V2_CURRENT_PATH,
    paths?.v2MaxPath ?? DEFAULT_CGROUP_V2_MAX_PATH,
    resolveStatPath(
      paths?.v2StatPath,
      paths?.v2CurrentPath,
      paths?.v2MaxPath,
      DEFAULT_CGROUP_V2_STAT_PATH,
    ),
    'v2',
  )
  if (v2) return v2
  return tryReadPairSync(
    paths?.v1CurrentPath ?? DEFAULT_CGROUP_V1_CURRENT_PATH,
    paths?.v1MaxPath ?? DEFAULT_CGROUP_V1_MAX_PATH,
    resolveStatPath(
      paths?.v1StatPath,
      paths?.v1CurrentPath,
      paths?.v1MaxPath,
      DEFAULT_CGROUP_V1_STAT_PATH,
    ),
    'v1',
  )
}

/**
 * Max resident (running subprocess) runners kept warm simultaneously.
 * `OC_MAX_RESIDENT_RUNNERS=0` disables the count guardrail; invalid values fall
 * back to `DEFAULT_MAX_RESIDENT_RUNNERS`.
 */
export function resolveMaxResidentRunners(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_MAX_RESIDENT_RUNNERS?.trim()
  if (raw === undefined || raw === '') return DEFAULT_MAX_RESIDENT_RUNNERS
  if (!/^\d+$/.test(raw)) return DEFAULT_MAX_RESIDENT_RUNNERS
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) ? parsed : DEFAULT_MAX_RESIDENT_RUNNERS
}

/**
 * Cgroup memory watermark ratio above which LRU idle runners are retired via
 * `retireKeepResume`. Defaults to 0.75 (75%).
 */
export function resolveMemoryPressureThreshold(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.OC_MEMORY_PRESSURE_RATIO?.trim()
  if (!raw) return DEFAULT_MEMORY_PRESSURE_RATIO
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0.1 || parsed > 0.99) {
    return DEFAULT_MEMORY_PRESSURE_RATIO
  }
  return parsed
}
