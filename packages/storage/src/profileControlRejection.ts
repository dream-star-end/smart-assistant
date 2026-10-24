/** Closed pre-GO reasons; no filesystem details or user content cross worker IPC. */
export type ProfileControlRejectionCode = 'CONFLICT' | 'INVALID_INPUT' | 'UNAVAILABLE'
export const isProfileControlRejectionCode = (v: unknown): v is ProfileControlRejectionCode =>
  v === 'CONFLICT' || v === 'INVALID_INPUT' || v === 'UNAVAILABLE'

/** Only raised by deterministic generation checks before admission and staging. */
export class ProfileGenerationPreGoRejected extends Error {
  constructor(readonly code: ProfileControlRejectionCode) { super('Profile generation rejected before admission') }
}

/** Broker evidence: original publish, no GO, strict reply and clean observed child exit. */
export class ProfileControlRejected extends Error {
  constructor(readonly code: ProfileControlRejectionCode) { super('Profile control rejected without business effect') }
}
