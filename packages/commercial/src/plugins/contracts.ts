import { extname } from 'node:path'
import { normalizeHttpsOrigin } from '../connectors/outboundPolicy.js'
import { canonicalSha256Hex } from '../connectors/spec/canonical.js'
import {
  type CompiledLocalPluginBrokerPolicy,
  compileLocalPluginBrokerPolicy,
} from './localBroker.js'
import {
  type CompiledLocalPluginPackage,
  LOCAL_PLUGIN_IMAGE_ABI,
  LOCAL_PLUGIN_IMAGE_ABI_LABEL,
  LOCAL_PLUGIN_PARAMS_MAX_BYTES,
  LOCAL_PLUGIN_STDOUT_MAX_BYTES,
  type PlatformLocalPluginPackage,
  compilePlatformLocalPluginPackage,
} from './localSandbox.js'

const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/
const ACTION_RE = /^[a-z][a-z0-9_-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const LABEL_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\/-]{0,127}$/
const POLLUTION_KEYS = new Set(['__proto__', 'prototype', 'constructor'])
const SCHEMA_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
])
const SAFE_BROWSER_METHODS = new Set(['GET', 'HEAD', 'POST'])
const INTERPRETER_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.py': '/usr/bin/python3',
  '.mjs': '/usr/bin/node',
  '.sh': '/bin/sh',
}

export const RUNTIME_PLUGIN_COMPILER_VERSION = 1
export const RUNTIME_PLUGIN_ACCOUNT_CONTRACT_VERSION = 1
export const RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES = 512 * 1024
export const RUNTIME_PLUGIN_ARTIFACT_MAX_NODES = 4096
export const REQUIRED_BROWSER_FORBIDDEN_CHANNELS = [
  'background-network',
  'doh',
  'proxy',
  'quic',
  'websocket',
  'webrtc',
  'worker',
] as const

export class RuntimePluginContractError extends Error {
  readonly code: 'INVALID_ARTIFACT' | 'INVALID_CONTRACT' | 'INVALID_PARAMS' | 'INVALID_RESULT'

  constructor(code: RuntimePluginContractError['code'], message: string) {
    super(message)
    this.name = 'RuntimePluginContractError'
    this.code = code
  }
}

export interface RuntimePluginActionContractV1 {
  id: string
  description: string
  effect: 'read'
  timeoutSeconds: number
  params: Record<string, unknown>
  result: Record<string, unknown>
}

export interface LocalRuntimeContractV1 {
  packageDigest: string
  imageId: string
  sandboxAbi: typeof LOCAL_PLUGIN_IMAGE_ABI
  requiredLabels: Readonly<Record<string, string>>
  interpreterVersions: Readonly<Record<string, string>>
  brokerPolicy: CompiledLocalPluginBrokerPolicy | null
  brokerPolicyHash: string | null
}

export interface ManagedBrowserNetworkContractV1 {
  origins: readonly string[]
  methods: readonly ('GET' | 'HEAD' | 'POST')[]
  forbiddenChannels: typeof REQUIRED_BROWSER_FORBIDDEN_CHANNELS
  redirects: 'revalidate-every-hop'
  ipv4PinsRequired: true
}

export interface ManagedBrowserRuntimeContractV1 {
  driverId: string
  driverVersion: string
  network: ManagedBrowserNetworkContractV1
}

interface RuntimePluginContractBaseV1 {
  schemaVersion: 1
  artifactHash: string
  id: string
  version: string
  account: {
    mode: 'none' | 'required'
    contractVersion: typeof RUNTIME_PLUGIN_ACCOUNT_CONTRACT_VERSION
  }
  actions: readonly RuntimePluginActionContractV1[]
}

export interface SandboxedLocalPluginContractV1 extends RuntimePluginContractBaseV1 {
  pluginType: 'sandboxed-local'
  account: { mode: 'none'; contractVersion: 1 }
  runtime: LocalRuntimeContractV1
}

