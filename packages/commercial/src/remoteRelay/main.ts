/**
 * Standalone blue-green `remote-relay` daemon (OCV5-855).
 *
 * Decouples remote-pool SSH relays (`Cc5Relay` / `CodexRemoteRelay` / `RemotePoolRelay`)
 * and remote-native billing settlement from the Master gateway process so Master blue-green
 * flips never interrupt active `remote-driver-v4` turns.
 *
 * Security & operational invariants:
 * - Fail-closed if `OC_EGRESS_SECRET` is missing or `OC_REMOTE_RELAY_SLOT` is invalid.
 * - Distinguishes intentionally-disabled (`runtimeState: 'disabled'`, HTTP 200 with
 *   `remoteRuntimeReady: false`) from enabled-but-broken (`runtimeState: 'error'`, HTTP 503) (B6).
 * - Uses `authorityKeyringProvider()` (public-key verification only; never holds Master private key).
 * - Listens ONLY on its own slot socket (`remote-relay-{A|B}.sock`, mode `0600`); on cold start,
 *   restores `remote-relay-active.sock` ONLY if persisted state identifies this slot as active AND
 *   the symlink is missing/dangling/dead (never preempts a live peer) (B10).
 * - On SIGTERM/SIGINT: stops admitting new `ensureLane` calls, waits for `inFlightRpcCount === 0`
 *   AND `activeRelayCount === 0` AND this slot's own `(operationId, generation)` unsettled
 *   `request_finalize_journal` rows (B4).
 * - On drain timeout: NEVER force-kills active SSH lanes (`drainOwnIdleAndOwnedLanes` is skipped)
 *   and NEVER exits 0; atomically writes the drain-timeout marker and exits 79 (B3).
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import IORedis from 'ioredis'
import type { Pool } from 'pg'
import {
  type RemoteLaneRuntimePort,
  createRemoteLaneRuntime,
} from '@openclaude/gateway/cc5-container-runtime'
import {
  CC5_TEST_UID_ENV,
  type Cc5PolicyEnvironment,
  canUseCc5TestModel,
} from '@openclaude/protocol'
import {
  placeRemoteLane,
  recordRemoteLaneState,
  recordRemoteNativeThread,
  recordRemoteStartAttempt,
} from '../account-pool/remoteBrainPool.js'
import {
  reconcileRemoteChat,
  reconcileStaleContainerLanes,
} from '../account-pool/remoteLaneRecovery.js'
import {
  RemoteReleaseDrainCoordinator,
  isReservedVerificationSessionKey,
  legacyBindingEngineForAuthority,
  legacyProfileEngineForAuthority,
  loadRemoteDriverRegistry,
  placeRemoteDriverLane,
  recordRemoteDriverLaneState,
  recordRemoteDriverNativeSession,
  recordRemoteDriverStartAttempt,
} from '../account-pool/remotePool/index.js'
import { createRemoteRelayPeerClient } from '../agent-sandbox/remoteRelayClient.js'
import { makeLoadUserModelAuthz } from '../auth/userModelAuthz.js'
import { configureModelAvailability } from '../billing/modelAvailability.js'
import {
  authorityKeyringProvider,
  getModelCatalogCache,
} from '../billing/modelCatalogRuntime.js'
import { wrapIoredisForPreCheck } from '../billing/preCheck.js'
import { createRemoteNativeTurnFinance } from '../billing/remoteNativeTurnBilling.js'
import { loadConfig } from '../config.js'
import { closePool, getPool } from '../db/index.js'
import { assertFlavorIdentity } from '../flavor/assertFlavor.js'
import { rootLogger } from '../logging/logger.js'
import { assertModelAuthorityCutoverFloor } from '../runtimeCapabilities.js'
import {
  DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET,
  DEFAULT_REMOTE_RELAY_DRAIN_TIMEOUT_FILE,
  DEFAULT_REMOTE_RELAY_SLOT_SOCK_PREFIX,
  DEFAULT_REMOTE_RELAY_STATE_FILE,
  REMOTE_RELAY_BASE_ROOT_ENV,
  REMOTE_RELAY_DRAIN_MS_ENV,
  REMOTE_RELAY_DRAIN_TIMEOUT_FILE_ENV,
  REMOTE_RELAY_EVIDENCE_ROOT_ENV,
  REMOTE_RELAY_SLOT_ENV,
  REMOTE_RELAY_SLOT_SOCK_PREFIX_ENV,
  REMOTE_RELAY_SOCKET_ENV,
  REMOTE_RELAY_STATE_FILE_ENV,
  type RemoteRelayRuntimeState,
  type RemoteRelaySlot,
  parseRemoteRelaySlot,
  peerRemoteRelaySlot,
  remoteRelaySlotSocketPath,
} from './protocol.js'
import {
  type RemoteRelayLogger,
  type RemoteRelayQueryPoolLike,
  type RemoteRelayRpcServerHandle,
  type RemoteRelayRuntimeLike,
  createRemoteRelayRpcServer,
} from './server.js'

const log = rootLogger.child({ subsys: 'remoteRelayMain' })

const DEFAULT_BASE_ROOT = '/run/oc-cc5-t1555u'
const DEFAULT_EVIDENCE_ROOT = '/var/lib/openclaude/remote-native'
const DEFAULT_DRAIN_MS = 30 * 60_000
export const REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE = 79
const LEGACY_SUPPORTED_ENGINES: ReadonlySet<string> = new Set(['ccb', 'codex'])

function isLegacyRemoteEngine(value: string): value is 'ccb' | 'codex' {
  return LEGACY_SUPPORTED_ENGINES.has(value)
}

function parseDrainMs(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) return DEFAULT_DRAIN_MS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_DRAIN_MS
  return Math.floor(parsed)
}

function resolveControllerPath(): string {
  const cwdController = resolve('scripts/agent-remote/cc5-host-controller.py')
  return existsSync(cwdController)
    ? cwdController
    : fileURLToPath(
        new URL('../../../../scripts/agent-remote/cc5-host-controller.py', import.meta.url),
      )
}

/**
 * Tracks exact `(operationId, generation)` pairs placed/owned by THIS slot so a newer
/**
 * B3/settlement: Tracks `(operationId, generation)` pairs placed by THIS slot so a newer
 * sticky generation placed by the peer slot for the same `operationId` never blocks this
 * slot's graceful drain — while NEVER dropping a slot's settlement responsibility merely
 * because the lane binding transitioned to `released` before PG journal settlement finished.
 * A released `(operationId, generation)` key is only pruned after PG confirms zero unsettled
 * (`inflight` / `finalizing`) journal rows for that exact generation.
 */
