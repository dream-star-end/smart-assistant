#!/usr/bin/env node
/**
 * Weekly Autonomous Gardening Dispatcher & 14-Day Isolated Cooldown Ledger (OCV5-905).
 *
 * Responsibilities:
 * 1. Reads `arch-health.json` + `cooldown.json` + host governor `mode.json`
 *    (default `/opt/openclaude/harness-gate/control/mode.json`);
 * 2. Skips dispatch immediately when host governor mode is `emergency_stop`;
 * 3. Enforces **14-day isolated per-item cooldown**: a single failed/reverted gardening PR cools
 *    down ONLY its `itemKey` for 14 days without freezing other items;
 * 4. Trips the **global circuit breaker** ONLY when production rollbacks reach `>= 2` within a
 *    rolling 7-day window;
 * 5. Selects up to `2-3` highest-priority uncooled L3 items per week and emits structured micro-PR
 *    task specifications + exact `oc-task` OCV5 ticket creation commands (`--dry-run` supported).
 *
 * Usage:
 *   npx tsx scripts/gardening/run-gardening-dispatch.ts --health <arch-health.json>
 *     [--cooldown <cooldown.json>] [--governor-mode <mode.json>] [--limit 3] [--dry-run] [--out <dispatch.json>]
 *   npx tsx scripts/gardening/run-gardening-dispatch.ts --cooldown <cooldown.json>
 *     --record-failure <itemKey> --reason "<msg>" [--production-rollback]
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { asRecord, atomicWriteJson, errMsg, isRecord } from '../../packages/kernel/src/index.js'
import type { ArchHealthSnapshot, DebtCategory, PrioritizedDebtItem } from './arch-health-snapshot.js'
import {
  MAX_NET_LOC,
  MAX_STANDARD_FILES,
  MAX_TOTAL_CHURN,
  MAX_WHEEL_CONSOLIDATION_FILES,
} from './verify-micro-pr-bounds.js'

export const ITEM_COOLDOWN_DAYS = 14
export const ITEM_COOLDOWN_MS = ITEM_COOLDOWN_DAYS * 24 * 3600 * 1000
export const GLOBAL_BREAKER_WINDOW_DAYS = 7
export const GLOBAL_BREAKER_WINDOW_MS = GLOBAL_BREAKER_WINDOW_DAYS * 24 * 3600 * 1000
export const GLOBAL_BREAKER_ROLLBACK_THRESHOLD = 2
export const DEFAULT_WEEKLY_LIMIT = 3
export const DEFAULT_GOVERNOR_MODE_PATH = '/opt/openclaude/harness-gate/control/mode.json'

export type GovernorMode = 'autonomous' | 'debt_first' | 'emergency_stop'

export interface CooldownItemEntry {
  itemKey: string
  failedAt: string
  cooldownUntil: string
  reason: string
  failures: number
}

export interface ProductionRollbackEvent {
  timestamp: string
  itemKey?: string
  trainId?: string
  reason: string
}

export interface CooldownLedger {
  schemaVersion: 1
  updatedAt: string
  items: Record<string, CooldownItemEntry>
  productionRollbacks: ProductionRollbackEvent[]
}

export interface GardeningTaskSpec {
  itemKey: string
  category: DebtCategory
  file: string
  priorityScore: number
  magnetScore: number
  ttlUrgency: number
  targetBaseline: string
  bounds: {
    maxNetLoc: number
    maxTouchedFiles: number
    maxTotalChurn: number
    requireBaselineDrop: true
    forbidTestAssertionMutation: true
  }
  suggestedAction: string
  ocv5TicketCommand: string
  verificationCommands: string[]
}

export interface DispatchDecision {
  schemaVersion: 1
  generatedAt: string
  dryRun: boolean
  governorMode: GovernorMode
  status: 'dispatched' | 'skipped_emergency_stop' | 'halted_global_breaker' | 'no_eligible_items'
  reason?: string
  recentProductionRollbacks7d: number
  activeCooldownKeys: string[]
  selected: GardeningTaskSpec[]
}

export function createEmptyCooldownLedger(now = new Date()): CooldownLedger {
  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    items: {},
    productionRollbacks: [],
  }
}

export function parseCooldownLedger(raw: unknown, now = new Date()): CooldownLedger {
  const obj = asRecord(raw)
  if (!obj) return createEmptyCooldownLedger(now)
  const items: Record<string, CooldownItemEntry> = {}
  const rawItems = asRecord(obj.items)
  if (rawItems) {
    for (const [k, v] of Object.entries(rawItems)) {
      const rec = asRecord(v)
      if (!rec || typeof rec.cooldownUntil !== 'string') continue
      items[k] = {
        itemKey: typeof rec.itemKey === 'string' ? rec.itemKey : k,
        failedAt: typeof rec.failedAt === 'string' ? rec.failedAt : now.toISOString(),
        cooldownUntil: rec.cooldownUntil,
        reason: typeof rec.reason === 'string' ? rec.reason : 'unspecified',
        failures: typeof rec.failures === 'number' && rec.failures > 0 ? rec.failures : 1,
      }
    }
  }
  const productionRollbacks: ProductionRollbackEvent[] = []
  if (Array.isArray(obj.productionRollbacks)) {
    for (const ev of obj.productionRollbacks) {
      const rec = asRecord(ev)
      if (!rec || typeof rec.timestamp !== 'string') continue
      productionRollbacks.push({
        timestamp: rec.timestamp,
        ...(typeof rec.itemKey === 'string' ? { itemKey: rec.itemKey } : {}),
        ...(typeof rec.trainId === 'string' ? { trainId: rec.trainId } : {}),
        reason: typeof rec.reason === 'string' ? rec.reason : 'rollback',
      })
    }
  }
  return {
    schemaVersion: 1,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : now.toISOString(),
    items,
    productionRollbacks,
  }
}

/**
 * Record a single gardening item failure/revert: isolates cooldown to ONLY `itemKey` for 14 days
 * without freezing other items. Only increments the 7-day global rollback counter when
 * `isProductionRollback === true`.
 */
