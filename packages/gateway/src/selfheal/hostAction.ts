/**
 * Tier1 host action transport — runs a versioned, parameter-free opcode on the
 * v5 host (kl-mirror) via a DEDICATED restricted SSH key whose authorized_keys
 * line pins `command="/usr/local/sbin/oc-selfheal-host-action"`. The remote
 * wrapper is the OUTERMOST of three whitelists (master policy ∩ this module's
 * opcode map ∩ remote forced-command); any drift fails closed.
 *
 * Security invariants:
 *  - execFile (no shell): opcode is a single argv token, never interpolated.
 *  - Host is pinned by env to an exact alias — never a caller-supplied hostname.
 *  - Dedicated IdentityFile + IdentitiesOnly + BatchMode + StrictHostKeyChecking;
 *    the general root key is NEVER reused (a broker compromise must not become
 *    arbitrary root on kl-mirror — only these fixed opcodes).
 *  - SSH disconnect / ambiguous exit ⇒ outcome 'unknown' (never auto-replayed;
 *    the master probe fence adjudicates recovery).
 */

import { execFile } from 'node:child_process'
import { createLogger } from '../logger.js'

const log = createLogger({ module: 'selfheal-hostaction' })

/** Local (second-layer) opcode whitelist — the ONLY opcodes this module will
 *  transmit. Must stay in sync with the remote wrapper and the master policy
 *  action_opcode values; the broker additionally asserts the frozen master
 *  opcode equals the value this module maps a condition key to. */
export const TIER1_OPCODES = new Set(['restart-v5-egress-v1', 'clean-v5-disk-v1'])

/** Exact condition-key → opcode map (batch1a). Prefix conditions expand to
 *  their concrete probe keys here — an EXACT map, never a broad prefix, so a
 *  new/unknown key can never inherit an action. */
export const CONDITION_OPCODE_MAP: Record<string, string> = {
  'ops.monitor:svc_egress': 'restart-v5-egress-v1',
  'ops.monitor:http_egress': 'restart-v5-egress-v1',
  'ops.monitor:disk_root': 'clean-v5-disk-v1',
  'ops.monitor:disk_var': 'clean-v5-disk-v1',
}

export type HostActionOutcome = 'completed' | 'failed' | 'unknown'

export interface HostActionReceipt {
  opcode: string
  outcome: HostActionOutcome
  /** SSH/remote exit code (or -1 when the transport never delivered). */
  exit: number
  host: string
  startedAt: number
  finishedAt: number
  durationMs: number
  /** Parsed remote JSON detail, or raw truncated output when unparseable. */
  detail: unknown
}

const DEFAULT_TIMEOUT_MS = 90_000

export interface HostActionConfig {
  /** ssh alias/host — pinned, exact. */
  host: string
  /** dedicated private key path. */
  keyPath: string
  timeoutMs?: number
  /** injectable for tests. */
  runner?: (
    args: string[],
    timeoutMs: number,
  ) => Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>
}

/** Resolve host-action config from env; null when not provisioned (Tier1 host
 *  execution stays fail-closed until both are set). */
export function hostActionConfigFromEnv(env = process.env): HostActionConfig | null {
  const host = env.OC_SELFHEAL_ACTION_HOST?.trim()
  const keyPath = env.OC_SELFHEAL_ACTION_KEY?.trim()
  if (!host || !keyPath) return null
  // Host must be a bare ssh alias / hostname token — never an option-injection
  // vector (no leading '-', no whitespace).
  if (!/^[A-Za-z0-9._-]+$/.test(host)) {
    log.warn('OC_SELFHEAL_ACTION_HOST has an illegal shape — Tier1 host action disabled', { host })
    return null
  }
  return { host, keyPath }
}

function defaultRunner(args: string[], timeoutMs: number) {
  return new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(
    (resolve) => {
      execFile(
        'ssh',
        args,
        { timeout: timeoutMs, maxBuffer: 256 * 1024 },
        (err, stdout, stderr) => {
          const timedOut = Boolean(err && (err as { killed?: boolean }).killed)
          const code =
            err && typeof (err as { code?: unknown }).code === 'number'
              ? ((err as { code: number }).code)
              : err
                ? -1
                : 0
          resolve({ code, stdout: String(stdout), stderr: String(stderr), timedOut })
        },
      )
    },
  )
}

/**
 * Transmit a single Tier1 opcode. `startedAt` is caller-supplied (scripts have
 * no Date.now in the workflow sandbox; the broker passes real time). Returns a
 * receipt whose outcome is:
 *   - 'completed'  remote wrapper exit 0
 *   - 'failed'     remote wrapper exit >0 (action ran, did not succeed)
 *   - 'unknown'    transport never delivered a clean result (timeout/disconnect)
 * A caller MUST finalize (never auto-replay) on 'failed' or 'unknown'.
 */
export async function executeHostOpcode(
  opcode: string,
  cfg: HostActionConfig,
  now: () => number = Date.now,
): Promise<HostActionReceipt> {
  const startedAt = now()
  if (!TIER1_OPCODES.has(opcode)) {
    return {
      opcode,
      outcome: 'failed',
      exit: -1,
      host: cfg.host,
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      detail: { reason: 'opcode not in local whitelist' },
    }
  }
  const args = [
    '-i',
    cfg.keyPath,
    '-o',
    'IdentitiesOnly=yes',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=15',
    '--',
    cfg.host,
    opcode,
  ]
  const runner = cfg.runner ?? defaultRunner
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const r = await runner(args, timeoutMs)
  const finishedAt = now()
  const base = {
    opcode,
    host: cfg.host,
    exit: r.code,
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
  }
  // Timeout / transport failure with no clean remote line ⇒ unknown.
  if (r.timedOut || (r.code === -1 && !r.stdout.trim())) {
    return { ...base, outcome: 'unknown', detail: { reason: 'ssh transport timeout/disconnect', stderr: r.stderr.slice(0, 400) } }
  }
  let detail: unknown
  try {
    detail = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}')
  } catch {
    detail = { raw: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
  }
  // Remote exit 0 = completed; anything else = failed (the action was attempted;
  // never retried automatically — the master probe decides recovery).
  const outcome: HostActionOutcome = r.code === 0 ? 'completed' : 'failed'
  return { ...base, outcome, detail }
}
