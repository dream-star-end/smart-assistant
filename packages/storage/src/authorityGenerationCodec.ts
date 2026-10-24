/** Pure canonical generation codecs shared by host writer and sealed state-only reader. No filesystem access. */
import type { SystemActionReceiptBinding } from './systemActions.js'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/
const SHA = /^[0-9a-f]{64}(?![\s\S])/
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value))
const unknown = () => new Error('Authority generation unavailable; outcome unknown')
export type FileEntry = { path: string; size: number; sha256: string }
export type Manifest = { version: 1; userId: string; generation: string; parent: string | null; files: FileEntry[] }
export type ProfileGenerationReceipt = Readonly<{
  binding: SystemActionReceiptBinding
  generation: string
  result: { version: string }
}>
export function binding(value: SystemActionReceiptBinding, userId: string): SystemActionReceiptBinding {
  if (!value || value.userId !== userId || (typeof value.id !== 'string' || !UUID.test(value.id)) || (typeof value.inputHash !== 'string' || !SHA.test(value.inputHash)) || (typeof value.requestHash !== 'string' || !SHA.test(value.requestHash)) || !Number.isSafeInteger(value.operationVersion) || value.operationVersion < 1) throw unknown()
  for (const part of [value.sessionId, value.agentId, value.operationId]) if (typeof part !== 'string' || !part || part.length > 256 || part.includes('\0')) throw unknown()
  return { id: value.id, userId, sessionId: value.sessionId, agentId: value.agentId, operationId: value.operationId, operationVersion: value.operationVersion, requestHash: value.requestHash, inputHash: value.inputHash }
}
export function decodeReceipt(raw: Buffer, userId: string, id: string): ProfileGenerationReceipt {
  const value = JSON.parse(raw.toString('utf8')) as ProfileGenerationReceipt
  const exact = binding(value.binding, userId)
  if (exact.id !== id || (typeof value.generation !== 'string' || !UUID.test(value.generation)) || (typeof value.result?.version !== 'string' || value.result.version.length !== 16 || !/^[0-9a-f]{16}$/.test(value.result.version))) throw unknown()
  if (!bytes({ binding: exact, generation: value.generation, result: { version: value.result.version } }).equals(raw)) throw unknown()
  return Object.freeze({ binding: Object.freeze(exact), generation: value.generation, result: Object.freeze({ version: value.result.version }) })
}
export function decodeManifest(raw: Buffer, userId: string): Manifest {
  const m = JSON.parse(raw.toString('utf8')) as Manifest
  if (m.version !== 1 || m.userId !== userId || (typeof m.generation !== 'string' || !UUID.test(m.generation)) || (m.parent !== null && (typeof m.parent !== 'string' || !SHA.test(m.parent))) || !Array.isArray(m.files)) throw unknown()
  const seen = new Set<string>()
  for (const file of m.files) {
    if (!file || typeof file.path !== 'string' || (file.path !== 'data/user.md' && !/^receipts\/[0-9a-f-]{36}\.json$/.test(file.path)) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > (file.path === 'data/user.md' ? 1048576 : 65536) || typeof file.sha256 !== 'string' || !SHA.test(file.sha256) || seen.has(file.path)) throw unknown()
    seen.add(file.path)
  }
  if (!bytes(m.files).equals(bytes(m.files.map(f => ({ path: f.path, size: f.size, sha256: f.sha256 }))))) throw unknown()
  if (!seen.has('data/user.md') || !bytes(m.files.map(f => f.path)).equals(bytes([...seen].sort()))) throw unknown()
  if (!bytes({ version: 1, userId, generation: m.generation, parent: m.parent, files: m.files }).equals(raw)) throw unknown()
  return m
}
