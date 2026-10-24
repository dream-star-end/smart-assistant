/** Fixed v1 profile generation CAS condition, retained by the private ledger after args cleanup. */
export type ProfileControlCondition = Readonly<{
  parentManifestSha256: string
  baseProfileVersion: string
  targetProfileSha256: string
}>
const CONDITION = /^profile-generation-v1:([a-f0-9]{64}):([a-f0-9]{16}):([a-f0-9]{64})$/
export function parseProfileControlVersion(value: unknown): ProfileControlCondition | null {
  if (typeof value !== 'string') return null
  const parts = CONDITION.exec(value)
  if (!parts || parts[0] !== value) return null
  return Object.freeze({ parentManifestSha256: parts[1]!, baseProfileVersion: parts[2]!, targetProfileSha256: parts[3]! })
}
export function profileControlVersion(value: ProfileControlCondition): string {
  if (!value || ![value.parentManifestSha256, value.baseProfileVersion, value.targetProfileSha256].every(part => typeof part === 'string')) throw new Error('Invalid profile control condition')
  const token = `profile-generation-v1:${value.parentManifestSha256}:${value.baseProfileVersion}:${value.targetProfileSha256}`
  if (!parseProfileControlVersion(token)) throw new Error('Invalid profile control condition')
  return token
}
