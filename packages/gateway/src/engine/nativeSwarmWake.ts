/**
 * Native Antigravity swarm wake control plane & live handler registry (OCV5-932).
 *
 * Pure L2 engine helper (zero upward imports, zero file cycles):
 *   1. Shared honest wake contract (`SwarmWakeDeliveryStatus`, `SwarmWakeOutcome`,
 *      `SwarmWakeTargetContext`, `SwarmWakeTargetHandler`) consumed by `swarmCommand.ts`,
 *      `swarmCommandRoute.ts`, `antigravityDeadlockGuard.ts`, and `antigravityAdapter.ts`.
 *   2. Tokenized per-turn module-level registry keyed by normalized
 *      `(realBrainDir, conversationId.toLowerCase())` so `AntigravityAdapter` registers
 *      its live turn wake handler on watcher start and unconditionally unregisters only
 *      its own token on teardown (a stale turn's cleanup never evicts a newer turn).
 *   3. Honest native Antigravity CLI 1.x wake policy grounded in offline loopback probes
 *      against `/usr/local/bin/antigravity` 1.5.18:
 *        - External writes to `board.jsonl` are NOT watched by the CLI's in-memory
 *          `swarm_wait` notifier.
 *        - Writing a follow-up NDJSON `{"event":"user",...}` line to `proc.stdin` while
 *          the current turn has not emitted `result` does NOT wake a parked coordinator
 *          or worker (`--input-format stream-json` queues stdin sequentially until after
 *          `result`, then runs an unwanted extra turn).
 *        - Launching a second `antigravity --conversation <id> --print` process while
 *          the coordinator process is active creates an isolated split-brain process
 *          that does not wake the live process and races the shared SQLite/board files.
 *      Consequently, native CLI 1.x turns MUST NOT write speculative stdin lines or spawn
 *      split-brain processes; they report `wakeDelivery: 'board_only_unwoken'` honestly
 *      with an explicit `wakeDetail`.
 */
import { realpath as realpathAsync } from 'node:fs/promises'
import path from 'node:path'

const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type SwarmWakeDeliveryStatus = 'woken' | 'board_only_unwoken' | 'not_applicable'

export interface SwarmWakeOutcome {
  readonly status: SwarmWakeDeliveryStatus
  readonly detail?: string
}

export interface SwarmWakeTargetContext {
  readonly target: string
  readonly seq: number
  readonly channel: string
  readonly text: string
  readonly controlKind: string
  readonly targetConversationId?: string
}

export type SwarmWakeTargetHandler = (
  ctx: SwarmWakeTargetContext,
) => Promise<SwarmWakeOutcome> | SwarmWakeOutcome

export type NativeSwarmWakeHandler = SwarmWakeTargetHandler

interface RegisteredWakeEntry {
  readonly token: symbol
  readonly handler: NativeSwarmWakeHandler
}

const activeNativeSwarmWakeHandlers = new Map<string, RegisteredWakeEntry>()

function normalizeBrainDir(brainDir: string): string {
  return path.resolve(brainDir)
}

function nativeSwarmWakeKey(brainDir: string, conversationId: string): string | null {
  const trimmedBrain = brainDir.trim()
  const trimmedConv = conversationId.trim()
  if (!trimmedBrain || !CONVERSATION_ID_RE.test(trimmedConv)) return null
  return `${normalizeBrainDir(trimmedBrain)}\0${trimmedConv.toLowerCase()}`
}

export function extractMemberConversationId(
  members: Record<string, Record<string, unknown>> | undefined,
  target: string,
): string | undefined {
  if (!members || typeof members !== 'object') return undefined
  const entry = members[target]
  const raw = entry && typeof entry === 'object' ? entry.conversation_id : undefined
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return CONVERSATION_ID_RE.test(trimmed) ? trimmed : undefined
}

