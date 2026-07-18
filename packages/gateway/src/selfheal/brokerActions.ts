/**
 * Self-heal broker — Tier1 deterministic action allowlist.
 *
 * Tier1 = bounded, deterministic ops (service restart / disk cleanup / proxy
 * node switch) that the root-side broker performs on behalf of a repair. They
 * are NOT free-form: every action has a strict param validator and a fixed,
 * shell-free command. The unprivileged `ocheal` codex can only REQUEST an
 * action by kind+params over the broker socket; it can never run `systemctl` /
 * `docker` / deploy itself. Anything not in this registry is rejected.
 *
 * Design notes:
 *  - Executors receive an injectable `run` (no shell — args are an array), so
 *    tests exercise the validation + routing without touching the real system.
 *  - `restart_service` only accepts units in an env-provided allowlist
 *    (OC_SELFHEAL_RESTART_UNITS). Empty allowlist ⇒ every unit rejected — the
 *    safe default until block C explicitly opts units in.
 *  - Global disk cleanup is intentionally absent: neither Docker's global
 *    object graph nor the shared journal is scoped to a single V5 repair.
 *  - `switch_node` is a reserved interface: params are validated but the actual
 *    egress switch integrates with egressSubscription (block C); until wired it
 *    returns `status: 'reserved'` rather than pretending to act.
 */

import type { Logger } from '../logger.js'

/** Result of a Tier1 action. `ok=false` with a status describes a controlled
 *  rejection/no-op (not a thrown error). */
export interface BrokerActionResult {
  ok: boolean
  /** Machine-readable outcome, e.g. 'restarted' | 'cleaned' | 'reserved'. */
  status: string
  detail?: Record<string, unknown>
}

/** Outcome of running an external command. */
export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/** Optional per-command execution controls. */
export interface RunOpts {
  /** Drop the child process to this uid. Set for steps that execute
   *  candidate-controlled code (verify layers, bundle export) so they run as the
   *  unprivileged `ocheal`, never root. Omitted ⇒ inherit the broker's uid. */
  uid?: number
  /** Drop the child process to this gid (paired with {@link RunOpts.uid}). */
  gid?: number
  /** Working directory for the child. */
  cwd?: string
  /** Explicit child environment (replaces inheritance). Security-sensitive
   *  callers pass a curated, secret-free env; the default runner additionally
   *  scrubs `OC_SELFHEAL_*` whenever a uid drop is requested. */
  env?: NodeJS.ProcessEnv
}

/** Injectable, shell-free command runner. Args MUST be passed as an array (no
 *  string interpolation, no shell) — this is a security invariant. The optional
 *  {@link RunOpts} lets security-sensitive callers drop privileges (uid/gid) and
 *  set a cwd; the default runner also scrubs `OC_SELFHEAL_*` secrets from the
 *  child env whenever a uid drop is requested, so de-privileged candidate code
 *  can never read the verification HMAC / capability keys. */
export type CommandRunner = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>

export interface BrokerActionExecContext {
  run: CommandRunner
  log: Logger
}

export interface BrokerActionDef<P = unknown> {
  kind: string
  /** Strict schema validation. Throws {@link BrokerActionError} on any
   *  deviation (unknown fields, wrong types, disallowed values). Returns the
   *  narrowed, validated params on success. */
  validate: (rawParams: unknown) => P
  execute: (params: P, ctx: BrokerActionExecContext) => Promise<BrokerActionResult>
}

/** Thrown when an action's params fail validation. The broker maps this to a
 *  clean `{ ok: false, status: 'rejected' }` response (never a stack trace to
 *  the caller). */
export class BrokerActionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BrokerActionError'
  }
}

// ── tiny hand-rolled validators (no zod dependency in gateway) ───────────────

function asObject(raw: unknown, allowedKeys: string[]): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BrokerActionError('params must be a JSON object')
  }
  const obj = raw as Record<string, unknown>
  for (const k of Object.keys(obj)) {
    if (!allowedKeys.includes(k)) {
      throw new BrokerActionError(`unexpected param "${k}"`)
    }
  }
  return obj
}

function requireString(obj: Record<string, unknown>, key: string): string {
  const v = obj[key]
  if (typeof v !== 'string' || v.length === 0) {
    throw new BrokerActionError(`param "${key}" must be a non-empty string`)
  }
  return v
}

function optionalString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string' || v.length === 0) {
    throw new BrokerActionError(`param "${key}" must be a non-empty string when present`)
  }
  return v
}

/** Systemd unit allowlist, env-driven. Empty ⇒ nothing may be restarted. */
export function restartUnitAllowlist(): string[] {
  return (process.env.OC_SELFHEAL_RESTART_UNITS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── Tier1 action definitions ─────────────────────────────────────────────────

interface RestartServiceParams {
  unit: string
}

const restartService: BrokerActionDef<RestartServiceParams> = {
  kind: 'restart_service',
  validate(raw) {
    const obj = asObject(raw, ['unit'])
    const unit = requireString(obj, 'unit')
    // Defense in depth: reject shell/path metacharacters before the allowlist
    // check so a malformed unit can never reach execFile even if mis-allowlisted.
    if (!/^[A-Za-z0-9@._-]+$/.test(unit)) {
      throw new BrokerActionError('param "unit" contains illegal characters')
    }
    const allow = restartUnitAllowlist()
    if (!allow.includes(unit)) {
      throw new BrokerActionError(`unit "${unit}" is not in OC_SELFHEAL_RESTART_UNITS allowlist`)
    }
    return { unit }
  },
  async execute(params, ctx) {
    const r = await ctx.run('systemctl', ['restart', params.unit])
    if (r.code !== 0) {
      return {
        ok: false,
        status: 'restart_failed',
        detail: { unit: params.unit, code: r.code, stderr: r.stderr.slice(0, 500) },
      }
    }
    return { ok: true, status: 'restarted', detail: { unit: params.unit } }
  },
}

interface SwitchNodeParams {
  node?: string
}

const switchNode: BrokerActionDef<SwitchNodeParams> = {
  kind: 'switch_node',
  validate(raw) {
    const obj = asObject(raw, ['node'])
    const node = optionalString(obj, 'node')
    if (node !== undefined && !/^[A-Za-z0-9._-]+$/.test(node)) {
      throw new BrokerActionError('param "node" contains illegal characters')
    }
    return { node }
  },
  async execute(params, ctx) {
    // Reserved interface: the real egress switch is owned by egressSubscription
    // (block C). Validate + record intent, but do not fake an action.
    ctx.log.info('switch_node requested (reserved — no live egress switch yet)', {
      node: params.node,
    })
    return { ok: false, status: 'reserved', detail: { node: params.node ?? null } }
  },
}

/** The Tier1 allowlist registry. Anything not keyed here is rejected. */
export const TIER1_ACTIONS: Record<string, BrokerActionDef> = {
  [restartService.kind]: restartService as BrokerActionDef,
  [switchNode.kind]: switchNode as BrokerActionDef,
}

export const TIER1_ACTION_KINDS = Object.keys(TIER1_ACTIONS)