export interface ManagedBrowserPluginContractV1 extends RuntimePluginContractBaseV1 {
  pluginType: 'managed-browser'
  account: { mode: 'required'; contractVersion: 1 }
  runtime: ManagedBrowserRuntimeContractV1
}

export type RuntimePluginContractV1 =
  | SandboxedLocalPluginContractV1
  | ManagedBrowserPluginContractV1

interface CompiledRuntimePluginArtifactBase {
  artifactHash: string
  execContractHash: string
}

export type CompiledRuntimePluginArtifact =
  | (CompiledRuntimePluginArtifactBase & {
      pluginType: 'sandboxed-local'
      execContract: SandboxedLocalPluginContractV1
      localPackage: CompiledLocalPluginPackage
    })
  | (CompiledRuntimePluginArtifactBase & {
      pluginType: 'managed-browser'
      execContract: ManagedBrowserPluginContractV1
    })

function invalid(message: string): never {
  throw new RuntimePluginContractError('INVALID_ARTIFACT', message)
}

/**
 * Bound the complete JSON tree before canonicalization. Review/load also bounds
 * the raw UTF-8 bytes before JSON.parse; this second guard covers direct compiler
 * callers and caps combinatorial schema breadth/node count.
 */
function assertArtifactBudget(value: unknown): void {
  let nodes = 0
  let bytes = 0
  const seen = new Set<object>()
  const visit = (item: unknown, depth: number): void => {
    nodes++
    if (nodes > RUNTIME_PLUGIN_ARTIFACT_MAX_NODES) invalid('artifact exceeds the JSON node limit')
    if (depth > 32) invalid('artifact is nested too deeply')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) invalid('artifact contains a non-finite number')
      return
    }
    if (typeof item === 'string') {
      bytes += Buffer.byteLength(item, 'utf8')
      if (bytes > RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES) invalid('artifact exceeds the JSON byte limit')
      return
    }
    if (typeof item !== 'object') invalid('artifact contains a non-JSON value')
    if (seen.has(item)) invalid('artifact contains a cycle')
    seen.add(item)
    if (Array.isArray(item)) {
      if (item.length > RUNTIME_PLUGIN_ARTIFACT_MAX_NODES)
        invalid('artifact array exceeds the item limit')
      for (const child of item) visit(child, depth + 1)
      seen.delete(item)
      return
    }
    const proto = Object.getPrototypeOf(item)
    if (proto !== Object.prototype && proto !== null)
      invalid('artifact contains a non-plain object')
    const keys = Reflect.ownKeys(item)
    if (keys.length > RUNTIME_PLUGIN_ARTIFACT_MAX_NODES)
      invalid('artifact object exceeds the property limit')
    for (const ownKey of keys) {
      if (typeof ownKey !== 'string') invalid('artifact contains a symbol property')
      const key = ownKey as string
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (POLLUTION_KEYS.has(key) || !Object.hasOwn(descriptor, 'value'))
        invalid(`artifact contains forbidden property '${key}'`)
      bytes += Buffer.byteLength(key, 'utf8')
      if (bytes > RUNTIME_PLUGIN_ARTIFACT_MAX_BYTES) invalid('artifact exceeds the JSON byte limit')
      visit(descriptor.value, depth + 1)
    }
    seen.delete(item)
  }
  visit(value, 0)
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => POLLUTION_KEYS.has(key) || !allow.has(key))
  if (unknown.length > 0) invalid(`${label} has unknown fields: ${unknown.sort().join(', ')}`)
}

function boundedString(value: unknown, minimum: number, maximum: number, label: string): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum)
    invalid(`${label} must be a string of length ${minimum}-${maximum}`)
  return value
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum)
    invalid(`${label} must be an integer in ${minimum}-${maximum}`)
  return Number(value)
}