export class OwnLaneGenerationTracker {
  private readonly activeByOp = new Map<string, Set<string>>()
  private readonly releasedPendingByOp = new Map<string, Set<string>>()

  record(operationId: string, generation?: string): void {
    const op = operationId.trim()
    if (!op) return
    const gen = (generation ?? '').trim()
    let set = this.activeByOp.get(op)
    if (!set) {
      set = new Set<string>()
      this.activeByOp.set(op, set)
    }
    set.add(gen)
    const pending = this.releasedPendingByOp.get(op)
    if (pending) {
      pending.delete(gen)
      if (pending.size === 0) this.releasedPendingByOp.delete(op)
    }
  }

  /**
   * Moves `(operationId, generation)` from active to released-pending-settlement.
   * Keeps it in `scopedKeys()` until `pruneSettledKeys()` proves PG has no unsettled journal row.
   */
  markBindingReleased(operationId: string, generation?: string): void {
    const op = operationId.trim()
    if (!op) return
    const active = this.activeByOp.get(op)
    if (generation === undefined) {
      const moved = active ? [...active] : ['']
      this.activeByOp.delete(op)
      let pending = this.releasedPendingByOp.get(op)
      if (!pending) {
        pending = new Set<string>()
        this.releasedPendingByOp.set(op, pending)
      }
      for (const g of moved) pending.add(g)
      return
    }
    const gen = generation.trim()
    if (active) {
      active.delete(gen)
      if (active.size === 0) this.activeByOp.delete(op)
    }
    let pending = this.releasedPendingByOp.get(op)
    if (!pending) {
      pending = new Set<string>()
      this.releasedPendingByOp.set(op, pending)
    }
    pending.add(gen)
  }

  /** Backwards-compatible alias for `markBindingReleased` (never drops unsettled settlement responsibility). */
  release(operationId: string, generation?: string): void {
    this.markBindingReleased(operationId, generation)
  }

  /**
   * Prunes keys that are BOTH binding-released AND proven absent from the current unsettled
   * PG journal key set. Active lanes are never pruned.
   */
  pruneSettledKeys(unsettledScopedKeys: ReadonlySet<string>): void {
    for (const [op, gens] of this.releasedPendingByOp) {
      for (const gen of [...gens]) {
        if (!unsettledScopedKeys.has(`${op}:${gen}`)) {
          gens.delete(gen)
        }
      }
      if (gens.size === 0) {
        this.releasedPendingByOp.delete(op)
      }
    }
  }

  scopedKeys(): string[] {
    const seen = new Set<string>()
    for (const [op, gens] of this.activeByOp) {
      for (const gen of gens) seen.add(`${op}:${gen}`)
    }
    for (const [op, gens] of this.releasedPendingByOp) {
      for (const gen of gens) seen.add(`${op}:${gen}`)
    }
    return [...seen]
  }

  get size(): number {
    return this.scopedKeys().length
  }
}

export const OWN_UNSETTLED_JOURNALS_SQL = `SELECT DISTINCT
    CASE
      WHEN ctx ? 'remoteDriverV4'
        THEN ctx#>>'{remoteDriverV4,scope,operationId}' || ':' || COALESCE(ctx#>>'{remoteDriverV4,scope,generation}', '')
      ELSE ctx#>>'{remoteNative,scope,operationId}' || ':' || COALESCE(ctx#>>'{remoteNative,scope,generation}', '')
    END AS scoped_key
  FROM request_finalize_journal
 WHERE ctx ? 'remoteNativeBillingRecovery'
   AND state IN ('inflight', 'finalizing')
   AND (
     (ctx#>>'{remoteDriverV4,scope,operationId}' || ':' || COALESCE(ctx#>>'{remoteDriverV4,scope,generation}', '')) = ANY($1::text[])
     OR (ctx#>>'{remoteNative,scope,operationId}' || ':' || COALESCE(ctx#>>'{remoteNative,scope,generation}', '')) = ANY($1::text[])
   )`

