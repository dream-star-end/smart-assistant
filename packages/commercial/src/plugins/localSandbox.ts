/**
 * Local Plugin sandbox substrate (phase 3.2a).
 *
 * This module deliberately has no HTTP/RPC registration and ships with no
 * production package allowlist. It only provides the hard isolation primitives
 * that a later marketplace integration can call after a Plugin contract has
 * been reviewed and signed.
 *
 * Security boundary of this slice:
 *  - platform-owned, in-memory package definitions only (ordinary marketplace
 *    Skills are never discovered or executed);
 *  - root-owned, digest-addressed immutable package snapshots;
 *  - exact Docker image ID (sha256) pinning;
 *  - one-shot, network-none, read-only-rootfs containers with no user-volume or
 *    credential mounts;
 *  - read-only JSON actions only. The default remains fully network-free; an
 *    offline-reviewed action may receive the invocation-scoped read-only HTTPS
 *    broker socket. Browser/persistence and write/send effects remain rejected.
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  type FileHandle,
  chmod,
  constants as fsConstants,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'

import type Docker from 'dockerode'

import {
  LOCAL_PLUGIN_BROKER_SOCKET,
  type LocalPluginBrokerDeps,
  type LocalPluginBrokerHandle,
  type LocalPluginBrokerMount,
  compileLocalPluginBrokerPolicy,
  createLocalPluginBroker,
} from './localBroker.js'

const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/
const ACTION_RE = /^[a-z][a-z0-9_-]{0,63}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const PACKAGE_PATH_RE = /^scripts\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const IMAGE_ID_RE = /^sha256:[0-9a-f]{64}$/
const SAFE_IMAGE_ENV_KEYS = new Set(['PATH', 'LANG', 'LC_ALL'])
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
const INTERPRETER_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.py': '/usr/bin/python3',
  '.mjs': '/usr/bin/node',
  '.sh': '/bin/sh',
}

export const LOCAL_PLUGIN_PACKAGE_MAX_FILES = 16
export const LOCAL_PLUGIN_PACKAGE_MAX_FILE_BYTES = 64 * 1024
export const LOCAL_PLUGIN_PACKAGE_MAX_BYTES = 256 * 1024
export const LOCAL_PLUGIN_PARAMS_MAX_BYTES = 64 * 1024
export const LOCAL_PLUGIN_STDOUT_MAX_BYTES = 1024 * 1024
export const LOCAL_PLUGIN_STDERR_MAX_BYTES = 64 * 1024
export const LOCAL_PLUGIN_IMAGE_ABI_LABEL = 'oc.plugin.sandbox_abi'
export const LOCAL_PLUGIN_IMAGE_ABI = 'local-read-v1'

export class LocalPluginSandboxError extends Error {
  readonly code:
    | 'INVALID_PACKAGE'
    | 'PACKAGE_TAMPERED'
    | 'IMAGE_MISMATCH'
    | 'ACTION_NOT_FOUND'
    | 'INVALID_PARAMS'
    | 'INVALID_RESULT'
    | 'OUTPUT_LIMIT'
    | 'TIMEOUT'
    | 'QUOTA_EXCEEDED'
    | 'INVALID_CONFIG'
    | 'EXECUTION_FAILED'

  constructor(code: LocalPluginSandboxError['code'], message: string) {
    super(message)
    this.name = 'LocalPluginSandboxError'
    this.code = code
  }
}

export interface LocalPluginActionV1 {
  id: string
  description: string
  effect: 'read'
  entrypoint: string
  timeoutSeconds: number
  params: Record<string, unknown>
  result: Record<string, unknown>
}

export interface LocalPluginManifestV1 {
  schemaVersion: 1
  id: string
  version: string
  actions: LocalPluginActionV1[]
}

export interface PlatformLocalPluginPackage {
  manifest: unknown
  files: unknown
}

export interface CompiledLocalPluginPackage {
  manifest: LocalPluginManifestV1
  files: Record<string, string>
  digest: string
}

export interface MaterializedLocalPluginPackage {
  digest: string
  path: string
  compiled: CompiledLocalPluginPackage
}

function invalid(message: string): never {
  throw new LocalPluginSandboxError('INVALID_PACKAGE', message)
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allow = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !allow.has(key))
  if (unknown.length > 0) invalid(`${label} has unknown fields: ${unknown.sort().join(', ')}`)
}

function assertPlainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid(`${label} must be an object`)
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) invalid(`${label} must be a plain object`)
  return value as Record<string, unknown>
}

function assertSafeSchema(value: unknown, label: string, depth = 0): Record<string, unknown> {
  if (depth > 24) invalid(`${label} is nested too deeply`)
  const schema = assertPlainObject(value, label)
  for (const key of Object.keys(schema)) {
    if (POLLUTION_KEYS.has(key) || !SCHEMA_KEYS.has(key))
      invalid(`${label} contains unsupported schema key '${key}'`)
  }
  const type = schema.type
  if (!['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(String(type)))
    invalid(`${label}.type is unsupported`)
  if (schema.properties !== undefined) {
    if (type !== 'object') invalid(`${label}.properties requires type=object`)
    const props = assertPlainObject(schema.properties, `${label}.properties`)
    for (const [name, child] of Object.entries(props)) {
      if (POLLUTION_KEYS.has(name)) invalid(`${label}.properties contains forbidden key '${name}'`)
      assertSafeSchema(child, `${label}.properties.${name}`, depth + 1)
    }
  }
  if (schema.required !== undefined) {
    if (
      type !== 'object' ||
      !Array.isArray(schema.required) ||
      schema.required.some((item) => typeof item !== 'string')
    )
      invalid(`${label}.required must be a string array on an object schema`)
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean')
    invalid(`${label}.additionalProperties must be boolean`)
  if (schema.items !== undefined) {
    if (type !== 'array') invalid(`${label}.items requires type=array`)
    assertSafeSchema(schema.items, `${label}.items`, depth + 1)
  }
  if (
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      schema.enum.length === 0 ||
      schema.enum.some(
        (item) =>
          item !== null &&
          (typeof item === 'object' ||
            !['string', 'number', 'boolean'].includes(typeof item) ||
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
  return schema
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null)
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = stableValue((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(stableValue(value))
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function compilePlatformLocalPluginPackage(
  input: PlatformLocalPluginPackage,
): CompiledLocalPluginPackage {
  const manifestRaw = assertPlainObject(input.manifest, 'manifest')
  exactKeys(manifestRaw, ['schemaVersion', 'id', 'version', 'actions'], 'manifest')
  if (manifestRaw.schemaVersion !== 1) invalid('manifest.schemaVersion must be 1')
  if (typeof manifestRaw.id !== 'string' || !SLUG_RE.test(manifestRaw.id))
    invalid('manifest.id must be a valid Plugin slug')
  if (typeof manifestRaw.version !== 'string' || !VERSION_RE.test(manifestRaw.version))
    invalid('manifest.version must be semantic N.N.N')
  if (
    !Array.isArray(manifestRaw.actions) ||
    manifestRaw.actions.length === 0 ||
    manifestRaw.actions.length > 16
  )
    invalid('manifest.actions must contain 1-16 actions')

  const actionIds = new Set<string>()
  const actions: LocalPluginActionV1[] = manifestRaw.actions.map((item, index) => {
    const action = assertPlainObject(item, `manifest.actions[${index}]`)
    exactKeys(
      action,
      ['id', 'description', 'effect', 'entrypoint', 'timeoutSeconds', 'params', 'result'],
      `manifest.actions[${index}]`,
    )
    if (typeof action.id !== 'string' || !ACTION_RE.test(action.id))
      invalid(`manifest.actions[${index}].id is invalid`)
    if (actionIds.has(action.id)) invalid(`duplicate action id '${action.id}'`)
    actionIds.add(action.id)
    if (
      typeof action.description !== 'string' ||
      action.description.length === 0 ||
      action.description.length > 1000
    )
      invalid(`manifest.actions[${index}].description is invalid`)
    if (action.effect !== 'read')
      invalid(`manifest.actions[${index}].effect must be read in sandbox v1`)
    if (typeof action.entrypoint !== 'string' || !PACKAGE_PATH_RE.test(action.entrypoint))
      invalid(`manifest.actions[${index}].entrypoint must be a direct scripts/ file`)
    if (!INTERPRETER_BY_EXTENSION[extname(action.entrypoint)])
      invalid(`manifest.actions[${index}].entrypoint extension is not allowed`)
    if (
      !Number.isInteger(action.timeoutSeconds) ||
      Number(action.timeoutSeconds) < 1 ||
      Number(action.timeoutSeconds) > 120
    )
      invalid(`manifest.actions[${index}].timeoutSeconds must be 1-120`)
    const params = assertSafeSchema(action.params, `manifest.actions[${index}].params`)
    const result = assertSafeSchema(action.result, `manifest.actions[${index}].result`)
    if (params.type !== 'object' || params.additionalProperties !== false)
      invalid(`manifest.actions[${index}].params must be a strict object schema`)
    return {
      id: action.id,
      description: action.description,
      effect: 'read',
      entrypoint: action.entrypoint,
      timeoutSeconds: Number(action.timeoutSeconds),
      params,
      result,
    }
  })

  const filesRaw = assertPlainObject(input.files, 'files')
  const fileEntries = Object.entries(filesRaw)
  if (fileEntries.length === 0 || fileEntries.length > LOCAL_PLUGIN_PACKAGE_MAX_FILES)
    invalid(`files must contain 1-${LOCAL_PLUGIN_PACKAGE_MAX_FILES} entries`)
  const files: Record<string, string> = Object.create(null)
  let totalBytes = 0
  for (const [path, content] of fileEntries.sort(([a], [b]) => a.localeCompare(b))) {
    if (!PACKAGE_PATH_RE.test(path)) invalid(`invalid package file path '${path}'`)
    if (!INTERPRETER_BY_EXTENSION[extname(path)])
      invalid(`package file '${path}' has an unsupported extension`)
    if (typeof content !== 'string') invalid(`package file '${path}' must be UTF-8 text`)
    const bytes = Buffer.byteLength(content, 'utf8')
    if (bytes > LOCAL_PLUGIN_PACKAGE_MAX_FILE_BYTES)
      invalid(`package file '${path}' exceeds ${LOCAL_PLUGIN_PACKAGE_MAX_FILE_BYTES} bytes`)
    totalBytes += bytes
    files[path] = content
  }
  if (totalBytes > LOCAL_PLUGIN_PACKAGE_MAX_BYTES)
    invalid(`package exceeds ${LOCAL_PLUGIN_PACKAGE_MAX_BYTES} bytes`)
  for (const action of actions) {
    if (files[action.entrypoint] === undefined)
      invalid(`action '${action.id}' entrypoint is missing from files`)
  }

  const manifest: LocalPluginManifestV1 = {
    schemaVersion: 1,
    id: manifestRaw.id,
    version: manifestRaw.version,
    actions,
  }
  const digest = sha256(canonicalJson({ manifest, files }))
  return { manifest, files, digest }
}

async function fsyncHandle(handle: FileHandle): Promise<void> {
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function fsyncPath(path: string, flags: number): Promise<void> {
  await fsyncHandle(await open(path, flags))
}

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function assertSafeMaterializationRoot(
  root: string,
  expectedOwnerUid: number,
): Promise<string> {
  if (!isAbsolute(root))
    throw new LocalPluginSandboxError('INVALID_PACKAGE', 'artifact root must be absolute')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const lst = await lstat(root)
  if (!lst.isDirectory() || lst.isSymbolicLink())
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'artifact root is not a real directory')
  if (lst.uid !== expectedOwnerUid || (lst.mode & 0o022) !== 0)
    throw new LocalPluginSandboxError(
      'PACKAGE_TAMPERED',
      'artifact root ownership or mode is unsafe',
    )
  return realpath(root)
}

async function writeImmutableFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o755 })
  const handle = await open(
    path,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o444,
  )
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(path, 0o444)
}

async function collectTree(
  root: string,
): Promise<Array<{ abs: string; rel: string; entry: Dirent }>> {
  const out: Array<{ abs: string; rel: string; entry: Dirent }> = []
  const walk = async (absDir: string, relDir: string): Promise<void> => {
    const entries = await readdir(absDir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name
      const abs = join(absDir, entry.name)
      out.push({ abs, rel, entry })
      if (entry.isDirectory()) await walk(abs, rel)
    }
  }
  await walk(root, '')
  return out
}

export async function verifyMaterializedLocalPluginPackage(
  path: string,
  compiled: CompiledLocalPluginPackage,
  expectedOwnerUid = 0,
): Promise<void> {
  const candidate = resolve(path)
  const initialStat = await lstat(candidate).catch(() => null)
  if (!initialStat || !initialStat.isDirectory() || initialStat.isSymbolicLink())
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'artifact path is not a real directory')
  const root = await realpath(candidate).catch(() => '')
  if (!root || root !== candidate || !root.endsWith(`${sep}${compiled.digest}`))
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'artifact path is not digest-addressed')
  const rootStat = await lstat(root)
  if (rootStat.dev !== initialStat.dev || rootStat.ino !== initialStat.ino)
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'artifact directory changed during check')
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== expectedOwnerUid)
    throw new LocalPluginSandboxError(
      'PACKAGE_TAMPERED',
      'artifact directory ownership/type mismatch',
    )
  if ((rootStat.mode & 0o777) !== 0o555)
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'artifact directory mode mismatch')

  const expected = new Map<string, string>([
    ['manifest.json', `${canonicalJson(compiled.manifest)}\n`],
    ...Object.entries(compiled.files),
  ])
  const tree = await collectTree(root)
  for (const { abs, rel, entry } of tree) {
    const lst = await lstat(abs)
    if (lst.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
      throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `special package entry '${rel}'`)
    if (lst.uid !== expectedOwnerUid || (lst.mode & 0o022) !== 0)
      throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `unsafe ownership/mode for '${rel}'`)
    if (entry.isDirectory()) {
      if ((lst.mode & 0o777) !== 0o555)
        throw new LocalPluginSandboxError(
          'PACKAGE_TAMPERED',
          `directory mode mismatch for '${rel}'`,
        )
      continue
    }
    if (lst.nlink !== 1)
      throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `hardlinked package file '${rel}'`)
    if ((lst.mode & 0o777) !== 0o444)
      throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `file mode mismatch for '${rel}'`)
    const wanted = expected.get(rel)
    if (wanted === undefined)
      throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `unexpected package file '${rel}'`)
    const content = await readFile(abs, 'utf8')
    if (content !== wanted)
      throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `content mismatch for '${rel}'`)
    expected.delete(rel)
  }
  if (expected.size > 0)
    throw new LocalPluginSandboxError(
      'PACKAGE_TAMPERED',
      `package files missing: ${[...expected.keys()].join(', ')}`,
    )
  if (
    sha256(canonicalJson({ manifest: compiled.manifest, files: compiled.files })) !==
    compiled.digest
  )
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'compiled package digest mismatch')
}

export async function materializePlatformLocalPluginPackage(
  input: PlatformLocalPluginPackage,
  opts: { root: string; expectedOwnerUid?: number },
): Promise<MaterializedLocalPluginPackage> {
  const compiled = compilePlatformLocalPluginPackage(input)
  const expectedOwnerUid = opts.expectedOwnerUid ?? 0
  const artifactRoot = await assertSafeMaterializationRoot(resolve(opts.root), expectedOwnerUid)
  const finalPath = join(artifactRoot, compiled.digest)
  if (!contained(artifactRoot, finalPath))
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'artifact path escaped root')
  try {
    await verifyMaterializedLocalPluginPackage(finalPath, compiled, expectedOwnerUid)
    return { digest: compiled.digest, path: finalPath, compiled }
  } catch (error) {
    const exists = await stat(finalPath)
      .then(() => true)
      .catch(() => false)
    if (exists) throw error
  }

  const staging = join(artifactRoot, `.staging-${compiled.digest}-${process.pid}-${randomUUID()}`)
  if (!contained(artifactRoot, staging))
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'staging path escaped root')
  await mkdir(staging, { mode: 0o700 })
  try {
    await writeImmutableFile(
      join(staging, 'manifest.json'),
      `${canonicalJson(compiled.manifest)}\n`,
    )
    for (const [rel, content] of Object.entries(compiled.files)) {
      const target = join(staging, rel)
      if (!contained(staging, target))
        throw new LocalPluginSandboxError('PACKAGE_TAMPERED', `package path escaped: ${rel}`)
      await writeImmutableFile(target, content)
    }
    const dirs = (await collectTree(staging))
      .filter(({ entry }) => entry.isDirectory())
      .sort((a, b) => b.rel.length - a.rel.length)
    for (const dir of dirs) {
      await chmod(dir.abs, 0o555)
      await fsyncPath(dir.abs, fsConstants.O_RDONLY)
    }
    await chmod(staging, 0o555)
    await fsyncPath(staging, fsConstants.O_RDONLY)
    try {
      await rename(staging, finalPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
      await rm(staging, { recursive: true, force: true })
    }
    await fsyncPath(artifactRoot, fsConstants.O_RDONLY)
    await verifyMaterializedLocalPluginPackage(finalPath, compiled, expectedOwnerUid)
    return { digest: compiled.digest, path: finalPath, compiled }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export interface LocalPluginImagePolicy {
  imageId: string
  requiredLabels: Readonly<Record<string, string>>
}

export async function assertPinnedLocalPluginImage(
  docker: Docker,
  policy: LocalPluginImagePolicy,
): Promise<void> {
  if (!IMAGE_ID_RE.test(policy.imageId))
    throw new LocalPluginSandboxError('IMAGE_MISMATCH', 'Plugin image must be an exact sha256 ID')
  let info: Awaited<ReturnType<ReturnType<Docker['getImage']>['inspect']>>
  try {
    info = await docker.getImage(policy.imageId).inspect()
  } catch (error) {
    throw new LocalPluginSandboxError(
      'IMAGE_MISMATCH',
      `Plugin image is unavailable: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (info.Id !== policy.imageId)
    throw new LocalPluginSandboxError('IMAGE_MISMATCH', 'Docker returned a different image ID')
  const labels = info.Config?.Labels ?? {}
  if (labels[LOCAL_PLUGIN_IMAGE_ABI_LABEL] !== LOCAL_PLUGIN_IMAGE_ABI)
    throw new LocalPluginSandboxError('IMAGE_MISMATCH', 'Plugin image sandbox ABI mismatch')
  for (const [key, value] of Object.entries(policy.requiredLabels)) {
    if (labels[key] !== value)
      throw new LocalPluginSandboxError('IMAGE_MISMATCH', `Plugin image label mismatch: ${key}`)
  }
  if (Object.keys(info.Config?.Volumes ?? {}).length > 0)
    throw new LocalPluginSandboxError('IMAGE_MISMATCH', 'Plugin image declares writable volumes')
  for (const item of info.Config?.Env ?? []) {
    const separator = item.indexOf('=')
    const key = separator >= 0 ? item.slice(0, separator) : item
    if (!SAFE_IMAGE_ENV_KEYS.has(key))
      throw new LocalPluginSandboxError(
        'IMAGE_MISMATCH',
        `Plugin image declares unsupported environment key: ${key}`,
      )
  }
}

export interface LocalPluginSandboxLimits {
  memoryBytes: number
  nanoCpus: number
  pidsLimit: number
  tmpBytes: number
  stateBytes: number
  maxConcurrentPerUser: number
}

export const DEFAULT_LOCAL_PLUGIN_LIMITS: LocalPluginSandboxLimits = {
  memoryBytes: 512 * 1024 * 1024,
  nanoCpus: 500_000_000,
  pidsLimit: 64,
  tmpBytes: 64 * 1024 * 1024,
  stateBytes: 64 * 1024 * 1024,
  maxConcurrentPerUser: 2,
}

const LOCAL_PLUGIN_LIMIT_BOUNDS: Readonly<
  Record<keyof LocalPluginSandboxLimits, readonly [number, number]>
> = {
  memoryBytes: [64 * 1024 * 1024, 2 * 1024 * 1024 * 1024],
  nanoCpus: [100_000_000, 2_000_000_000],
  pidsLimit: [8, 256],
  tmpBytes: [1024 * 1024, 256 * 1024 * 1024],
  stateBytes: [1024 * 1024, 256 * 1024 * 1024],
  maxConcurrentPerUser: [1, 8],
}

export function assertLocalPluginSandboxLimits(limits: LocalPluginSandboxLimits): void {
  for (const [key, [minimum, maximum]] of Object.entries(LOCAL_PLUGIN_LIMIT_BOUNDS) as Array<
    [keyof LocalPluginSandboxLimits, readonly [number, number]]
  >) {
    const value = limits[key]
    if (!Number.isInteger(value) || value < minimum || value > maximum)
      throw new LocalPluginSandboxError(
        'INVALID_CONFIG',
        `Plugin sandbox limit ${key} must be an integer in ${minimum}-${maximum}`,
      )
  }
}

function interpreterFor(entrypoint: string): string {
  const interpreter = INTERPRETER_BY_EXTENSION[extname(entrypoint)]
  if (!interpreter) throw new LocalPluginSandboxError('INVALID_PACKAGE', 'unsupported entrypoint')
  return interpreter
}

export function buildLocalPluginContainerOptions(args: {
  imageId: string
  materializedPath: string
  digest: string
  manifest: LocalPluginManifestV1
  action: LocalPluginActionV1
  invocationId: string
  limits?: LocalPluginSandboxLimits
  broker?: LocalPluginBrokerMount
}): Docker.ContainerCreateOptions {
  if (!IMAGE_ID_RE.test(args.imageId))
    throw new LocalPluginSandboxError('IMAGE_MISMATCH', 'Plugin image must be an exact sha256 ID')
  if (!/^[0-9a-f]{64}$/.test(args.digest))
    throw new LocalPluginSandboxError('INVALID_PACKAGE', 'invalid package digest')
  const materializedPath = resolve(args.materializedPath)
  if (!isAbsolute(materializedPath) || !materializedPath.endsWith(`${sep}${args.digest}`))
    throw new LocalPluginSandboxError('PACKAGE_TAMPERED', 'materialized path/digest mismatch')
  const invocation = args.invocationId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32)
  if (invocation.length < 16)
    throw new LocalPluginSandboxError('INVALID_PACKAGE', 'invalid invocation id')
  const limits = args.limits ?? DEFAULT_LOCAL_PLUGIN_LIMITS
  assertLocalPluginSandboxLimits(limits)
  let brokerMount: Docker.MountSettings | null = null
  const brokerEnv: string[] = []
  if (args.broker) {
    const brokerRoot = resolve(args.broker.brokerRoot)
    const hostDirectory = resolve(args.broker.hostDirectory)
    if (
      args.broker.invocationId !== args.invocationId ||
      !isAbsolute(args.broker.brokerRoot) ||
      !isAbsolute(args.broker.hostDirectory) ||
      !isAbsolute(args.broker.hostSocketPath) ||
      dirname(hostDirectory) !== brokerRoot ||
      relative(brokerRoot, hostDirectory) !== args.invocationId ||
      args.broker.hostSocketPath !== join(hostDirectory, 'broker.sock') ||
      args.broker.containerSocketPath !== LOCAL_PLUGIN_BROKER_SOCKET ||
      !/^[A-Za-z0-9_-]{43}$/.test(args.broker.token)
    )
      throw new LocalPluginSandboxError('INVALID_CONFIG', 'invalid Plugin broker mount')
    brokerMount = {
      Type: 'bind',
      Source: hostDirectory,
      Target: dirname(LOCAL_PLUGIN_BROKER_SOCKET),
      ReadOnly: true,
      BindOptions: { Propagation: 'rprivate' },
    }
    brokerEnv.push(
      `OC_PLUGIN_BROKER_SOCKET=${LOCAL_PLUGIN_BROKER_SOCKET}`,
      `OC_PLUGIN_BROKER_TOKEN=${args.broker.token}`,
    )
  }
  return {
    name: `oc-v5-plugin-${invocation.toLowerCase()}`,
    Image: args.imageId,
    User: '1000:1000',
    WorkingDir: '/plugin',
    Env: [
      'HOME=/state',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'LANG=C.UTF-8',
      'LC_ALL=C.UTF-8',
      `OC_PLUGIN_ID=${args.manifest.id}`,
      `OC_PLUGIN_VERSION=${args.manifest.version}`,
      `OC_PLUGIN_ACTION=${args.action.id}`,
      ...brokerEnv,
    ],
    Entrypoint: [],
    Cmd: [interpreterFor(args.action.entrypoint), `/plugin/${args.action.entrypoint}`],
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: true,
    StdinOnce: true,
    Tty: false,
    NetworkDisabled: true,
    Healthcheck: { Test: ['NONE'] },
    Labels: {
      'com.openclaude.plugin.sandbox': '1',
      'com.openclaude.plugin.digest': args.digest,
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      CapAdd: [],
      SecurityOpt: ['no-new-privileges'],
      Privileged: false,
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,
      MemorySwappiness: 0,
      NanoCpus: limits.nanoCpus,
      PidsLimit: limits.pidsLimit,
      Tmpfs: {
        '/tmp': `rw,nosuid,nodev,noexec,size=${limits.tmpBytes},mode=0700,uid=1000,gid=1000`,
        '/state': `rw,nosuid,nodev,noexec,size=${limits.stateBytes},mode=0700,uid=1000,gid=1000`,
      },
      Mounts: [
        {
          Type: 'bind',
          Source: materializedPath,
          Target: '/plugin',
          ReadOnly: true,
          BindOptions: { Propagation: 'rprivate' },
        },
        ...(brokerMount ? [brokerMount] : []),
      ],
      RestartPolicy: { Name: 'no', MaximumRetryCount: 0 },
      LogConfig: { Type: 'none', Config: {} },
      AutoRemove: false,
      ShmSize: 32 * 1024 * 1024,
    },
  }
}

export class BoundedOutput {
  private chunks: Buffer[] = []
  private bytes = 0
  overflowed = false

  constructor(readonly maxBytes: number) {}

  append(chunk: string | Uint8Array): void {
    if (this.overflowed) return
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === 'string'
        ? Buffer.from(chunk)
        : Buffer.from(chunk)
    const remaining = this.maxBytes - this.bytes
    if (buf.length > remaining) {
      if (remaining > 0) this.chunks.push(buf.subarray(0, remaining))
      this.bytes = this.maxBytes
      this.overflowed = true
      return
    }
    this.chunks.push(buf)
    this.bytes += buf.length
  }

  text(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8')
  }
}

export async function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void | Promise<void>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => {
          void Promise.resolve(onTimeout()).catch(() => {})
          reject(new LocalPluginSandboxError('TIMEOUT', 'Plugin action timed out'))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function writableSink(out: BoundedOutput, onOverflow: () => void): NodeJS.WritableStream {
  return {
    write(chunk: string | Uint8Array): boolean {
      const before = out.overflowed
      out.append(chunk)
      if (!before && out.overflowed) onOverflow()
      return true
    },
  } as unknown as NodeJS.WritableStream
}

function jsonScalarEqual(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Object.is(a, b))
}

function matchesSafeJsonSchema(schema: Record<string, unknown>, value: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => jsonScalarEqual(item, value)))
    return false
  switch (schema.type) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'string': {
      if (typeof value !== 'string') return false
      if (typeof schema.minLength === 'number' && value.length < schema.minLength) return false
      if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) return false
      return true
    }
    case 'integer':
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false
      if (schema.type === 'integer' && !Number.isInteger(value)) return false
      if (typeof schema.minimum === 'number' && value < schema.minimum) return false
      if (typeof schema.maximum === 'number' && value > schema.maximum) return false
      return true
    }
    case 'array': {
      if (!Array.isArray(value)) return false
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false
      if (schema.items === undefined) return true
      return value.every((item) =>
        matchesSafeJsonSchema(schema.items as Record<string, unknown>, item),
      )
    }
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
        if (!matchesSafeJsonSchema(childSchema, child)) return false
      }
      return true
    }
    default:
      return false
  }
}

function validateJsonAgainstSchema(
  schema: Record<string, unknown>,
  value: unknown,
  code: 'INVALID_PARAMS' | 'INVALID_RESULT',
): void {
  if (!matchesSafeJsonSchema(schema, value))
    throw new LocalPluginSandboxError(
      code,
      code === 'INVALID_PARAMS' ? 'params do not match schema' : 'result does not match schema',
    )
}

export interface LocalPluginRunResult {
  result: unknown
  stderr: string
  digest: string
}

export class LocalPluginSandboxService {
  private readonly activeByUser = new Map<number, number>()

  constructor(
    private readonly docker: Docker,
    private readonly opts: {
      artifactRoot: string
      image: LocalPluginImagePolicy
      packages: ReadonlyMap<string, PlatformLocalPluginPackage>
      limits?: LocalPluginSandboxLimits
      expectedArtifactOwnerUid?: number
      brokerPolicies?: ReadonlyMap<string, unknown>
      brokerRoot?: string
      brokerDeps?: LocalPluginBrokerDeps
      expectedBrokerOwnerUid?: number
      brokerSocketUid?: number
      brokerSocketGid?: number
    },
  ) {}

  /** No production caller is wired in phase 3.2a; this remains an internal boundary. */
  async runReadAction(args: {
    userId: number
    pluginId: string
    actionId: string
    params: Record<string, unknown>
  }): Promise<LocalPluginRunResult> {
    const limits = this.opts.limits ?? DEFAULT_LOCAL_PLUGIN_LIMITS
    assertLocalPluginSandboxLimits(limits)
    const current = this.activeByUser.get(args.userId) ?? 0
    if (current >= limits.maxConcurrentPerUser)
      throw new LocalPluginSandboxError('QUOTA_EXCEEDED', 'too many concurrent Plugin actions')
    const source = this.opts.packages.get(args.pluginId)
    if (!source)
      throw new LocalPluginSandboxError(
        'ACTION_NOT_FOUND',
        'Plugin is not in the platform allowlist',
      )
    this.activeByUser.set(args.userId, current + 1)
    let container: Docker.Container | null = null
    let attachStream: Duplex | null = null
    let broker: LocalPluginBrokerHandle | null = null
    let completed: LocalPluginRunResult | null = null
    let failure: { error: unknown } | null = null
    let brokerCleanupError: unknown
    try {
      await assertPinnedLocalPluginImage(this.docker, this.opts.image)
      const materialized = await materializePlatformLocalPluginPackage(source, {
        root: this.opts.artifactRoot,
        expectedOwnerUid: this.opts.expectedArtifactOwnerUid ?? 0,
      })
      if (materialized.compiled.manifest.id !== args.pluginId)
        throw new LocalPluginSandboxError(
          'INVALID_PACKAGE',
          'allowlist key does not match manifest id',
        )
      const action = materialized.compiled.manifest.actions.find(
        (item) => item.id === args.actionId,
      )
      if (!action) throw new LocalPluginSandboxError('ACTION_NOT_FOUND', 'Plugin action not found')
      validateJsonAgainstSchema(action.params, args.params, 'INVALID_PARAMS')
      const paramsJson = canonicalJson(args.params)
      if (Buffer.byteLength(paramsJson, 'utf8') > LOCAL_PLUGIN_PARAMS_MAX_BYTES)
        throw new LocalPluginSandboxError('INVALID_PARAMS', 'params exceed byte limit')

      const invocationId = randomUUID()
      const rawBrokerPolicy = this.opts.brokerPolicies?.get(args.pluginId)
      if (rawBrokerPolicy !== undefined) {
        const allowedActionIds = new Set(
          materialized.compiled.manifest.actions.map((item) => item.id),
        )
        const compiledBrokerPolicy = compileLocalPluginBrokerPolicy(
          rawBrokerPolicy,
          allowedActionIds,
        )
        const actionPolicy = compiledBrokerPolicy.actions[action.id]
        if (actionPolicy) {
          if (!this.opts.brokerRoot)
            throw new LocalPluginSandboxError(
              'INVALID_CONFIG',
              'Plugin broker root is required by the action policy',
            )
          broker = await createLocalPluginBroker({
            root: this.opts.brokerRoot,
            invocationId,
            policy: actionPolicy,
            expectedOwnerUid: this.opts.expectedBrokerOwnerUid ?? 0,
            socketUid: this.opts.brokerSocketUid ?? 1000,
            socketGid: this.opts.brokerSocketGid ?? 1000,
            deps: this.opts.brokerDeps,
          })
        }
      }
      container = await this.docker.createContainer(
        buildLocalPluginContainerOptions({
          imageId: this.opts.image.imageId,
          materializedPath: materialized.path,
          digest: materialized.digest,
          manifest: materialized.compiled.manifest,
          action,
          invocationId,
          limits,
          ...(broker ? { broker: broker.mount } : {}),
        }),
      )
      const stream = (await container.attach({
        stream: true,
        stdin: true,
        stdout: true,
        stderr: true,
      })) as Duplex
      attachStream = stream
      const stdout = new BoundedOutput(LOCAL_PLUGIN_STDOUT_MAX_BYTES)
      const stderr = new BoundedOutput(LOCAL_PLUGIN_STDERR_MAX_BYTES)
      let outputKilled = false
      const killForOutput = () => {
        if (outputKilled) return
        outputKilled = true
        void container?.kill().catch(() => {})
      }
      this.docker.modem.demuxStream(
        stream,
        writableSink(stdout, killForOutput),
        writableSink(stderr, killForOutput),
      )
      const streamEnded = new Promise<void>((resolveEnd, rejectEnd) => {
        stream.once('end', resolveEnd)
        stream.once('error', rejectEnd)
      })
      await container.start()
      await new Promise<void>((resolveWrite, rejectWrite) => {
        stream.write(`${paramsJson}\n`, (error) => {
          if (error) rejectWrite(error)
          else resolveWrite()
        })
      })
      const waitResult = await waitWithTimeout(container.wait(), action.timeoutSeconds * 1000, () =>
        container?.kill().catch(() => {}),
      )
      await waitWithTimeout(streamEnded, 2_000, () => container?.kill().catch(() => {}))
      if (stdout.overflowed || stderr.overflowed)
        throw new LocalPluginSandboxError('OUTPUT_LIMIT', 'Plugin output exceeded byte limit')
      const statusCode = (waitResult as { StatusCode?: number }).StatusCode ?? -1
      if (statusCode !== 0)
        throw new LocalPluginSandboxError(
          'EXECUTION_FAILED',
          `Plugin exited with status ${statusCode}: ${stderr.text().slice(0, 1000)}`,
        )
      let result: unknown
      try {
        result = JSON.parse(stdout.text())
      } catch {
        throw new LocalPluginSandboxError('INVALID_RESULT', 'Plugin stdout is not one JSON value')
      }
      validateJsonAgainstSchema(action.result, result, 'INVALID_RESULT')
      completed = { result, stderr: stderr.text(), digest: materialized.digest }
    } catch (error) {
      failure = { error }
    } finally {
      attachStream?.destroy()
      if (container) await container.remove({ force: true }).catch(() => {})
      if (broker) {
        try {
          await broker.close()
        } catch (error) {
          brokerCleanupError = error
        }
      }
      const next = (this.activeByUser.get(args.userId) ?? 1) - 1
      if (next <= 0) this.activeByUser.delete(args.userId)
      else this.activeByUser.set(args.userId, next)
    }
    if (brokerCleanupError) throw brokerCleanupError
    if (failure) throw failure.error
    if (!completed)
      throw new LocalPluginSandboxError('EXECUTION_FAILED', 'Plugin action did not complete')
    return completed
  }
}