export async function invokeSwarmWakeTarget(
  wakeTarget: SwarmWakeTargetHandler | undefined,
  ctx: SwarmWakeTargetContext,
): Promise<{ wakeDelivery?: SwarmWakeDeliveryStatus; wakeDetail?: string }> {
  if (!wakeTarget) return {}
  try {
    const outcome = await wakeTarget(ctx)
    const status: SwarmWakeDeliveryStatus =
      outcome?.status === 'woken' ||
      outcome?.status === 'board_only_unwoken' ||
      outcome?.status === 'not_applicable'
        ? outcome.status
        : 'board_only_unwoken'
    const detail =
      typeof outcome?.detail === 'string' && outcome.detail.trim().length > 0
        ? outcome.detail.trim()
        : undefined
    return {
      wakeDelivery: status,
      ...(detail ? { wakeDetail: detail } : {}),
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const clean = msg.trim().slice(0, 120)
    return {
      wakeDelivery: 'board_only_unwoken',
      wakeDetail: clean ? `wake_handler_error:${clean}` : 'wake_handler_error',
    }
  }
}

/**
 * Register a live native Antigravity turn's wake handler under normalized
 * `(realBrainDir, conversationId.toLowerCase())`. Returns an idempotent,
 * token-checked unregister closure so a stale turn's cleanup never evicts
 * a newer turn's handler.
 */
export function registerActiveNativeSwarmWakeHandler(
  brainDir: string,
  conversationId: string,
  handler: NativeSwarmWakeHandler,
): () => void {
  const key = nativeSwarmWakeKey(brainDir, conversationId)
  if (!key) return () => {}
  const token = Symbol('nativeSwarmWakeTurn')
  activeNativeSwarmWakeHandlers.set(key, { token, handler })
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    const current = activeNativeSwarmWakeHandlers.get(key)
    if (current && current.token === token) {
      activeNativeSwarmWakeHandlers.delete(key)
    }
  }
}

export function lookupActiveNativeSwarmWakeHandler(
  brainDir: string,
  conversationId: string,
): NativeSwarmWakeHandler | null {
  const key = nativeSwarmWakeKey(brainDir, conversationId)
  if (!key) return null
  return activeNativeSwarmWakeHandlers.get(key)?.handler ?? null
}

/**
 * Create a `wakeTarget` callback for HTTP/internal route commands bound to a
 * native Antigravity swarm. Looks up the live turn handler at execution time;
 * returns `board_only_unwoken` (`no_active_native_swarm_process`) when idle/cold.
 */
export function createNativeSwarmWakeTarget(
  brainDir: string,
  conversationId: string,
): SwarmWakeTargetHandler {
  return async (ctx) => {
    let active = lookupActiveNativeSwarmWakeHandler(brainDir, conversationId)
    if (!active) {
      let realBrain: string | null = null
      try {
        realBrain = await realpathAsync(path.resolve(brainDir))
      } catch {
        realBrain = null
      }
      if (realBrain && realBrain !== path.resolve(brainDir)) {
        active = lookupActiveNativeSwarmWakeHandler(realBrain, conversationId)
      }
    }
    if (!active) {
      return {
        status: 'board_only_unwoken',
        detail: 'no_active_native_swarm_process',
      }
    }
    return active(ctx)
  }
}

/**
 * Build the turn-bound wake handler owned by `AntigravityAdapter`.
 * Always aborts/no-ops once `isInactive()` flips true (terminal, abandoned,
 * interrupted, sawResult, procClosed, or proc missing).
 */
export function createNativeAntigravityWakeHandler(opts: {
  isInactive: () => boolean
  overrideWake?: NativeSwarmWakeHandler
}): NativeSwarmWakeHandler {
  return (ctx) => {
    if (opts.isInactive()) {
      return {
        status: 'board_only_unwoken',
        detail: 'native_swarm_turn_inactive',
      }
    }
    if (opts.overrideWake) {
      return opts.overrideWake(ctx)
    }
    const targetLower = ctx.target.trim().toLowerCase()
    if (targetLower === 'coordinator' || targetLower === 'all') {
      return {
        status: 'board_only_unwoken',
        detail: 'native_cli_stdin_queued_until_result',
      }
    }
    return {
      status: 'board_only_unwoken',
      detail: 'native_worker_no_external_wake_channel',
    }
  }
}

export function activeNativeSwarmWakeHandlerCountForTests(): number {
  return activeNativeSwarmWakeHandlers.size
}

export function clearActiveNativeSwarmWakeHandlersForTests(): void {
  activeNativeSwarmWakeHandlers.clear()
}
