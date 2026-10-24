/** Actual Docker metadata only. No expectations, environment, host ownership or RO claim. */
export interface RuntimeInspection {
  readonly version: 1
  readonly id: string
  readonly imageId: string
  readonly configuredUser: string
  readonly identityLabels: Readonly<Record<string, string>>
  readonly mounts: readonly RuntimeMountInspection[]
  readonly tmpfs: Readonly<Record<string, string>>
}
export interface RuntimeMountInspection {
  readonly type: string
  readonly source: string
  readonly destination: string
  readonly rw: boolean
  readonly propagation: string
  readonly mode?: string
  readonly name?: string
  readonly driver?: string
}
const identityKeys = new Set([
  'com.openclaude.v3.managed', 'com.openclaude.v3.uid', 'com.openclaude.v3.containerDbId',
  'com.openclaude.runtime_channel', 'com.openclaude.runtime.image_id', 'com.openclaude.runtime.release',
  'com.openclaude.runtime.bundle_rev', 'com.openclaude.runtime.boot_hash',
])
const cid = /^[a-f0-9]{64}(?![\s\S])/
const image = /^sha256:[a-f0-9]{64}(?![\s\S])/
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}
function strings(value: unknown): Record<string, string> | undefined {
  if (value === null) return {}
  if (!record(value) || Object.values(value).some(item => typeof item !== 'string')) return undefined
  return Object.fromEntries(Object.entries(value)) as Record<string, string>
}
function mount(value: unknown, raw: boolean): RuntimeMountInspection | undefined {
  if (!record(value)) return undefined
  const key = (wire: string, docker: string) => value[raw ? docker : wire]
  const type = key('type', 'Type'); const source = key('source', 'Source')
  const destination = key('destination', 'Destination'); const rw = key('rw', 'RW')
  const propagation = key('propagation', 'Propagation')
  if (typeof type !== 'string' || !type || typeof source !== 'string' || typeof destination !== 'string' ||
      typeof rw !== 'boolean' || typeof propagation !== 'string') return undefined
  const optional: { mode?: string; name?: string; driver?: string } = {}
  for (const [wire, docker] of [['mode', 'Mode'], ['name', 'Name'], ['driver', 'Driver']] as const) {
    const k = raw ? docker : wire
    if (Object.hasOwn(value, k)) {
      if (typeof value[k] !== 'string') return undefined
      optional[wire] = value[k]
    }
  }
  return Object.freeze({ type, source, destination, rw, propagation, ...optional })
}
function capture(value: unknown, expectedId: string, raw: boolean): RuntimeInspection | undefined {
  if (!cid.test(expectedId) || !record(value)) return undefined
  const id = value[raw ? 'Id' : 'id']; const imageId = value[raw ? 'Image' : 'imageId']
  if (id !== expectedId || typeof imageId !== 'string' || !image.test(imageId)) return undefined
  if (!raw && value.version !== 1) return undefined
  const config = raw ? value.Config : value
  const host = raw ? value.HostConfig : value
  if (!record(config) || !record(host)) return undefined
  const userKey = raw ? 'User' : 'configuredUser'; const labelKey = raw ? 'Labels' : 'identityLabels'
  const tmpfsKey = raw ? 'Tmpfs' : 'tmpfs'; const mountKey = raw ? 'Mounts' : 'mounts'
  const configuredUser = config[userKey]
  if (typeof configuredUser !== 'string' || !Object.hasOwn(config, labelKey) || !Object.hasOwn(host, tmpfsKey)) return undefined
  const labels = strings(config[labelKey]); const tmpfs = strings(host[tmpfsKey]); const rawMounts = value[mountKey]
  // Docker may omit empty Tmpfs. That remains unknown here, never proof of absence.
  if (!labels || !tmpfs || !Array.isArray(rawMounts)) return undefined
  const mounts: RuntimeMountInspection[] = []
  for (const item of rawMounts) {
    const parsed = mount(item, raw)
    if (!parsed) return undefined
    mounts.push(parsed)
  }
  const identityLabels = Object.fromEntries(Object.entries(labels).filter(([key]) => identityKeys.has(key)))
  return Object.freeze({ version: 1, id: expectedId, imageId, configuredUser,
    identityLabels: Object.freeze(identityLabels), mounts: Object.freeze(mounts), tmpfs: Object.freeze(tmpfs) })
}
export function readDockerRuntimeInspection(value: unknown, expectedId: string): RuntimeInspection | undefined {
  return capture(value, expectedId, true)
}
export function readWireRuntimeInspection(value: unknown, outerId: string, expectedId: string): RuntimeInspection | undefined {
  return outerId === expectedId ? capture(value, expectedId, false) : undefined
}
