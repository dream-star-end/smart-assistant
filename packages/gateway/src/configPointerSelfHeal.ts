/**
 * OCV5-883: Declarative startup/refresh self-healing for retired model & provider pointers.
 *
 * Inspects and idempotently heals stale model/provider pointers across:
 *   1. `openclaude.json` (`defaults.model`, top-level `provider`)
 *   2. `agents.yaml` (`agents[].model`, `agents[].provider`)
 *   3. `collaboration-config.json` (`defaultAdvisorModel`, `sessions[id].advisorModel`)
 *
 * Safety invariants:
 *   - Only migrates to a target model proven routable in the active `LocalCatalogView`.
 *   - Corrupt JSON/YAML fails closed (recorded in `errors[]`, original bytes never overwritten).
 *   - Uses shared `acquireKernelFileLock("${file}.lock")` + in-lock fresh read + in-place
 *     mutation of target fields only + atomic `0600` temp+rename so concurrent OAuth/config
 *     updates and unknown top-level/session extension fields are strictly preserved.
 *   - Zero changes or `dryRun: true` perform zero writes, zero lock-file creations, and zero
 *     `rev` increments.
 *   - Emits a single structured log entry when migrations occurred; completely silent otherwise.
 *   - Second call is 100% idempotent (`changedFiles: []`, `migrations: []`).
 */
import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { acquireKernelFileLock, paths } from '@openclaude/storage'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  COLLAB_CONFIG_FORMAT,
  CollaborationConfigError,
  parseCollaborationConfigDoc,
} from './advisorConfigStore.js'
import type { LocalCatalogModel, LocalCatalogView } from './modelCatalogClient.js'

export const LEGACY_MODEL_POINTER_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'gpt-6.1-sol': 'gpt-6.2-sol',
  'gpt-6.1-sol-1m': 'gpt-6.2-sol-1m',
  'gpt-6.1-astra': 'gpt-6.2-astra',
  'gpt-6.1-astra-1m': 'gpt-6.2-astra-1m',
  'grok-build': 'gpt-6.2-sol',
  'grok-build-fast': 'gpt-6.2-sol',
  'cursor-grok-4.6-low': 'cursor-grok-4.7-low',
  'cursor-grok-4.6-medium': 'cursor-grok-4.7-medium',
  'cursor-grok-4.6-high': 'cursor-grok-4.7-high',
  'cursor-grok-4.6-xhigh': 'cursor-grok-4.7-xhigh',
  'cursor-grok-4.6-high-fast': 'cursor-grok-4.7-high-fast',
})

export const DEPRECATED_PROVIDERS: ReadonlySet<string> = new Set([
  'zai',
  'z.ai',
])

export type ModelCatalogHealView = Pick<LocalCatalogView, 'canonicalize' | 'isRoutable' | 'resolve'>

export interface HealedModelPointerResult {
  changed: boolean
  from: string
  to: string
  reason: 'unchanged' | 'catalog_canonicalized' | 'legacy_alias' | 'unroutable_kept'
  resolvedModel: LocalCatalogModel | null
}

export interface HealedProviderResult {
  changed: boolean
  from: string | undefined
  to: string | undefined
  reason: 'unchanged' | 'deprecated_provider' | 'provider_conflict'
}

export type ConfigPointerHealFileName =
  | 'openclaude.json'
  | 'agents.yaml'
  | 'collaboration-config.json'

export interface ConfigPointerMigration {
  file: ConfigPointerHealFileName
  field: string
  from: string | null
  to: string | null
  reason: string
}

export interface HealConfigModelPointersOptions {
  catalog: ModelCatalogHealView
  configPath?: string
  agentsYamlPath?: string
  collaborationConfigPath?: string
  extraAliases?: Readonly<Record<string, string>>
  dryRun?: boolean
  log?: (event: string, fields: Record<string, unknown>) => void
}

