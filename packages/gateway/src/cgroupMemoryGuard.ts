/**
 * Container cgroup memory watermark & active resident runner cap guardrails (OCV5-825).
 *
 * Reads cgroup v2 (`memory.current` / `memory.max`) with fallback to cgroup v1
 * (`memory.usage_in_bytes` / `memory.limit_in_bytes`). Returns `null` (safe
 * no-op) when running outside a memory-limited cgroup (e.g., dev hosts,
 * macOS, unlimited containers, or unreadable procfs/sysfs).
 */
import { readFile } from 'node:fs/promises'

export const DEFAULT_MEMORY_PRESSURE_RATIO = 0.75
export const DEFAULT_MAX_RESIDENT_RUNNERS = 6

/** Cgroup v1 reports ~8 EiB (9223372036854771712) when unlimited; treat >=1 PiB as unlimited. */
const CGROUP_UNLIMITED_SENTINEL = 1n << 50n

export const DEFAULT_CGROUP_V2_CURRENT_PATH = '/sys/fs/cgroup/memory.current'
export const DEFAULT_CGROUP_V2_MAX_PATH = '/sys/fs/cgroup/memory.max'
export const DEFAULT_CGROUP_V1_CURRENT_PATH = '/sys/fs/cgroup/memory/memory.usage_in_bytes'
export const DEFAULT_CGROUP_V1_MAX_PATH = '/sys/fs/cgroup/memory/memory.limit_in_bytes'

export interface CgroupMemoryReading {
  readonly currentBytes: number
  readonly maxBytes: number
  readonly ratio: number
  readonly version: 'v2' | 'v1'
}

export interface CgroupMemoryPaths {
  v2CurrentPath?: string
  v2MaxPath?: string
  v1CurrentPath?: string
  v1MaxPath?: string
}

function parseCgroupPair(
  currentRaw: string,
  maxRaw: string,
  version: 'v2' | 'v1',
): CgroupMemoryReading | null {
  const maxTrimmed = maxRaw.trim()
  if (!maxTrimmed || maxTrimmed === 'max') return null
  const currentTrimmed = currentRaw.trim()
  if (!/^\d+$/.test(currentTrimmed) || !/^\d+$/.test(maxTrimmed)) return null
  const current = BigInt(currentTrimmed)
  const max = BigInt(maxTrimmed)
  if (max <= 0n || max >= CGROUP_UNLIMITED_SENTINEL || current < 0n) return null
  const currentNum = Number(current)
  const maxNum = Number(max)
  if (!Number.isFinite(currentNum) || !Number.isFinite(maxNum) || maxNum <= 0) return null
  return {
    currentBytes: currentNum,
    maxBytes: maxNum,
    ratio: currentNum / maxNum,
    version,
  }
}

async function tryReadPair(
  currentPath: string,
  maxPath: string,
  version: 'v2' | 'v1',
): Promise<CgroupMemoryReading | null> {
  try {
    const [cur, max] = await Promise.all([readFile(currentPath, 'utf8'), readFile(maxPath, 'utf8')])
    return parseCgroupPair(cur, max, version)
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
    'v2',
  )
  if (v2) return v2
  return tryReadPair(
    paths?.v1CurrentPath ?? DEFAULT_CGROUP_V1_CURRENT_PATH,
    paths?.v1MaxPath ?? DEFAULT_CGROUP_V1_MAX_PATH,
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