function safeSchema(value: unknown, label: string, depth = 0): Record<string, unknown> {
  if (depth > 24) invalid(`${label} is nested too deeply`)
  const schema = plainObject(value, label)
  for (const key of Object.keys(schema)) {
    if (POLLUTION_KEYS.has(key) || !SCHEMA_KEYS.has(key))
      invalid(`${label} contains unsupported schema key '${key}'`)
  }
  const type = schema.type
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(type)))
    invalid(`${label}.type is unsupported`)
  if (schema.properties !== undefined) {
    if (type !== 'object') invalid(`${label}.properties requires type=object`)
    const props = plainObject(schema.properties, `${label}.properties`)
    if (Object.keys(props).length > 64) invalid(`${label}.properties has too many entries`)
    for (const [name, child] of Object.entries(props)) {
      if (
        POLLUTION_KEYS.has(name) ||
        name.length === 0 ||
        name.length > 128 ||
        name.includes('\0') ||
        name.includes('\r') ||
        name.includes('\n')
      )
        invalid(`${label}.properties contains forbidden key '${name}'`)
      safeSchema(child, `${label}.properties.${name}`, depth + 1)
    }
  }
  if (schema.required !== undefined) {
    if (
      type !== 'object' ||
      !Array.isArray(schema.required) ||
      schema.required.some((item) => typeof item !== 'string' || POLLUTION_KEYS.has(item)) ||
      new Set(schema.required).size !== schema.required.length ||
      schema.required.some(
        (item) =>
          typeof item === 'string' &&
          (!schema.properties || !Object.hasOwn(schema.properties as object, item)),
      )
    )
      invalid(`${label}.required must be a unique subset of object properties`)
  }
  if (type === 'object' && schema.additionalProperties !== false)
    invalid(`${label}.additionalProperties must be false`)
  if (type !== 'object' && schema.additionalProperties !== undefined)
    invalid(`${label}.additionalProperties requires type=object`)
  if (schema.items !== undefined) {
    if (type !== 'array') invalid(`${label}.items requires type=array`)
    safeSchema(schema.items, `${label}.items`, depth + 1)
  }
  if (type === 'array' && schema.items === undefined) invalid(`${label}.items is required`)
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.length > 128 ||
      schema.enum.some(
        (item) =>
          item !== null &&
          (typeof item === 'object' ||
            !['string', 'number', 'boolean'].includes(typeof item) ||
            (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > 16 * 1024) ||
            (typeof item === 'number' && !Number.isFinite(item))),
      ))
  )
    invalid(`${label}.enum must contain scalar JSON values`)
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const item = schema[key]
    if (item !== undefined && (!Number.isInteger(item) || Number(item) < 0))
      invalid(`${label}.${key} must be a non-negative integer`)
  }
  for (const key of ['minimum', 'maximum'] as const) {
    const item = schema[key]
    if (item !== undefined && (typeof item !== 'number' || !Number.isFinite(item)))
      invalid(`${label}.${key} must be finite`)
  }
  if (
    typeof schema.minLength === 'number' &&
    typeof schema.maxLength === 'number' &&
    schema.minLength > schema.maxLength
  )
    invalid(`${label}.minLength exceeds maxLength`)
  if (
    typeof schema.minItems === 'number' &&
    typeof schema.maxItems === 'number' &&
    schema.minItems > schema.maxItems
  )
    invalid(`${label}.minItems exceeds maxItems`)
  if (
    typeof schema.minimum === 'number' &&
    typeof schema.maximum === 'number' &&
    schema.minimum > schema.maximum
  )
    invalid(`${label}.minimum exceeds maximum`)
  return schema
}

function jsonScalarEqual(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a, b))
}