export interface ConfigPointerSelfHealReport {
  dryRun: boolean
  changedFiles: ConfigPointerHealFileName[]
  migrations: ConfigPointerMigration[]
  errors: string[]
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isEnoent(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as NodeJS.ErrnoException).code === 'ENOENT')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function lookupAlias(
  key: string,
  extraAliases?: Readonly<Record<string, string>>,
): string | undefined {
  const lower = key.toLowerCase()
  if (extraAliases) {
    if (Object.prototype.hasOwnProperty.call(extraAliases, key)) return extraAliases[key]
    for (const [k, v] of Object.entries(extraAliases)) {
      if (k.toLowerCase() === lower) return v
    }
  }
  if (Object.prototype.hasOwnProperty.call(LEGACY_MODEL_POINTER_ALIASES, lower)) {
    return LEGACY_MODEL_POINTER_ALIASES[lower]
  }
  return undefined
}

export function resolveHealedModelPointer(
  rawModel: string,
  catalog: ModelCatalogHealView,
  extraAliases?: Readonly<Record<string, string>>,
): HealedModelPointerResult {
  const trimmed = rawModel.trim()
  if (!trimmed) {
    return {
      changed: false,
      from: rawModel,
      to: rawModel,
      reason: 'unchanged',
      resolvedModel: null,
    }
  }

  const canonical = catalog.canonicalize(trimmed)
  if (catalog.isRoutable(canonical)) {
    const resolvedModel = catalog.resolve(canonical)
    if (canonical !== rawModel) {
      return {
        changed: true,
        from: rawModel,
        to: canonical,
        reason: 'catalog_canonicalized',
        resolvedModel,
      }
    }
    return {
      changed: false,
      from: rawModel,
      to: rawModel,
      reason: 'unchanged',
      resolvedModel,
    }
  }

  const aliasCandidate =
    lookupAlias(trimmed, extraAliases) ??
    (canonical !== trimmed ? lookupAlias(canonical, extraAliases) : undefined)
  if (aliasCandidate) {
    const target = catalog.canonicalize(aliasCandidate.trim())
    if (catalog.isRoutable(target)) {
      const resolvedModel = catalog.resolve(target)
      return {
        changed: target !== rawModel,
        from: rawModel,
        to: target,
        reason: target !== rawModel ? 'legacy_alias' : 'unchanged',
        resolvedModel,
      }
    }
  }

  return {
    changed: false,
    from: rawModel,
    to: rawModel,
    reason: 'unroutable_kept',
    resolvedModel: null,
  }
}

function providerMatchesModel(normProvider: string, model: LocalCatalogModel): boolean {
  if (model.providerId && model.providerId.trim().toLowerCase() === normProvider) return true
  const engine = model.engine.toLowerCase()
  if (engine === normProvider) return true
  if (engine === 'codex' && normProvider === 'codex-native') return true
  return false
}

function preferredProviderForModel(model: LocalCatalogModel | null): string | undefined {
  const candidate = model?.providerId?.trim()
  if (!candidate) return undefined
  if (DEPRECATED_PROVIDERS.has(candidate.toLowerCase())) return undefined
  return candidate
}

export function resolveHealedProvider(
  currentProvider: string | undefined,
  modelResult: HealedModelPointerResult | null,
): HealedProviderResult {
  if (typeof currentProvider !== 'string' || !currentProvider.trim()) {
    return { changed: false, from: currentProvider, to: currentProvider, reason: 'unchanged' }
  }
  const norm = currentProvider.trim().toLowerCase()
  const resolved = modelResult?.resolvedModel ?? null

  if (DEPRECATED_PROVIDERS.has(norm)) {
    const nextProvider = preferredProviderForModel(resolved)
    return {
      changed: true,
      from: currentProvider,
      to: nextProvider,
      reason: 'deprecated_provider',
    }
  }

  if (modelResult?.changed && resolved && !providerMatchesModel(norm, resolved)) {
    const nextProvider = preferredProviderForModel(resolved)
    return {
      changed: nextProvider !== currentProvider,
      from: currentProvider,
      to: nextProvider,
      reason: 'provider_conflict',
    }
  }

  return { changed: false, from: currentProvider, to: currentProvider, reason: 'unchanged' }
}