export async function countOwnUnsettledJournals(
  pool: RemoteRelayQueryPoolLike,
  tracker: OwnLaneGenerationTracker,
): Promise<number> {
  const keys = tracker.scopedKeys()
  if (keys.length === 0) return 0
  const res = await pool.query<{ scoped_key?: string; cnt?: string }>(OWN_UNSETTLED_JOURNALS_SQL, [
    keys,
  ])
  if (res.rows.length === 0) {
    tracker.pruneSettledKeys(new Set())
    return 0
  }
  const first = res.rows[0]
  if (first && typeof first.cnt === 'string' && first.scoped_key === undefined) {
    const count = Number(first.cnt)
    const normalized = Number.isSafeInteger(count) && count >= 0 ? count : 0
    if (normalized === 0) {
      tracker.pruneSettledKeys(new Set())
    }
    return normalized
  }
  const unsettled = new Set<string>()
  for (const row of res.rows) {
    if (typeof row.scoped_key === 'string' && row.scoped_key.length > 0) {
      unsettled.add(row.scoped_key)
    }
  }
  tracker.pruneSettledKeys(unsettled)
  return unsettled.size
}

function isUnixSocketAcceptingConnections(sockPath: string, timeoutMs = 400): Promise<boolean> {
  return new Promise<boolean>((resolveProbe) => {
    let settled = false
    const finish = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveProbe(alive)
    }
    const sock = createConnection(sockPath)
    sock.once('connect', () => {
      sock.destroy()
      finish(true)
    })
    sock.once('error', (err: NodeJS.ErrnoException) => {
      sock.destroy()
      // Only ENOENT / ECONNREFUSED prove no live listener; EACCES/EPERM/other fail-closed as live.
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') {
        finish(false)
      } else {
        finish(true)
      }
    })
    const timer = setTimeout(() => {
      sock.destroy()
      finish(true)
    }, timeoutMs)
    timer.unref?.()
  })
}

export interface ActiveSymlinkReconcileResult {
  readonly action:
    | 'restored'
    | 'kept_live_peer'
    | 'skipped_not_active_slot'
    | 'skipped_unmigrated'
    | 'skipped_not_ready'
    | 'error'
  readonly activeSocketPath: string
  readonly targetSocketPath: string
  readonly reason?: string
}

/**
 * B10: Cold-start recovery of `remote-relay-active.sock`.
 * Restores the symlink ONLY when this slot is ready, persisted state confirms
 * `migrated === true && activeSlot === slot`, and the active symlink is missing,
 * dangling, or points to a non-listening socket. NEVER preempts a live peer slot.
 */