export function recordGardeningFailure(
  ledger: CooldownLedger,
  event: {
    itemKey: string
    reason: string
    now?: Date
    isProductionRollback?: boolean
    trainId?: string
  },
): CooldownLedger {
  const now = event.now ?? new Date()
  const prev = ledger.items[event.itemKey]
  const cooldownUntil = new Date(now.getTime() + ITEM_COOLDOWN_MS).toISOString()

  const nextItems: Record<string, CooldownItemEntry> = {
    ...ledger.items,
    [event.itemKey]: {
      itemKey: event.itemKey,
      failedAt: now.toISOString(),
      cooldownUntil,
      reason: event.reason,
      failures: (prev?.failures ?? 0) + 1,
    },
  }

  const nextRollbacks = [...ledger.productionRollbacks]
  if (event.isProductionRollback) {
    nextRollbacks.push({
      timestamp: now.toISOString(),
      itemKey: event.itemKey,
      ...(event.trainId ? { trainId: event.trainId } : {}),
      reason: event.reason,
    })
  }

  return {
    schemaVersion: 1,
    updatedAt: now.toISOString(),
    items: nextItems,
    productionRollbacks: nextRollbacks,
  }
}

export function isItemInCooldown(
  ledger: CooldownLedger,
  itemKey: string,
  now = new Date(),
): boolean {
  const entry = ledger.items[itemKey]
  if (!entry) return false
  const untilMs = Date.parse(entry.cooldownUntil)
  return Number.isFinite(untilMs) && now.getTime() < untilMs
}

