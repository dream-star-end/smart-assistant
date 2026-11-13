/** Closed data protocol for the fixed host worker. No paths, commands, env, approval nonce or JWT. */
import type { SystemActionReceiptBinding } from './systemActions.js'
import { parseProfileControlVersion } from './profileControlVersion.js'
export const PROFILE_WORKER_MAX_BYTES = 4 * 1024 * 1024
export type ProfileControlRequest = Readonly<{
  v: 1; jobId: string; kind: 'publish-profile' | 'recover-profile'
  binding: Readonly<SystemActionReceiptBinding>; token: string; text?: string
}>
const uuid = (v: unknown): v is string => typeof v === 'string' && v.length === 36 && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v)
const sha = (v: unknown): v is string => typeof v === 'string' && v.length === 64 && /^[a-f0-9]{64}$/.test(v)
const plain = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && ![...v].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
export function exactKeys(value: unknown, names: string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...names].sort())
}
export function parseProfileControlRequest(value: unknown): ProfileControlRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  const fields = ['v', 'jobId', 'kind', 'binding', 'token', ...(r.kind === 'publish-profile' ? ['text'] : [])]
  if (!exactKeys(r, fields) || r.v !== 1 || !uuid(r.jobId) || (r.kind !== 'publish-profile' && r.kind !== 'recover-profile') || !parseProfileControlVersion(r.token)) return null
  const b = r.binding
  if (!exactKeys(b, ['id', 'userId', 'sessionId', 'agentId', 'operationId', 'operationVersion', 'requestHash', 'inputHash'])
    || !uuid(b.id) || typeof b.userId !== 'string' || b.userId.length > 19 || !/^[1-9][0-9]*$/.test(b.userId)
    || BigInt(b.userId).toString() !== b.userId || BigInt(b.userId) > 9223372036854775807n
    || !plain(b.sessionId) || !plain(b.agentId) || b.operationId !== 'memory.profile.update' || b.operationVersion !== 1 || !sha(b.requestHash) || !sha(b.inputHash)) return null
  if (r.kind === 'publish-profile' && (typeof r.text !== 'string' || Buffer.byteLength(r.text) > 1048576)) return null
  return Object.freeze({ v: 1, jobId: r.jobId, kind: r.kind as ProfileControlRequest['kind'], token: r.token as string,
    binding: Object.freeze({ id: b.id, userId: b.userId, sessionId: b.sessionId, agentId: b.agentId,
      operationId: b.operationId, operationVersion: b.operationVersion, requestHash: b.requestHash, inputHash: b.inputHash }),
    ...(r.kind === 'publish-profile' ? { text: r.text as string } : {}) })
}
