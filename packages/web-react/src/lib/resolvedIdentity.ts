import { AuthEpochStaleError } from './api/http'
import type { AuthSession } from './types'

/** Frontend evidence only. Tokens remain in this module's private WeakMap. */
export type ResolvedIdentity = Readonly<{ userId: string; epoch: number; generation: number; sequence: number }>
type Attempt = { auth: AuthSession; token: string; epoch: number; generation: number }
let nextSequence = 0
const proofs = new WeakMap<ResolvedIdentity, Attempt>()

export function attemptCurrent(attempt: Attempt, auth: AuthSession): boolean {
  const now = auth.snapshot()
  return auth === attempt.auth && now.token === attempt.token && now.epoch === attempt.epoch &&
    typeof auth.getAccessGeneration === 'function' && auth.getAccessGeneration() === attempt.generation
}

/** Capture inside the actual HTTP make(token), never after an awaited response. */
export function captureIdentityAttempt(auth: AuthSession, token: string): Attempt {
  const snapshot = auth.snapshot()
  const generation = typeof auth.getAccessGeneration === 'function' ? auth.getAccessGeneration() : -1
  if (!Number.isSafeInteger(generation) || generation < 0 || typeof auth.subscribeAccessGeneration !== 'function') throw new Error('auth identity observation unavailable')
  if (!token || token !== snapshot.token) throw new AuthEpochStaleError()
  return { auth, token, epoch: snapshot.epoch, generation }
}

/** Only login/verify or the authenticated /me response supplies userId. */
export function resolveIdentity(attempt: Attempt, userId: string): ResolvedIdentity {
  if (!attemptCurrent(attempt, attempt.auth)) throw new AuthEpochStaleError()
  if (typeof userId !== 'string' || !userId) throw new Error('invalid authenticated user identity')
  const identity = Object.freeze({ userId, epoch: attempt.epoch, generation: attempt.generation, sequence: ++nextSequence })
  proofs.set(identity, attempt)
  return identity
}

export function identityIsCurrent(identity: ResolvedIdentity | null | undefined, auth: AuthSession, userId?: string): boolean {
  const proof = identity && proofs.get(identity)
  return !!proof && (!userId || identity!.userId === userId) && attemptCurrent(proof, auth)
}

export function assertResolvedIdentity(identity: ResolvedIdentity, auth: AuthSession): void {
  if (!identityIsCurrent(identity, auth)) throw new AuthEpochStaleError()
}

export function revokeResolvedIdentity(identity: ResolvedIdentity | null): void {
  if (identity) proofs.delete(identity)
}

/** Transfer an existing verified proof across an explicit account-switch boundary. */
export function advanceResolvedIdentityEpoch(identity: ResolvedIdentity, auth: AuthSession): ResolvedIdentity {
  const proof = proofs.get(identity)
  if (!proof || !attemptCurrent(proof, auth)) throw new AuthEpochStaleError()
  const epoch = auth.beginIdentity()
  if (!auth.commitToken(epoch, proof.token)) throw new AuthEpochStaleError()
  proofs.delete(identity)
  // Same authenticated uid/token evidence; callers cannot supply a display uid.
  return resolveIdentity({ ...proof, epoch, generation: auth.getAccessGeneration() }, identity.userId)
}