export function countRecentProductionRollbacks(ledger: CooldownLedger, now = new Date()): number {
  const cutoff = now.getTime() - GLOBAL_BREAKER_WINDOW_MS
  let count = 0
  for (const ev of ledger.productionRollbacks) {
    const ts = Date.parse(ev.timestamp)
    if (Number.isFinite(ts) && ts >= cutoff && ts <= now.getTime() + 60_000) {
      count++
    }
  }
  return count
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function buildOcv5TicketCommand(item: PrioritizedDebtItem): string {
  const title = `[gardening][${item.category}] ${item.file} (score=${item.priorityScore})`
  const desc = [
    `itemKey: ${item.itemKey}`,
    `category: ${item.category}`,
    `targetBaseline: ${item.targetBaseline}`,
    `magnetScore: ${item.magnetScore} (touches60d=${item.touches60d}, loc=${item.loc}, ttlUrgency=${item.ttlUrgency})`,
    `bounds: netLoc<=${MAX_NET_LOC}, files<=${item.category === 'wheel-consolidation' ? MAX_WHEEL_CONSOLIDATION_FILES : MAX_STANDARD_FILES}, baselineDelta<0`,
    `action: ${item.suggestedAction}`,
  ].join(' | ')
  return [
    'oc-task ticket create',
    '--project-id OCV5',
    `--title ${shellSingleQuote(title)}`,
    '--labels self-evolve,gardening,l3-micro-pr',
    `--description ${shellSingleQuote(desc)}`,
  ].join(' ')
}

function toTaskSpec(item: PrioritizedDebtItem): GardeningTaskSpec {
  const maxTouchedFiles =
    item.category === 'wheel-consolidation' ? MAX_WHEEL_CONSOLIDATION_FILES : MAX_STANDARD_FILES
  return {
    itemKey: item.itemKey,
    category: item.category,
    file: item.file,
    priorityScore: item.priorityScore,
    magnetScore: item.magnetScore,
    ttlUrgency: item.ttlUrgency,
    targetBaseline: item.targetBaseline,
    bounds: {
      maxNetLoc: MAX_NET_LOC,
      maxTouchedFiles,
      maxTotalChurn: MAX_TOTAL_CHURN,
      requireBaselineDrop: true,
      forbidTestAssertionMutation: true,
    },
    suggestedAction: item.suggestedAction,
    ocv5TicketCommand: buildOcv5TicketCommand(item),
    verificationCommands: [
      `npx tsx scripts/gardening/verify-micro-pr-bounds.ts --category ${item.category}`,
      'npx tsx scripts/check-architecture.ts --enforce',
      'scripts/check-biome-changed.sh',
    ],
  }
}

export function planGardeningDispatch(args: {
  snapshot: Pick<ArchHealthSnapshot, 'prioritizedDebtQueue'>
  ledger: CooldownLedger
  governorMode: GovernorMode
  governorBreakerTripped?: boolean
  limit?: number
  dryRun?: boolean
  now?: Date
}): DispatchDecision {
  const now = args.now ?? new Date()
  const dryRun = args.dryRun ?? false
  const limit = Math.min(3, Math.max(1, args.limit ?? DEFAULT_WEEKLY_LIMIT))

  const activeCooldownKeys = Object.keys(args.ledger.items)
    .filter((k) => isItemInCooldown(args.ledger, k, now))
    .sort()
  const recentRollbacks = countRecentProductionRollbacks(args.ledger, now)

  if (args.governorMode === 'emergency_stop') {
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      dryRun,
      governorMode: args.governorMode,
      status: 'skipped_emergency_stop',
      reason: 'Host governor mode is emergency_stop; skipping autonomous gardening dispatch.',
      recentProductionRollbacks7d: recentRollbacks,
      activeCooldownKeys,
      selected: [],
    }
  }

  if (args.governorBreakerTripped || recentRollbacks >= GLOBAL_BREAKER_ROLLBACK_THRESHOLD) {
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      dryRun,
      governorMode: args.governorMode,
      status: 'halted_global_breaker',
      reason: `Global circuit breaker active (${recentRollbacks} production rollbacks in last 7d >= ${GLOBAL_BREAKER_ROLLBACK_THRESHOLD}).`,
      recentProductionRollbacks7d: recentRollbacks,
      activeCooldownKeys,
      selected: [],
    }
  }

  const eligible = args.snapshot.prioritizedDebtQueue.filter(
    (item) =>
      item.autonomyTier === 'L3-auto' && !isItemInCooldown(args.ledger, item.itemKey, now),
  )

  const picked = eligible.slice(0, limit).map(toTaskSpec)
  if (picked.length === 0) {
    return {
      schemaVersion: 1,
      generatedAt: now.toISOString(),
      dryRun,
      governorMode: args.governorMode,
      status: 'no_eligible_items',
      reason: 'All candidate debt items are either cooling down or require T2 human merge.',
      recentProductionRollbacks7d: recentRollbacks,
      activeCooldownKeys,
      selected: [],
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    dryRun,
    governorMode: args.governorMode,
    status: 'dispatched',
    recentProductionRollbacks7d: recentRollbacks,
    activeCooldownKeys,
    selected: picked,
  }
}