export async function reconcileActiveSymlinkOnStartup(args: {
  readonly slot: RemoteRelaySlot | null
  readonly runtimeState: RemoteRelayRuntimeState
  readonly slotSocketPath: string
  readonly activeSocketPath: string
  readonly stateFilePath: string
  readonly probeSocketAlive?: (sockPath: string) => Promise<boolean>
  readonly logger?: RemoteRelayLogger
}): Promise<ActiveSymlinkReconcileResult> {
  if (args.runtimeState !== 'ready' || !args.slot) {
    return {
      action: 'skipped_not_ready',
      activeSocketPath: args.activeSocketPath,
      targetSocketPath: args.slotSocketPath,
    }
  }
  if (!existsSync(args.stateFilePath)) {
    return {
      action: 'skipped_unmigrated',
      activeSocketPath: args.activeSocketPath,
      targetSocketPath: args.slotSocketPath,
    }
  }

  let state: { migrated?: unknown; activeSlot?: unknown }
  try {
    const parsed = JSON.parse(readFileSync(args.stateFilePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        action: 'error',
        activeSocketPath: args.activeSocketPath,
        targetSocketPath: args.slotSocketPath,
        reason: 'state_file_not_object',
      }
    }
    state = parsed as { migrated?: unknown; activeSlot?: unknown }
  } catch (err) {
    return {
      action: 'error',
      activeSocketPath: args.activeSocketPath,
      targetSocketPath: args.slotSocketPath,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  if (state.migrated !== true || state.activeSlot !== args.slot) {
    return {
      action: 'skipped_not_active_slot',
      activeSocketPath: args.activeSocketPath,
      targetSocketPath: args.slotSocketPath,
    }
  }

  const probe = args.probeSocketAlive ?? isUnixSocketAcceptingConnections
  let existingLinkTarget: string | null = null
  let existingPresent = false
  try {
    const st = lstatSync(args.activeSocketPath)
    existingPresent = true
    if (st.isSymbolicLink()) {
      const rawTarget = readlinkSync(args.activeSocketPath)
      existingLinkTarget = resolve(dirname(args.activeSocketPath), rawTarget)
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT') {
      return {
        action: 'error',
        activeSocketPath: args.activeSocketPath,
        targetSocketPath: args.slotSocketPath,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  const resolvedSelf = resolve(args.slotSocketPath)
  if (existingPresent && existingLinkTarget !== resolvedSelf) {
    const aliveTarget = existingLinkTarget ?? args.activeSocketPath
    if (existsSync(aliveTarget) && (await probe(aliveTarget))) {
      args.logger?.warn?.('remote_relay_active_symlink_kept_live_peer', {
        slot: args.slot,
        activeSocketPath: args.activeSocketPath,
        existingLinkTarget,
      })
      return {
        action: 'kept_live_peer',
        activeSocketPath: args.activeSocketPath,
        targetSocketPath: args.slotSocketPath,
      }
    }
  }

  const parent = dirname(args.activeSocketPath)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
  const tmpLink = `${args.activeSocketPath}.tmp.${process.pid}.${Date.now()}`
  try {
    rmSync(tmpLink, { force: true })
    symlinkSync(args.slotSocketPath, tmpLink)
    renameSync(tmpLink, args.activeSocketPath)
  } catch (err) {
    rmSync(tmpLink, { force: true })
    return {
      action: 'error',
      activeSocketPath: args.activeSocketPath,
      targetSocketPath: args.slotSocketPath,
      reason: err instanceof Error ? err.message : String(err),
    }
  }

  args.logger?.info?.('remote_relay_active_symlink_restored', {
    slot: args.slot,
    activeSocketPath: args.activeSocketPath,
    targetSocketPath: args.slotSocketPath,
  })
  return {
    action: 'restored',
    activeSocketPath: args.activeSocketPath,
    targetSocketPath: args.slotSocketPath,
  }
}

export interface GracefulShutdownDrainOutcome {
  readonly drained: boolean
  readonly keptAlive: boolean
  readonly cancelled?: boolean
  readonly exitCode: 0 | typeof REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE
  readonly elapsedMs: number
  readonly activeRelayCount: number
  readonly inFlightRpcCount: number
  readonly ownUnsettled: number
  readonly timeoutMarkerPath?: string
}

function writeAtomicJsonMarker(filePath: string, payload: Record<string, unknown>): void {
  const parent = dirname(filePath)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 })
  }
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmpPath, filePath)
}

/**
 * B3 + B4: Executes bounded graceful drain for `remote-relay` retirement or shutdown.
 * - Normal completion (`inFlightRpcCount === 0 && activeRelayCount === 0 && ownUnsettled === 0`):
 *   drains own idle lanes, re-verifies zero unsettled journals, closes RPC server (unlinking
 *   ONLY own slot socket), closes Redis/PG, and returns `{ drained: true, keptAlive: false, exitCode: 0 }`.
 * - Timeout when `keepAliveOnTimeout === true` (normal blue-green online self-drain):
 *   atomically writes the alert marker and logs an error, **keeps the process, RPC server,
 *   billing connections, and live SSH lanes intact** (`keptAlive: true`), and returns without
 *   terminating active turns.
 * - Timeout when `keepAliveOnTimeout !== true` (explicit SIGTERM/SIGINT):
 *   NEVER calls `drainOwnIdleAndOwnedLanes()`, writes timeout marker, returns `exitCode: 79`.
 */
export async function executeGracefulShutdownDrain(args: {
  readonly slot: RemoteRelaySlot | null
  readonly instanceId: string
  readonly drainMs: number
  readonly pollIntervalMs?: number
  readonly drainTimeoutFilePath: string
  readonly keepAliveOnTimeout?: boolean
  readonly isCancelled?: () => boolean
  readonly rpcServer: Pick<
    RemoteRelayRpcServerHandle,
    'beginDrain' | 'getInFlightRpcCount' | 'close'
  >
  readonly drainGate: Pick<
    RemoteReleaseDrainCoordinator,
    'activeRelayCount' | 'registeredRelayCount'
  >
  readonly runtime: Pick<RemoteRelayRuntimeLike, 'drainOwnIdleAndOwnedLanes'> | undefined
  readonly countOwnUnsettled: () => Promise<number>
  readonly closeResources?: () => Promise<void>
  readonly logger?: RemoteRelayLogger
}): Promise<GracefulShutdownDrainOutcome> {
  args.rpcServer.beginDrain()
  const startedAt = Date.now()
  const pollMs = Math.max(10, Math.min(250, Math.floor(args.pollIntervalMs ?? 250)))

  let drained = false
  let lastOwnUnsettled = 0

  while (true) {
    if (args.isCancelled?.()) {
      return {
        drained: false,
        keptAlive: true,
        cancelled: true,
        exitCode: 0,
        elapsedMs: Date.now() - startedAt,
        activeRelayCount: args.drainGate.activeRelayCount,
        inFlightRpcCount: args.rpcServer.getInFlightRpcCount(),
        ownUnsettled: lastOwnUnsettled,
      }
    }
    const inFlight = args.rpcServer.getInFlightRpcCount()
    const activeRelays = args.drainGate.activeRelayCount
    if (inFlight === 0 && activeRelays === 0) {
      try {
        lastOwnUnsettled = await args.countOwnUnsettled()
      } catch (err) {
        args.logger?.warn?.('remote_relay_shutdown_journal_check_failed', {
          err: err instanceof Error ? err.message : String(err),
        })
        lastOwnUnsettled = 1
      }
      if (
        lastOwnUnsettled === 0 &&
        args.rpcServer.getInFlightRpcCount() === 0 &&
        args.drainGate.activeRelayCount === 0
      ) {
        drained = true
        break
      }
    }
    if (Date.now() - startedAt >= args.drainMs) {
      break
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }

  const elapsedMs = Date.now() - startedAt
  const finalActiveRelays = args.drainGate.activeRelayCount
  const finalInFlightRpc = args.rpcServer.getInFlightRpcCount()

  if (!drained) {
    // Re-sample unsettled count if we never reached the idle check branch.
    if (finalActiveRelays > 0 || finalInFlightRpc > 0) {
      try {
        lastOwnUnsettled = await args.countOwnUnsettled()
      } catch {
        lastOwnUnsettled = -1
      }
    }
    const marker = {
      slot: args.slot,
      instanceId: args.instanceId,
      pid: process.pid,
      activeRelayCount: finalActiveRelays,
      registeredRelayCount: args.drainGate.registeredRelayCount,
      ownUnsettled: lastOwnUnsettled,
      inFlightRpcCount: finalInFlightRpc,
      keepAliveOnTimeout: args.keepAliveOnTimeout === true,
      elapsedMs,
      timedOutAt: new Date().toISOString(),
    }
    try {
      writeAtomicJsonMarker(args.drainTimeoutFilePath, marker)
    } catch (err) {
      args.logger?.error?.('remote_relay_drain_timeout_marker_write_failed', {
        path: args.drainTimeoutFilePath,
        err: err instanceof Error ? err.message : String(err),
      })
    }
    args.logger?.error?.('remote_relay_shutdown_drain_timeout', marker)

    if (args.keepAliveOnTimeout === true) {
      // B3: Online self-drain timeout NEVER exits or closes resources — keep the old slot
      // alive so long-running SSH turns continue uninterrupted until they finish & settle.
      return {
        drained: false,
        keptAlive: true,
        exitCode: REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE,
        elapsedMs,
        activeRelayCount: finalActiveRelays,
        inFlightRpcCount: finalInFlightRpc,
        ownUnsettled: lastOwnUnsettled,
        timeoutMarkerPath: args.drainTimeoutFilePath,
      }
    }

    // Explicit SIGTERM/SIGINT timeout: NEVER call drainOwnIdleAndOwnedLanes() to force-kill SSH.
    try {
      await args.rpcServer.close({ unlinkSocket: true })
    } catch {
      // Best-effort RPC socket close on timeout exit
    }
    try {
      await args.closeResources?.()
    } catch {
      // Best-effort resource cleanup
    }
    return {
      drained: false,
      keptAlive: false,
      exitCode: REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE,
      elapsedMs,
      activeRelayCount: finalActiveRelays,
      inFlightRpcCount: finalInFlightRpc,
      ownUnsettled: lastOwnUnsettled,
      timeoutMarkerPath: args.drainTimeoutFilePath,
    }
  }

  try {
    await args.runtime?.drainOwnIdleAndOwnedLanes?.()
  } catch (err) {
    args.logger?.warn?.('remote_relay_drain_own_lanes_failed', {
      err: err instanceof Error ? err.message : String(err),
    })
  }

  // B3: Final settlement re-check right before process exit.
  let finalUnsettled = 0
  try {
    finalUnsettled = await args.countOwnUnsettled()
  } catch {
    finalUnsettled = 1
  }
  if (
    finalUnsettled > 0 ||
    args.drainGate.activeRelayCount > 0 ||
    args.rpcServer.getInFlightRpcCount() > 0
  ) {
    if (args.keepAliveOnTimeout === true) {
      return {
        drained: false,
        keptAlive: true,
        exitCode: REMOTE_RELAY_DRAIN_TIMEOUT_EXIT_CODE,
        elapsedMs: Date.now() - startedAt,
        activeRelayCount: args.drainGate.activeRelayCount,
        inFlightRpcCount: args.rpcServer.getInFlightRpcCount(),
        ownUnsettled: finalUnsettled,
      }
    }
  }

  // Unlink ONLY this slot's own socket; NEVER touch remote-relay-active.sock!
  try {
    await args.rpcServer.close({ unlinkSocket: true })
  } catch {
    // Best-effort close on exit
  }
  try {
    await args.closeResources?.()
  } catch {
    // Best-effort resource cleanup
  }
  return {
    drained: true,
    keptAlive: false,
    exitCode: 0,
    elapsedMs: Date.now() - startedAt,
    activeRelayCount: 0,
    inFlightRpcCount: 0,
    ownUnsettled: 0,
  }
}

async function resolveDriverV4Selection(
  pool: Pool,
  request: {
    uid: number
    sessionKey: string
    canonicalModel: string
    engine?: 'ccb' | 'codex' | 'antigravity'
  },
): Promise<string | null> {
  const authEngine = request.engine ?? 'ccb'
  const legacyBindEngine = legacyBindingEngineForAuthority(authEngine)
  const legacyProfEngine = legacyProfileEngineForAuthority(authEngine)
  const regMap = loadRemoteDriverRegistry()
  const stickyRows = (
    await pool.query<{ driver_id: string | null }>(
      `SELECT driver_id
         FROM remote_agent_bindings
        WHERE uid = $1
          AND session_key = $2
          AND driver_id IS NOT NULL
          AND engine = $3
        ORDER BY updated_at DESC
        LIMIT 8`,
      [String(request.uid), request.sessionKey, legacyBindEngine],
    )
  ).rows
  for (const sticky of stickyRows) {
    const did = sticky?.driver_id ? String(sticky.driver_id) : ''
    if (did && regMap.get(did)?.authorityEngine === authEngine) {
      return did
    }
  }

  const offer = (
    await pool.query<{ driver_id: string }>(
      `SELECT p.driver_id
         FROM remote_model_offers o
         JOIN remote_agent_profiles p ON p.id = o.profile_id
         JOIN remote_agent_nodes n ON n.id = p.node_id
        WHERE o.canonical_model_id = $1
          AND o.enabled = TRUE
          AND p.driver_id IS NOT NULL
          AND p.engine = $2
          AND p.status IN ('active', 'degraded')
          AND (p.disabled_by IS NULL OR p.disabled_by <> 'admin')
          AND n.status IN ('active', 'degraded')
          AND (n.disabled_by IS NULL OR n.disabled_by <> 'admin')
          AND (
            p.execution_ready = TRUE
            OR p.verified_fingerprint IS NOT NULL
            OR NOT EXISTS (
              SELECT 1
                FROM remote_model_offers o_leg
                JOIN remote_agent_profiles p_leg ON p_leg.id = o_leg.profile_id
                JOIN remote_agent_nodes n_leg ON n_leg.id = p_leg.node_id
               WHERE o_leg.canonical_model_id = $1
                 AND o_leg.enabled = TRUE
                 AND p_leg.driver_id IS NULL
                 AND p_leg.engine = $2
                 AND p_leg.status IN ('active', 'degraded')
                 AND (p_leg.disabled_by IS NULL OR p_leg.disabled_by <> 'admin')
                 AND n_leg.status IN ('active', 'degraded')
                 AND (n_leg.disabled_by IS NULL OR n_leg.disabled_by <> 'admin')
            )
          )
        ORDER BY p.execution_ready DESC, p.weight DESC, p.id ASC
        LIMIT 1`,
      [request.canonicalModel, legacyProfEngine],
    )
  ).rows[0]
  return offer?.driver_id ?? null
}

type DualSlotConfiguration = ReturnType<
  Parameters<typeof createRemoteLaneRuntime>[0]['configuration']
> & {
  readonly ownerSlot?: string
  readonly ownerInstanceId?: string
  readonly peerSessionHandover?: (input: {
    readonly sessionKey: string
    readonly operationId: string
    readonly ownerSlot: string
    readonly ownerPid: number
  }) => Promise<'released' | 'busy' | 'unavailable'>
}

export async function startRemoteRelayDaemon(): Promise<void> {
  configureModelAvailability(assertFlavorIdentity())
  assertModelAuthorityCutoverFloor()

  const cfg = loadConfig()
  const secret = (cfg.OC_EGRESS_SECRET ?? process.env.OC_EGRESS_SECRET ?? '').trim()
  if (!secret) {
    throw new Error('[remote-relay] OC_EGRESS_SECRET is required, refusing to start')
  }

  const rawSlot = process.env[REMOTE_RELAY_SLOT_ENV]?.trim()
  let slot: RemoteRelaySlot | null = null
  if (rawSlot && rawSlot.length > 0) {
    slot = parseRemoteRelaySlot(rawSlot)
    if (!slot) {
      throw new Error(
        `[remote-relay] invalid ${REMOTE_RELAY_SLOT_ENV}=${rawSlot} (expected A or B)`,
      )
    }
  }

  const sockPrefix =
    process.env[REMOTE_RELAY_SLOT_SOCK_PREFIX_ENV]?.trim() ||
    DEFAULT_REMOTE_RELAY_SLOT_SOCK_PREFIX
  const slotSocketPath = remoteRelaySlotSocketPath(slot, sockPrefix)
  const peerSocketPath = slot ? remoteRelaySlotSocketPath(peerRemoteRelaySlot(slot), sockPrefix) : null
  const activeSocketPath =
    process.env[REMOTE_RELAY_SOCKET_ENV]?.trim() || DEFAULT_REMOTE_RELAY_ACTIVE_SOCKET
  const stateFilePath =
    process.env[REMOTE_RELAY_STATE_FILE_ENV]?.trim() || DEFAULT_REMOTE_RELAY_STATE_FILE
  const drainTimeoutFilePath =
    process.env[REMOTE_RELAY_DRAIN_TIMEOUT_FILE_ENV]?.trim() ||
    DEFAULT_REMOTE_RELAY_DRAIN_TIMEOUT_FILE
  const drainMs = parseDrainMs(process.env[REMOTE_RELAY_DRAIN_MS_ENV])
  const instanceId = process.env.INVOCATION_ID?.trim() || randomUUID()

  const redis = new IORedis(cfg.REDIS_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  })
  const preCheckRedis = wrapIoredisForPreCheck(redis)
  const pool = getPool()
  const modelCatalog = await getModelCatalogCache()
  const keyring = authorityKeyringProvider()
  const loadUserModelAuthz = makeLoadUserModelAuthz()

  const peerClient = peerSocketPath
    ? createRemoteRelayPeerClient({
        socketPath: peerSocketPath,
        secret,
        timeoutMs: 3_000,
      })
    : undefined

  const drainGate = new RemoteReleaseDrainCoordinator()
  const controllerPath = resolveControllerPath()
  const baseRoot = process.env[REMOTE_RELAY_BASE_ROOT_ENV]?.trim() || DEFAULT_BASE_ROOT
  const evidenceRoot = process.env[REMOTE_RELAY_EVIDENCE_ROOT_ENV]?.trim() || DEFAULT_EVIDENCE_ROOT
  const ownLaneGenerations = new OwnLaneGenerationTracker()
  let shuttingDown = false

  const runPlaceOnce = async (request: {
    engine?: 'ccb' | 'codex' | 'antigravity'
    uid: number
    containerDbId: string
    dockerId: string
    sessionKey: string
    canonicalModel: string
    allowStickyFailover?: boolean
  }) => {
    if (isReservedVerificationSessionKey(request.sessionKey)) {
      throw new Error('REMOTE_SESSION_KEY_RESERVED')
    }
    if (shuttingDown) {
      throw new Error('REMOTE_POOL_DRAINING_RETRY_LATER')
    }
    drainGate.assertAdmissionOpen()
    const driverId = await resolveDriverV4Selection(pool, request)
    if (driverId) {
      const v4 = await placeRemoteDriverLane(
        {
          uid: request.uid,
          containerDbId: request.containerDbId,
          dockerId: request.dockerId,
          sessionKey: request.sessionKey,
          canonicalModel: request.canonicalModel,
          driverId,
        },
        {
          pool,
          drainGate,
          ...(request.allowStickyFailover === true ? { allowStickyFailover: true } : {}),
        },
      )
      ownLaneGenerations.record(v4.binding.operationId, v4.generation)
      return {
        target: v4.sshTarget,
        taskRoot: v4.spec.manifest.root,
        operationId: v4.binding.operationId,
        runId: v4.binding.runId,
        provisionPacket: Buffer.alloc(0),
        profileId: v4.profileUuid,
        generation: v4.generation,
        v4: {
          binding: v4.binding,
          spec: v4.spec,
          sshTarget: v4.sshTarget,
        },
      }
    }
    const requestedEngine = request.engine
    if (requestedEngine !== undefined && !isLegacyRemoteEngine(requestedEngine)) {
      throw new Error('REMOTE_LANE_UNAVAILABLE')
    }
    const legacy = await placeRemoteLane(
      {
        ...request,
        engine: requestedEngine,
      },
      { controllerPath, pool },
    )
    ownLaneGenerations.record(legacy.operationId, legacy.generation)
    return legacy
  }

  // B6: Distinguish intentionally-disabled feature from enabled-but-broken runtime init.
  const policyEnv = process.env as Cc5PolicyEnvironment
  const cc5FeatureEnabled = canUseCc5TestModel(policyEnv[CC5_TEST_UID_ENV], policyEnv)
  let runtime: RemoteRelayRuntimeLike | undefined
  let runtimeState: RemoteRelayRuntimeState

  if (!cc5FeatureEnabled) {
    runtime = undefined
    runtimeState = 'disabled'
  } else {
    try {
      const built: RemoteLaneRuntimePort | undefined = createRemoteLaneRuntime({
        selfhost: true,
        env: policyEnv,
        financeFactory: (binding, lane) => {
          if (binding?.operationId) {
            const gen =
              'generation' in binding && typeof binding.generation === 'string'
                ? binding.generation
                : undefined
            ownLaneGenerations.record(binding.operationId, gen)
          }
          return createRemoteNativeTurnFinance({
            pool,
            preCheckRedis,
            catalog: modelCatalog,
            keyring,
            loadUserModelAuthz,
            log: rootLogger.child({ subsys: 'remoteNativeBilling' }),
            upstreamModel: lane.upstreamModel,
          })
        },
        configuration: (): DualSlotConfiguration => ({
          baseRoot,
          controllerPath,
          evidenceRoot,
          ownerSlot: slot ?? 'single',
          ownerInstanceId: instanceId,
          ...(peerClient
            ? {
                peerSessionHandover: async (input) => {
                  const res = await peerClient.releaseSessionIfIdle(input.sessionKey, {
                    operationId: input.operationId,
                  })
                  if (!res) return 'unavailable'
                  if (res.status === 'released' || res.status === 'not_found') return 'released'
                  if (res.status === 'busy') return 'busy'
                  return 'unavailable'
                },
              }
            : {}),
        }),
        hooks: {
          place: async (request) => {
            try {
              return await runPlaceOnce(request)
            } catch (error) {
              const code = error instanceof Error ? error.message : ''
              if (code === 'REMOTE_LANE_STOP_UNPROVEN') {
                await reconcileRemoteChat(pool, request.uid, request.sessionKey)
              } else if (
                code !== 'REMOTE_LANE_CAPACITY_EXHAUSTED' ||
                !(await reconcileStaleContainerLanes(pool, request.uid, request.dockerId))
              ) {
                throw error
              }
              return runPlaceOnce(request)
            }
          },
          onState: async (operationId, state, generation, isV4) => {
            if (isV4) {
              await recordRemoteDriverLaneState(operationId, generation!, state, pool)
            } else {
              await recordRemoteLaneState(operationId, state, pool, generation)
            }
            if (state === 'released') {
              ownLaneGenerations.release(operationId, generation)
            }
          },
          onRemoteStart: (operationId, generation, isV4) =>
            isV4
              ? recordRemoteDriverStartAttempt(operationId, generation, pool)
              : recordRemoteStartAttempt(operationId, generation, pool),
          onNativeThread: (operationId, generation, id, isV4) =>
            isV4
              ? recordRemoteDriverNativeSession(operationId, generation, id, pool)
              : recordRemoteNativeThread(operationId, generation, id, pool),
          registerDrainRelay: (id, relay) => drainGate.registerRelay(id, relay),
        },
      })
      if (built) {
        runtime = built as RemoteRelayRuntimeLike
        runtimeState = 'ready'
      } else {
        runtime = undefined
        runtimeState = 'error'
      }
    } catch (err) {
      log.error('remote_relay_runtime_init_failed', {
        err: err instanceof Error ? err.message : String(err),
      })
      runtime = undefined
      runtimeState = 'error'
    }
  }

  let onlineSelfDrainActive = false
  let onlineSelfDrainGeneration = 0
  const closeDaemonResources = async () => {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
    try {
      await closePool()
    } catch {
      // Best-effort PG pool close
    }
  }

  const startOnlineSelfDrain = () => {
    if (shuttingDown || onlineSelfDrainActive) return
    onlineSelfDrainActive = true
    const myGen = ++onlineSelfDrainGeneration
    log.info('remote_relay_online_self_drain_start', {
      slot,
      instanceId,
      activeRelayCount: drainGate.activeRelayCount,
      registeredRelayCount: drainGate.registeredRelayCount,
      inFlightRpcCount: rpcServer.getInFlightRpcCount(),
      drainMs,
    })

    void (async () => {
      // First pass: bounded wait up to drainMs; on timeout, write alert marker and KEEP ALIVE
      // (never exit / never trigger systemd SIGKILL while live SSH turns are still running).
      while (!shuttingDown && onlineSelfDrainActive && onlineSelfDrainGeneration === myGen) {
        const outcome = await executeGracefulShutdownDrain({
          slot,
          instanceId,
          drainMs,
          drainTimeoutFilePath,
          keepAliveOnTimeout: true,
          isCancelled: () => shuttingDown || !onlineSelfDrainActive || onlineSelfDrainGeneration !== myGen,
          rpcServer,
          drainGate,
          runtime,
          countOwnUnsettled: () => countOwnUnsettledJournals(pool, ownLaneGenerations),
          closeResources: closeDaemonResources,
          logger: log,
        })
        if (outcome.cancelled) return
        if (outcome.drained && !outcome.keptAlive) {
          log.info('remote_relay_online_self_drain_exiting_clean', {
            slot,
            instanceId,
            elapsedMs: outcome.elapsedMs,
          })
          process.exit(0)
        }
        // Still live past drainMs: stay alive and continue polling until turns finish naturally.
        await new Promise((r) => setTimeout(r, 2_000))
      }
    })()
  }

  const rpcServer = await createRemoteRelayRpcServer({
    socketPath: slotSocketPath,
    secret,
    slot,
    instanceId,
    runtime,
    runtimeState,
    drainGate,
    pool: () => pool,
    peerClient,
    peerSocketPath: peerSocketPath ?? undefined,
    isDrainingForShutdown: () => shuttingDown,
    onDrainBegin: (opts) => {
      if (opts?.exitWhenDrained === true) {
        startOnlineSelfDrain()
      }
    },
    onReopen: () => {
      onlineSelfDrainActive = false
      onlineSelfDrainGeneration += 1
    },
    logger: log,
  })

  // B10: Restore active symlink after host reboot if persisted state identifies this slot as active
  // and no live peer currently owns the active socket.
  const symlinkReconcile = await reconcileActiveSymlinkOnStartup({
    slot,
    runtimeState,
    slotSocketPath,
    activeSocketPath,
    stateFilePath,
    logger: log,
  })

  log.info('remote_relay_listening', {
    slot,
    instanceId,
    pid: process.pid,
    socketPath: slotSocketPath,
    peerSocketPath,
    runtimeState,
    remoteRuntimeReady: Boolean(runtime),
    symlinkReconcile: symlinkReconcile.action,
  })
  // eslint-disable-next-line no-console
  console.log(
    `[remote-relay] listening on ${slotSocketPath} (slot=${slot ?? 'single'}, instance=${instanceId}, state=${runtimeState}, symlink=${symlinkReconcile.action})`,
  )

  const shutdown = (signal: string) => {
    if (shuttingDown) return
    shuttingDown = true
    onlineSelfDrainActive = false
    onlineSelfDrainGeneration += 1
    log.info('remote_relay_shutdown_drain_start', {
      signal,
      slot,
      instanceId,
      activeRelayCount: drainGate.activeRelayCount,
      registeredRelayCount: drainGate.registeredRelayCount,
      inFlightRpcCount: rpcServer.getInFlightRpcCount(),
      drainMs,
    })

    void executeGracefulShutdownDrain({
      slot,
      instanceId,
      drainMs,
      drainTimeoutFilePath,
      keepAliveOnTimeout: false,
      rpcServer,
      drainGate,
      runtime,
      countOwnUnsettled: () => countOwnUnsettledJournals(pool, ownLaneGenerations),
      closeResources: closeDaemonResources,
      logger: log,
    }).then((outcome) => {
      process.exit(outcome.exitCode)
    })
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'))
  process.on('SIGINT', () => shutdown('SIGINT'))
}

const isDirectRun =
  process.argv[1]?.endsWith('remoteRelay/main.ts') ||
  process.argv[1]?.endsWith('remoteRelay/main.js')
if (isDirectRun) {
  startRemoteRelayDaemon().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[remote-relay] fatal:', err)
    process.exit(1)
  })
}