function matchesSchema(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonScalarEqual(item, value)))
    return false
  switch (schema.type) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'string':
      return (
        typeof value === 'string' &&
        (typeof schema.minLength !== 'number' || value.length >= schema.minLength) &&
        (typeof schema.maxLength !== 'number' || value.length <= schema.maxLength)
      )
    case 'integer':
    case 'number':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        (schema.type !== 'integer' || Number.isInteger(value)) &&
        (typeof schema.minimum !== 'number' || value >= schema.minimum) &&
        (typeof schema.maximum !== 'number' || value <= schema.maximum)
      )
    case 'array':
      return (
        Array.isArray(value) &&
        (typeof schema.minItems !== 'number' || value.length >= schema.minItems) &&
        (typeof schema.maxItems !== 'number' || value.length <= schema.maxItems) &&
        (schema.items === undefined ||
          value.every((item) => matchesSchema(schema.items as Record<string, unknown>, item)))
      )
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) return false
      const objectValue = value as Record<string, unknown>
      const properties =
        schema.properties && typeof schema.properties === 'object'
          ? (schema.properties as Record<string, Record<string, unknown>>)
          : {}
      const required = Array.isArray(schema.required) ? (schema.required as string[]) : []
      if (required.some((key) => !Object.hasOwn(objectValue, key))) return false
      for (const [key, child] of Object.entries(objectValue)) {
        if (POLLUTION_KEYS.has(key)) return false
        const childSchema = properties[key]
        if (!childSchema) {
          if (schema.additionalProperties === false) return false
          continue
        }
        if (!matchesSchema(childSchema, child)) return false
      }
      return true
    }
    default:
      return false
  }
}

export function validateRuntimePluginJson(
  schema: Record<string, unknown>,
  value: unknown,
  kind: 'params' | 'result',
): void {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    serialized = undefined
  }
  const maxBytes = kind === 'params' ? LOCAL_PLUGIN_PARAMS_MAX_BYTES : LOCAL_PLUGIN_STDOUT_MAX_BYTES
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes)
    throw new RuntimePluginContractError(
      kind === 'params' ? 'INVALID_PARAMS' : 'INVALID_RESULT',
      `${kind} exceed the Plugin JSON byte limit`,
    )
  if (!matchesSchema(schema, value))
    throw new RuntimePluginContractError(
      kind === 'params' ? 'INVALID_PARAMS' : 'INVALID_RESULT',
      `${kind} do not match the signed Plugin schema`,
    )
}

function compileActions(raw: unknown): RuntimePluginActionContractV1[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 16)
    invalid('actions must contain 1-16 items')
  const seen = new Set<string>()
  return raw.map((item, index) => {
    const action = plainObject(item, `actions[${index}]`)
    exactKeys(
      action,
      ['id', 'description', 'effect', 'timeoutSeconds', 'params', 'result'],
      `actions[${index}]`,
    )
    const id = boundedString(action.id, 1, 64, `actions[${index}].id`)
    if (!ACTION_RE.test(id) || seen.has(id)) invalid(`actions[${index}].id is invalid or duplicate`)
    seen.add(id)
    if (action.effect !== 'read') invalid('runtime Plugin actions must be read-only in contract v1')
    return {
      id,
      description: boundedString(action.description, 1, 512, `actions[${index}].description`),
      effect: 'read',
      timeoutSeconds: boundedInteger(
        action.timeoutSeconds,
        1,
        120,
        `actions[${index}].timeoutSeconds`,
      ),
      params: safeSchema(action.params, `actions[${index}].params`),
      result: safeSchema(action.result, `actions[${index}].result`),
    }
  })
}

function compileStringMap(
  value: unknown,
  label: string,
  opts: { maxEntries: number; key: (key: string) => boolean },
): Record<string, string> {
  const input = plainObject(value, label)
  const entries = Object.entries(input).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length > opts.maxEntries) invalid(`${label} has too many entries`)
  const out: Record<string, string> = Object.create(null)
  for (const [key, raw] of entries) {
    if (POLLUTION_KEYS.has(key) || !opts.key(key)) invalid(`${label} has invalid key '${key}'`)
    out[key] = boundedString(raw, 1, 128, `${label}.${key}`)
  }
  return out
}