async function atomicWriteText(filepath: string, content: string): Promise<void> {
  await mkdir(dirname(filepath), { recursive: true })
  const tmp = `${filepath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  try {
    await writeFile(tmp, content, { mode: 0o600 })
    await rename(tmp, filepath)
  } finally {
    await rm(tmp, { force: true }).catch(() => {})
  }
}

async function fileExistsRegular(filepath: string): Promise<boolean> {
  try {
    const st = await lstat(filepath)
    return !st.isSymbolicLink() && st.isFile()
  } catch (err) {
    if (isEnoent(err)) return false
    throw err
  }
}

function applyOpenClaudeJsonHealInPlace(
  parsed: Record<string, unknown>,
  catalog: ModelCatalogHealView,
  extraAliases: Readonly<Record<string, string>> | undefined,
): ConfigPointerMigration[] {
  const migrations: ConfigPointerMigration[] = []
  let modelResult: HealedModelPointerResult | null = null

  if (isPlainObject(parsed.defaults) && typeof parsed.defaults.model === 'string') {
    modelResult = resolveHealedModelPointer(parsed.defaults.model, catalog, extraAliases)
    if (modelResult.changed) {
      parsed.defaults.model = modelResult.to
      migrations.push({
        file: 'openclaude.json',
        field: 'defaults.model',
        from: modelResult.from,
        to: modelResult.to,
        reason: modelResult.reason,
      })
    }
  }

  if (typeof parsed.provider === 'string') {
    const providerResult = resolveHealedProvider(parsed.provider, modelResult)
    if (providerResult.changed) {
      if (providerResult.to === undefined) {
        delete parsed.provider
      } else {
        parsed.provider = providerResult.to
      }
      migrations.push({
        file: 'openclaude.json',
        field: 'provider',
        from: providerResult.from ?? null,
        to: providerResult.to ?? null,
        reason: providerResult.reason,
      })
    }
  }

  return migrations
}

async function healOpenClaudeJson(
  configPath: string,
  catalog: ModelCatalogHealView,
  extraAliases: Readonly<Record<string, string>> | undefined,
  dryRun: boolean,
  report: ConfigPointerSelfHealReport,
): Promise<void> {
  let exists: boolean
  try {
    exists = await fileExistsRegular(configPath)
  } catch (err) {
    report.errors.push(`openclaude.json: ${formatErr(err)}`)
    return
  }
  if (!exists) return

  const runBody = async (): Promise<void> => {
    if (!(await fileExistsRegular(configPath))) return
    let rawText: string
    try {
      rawText = await readFile(configPath, 'utf8')
    } catch (err) {
      if (isEnoent(err)) return
      report.errors.push(`openclaude.json read: ${formatErr(err)}`)
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(rawText)
    } catch (err) {
      report.errors.push(`openclaude.json corrupt JSON: ${formatErr(err)}`)
      return
    }
    if (!isPlainObject(parsed)) {
      report.errors.push('openclaude.json corrupt: root is not an object')
      return
    }

    // Mutate only defaults.model & top-level provider in place on the latest disk snapshot
    // so concurrent OAuth / auth / gateway / mcpServers fields are strictly preserved.
    const migrations = applyOpenClaudeJsonHealInPlace(parsed, catalog, extraAliases)
    if (migrations.length === 0) return

    report.migrations.push(...migrations)
    if (!dryRun) {
      await atomicWriteText(configPath, `${JSON.stringify(parsed, null, 2)}\n`)
      report.changedFiles.push('openclaude.json')
    }
  }

  if (dryRun) {
    await runBody()
    return
  }

  // Share the exact `${configPath}.lock` lock file used by `@openclaude/storage` config writers.
  const lock = await acquireKernelFileLock(`${configPath}.lock`)
  try {
    await runBody()
  } finally {
    await lock.release()
  }
}

function applyAgentsYamlHealInPlace(
  parsed: Record<string, unknown>,
  catalog: ModelCatalogHealView,
  extraAliases: Readonly<Record<string, string>> | undefined,
): ConfigPointerMigration[] {
  const migrations: ConfigPointerMigration[] = []
  const agents = parsed.agents as unknown[]
  for (let i = 0; i < agents.length; i++) {
    const entry = agents[i]
    if (!isPlainObject(entry)) continue
    const agentLabel = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : String(i)

    let modelResult: HealedModelPointerResult | null = null
    if (typeof entry.model === 'string') {
      modelResult = resolveHealedModelPointer(entry.model, catalog, extraAliases)
      if (modelResult.changed) {
        entry.model = modelResult.to
        migrations.push({
          file: 'agents.yaml',
          field: `agents.${agentLabel}.model`,
          from: modelResult.from,
          to: modelResult.to,
          reason: modelResult.reason,
        })
      }
    }

    if (typeof entry.provider === 'string') {
      const providerResult = resolveHealedProvider(entry.provider, modelResult)
      if (providerResult.changed) {
        if (providerResult.to === undefined) {
          delete entry.provider
        } else {
          entry.provider = providerResult.to
        }
        migrations.push({
          file: 'agents.yaml',
          field: `agents.${agentLabel}.provider`,
          from: providerResult.from ?? null,
          to: providerResult.to ?? null,
          reason: providerResult.reason,
        })
      }
    }
  }
  return migrations
}

async function healAgentsYaml(
  agentsYamlPath: string,
  catalog: ModelCatalogHealView,
  extraAliases: Readonly<Record<string, string>> | undefined,
  dryRun: boolean,
  report: ConfigPointerSelfHealReport,
): Promise<void> {
  let exists: boolean
  try {
    exists = await fileExistsRegular(agentsYamlPath)
  } catch (err) {
    report.errors.push(`agents.yaml: ${formatErr(err)}`)
    return
  }
  if (!exists) return

  const runBody = async (): Promise<void> => {
    if (!(await fileExistsRegular(agentsYamlPath))) return
    let rawText: string
    try {
      rawText = await readFile(agentsYamlPath, 'utf8')
    } catch (err) {
      if (isEnoent(err)) return
      report.errors.push(`agents.yaml read: ${formatErr(err)}`)
      return
    }

    let parsed: unknown
    try {
      parsed = parseYaml(rawText)
    } catch (err) {
      report.errors.push(`agents.yaml corrupt YAML: ${formatErr(err)}`)
      return
    }
    if (!isPlainObject(parsed) || !Array.isArray(parsed.agents)) {
      report.errors.push('agents.yaml corrupt: root or agents[] invalid')
      return
    }

    const migrations = applyAgentsYamlHealInPlace(parsed, catalog, extraAliases)
    if (migrations.length === 0) return

    report.migrations.push(...migrations)
    if (!dryRun) {
      await atomicWriteText(agentsYamlPath, stringifyYaml(parsed))
      report.changedFiles.push('agents.yaml')
    }
  }

  if (dryRun) {
    await runBody()
    return
  }

  const lock = await acquireKernelFileLock(`${agentsYamlPath}.lock`)
  try {
    await runBody()
  } finally {
    await lock.release()
  }
}

function applyCollaborationRawHealInPlace(
  rawObj: Record<string, unknown>,
  catalog: ModelCatalogHealView,
  extraAliases: Readonly<Record<string, string>> | undefined,
): ConfigPointerMigration[] {
  const migrations: ConfigPointerMigration[] = []

  if (typeof rawObj.defaultAdvisorModel === 'string' && rawObj.defaultAdvisorModel.trim()) {
    const res = resolveHealedModelPointer(rawObj.defaultAdvisorModel, catalog, extraAliases)
    if (res.changed && res.to.length <= 64) {
      rawObj.defaultAdvisorModel = res.to
      migrations.push({
        file: 'collaboration-config.json',
        field: 'defaultAdvisorModel',
        from: res.from,
        to: res.to,
        reason: res.reason,
      })
    }
  }

  if (isPlainObject(rawObj.sessions)) {
    for (const [sessionId, sessionVal] of Object.entries(rawObj.sessions)) {
      if (!isPlainObject(sessionVal)) continue
      if (typeof sessionVal.advisorModel === 'string' && sessionVal.advisorModel.trim()) {
        const res = resolveHealedModelPointer(sessionVal.advisorModel, catalog, extraAliases)
        if (res.changed) {
          sessionVal.advisorModel = res.to
          migrations.push({
            file: 'collaboration-config.json',
            field: `sessions.${sessionId}.advisorModel`,
            from: res.from,
            to: res.to,
            reason: res.reason,
          })
        }
      }
    }
  }

  return migrations
}

async function healCollaborationConfig(
  collabPath: string,
  catalog: ModelCatalogHealView,
  extraAliases: Readonly<Record<string, string>> | undefined,
  dryRun: boolean,
  report: ConfigPointerSelfHealReport,
): Promise<void> {
  let exists: boolean
  try {
    exists = await fileExistsRegular(collabPath)
  } catch (err) {
    report.errors.push(`collaboration-config.json: ${formatErr(err)}`)
    return
  }
  if (!exists) return

  const runBody = async (): Promise<void> => {
    if (!(await fileExistsRegular(collabPath))) return
    let rawText: string
    try {
      rawText = await readFile(collabPath, 'utf8')
    } catch (err) {
      if (isEnoent(err)) return
      report.errors.push(`collaboration-config.json read: ${formatErr(err)}`)
      return
    }

    let rawObj: unknown
    try {
      rawObj = JSON.parse(rawText)
    } catch (err) {
      report.errors.push(`collaboration-config.json corrupt JSON: ${formatErr(err)}`)
      return
    }

    // Validate full document contract via parseCollaborationConfigDoc (fail closed on corrupt),
    // but mutate `rawObj` directly in place so unknown top-level & session extension fields
    // are never stripped by whitelist projection.
    let validatedDoc
    try {
      validatedDoc = parseCollaborationConfigDoc(rawObj)
    } catch (err) {
      if (err instanceof CollaborationConfigError) {
        report.errors.push(`collaboration-config.json corrupt: ${err.message}`)
      } else {
        report.errors.push(`collaboration-config.json validate: ${formatErr(err)}`)
      }
      return
    }
    if (!isPlainObject(rawObj)) {
      report.errors.push('collaboration-config.json corrupt: root is not an object')
      return
    }

    const migrations = applyCollaborationRawHealInPlace(rawObj, catalog, extraAliases)
    if (migrations.length === 0) return

    if (dryRun) {
      report.migrations.push(...migrations)
      return
    }

    rawObj.format = COLLAB_CONFIG_FORMAT
    rawObj.rev = validatedDoc.rev + 1
    try {
      parseCollaborationConfigDoc(rawObj)
    } catch (err) {
      report.errors.push(`collaboration-config.json post-heal validation: ${formatErr(err)}`)
      return
    }

    await atomicWriteText(collabPath, `${JSON.stringify(rawObj, null, 2)}\n`)
    report.migrations.push(...migrations)
    report.changedFiles.push('collaboration-config.json')
  }

  if (dryRun) {
    await runBody()
    return
  }

  // Share the exact `${collabPath}.lock` lock file used by `AdvisorConfigStore`.
  const lock = await acquireKernelFileLock(`${collabPath}.lock`, 8_000)
  try {
    await runBody()
  } finally {
    await lock.release()
  }
}

export async function healConfigModelPointers(
  opts: HealConfigModelPointersOptions,
): Promise<ConfigPointerSelfHealReport> {
  const configPath = opts.configPath ?? paths.config
  const agentsYamlPath = opts.agentsYamlPath ?? paths.agentsYaml
  const collabPath = opts.collaborationConfigPath ?? paths.collaborationConfig
  const dryRun = opts.dryRun === true

  const report: ConfigPointerSelfHealReport = {
    dryRun,
    changedFiles: [],
    migrations: [],
    errors: [],
  }

  try {
    await healOpenClaudeJson(configPath, opts.catalog, opts.extraAliases, dryRun, report)
  } catch (err) {
    report.errors.push(`openclaude.json: ${formatErr(err)}`)
  }

  try {
    await healAgentsYaml(agentsYamlPath, opts.catalog, opts.extraAliases, dryRun, report)
  } catch (err) {
    report.errors.push(`agents.yaml: ${formatErr(err)}`)
  }

  try {
    await healCollaborationConfig(collabPath, opts.catalog, opts.extraAliases, dryRun, report)
  } catch (err) {
    report.errors.push(`collaboration-config.json: ${formatErr(err)}`)
  }

  if (report.migrations.length > 0) {
    opts.log?.('config_pointer_self_healed', {
      dryRun: report.dryRun,
      changedFiles: report.changedFiles,
      migrationCount: report.migrations.length,
      migrations: report.migrations,
      errors: report.errors,
    })
  }

  return report
}