export async function readGovernorState(modeFilePath: string): Promise<{
  mode: GovernorMode
  breakerTripped: boolean
}> {
  try {
    const raw = JSON.parse(await readFile(modeFilePath, 'utf8')) as unknown
    if (!isRecord(raw)) return { mode: 'autonomous', breakerTripped: false }
    const m = raw.mode
    const mode: GovernorMode =
      m === 'emergency_stop' || m === 'debt_first' || m === 'autonomous' ? m : 'autonomous'
    const breakerTripped = raw.breakerTripped === true || raw.frozen === true
    return { mode, breakerTripped }
  } catch (err: unknown) {
    void err
    return { mode: 'autonomous', breakerTripped: false }
  }
}

async function readJsonOrNull(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as unknown
  } catch (err: unknown) {
    void err
    return null
  }
}

function readFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag)
  return idx >= 0 ? argv[idx + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const nowArg = readFlag(argv, '--now')
  const now = nowArg ? new Date(nowArg) : new Date()
  if (Number.isNaN(now.getTime())) throw new Error(`Invalid --now timestamp: ${nowArg}`)

  const cooldownPath = path.resolve(
    readFlag(argv, '--cooldown') ?? 'arch/gardening-cooldown.json',
  )
  const ledger = parseCooldownLedger(await readJsonOrNull(cooldownPath), now)

  const recordFailureKey = readFlag(argv, '--record-failure')
  if (recordFailureKey) {
    const reason = readFlag(argv, '--reason') ?? 'gardening micro-PR gate/train failure'
    const isProductionRollback = argv.includes('--production-rollback')
    const trainId = readFlag(argv, '--train')
    const updated = recordGardeningFailure(ledger, {
      itemKey: recordFailureKey,
      reason,
      now,
      isProductionRollback,
      trainId,
    })
    if (!argv.includes('--dry-run')) {
      await atomicWriteJson(cooldownPath, updated)
    }
    process.stdout.write(`${JSON.stringify(updated, null, 2)}\n`)
    return
  }

  const healthPath = readFlag(argv, '--health')
  if (!healthPath) {
    throw new Error('Missing required --health <arch-health.json> (or --record-failure <itemKey>)')
  }
  const healthRaw = await readJsonOrNull(path.resolve(healthPath))
  if (!isRecord(healthRaw) || !Array.isArray(healthRaw.prioritizedDebtQueue)) {
    throw new Error(`Invalid arch-health snapshot at ${healthPath}`)
  }

  const govRoot = process.env.OC_GOVERNOR_ROOT
  const modePath =
    readFlag(argv, '--governor-mode') ??
    process.env.OC_GOVERNOR_MODE_FILE ??
    (govRoot ? path.join(govRoot, 'control', 'mode.json') : DEFAULT_GOVERNOR_MODE_PATH)
  const gov = await readGovernorState(modePath)
  const limitArg = readFlag(argv, '--limit')
  const limit = limitArg ? Number.parseInt(limitArg, 10) : DEFAULT_WEEKLY_LIMIT
  const dryRun = argv.includes('--dry-run')

  const decision = planGardeningDispatch({
    snapshot: { prioritizedDebtQueue: healthRaw.prioritizedDebtQueue as PrioritizedDebtItem[] },
    ledger,
    governorMode: gov.mode,
    governorBreakerTripped: gov.breakerTripped,
    limit,
    dryRun,
    now,
  })

  const outPath = readFlag(argv, '--out')
  if (outPath && !dryRun) {
    await atomicWriteJson(path.resolve(outPath), decision)
  }
  process.stdout.write(`${JSON.stringify(decision, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`[gardening-dispatch] fatal: ${errMsg(err)}`)
    process.exit(2)
  })
}