function compileLocal(
  root: Record<string, unknown>,
  artifactHash: string,
): CompiledRuntimePluginArtifact {
  exactKeys(
    root,
    ['schemaVersion', 'pluginType', 'id', 'version', 'package', 'image', 'brokerPolicy'],
    'artifact',
  )
  const id = boundedString(root.id, 2, 64, 'artifact.id')
  const version = boundedString(root.version, 5, 32, 'artifact.version')
  if (!SLUG_RE.test(id)) invalid('artifact.id must be a Plugin slug')
  if (!VERSION_RE.test(version)) invalid('artifact.version must be semantic N.N.N')

  const packageRaw = plainObject(root.package, 'artifact.package')
  exactKeys(packageRaw, ['manifest', 'files'], 'artifact.package')
  const localPackage = compilePlatformLocalPluginPackage(
    packageRaw as unknown as PlatformLocalPluginPackage,
  )
  if (localPackage.manifest.id !== id || localPackage.manifest.version !== version)
    invalid('local manifest identity/version does not match artifact')

  const image = plainObject(root.image, 'artifact.image')
  exactKeys(image, ['id', 'sandboxAbi', 'requiredLabels', 'interpreterVersions'], 'artifact.image')
  if (typeof image.id !== 'string' || !IMAGE_ID_RE.test(image.id))
    invalid('artifact.image.id must be an exact sha256 image ID')
  if (image.sandboxAbi !== LOCAL_PLUGIN_IMAGE_ABI)
    invalid(`artifact.image.sandboxAbi must be ${LOCAL_PLUGIN_IMAGE_ABI}`)
  const requiredLabels = compileStringMap(image.requiredLabels, 'artifact.image.requiredLabels', {
    maxEntries: 16,
    key: (key) => LABEL_RE.test(key),
  })
  if (
    Object.hasOwn(requiredLabels, LOCAL_PLUGIN_IMAGE_ABI_LABEL) &&
    requiredLabels[LOCAL_PLUGIN_IMAGE_ABI_LABEL] !== LOCAL_PLUGIN_IMAGE_ABI
  )
    invalid('artifact.image.requiredLabels conflicts with the sandbox ABI')
  requiredLabels[LOCAL_PLUGIN_IMAGE_ABI_LABEL] = LOCAL_PLUGIN_IMAGE_ABI
  const interpreterVersions = compileStringMap(
    image.interpreterVersions,
    'artifact.image.interpreterVersions',
    { maxEntries: 3, key: (key) => Object.values(INTERPRETER_BY_EXTENSION).includes(key) },
  )
  const requiredInterpreters = new Set(
    localPackage.manifest.actions.map(
      (action) => INTERPRETER_BY_EXTENSION[extname(action.entrypoint)],
    ),
  )
  if ([...requiredInterpreters].some((path) => !path || !interpreterVersions[path]))
    invalid('artifact.image.interpreterVersions does not pin every action interpreter')

  let brokerPolicy: CompiledLocalPluginBrokerPolicy | null = null
  if (root.brokerPolicy !== undefined) {
    brokerPolicy = compileLocalPluginBrokerPolicy(
      root.brokerPolicy,
      new Set(localPackage.manifest.actions.map((action) => action.id)),
    )
  }
  const actions = localPackage.manifest.actions.map((action) => ({
    id: action.id,
    description: action.description,
    effect: 'read' as const,
    timeoutSeconds: action.timeoutSeconds,
    params: safeSchema(action.params, `action.${action.id}.params`),
    result: safeSchema(action.result, `action.${action.id}.result`),
  }))
  const execContract: SandboxedLocalPluginContractV1 = {
    schemaVersion: 1,
    pluginType: 'sandboxed-local',
    artifactHash,
    id,
    version,
    account: { mode: 'none', contractVersion: 1 },
    actions,
    runtime: {
      packageDigest: localPackage.digest,
      imageId: image.id,
      sandboxAbi: LOCAL_PLUGIN_IMAGE_ABI,
      requiredLabels,
      interpreterVersions,
      brokerPolicy,
      brokerPolicyHash: brokerPolicy ? canonicalSha256Hex(brokerPolicy) : null,
    },
  }
  return {
    pluginType: 'sandboxed-local',
    artifactHash,
    execContract,
    execContractHash: canonicalSha256Hex(execContract),
    localPackage,
  }
}

