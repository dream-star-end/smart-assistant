/**
 * OCV5-180 B1 — exact-owner late delegate completion (pure helpers).
 *
 * A one-level delegation must only ever land as a team card on the exact
 * parent turn it was launched under ({parentSessionId, parentTurnKey,
 * turnIndex} frozen at launch). When that owner turn is already sealed
 * (its tape payload frozen by the turn-end drain), the completed group is
 * persisted as a **restricted late continuation tape** — same mechanism the
 * post-terminal Bash-tail writer uses, extended to carry exactly one
 * agent-group envelope:
 *
 *   - text='' / status='completed' / same parent session
 *   - deterministic turnKey derived from (ownerTurnKey, runId, canonical
 *     group bytes) → same logical run + same content is byte-idempotent at
 *     master finalize; master UPSERT sees the same tapeId again.
 *   - every engine billing inside the group keeps parentTurnKey = the OWNER
 *     turn key (never the continuation's own key); the tape validator
 *     (packages/commercial/src/http/losslessTurnTape.ts) enforces this for
 *     the continuation branch. Settlement stays fenced by the original
 *     requestId journal — a late card is never a second charge.
 *
 * This module is intentionally pure (no imports from sessionManager/server)
 * so the identity/payload logic is unit-testable in isolation.
 */
import { createHash } from 'node:crypto'

import type { DurableAgentGroup } from '@openclaude/protocol'

/** Immutable owner locator frozen at delegation launch. `parentSessionId` is
 * the webchat client session id (the tape sessionId the owner turn's own
 * tape used); `parentTurnKey` is the leader's exact turn key at launch. */
export interface DelegateOwnerTurnLocator {
  parentSessionId: string
  parentTurnKey: string
  turnIndex: number
}

const TURN_KEY_RE = /^[0-9a-f]{64}$/
const SESSION_ID_RE = /^.{1,128}$/

export function isValidDelegateOwnerLocator(
  owner: DelegateOwnerTurnLocator,
): boolean {
  return (
    typeof owner.parentSessionId === 'string' &&
    SESSION_ID_RE.test(owner.parentSessionId) &&
    typeof owner.parentTurnKey === 'string' &&
    TURN_KEY_RE.test(owner.parentTurnKey) &&
    Number.isSafeInteger(owner.turnIndex) &&
    owner.turnIndex >= 1
  )
}

/** Canonical (sorted-key) JSON of a completed group. Mirrors
 * serializeLosslessTurnPayload's key ordering so the identity is stable
 * against irrelevant insertion-order differences. */
export function canonicalAgentGroupBytes(group: DurableAgentGroup): Buffer {
  const json = JSON.stringify(group, (key, current) => {
    if (key === '_ocEventOrdinal') return undefined
    if (!current || typeof current !== 'object' || Array.isArray(current)) return current
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(current as Record<string, unknown>).sort()) {
      sorted[key] = (current as Record<string, unknown>)[key]
    }
    return sorted
  })
  if (json === undefined) throw new Error('late delegate group is not JSON serializable')
  return Buffer.from(json, 'utf8')
}

/** Deterministic identity for one late completion: same logical run with the
 * same content ⇒ same identity; different content under the same run is an
 * observable conflict the caller must surface, not a second card. */
export function lateDelegateGroupIdentity(
  owner: DelegateOwnerTurnLocator,
  group: DurableAgentGroup,
): string {
  return createHash('sha256')
    .update('oc-late-delegate-group-v1\0')
    .update(owner.parentTurnKey)
    .update('\0')
    .update(group.runId)
    .update('\0')
    .update(canonicalAgentGroupBytes(group))
    .digest('hex')
}

/** One logical run under one owner turn. Tape key / agentId derive from this
 * (NOT the content hash) so a restart + different payload collides on the
 * same immutable tape (409) instead of minting a second card. */
export function lateDelegateLogicalRunKey(
  owner: DelegateOwnerTurnLocator,
  runId: string,
): string {
  return createHash('sha256')
    .update('oc-late-delegate-run-v1\0')
    .update(owner.parentTurnKey)
    .update('\0')
    .update(runId)
    .digest('hex')
}

/** Deterministic continuation tape key (64-hex ⇒ deriveLosslessTurnKey keeps
 * it verbatim). Input is the logical-run key, never the content identity. */
export function lateDelegateGroupTurnKey(runKey: string): string {
  return createHash('sha256')
    .update('oc-late-delegate-tape-v1\0')
    .update(runKey)
    .digest('hex')
}

/** Build the persistServerAuthoredTurnOutcome args for the restricted late
 * continuation. agentGroups-only branch: no top-level runtimeEvents, no
 * text, no requestId — the group's own engineBillings ride inside the group
 * and are validated against continuationOfTurnKey by the tape parser. */
export function buildLateDelegateContinuationArgs(args: {
  owner: DelegateOwnerTurnLocator
  group: DurableAgentGroup
  /** Owner webchat sessionKey (logging/pending-tracking only). */
  sessionKey: string
}): {
  sessionKey: string
  peerId: string
  agentId: string
  userId: undefined
  turnIndex: number
  turnKey: string
  continuationOfTurnKey: string
  createdAt: number
  text: string
  status: 'completed'
  agentGroups: DurableAgentGroup[]
} {
  const runKey = lateDelegateLogicalRunKey(args.owner, args.group.runId)
  return {
    sessionKey: args.sessionKey,
    peerId: args.owner.parentSessionId,
    agentId: `late_${runKey.slice(0, 24)}`,
    userId: undefined,
    turnIndex: args.owner.turnIndex,
    turnKey: lateDelegateGroupTurnKey(runKey),
    continuationOfTurnKey: args.owner.parentTurnKey,
    createdAt: args.group.completedAt,
    text: '',
    status: 'completed' as const,
    agentGroups: [structuredClone(args.group)],
  }
}