function compileManaged(
  root: Record<string, unknown>,
  artifactHash: string,
): CompiledRuntimePluginArtifact {
  exactKeys(
    root,
    ['schemaVersion', 'pluginType', 'id', 'version', 'driver', 'account', 'network', 'actions'],
    'artifact',
  )
  const id = boundedString(root.id, 2, 64, 'artifact.id')
  const version = boundedString(root.version, 5, 32, 'artifact.version')
  if (!SLUG_RE.test(id)) invalid('artifact.id must be a Plugin slug')
  if (!VERSION_RE.test(version)) invalid('artifact.version must be semantic N.N.N')
  const driver = plainObject(root.driver, 'artifact.driver')
  exactKeys(driver, ['id', 'version'], 'artifact.driver')
  const driverId = boundedString(driver.id, 2, 64, 'artifact.driver.id')
  const driverVersion = boundedString(driver.version, 5, 32, 'artifact.driver.version')
  if (!SLUG_RE.test(driverId) || !VERSION_RE.test(driverVersion))
    invalid('artifact.driver id/version is invalid')
  const account = plainObject(root.account, 'artifact.account')
  exactKeys(account, ['mode', 'contractVersion'], 'artifact.account')
  if (account.mode !== 'required' || account.contractVersion !== 1)
    invalid('managed-browser account must be required contractVersion=1')

  const network = plainObject(root.network, 'artifact.network')
  exactKeys(network, ['origins', 'methods'], 'artifact.network')
  if (
    !Array.isArray(network.origins) ||
    network.origins.length === 0 ||
    network.origins.length > 16
  )
    invalid('artifact.network.origins must contain 1-16 origins')
  const origins = [
    ...new Set(
      network.origins.map((origin) => {
        if (typeof origin !== 'string') invalid('artifact.network origin must be a string')
        try {
          return normalizeHttpsOrigin(origin)
        } catch {
          invalid('artifact.network origin must be a safe HTTPS origin')
        }
      }),
    ),
  ].sort()
  if (origins.length !== network.origins.length)
    invalid('artifact.network origins contain duplicates')
  if (!Array.isArray(network.methods) || network.methods.length === 0 || network.methods.length > 3)
    invalid('artifact.network.methods must contain 1-3 methods')
  const methods = [
    ...new Set(
      network.methods.map((method) => {
        if (typeof method !== 'string' || !SAFE_BROWSER_METHODS.has(method))
          invalid('artifact.network method is not allowed')
        return method as 'GET' | 'HEAD' | 'POST'
      }),
    ),
  ].sort()
  if (methods.length !== network.methods.length)
    invalid('artifact.network methods contain duplicates')
  const actions = compileActions(root.actions)
  const execContract: ManagedBrowserPluginContractV1 = {
    schemaVersion: 1,
    pluginType: 'managed-browser',
    artifactHash,
    id,
    version,
    account: { mode: 'required', contractVersion: 1 },
    actions,
    runtime: {
      driverId,
      driverVersion,
      network: {
        origins,
        methods,
        forbiddenChannels: REQUIRED_BROWSER_FORBIDDEN_CHANNELS,
        redirects: 'revalidate-every-hop',
        ipv4PinsRequired: true,
      },
    },
  }
  return {
    pluginType: 'managed-browser',
    artifactHash,
    execContract,
    execContractHash: canonicalSha256Hex(execContract),
  }
}

export function compileRuntimePluginArtifact(input: unknown): CompiledRuntimePluginArtifact {
  assertArtifactBudget(input)
  const root = plainObject(input, 'artifact')
  if (root.schemaVersion !== 1) invalid('artifact.schemaVersion must be 1')
  const artifactHash = canonicalSha256Hex(input)
  if (root.pluginType === 'sandboxed-local') return compileLocal(root, artifactHash)
  if (root.pluginType === 'managed-browser') return compileManaged(root, artifactHash)
  invalid('artifact.pluginType must be sandboxed-local or managed-browser')
}
