/** OCV5-746: tool version-drift check between the official Claude Code CLI's builtin tools and the
 * container CCB tool host (`mcp serve --tool-profile full`), which every remote-pool chat uses.
 *
 * Remote chats run the official CLI with `--tools ''`; all tools come from the CCB host. An upgrade
 * of the node's pinned CLI can therefore silently change what the model is offered. Run this check
 * whenever that pin moves.
 *
 * Usage (from the repository root):
 *
 *   # 1. Official side: capture the request body the pinned CLI would send (no model calls).
 *   scripts/agent-remote/cc5-official-tools.sh --out /tmp/official-2.1.316.json
 *
 *   # 2. Diff against the live container host:
 *   npx tsx scripts/agent-remote/cc5-tool-drift.mts \
 *     --official /tmp/official-2.1.316.json --ccb-live --out /tmp/drift.md
 *
 *   # ...or against a saved CCB tools/list dump:
 *   npx tsx scripts/agent-remote/cc5-tool-drift.mts --official a.json --ccb b.json
 *
 * Exit codes: 0 = no unexpected drift, 1 = drift, 2 = usage/IO error.
 *
 * Accepted input files: a raw Anthropic request body or capture (`{tools:[...]}`), an
 * `api-request-shape` transcript row (`{shape:{tools:[...]}}`), an MCP `tools/list` result
 * (`{result:{tools:[...]}}`), a bare array, or an NDJSON transcript (union of all rows).
 * Tool objects may use `input_schema` (API) or `inputSchema` (MCP).
 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Cc5ToolHost } from '../../packages/gateway/src/cc5ToolHost.js'

// ---------------------------------------------------------------------------------------------
// Classification policy. Anything one-sided that is not listed here is reported as drift so a
// CLI upgrade cannot quietly change the remote tool surface.
// ---------------------------------------------------------------------------------------------

/** Tools the CCB host adds for the remote bridge itself; the official CLI never has them. */
export const PLATFORM_ONLY_CCB = ['ExecuteExtraTool', 'SearchExtraTools'] as const

/** Deferred-tool mechanism tools. Loading strategy, not behaviour: never a drift finding. */
export const MECHANISM = ['DeferredToolPlaceholder', 'ToolSearch'] as const

/** Official builtins the remote tool host deliberately withholds (interactive UI, messaging,
 * schedulers, plan mode, and AskUserQuestion which the gateway answers as a permission card). */
export const EXCLUDED_OFFICIAL = [
  'Agent',
  'AskUserQuestion',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterPlanMode',
  'ExitPlanMode',
  'RemoteTrigger',
  'SendMessage',
] as const

const PLATFORM = new Set<string>(PLATFORM_ONLY_CCB)
const MECHANISMS = new Set<string>(MECHANISM)
const EXCLUDED = new Set<string>(EXCLUDED_OFFICIAL)
const SCHEMA_IGNORED_KEYS = new Set(['$schema'])

// ---------------------------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema of the input, or null when only the name is known (deferred, schema unloaded). */
  inputSchema: Record<string, unknown> | null
  /** The official CLI defers this tool: it appears by name only until fetched via ToolSearch. */
  deferred: boolean
}

export interface ToolSet {
  /** Human label used in the report (file path, or "live CCB tool host"). */
  label: string
  /** Free-form provenance lines, e.g. cli version, capture method, model calls. */
  meta: Record<string, string>
  tools: ToolDefinition[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function toolArrayFrom(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value
  if (!isRecord(value)) return null
  if (Array.isArray(value.tools)) return value.tools
  if (isRecord(value.shape) && Array.isArray(value.shape.tools)) return value.shape.tools
  if (isRecord(value.result) && Array.isArray(value.result.tools)) return value.result.tools
  return null
}

function normalizeTool(value: unknown): ToolDefinition | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !value.name) return null
  const rawSchema = value.input_schema ?? value.inputSchema
  const schema = isRecord(rawSchema) ? rawSchema : null
  return {
    name: value.name,
    description: typeof value.description === 'string' ? value.description : '',
    inputSchema: schema,
    deferred: value.defer_loading === true || value.deferred === true,
  }
}

/** Everything a file may carry, merged by name: later rows win, but a real schema beats none. */
function mergeTools(values: unknown[]): ToolDefinition[] {
  const byName = new Map<string, ToolDefinition>()
  for (const value of values) {
    const tool = normalizeTool(value)
    if (!tool) continue
    const previous = byName.get(tool.name)
    if (!previous) {
      byName.set(tool.name, tool)
      continue
    }
    byName.set(tool.name, {
      name: tool.name,
      description: tool.description || previous.description,
      inputSchema: tool.inputSchema ?? previous.inputSchema,
      deferred: previous.deferred && tool.deferred,
    })
  }
  return [...byName.values()]
}

/** Merges a capture's `deferred_names` (names the CLI mentions but never sends a schema for). */
function withDeferredNames(tools: ToolDefinition[], names: unknown): ToolDefinition[] {
  if (!Array.isArray(names)) return tools
  const seen = new Set(tools.map((tool) => tool.name))
  const extra: ToolDefinition[] = []
  for (const name of names) {
    if (typeof name !== 'string' || !name || seen.has(name)) continue
    seen.add(name)
    extra.push({ name, description: '', inputSchema: null, deferred: true })
  }
  return [...tools, ...extra]
}

export function parseToolDocument(text: string): ToolDefinition[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // NDJSON (a session transcript): merge every row that carries a tools array or deferred names.
    const rows: unknown[] = []
    let deferredNames: unknown[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let row: unknown
      try {
        row = JSON.parse(trimmed)
      } catch {
        continue
      }
      const tools = toolArrayFrom(row)
      if (tools) rows.push(...tools)
      if (isRecord(row) && Array.isArray(row.deferred_names))
        deferredNames = deferredNames.concat(row.deferred_names)
      else if (isRecord(row) && Array.isArray(row.deferredNames))
        deferredNames = deferredNames.concat(row.deferredNames)
    }
    if (!rows.length && !deferredNames.length) throw new Error('CC5_DRIFT_INPUT_NOT_JSON')
    return withDeferredNames(mergeTools(rows), deferredNames)
  }
  const tools = toolArrayFrom(parsed)
  if (!tools) throw new Error('CC5_DRIFT_INPUT_NO_TOOLS')
  const names = isRecord(parsed) ? (parsed.deferred_names ?? parsed.deferredNames) : undefined
  const normalized = mergeTools(tools)
  if (!normalized.length) throw new Error('CC5_DRIFT_INPUT_NO_TOOLS')
  return withDeferredNames(normalized, names)
}

/** Provenance lines a capture file carries (`cli_version`, `captured_at`, `model_calls`, ...). */
export function parseProvenance(text: string): Record<string, string> {
  const meta: Record<string, string> = {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed)) return meta
    for (const key of ['cli_version', 'captured_at', 'capture_method', 'model_calls', 'source']) {
      const value = parsed[key]
      if (typeof value === 'string' || typeof value === 'number') meta[key] = String(value)
    }
  } catch {
    /* NDJSON transcript: no provenance header. */
  }
  return meta
}

export function loadToolFile(path: string): ToolSet {
  const text = readFileSync(resolve(path), 'utf8')
  return { label: resolve(path), meta: parseProvenance(text), tools: parseToolDocument(text) }
}

// ---------------------------------------------------------------------------------------------
// Schema diff
// ---------------------------------------------------------------------------------------------

export type SchemaChangeKind =
  | 'property-added'
  | 'property-removed'
  | 'required-added'
  | 'required-removed'
  | 'type-changed'
  | 'enum-added'
  | 'enum-removed'
  | 'items-changed'
  | 'variant-count-changed'
  | 'additional-properties-changed'
  | 'value-changed'

export interface SchemaChange {
  /** JSON-Schema-ish path rooted at `$` (the tool's input schema). */
  path: string
  kind: SchemaChangeKind
  /** The side that is "ahead": official for additions/type changes, missing side otherwise. */
  official?: unknown
  ccb?: unknown
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}
const sameValue = (a: unknown, b: unknown): boolean => stableJson(a) === stableJson(b)
const scalarEntries = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => stableJson(entry)).sort() : []

function diffEnum(official: unknown, ccb: unknown, path: string, out: SchemaChange[]): void {
  if (!Array.isArray(official) && !Array.isArray(ccb)) {
    if (!sameValue(official, ccb)) out.push({ path, kind: 'value-changed', official, ccb })
    return
  }
  const left = new Set(scalarEntries(official))
  const right = new Set(scalarEntries(ccb))
  for (const entry of left) {
    if (!right.has(entry))
      out.push({ path, kind: 'enum-removed', official: JSON.parse(entry), ccb: undefined })
  }
  for (const entry of right) {
    if (!left.has(entry))
      out.push({ path, kind: 'enum-added', official: undefined, ccb: JSON.parse(entry) })
  }
}

function diffRequired(official: unknown, ccb: unknown, path: string, out: SchemaChange[]): void {
  const left = new Set(Array.isArray(official) ? official.filter((v) => typeof v === 'string') : [])
  const right = new Set(Array.isArray(ccb) ? ccb.filter((v) => typeof v === 'string') : [])
  for (const name of left) {
    if (!right.has(name)) {
      out.push({
        path: `${path}.required`,
        kind: 'required-removed',
        official: name,
        ccb: undefined,
      })
    }
  }
  for (const name of right) {
    if (!left.has(name)) {
      out.push({ path: `${path}.required`, kind: 'required-added', official: undefined, ccb: name })
    }
  }
}

/**
 * Recursive JSON Schema comparison. Reports property add/remove, required changes, type changes,
 * enum changes, item/variant shape changes, and any other value difference at a named path.
 * `$schema` is ignored (draft URL bookkeeping, not a parameter change).
 */
export function diffSchema(
  official: Record<string, unknown> | null,
  ccb: Record<string, unknown> | null,
  base = '$',
): SchemaChange[] {
  const out: SchemaChange[] = []
  if (!official || !ccb) return out
  walk(official, ccb, base, out)
  return out
}

function walk(a: unknown, b: unknown, path: string, out: SchemaChange[]): void {
  if (!isRecord(a) || !isRecord(b)) {
    if (!sameValue(a, b)) out.push({ path, kind: 'value-changed', official: a, ccb: b })
    return
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if (SCHEMA_IGNORED_KEYS.has(key)) continue
    const left = a[key]
    const right = b[key]
    const here = `${path}.${key}`
    if (key === 'properties' && isRecord(left) && isRecord(right)) {
      const names = new Set([...Object.keys(left), ...Object.keys(right)])
      for (const name of names) {
        const inOfficial = Object.hasOwn(left, name)
        const inCcb = Object.hasOwn(right, name)
        const childPath = `${here}.${name}`
        if (inOfficial && !inCcb)
          out.push({ path: childPath, kind: 'property-removed', official: left[name] })
        else if (!inOfficial && inCcb)
          out.push({ path: childPath, kind: 'property-added', ccb: right[name] })
        else walk(left[name], right[name], childPath, out)
      }
      continue
    }
    if (key === 'required') {
      diffRequired(left, right, path, out)
      continue
    }
    if (key === 'enum') {
      diffEnum(left, right, here, out)
      continue
    }
    if (key === 'items') {
      const leftList = Array.isArray(left) ? left : [left]
      const rightList = Array.isArray(right) ? right : [right]
      if (leftList.length !== rightList.length) {
        out.push({ path: here, kind: 'items-changed', official: left, ccb: right })
      } else {
        leftList.forEach((entry, index) => {
          walk(entry, rightList[index], Array.isArray(left) ? `${here}[${index}]` : here, out)
        })
      }
      continue
    }
    if (key === 'additionalProperties') {
      if (isRecord(left) && isRecord(right)) walk(left, right, here, out)
      else if (!sameValue(left, right))
        out.push({ path: here, kind: 'additional-properties-changed', official: left, ccb: right })
      continue
    }
    if (key === 'type') {
      if (!sameValue(left, right))
        out.push({ path: here, kind: 'type-changed', official: left, ccb: right })
      continue
    }
    if (key === 'anyOf' || key === 'oneOf' || key === 'allOf') {
      const leftList = Array.isArray(left) ? left : []
      const rightList = Array.isArray(right) ? right : []
      if (leftList.length !== rightList.length) {
        out.push({
          path: here,
          kind: 'variant-count-changed',
          official: leftList.length,
          ccb: rightList.length,
        })
      } else {
        leftList.forEach((entry, index) => walk(entry, rightList[index], `${here}[${index}]`, out))
      }
      continue
    }
    walk(left, right, here, out)
  }
}

// ---------------------------------------------------------------------------------------------
// Description diff
// ---------------------------------------------------------------------------------------------

export interface DescriptionDiff {
  officialSha: string
  ccbSha: string
  /** 1-based first differing line, or null when only trailing content differs. */
  line: number | null
  officialLine?: string
  ccbLine?: string
}

const sha = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
const clip = (text: string, max = 240): string =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length} chars]`

export function diffDescription(official: string, ccb: string): DescriptionDiff | null {
  if (official === ccb) return null
  const left = official.split('\n')
  const right = ccb.split('\n')
  const longest = Math.max(left.length, right.length)
  for (let index = 0; index < longest; index++) {
    if ((left[index] ?? '') !== (right[index] ?? '')) {
      return {
        officialSha: sha(official),
        ccbSha: sha(ccb),
        line: index + 1,
        officialLine: clip(left[index] ?? ''),
        ccbLine: clip(right[index] ?? ''),
      }
    }
  }
  return { officialSha: sha(official), ccbSha: sha(ccb), line: null }
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

export interface ToolComparison {
  name: string
  officialDeferred: boolean
  /** False when the official capture carried the name but no JSON Schema (deferred, unloaded). */
  officialSchemaKnown: boolean
  schemaChanges: SchemaChange[]
  description: DescriptionDiff | null
}

export interface DriftReport {
  official: { label: string; meta: Record<string, string>; toolCount: number }
  ccb: { label: string; meta: Record<string, string>; toolCount: number }
  both: ToolComparison[]
  /** Official-only names that are not policy-excluded: a remote chat silently loses them. */
  missing: string[]
  /** CCB-only names that are not platform/mechanism tools: extra surface for the remote chat. */
  extra: string[]
  expected: { platform: string[]; mechanism: string[]; excluded: string[]; allowed: string[] }
  /** Names with at least one schema change. */
  schemaDrift: string[]
  /** Names whose description differs. */
  descriptionDrift: string[]
  hasUnexpectedDrift: boolean
  counts: {
    officialOnly: number
    ccbOnly: number
    both: number
    missing: number
    extra: number
    schemaChanged: number
    schemaChanges: number
    descriptionChanged: number
  }
}

export interface DiffOptions {
  /** One-sided tool names the caller has decided are acceptable right now. */
  allow?: Iterable<string>
}

export function diffToolSets(
  official: ToolSet,
  ccb: ToolSet,
  options: DiffOptions = {},
): DriftReport {
  const allow = new Set(options.allow ?? [])
  const officialByName = new Map(official.tools.map((tool) => [tool.name, tool]))
  const ccbByName = new Map(ccb.tools.map((tool) => [tool.name, tool]))
  const both: ToolComparison[] = []
  const missing: string[] = []
  const extra: string[] = []
  const expected = {
    platform: [] as string[],
    mechanism: [] as string[],
    excluded: [] as string[],
    allowed: [] as string[],
  }

  for (const [name, tool] of officialByName) {
    const peer = ccbByName.get(name)
    if (peer) {
      both.push({
        name,
        officialDeferred: tool.deferred,
        officialSchemaKnown: tool.inputSchema !== null,
        schemaChanges: diffSchema(tool.inputSchema, peer.inputSchema),
        description: diffDescription(tool.description, peer.description),
      })
      continue
    }
    if (allow.has(name)) expected.allowed.push(name)
    else if (MECHANISMS.has(name)) expected.mechanism.push(name)
    else if (EXCLUDED.has(name)) expected.excluded.push(name)
    else missing.push(name)
  }
  for (const name of ccbByName.keys()) {
    if (officialByName.has(name)) continue
    if (allow.has(name)) {
      if (!expected.allowed.includes(name)) expected.allowed.push(name)
    } else if (PLATFORM.has(name) || MECHANISMS.has(name)) {
      const bucket = MECHANISMS.has(name) ? expected.mechanism : expected.platform
      if (!bucket.includes(name)) bucket.push(name)
    } else if (EXCLUDED.has(name)) {
      // Present in CCB although the official build dropped it: still the documented exclusion
      // (e.g. AskUserQuestion, which the gateway answers as a permission card).
      if (!expected.excluded.includes(name)) expected.excluded.push(name)
    } else extra.push(name)
  }

  const schemaDrift = both
    .filter((entry) => entry.schemaChanges.length > 0)
    .map((entry) => entry.name)
  const descriptionDrift = both.filter((entry) => entry.description).map((entry) => entry.name)
  const schemaChanges = both.reduce((total, entry) => total + entry.schemaChanges.length, 0)
  const order = (a: string, b: string) => a.localeCompare(b)
  both.sort((a, b) => order(a.name, b.name))
  missing.sort(order)
  extra.sort(order)
  for (const key of ['platform', 'mechanism', 'excluded', 'allowed'] as const)
    expected[key].sort(order)

  return {
    official: { label: official.label, meta: official.meta, toolCount: official.tools.length },
    ccb: { label: ccb.label, meta: ccb.meta, toolCount: ccb.tools.length },
    both,
    missing,
    extra,
    expected,
    schemaDrift,
    descriptionDrift,
    hasUnexpectedDrift:
      missing.length > 0 ||
      extra.length > 0 ||
      schemaDrift.length > 0 ||
      descriptionDrift.length > 0,
    counts: {
      officialOnly: official.tools.length - both.length,
      ccbOnly: ccb.tools.length - both.length,
      both: both.length,
      missing: missing.length,
      extra: extra.length,
      schemaChanged: schemaDrift.length,
      schemaChanges,
      descriptionChanged: descriptionDrift.length,
    },
  }
}

// ---------------------------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------------------------

const cell = (text: string): string => text.replaceAll('|', '\\|').replaceAll('\n', ' ')
const code = (text: string): string => `\`${text.replaceAll('`', "'")}\``

function renderChange(change: SchemaChange): string {
  const detail =
    change.kind === 'property-added'
      ? `added (CCB only): ${code(clip(stableJson(change.ccb), 180))}`
      : change.kind === 'property-removed'
        ? `missing in CCB: ${code(clip(stableJson(change.official), 180))}`
        : change.kind === 'required-added'
          ? `required only in CCB: ${code(String(change.ccb))}`
          : change.kind === 'required-removed'
            ? `required only in official: ${code(String(change.official))}`
            : change.kind === 'enum-added'
              ? `enum value only in CCB: ${code(stableJson(change.ccb))}`
              : change.kind === 'enum-removed'
                ? `enum value only in official: ${code(stableJson(change.official))}`
                : change.kind === 'type-changed'
                  ? `type ${code(stableJson(change.official))} (official) vs ${code(stableJson(change.ccb))} (CCB)`
                  : `${code(clip(stableJson(change.official), 120))} (official) vs ${code(clip(stableJson(change.ccb), 120))} (CCB)`
  return `- ${code(change.path)} — ${change.kind}: ${detail}`
}

export function renderMarkdown(
  report: DriftReport,
  generatedAt = new Date().toISOString(),
): string {
  const { counts } = report
  const verdict = report.hasUnexpectedDrift ? 'DRIFT' : 'NO UNEXPECTED DRIFT'
  const lines: string[] = []
  lines.push('# OCV5-746 tool drift: official Claude Code CLI vs CCB tool host', '')
  lines.push(`- **Official**: ${report.official.label} — ${report.official.toolCount} tools`)
  for (const [key, value] of Object.entries(report.official.meta))
    lines.push(`  - ${key}: ${value}`)
  lines.push(`- **CCB**: ${report.ccb.label} — ${report.ccb.toolCount} tools`)
  for (const [key, value] of Object.entries(report.ccb.meta)) lines.push(`  - ${key}: ${value}`)
  lines.push(`- **Generated**: ${generatedAt}`, '')
  lines.push(
    `**Result: ${verdict}** — ${counts.missing} missing in CCB, ${counts.extra} extra in CCB, ` +
      `${counts.schemaChanged} tools with ${counts.schemaChanges} schema changes, ` +
      `${counts.descriptionChanged} tools with changed descriptions.`,
    '',
  )
  lines.push('| | official only | both | CCB only |', '| --- | --- | --- | --- |')
  lines.push(`| tools | ${counts.officialOnly} | ${counts.both} | ${counts.ccbOnly} |`, '')

  lines.push('## 1. Unexpected drift', '')
  lines.push('### 1.1 Official tools missing from CCB', '')
  if (!report.missing.length) lines.push('_None._')
  else {
    lines.push(
      'A remote chat cannot use these: the official CLI sends them, the CCB host does not serve them.',
      '',
    )
    lines.push('| tool |', '| --- |')
    for (const name of report.missing) lines.push(`| ${code(name)} |`)
  }
  lines.push('')

  lines.push('### 1.2 CCB tools the official CLI would not send', '')
  if (!report.extra.length) lines.push('_None._')
  else {
    lines.push('| tool |', '| --- |')
    for (const name of report.extra) lines.push(`| ${code(name)} |`)
  }
  lines.push('')

  lines.push('### 1.3 Input schema differences', '')
  const schemaTools = report.both.filter((entry) => entry.schemaChanges.length > 0)
  if (!schemaTools.length) lines.push('_None._')
  else {
    for (const entry of schemaTools) {
      lines.push(`#### ${code(entry.name)}`, '')
      for (const change of entry.schemaChanges) lines.push(renderChange(change))
      lines.push('')
    }
  }

  lines.push('### 1.4 Description differences', '')
  const descriptionTools = report.both.filter((entry) => entry.description)
  if (!descriptionTools.length) lines.push('_None._')
  else {
    for (const entry of descriptionTools) {
      const diff = entry.description!
      lines.push(`#### ${code(entry.name)}`, '')
      lines.push(`- sha: official ${code(diff.officialSha)} / CCB ${code(diff.ccbSha)}`)
      if (diff.line === null) lines.push('- first difference: text length only')
      else {
        const quoted = (text?: string) => (text ? code(text) : '_(empty line)_')
        lines.push(`- first differing line ${diff.line}:`)
        lines.push(`  - official: ${quoted(diff.officialLine)}`)
        lines.push(`  - CCB: ${quoted(diff.ccbLine)}`)
      }
      lines.push('')
    }
  }

  lines.push('## 2. Expected differences', '')
  lines.push('### 2.1 Platform-only CCB tools (remote bridge mechanism)', '')
  lines.push(
    report.expected.platform.length ? report.expected.platform.map(code).join(', ') : '_None._',
    '',
  )
  lines.push('### 2.2 Deferred-tool mechanism', '')
  lines.push(
    report.expected.mechanism.length ? report.expected.mechanism.map(code).join(', ') : '_None._',
    '',
  )
  lines.push('### 2.3 Intentionally excluded official tools', '')
  lines.push(
    report.expected.excluded.length ? report.expected.excluded.map(code).join(', ') : '_None._',
    '',
  )
  if (report.expected.allowed.length) {
    lines.push('### 2.4 Accepted for now (--allow)', '')
    lines.push(report.expected.allowed.map(code).join(', '), '')
  }

  lines.push('## 3. Identical tools', '')
  const identical = report.both
    .filter((entry) => !entry.description && !entry.schemaChanges.length)
    .map((entry) => entry.name)
  lines.push(identical.length ? identical.map(code).join(', ') : '_None._', '')

  const deferred = report.both.filter(
    (entry) => entry.officialDeferred && entry.officialSchemaKnown,
  )
  const deferredUnschemad = report.both.filter(
    (entry) => entry.officialDeferred && !entry.officialSchemaKnown,
  )
  if (deferred.length || deferredUnschemad.length) {
    lines.push('## 4. Deferred on the official side', '')
    if (deferred.length) {
      lines.push(
        `The official CLI defers these by default; their schemas were recovered from the eager \
fallback request, so they were compared in full: ${deferred.map((entry) => code(entry.name)).join(', ')}`,
        '',
      )
    }
    if (deferredUnschemad.length) {
      lines.push(
        `The official CLI defers these and no schema was captured: only the name is known, so \
only their presence was compared: ${deferredUnschemad.map((entry) => code(entry.name)).join(', ')}`,
        '',
      )
    }
  }
  return `${lines.join('\n')}\n`
}

/** Compact summary for a terminal, not the report. */
export function summaryLine(report: DriftReport): string {
  const { counts } = report
  return (
    `${report.hasUnexpectedDrift ? 'DRIFT' : 'OK'}: missing=${counts.missing} extra=${counts.extra} ` +
    `schema_tools=${counts.schemaChanged} schema_changes=${counts.schemaChanges} descriptions=${counts.descriptionChanged}`
  )
}

// ---------------------------------------------------------------------------------------------
// Live CCB side
// ---------------------------------------------------------------------------------------------

/** Starts the real container tool host with no user config (builtin tools are the point). */
export async function loadLiveCcbTools(): Promise<ToolSet> {
  const root = mkdtempSync(join(tmpdir(), 'cc5-drift-'))
  const cwd = join(root, 'cwd')
  const home = join(root, 'home')
  mkdirSync(cwd, { mode: 0o700 })
  mkdirSync(home, { mode: 0o700 })
  const previousHome = process.env.HOME
  const previousConfig = process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = join(home, '.claude')
  const tools: ToolDefinition[] = []
  try {
    const host = new Cc5ToolHost(root, randomUUID(), {
      cwd,
      mcpConfigPath: null,
      settingsPath: null,
      disallowedTools: [],
    })
    try {
      for (const tool of await host.tools()) {
        tools.push({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          deferred: false,
        })
      }
    } finally {
      await host.close().catch(() => {})
    }
  } finally {
    // Assigning undefined would leave the literal string "undefined"; the child would then look
    // for a directory named that. Deletion is the only faithful restore.
    // biome-ignore lint/performance/noDelete: process.env needs deletion, not assignment.
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    // biome-ignore lint/performance/noDelete: process.env needs deletion, not assignment.
    if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfig
    rmSync(root, { recursive: true, force: true })
  }
  let version = 'unknown'
  try {
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../claude-code-best/package.json', import.meta.url)),
        'utf8',
      ),
    ) as { version?: unknown }
    if (typeof manifest.version === 'string') version = manifest.version
  } catch {
    /* the report still names the entry point; a missing manifest is not a check failure. */
  }
  return {
    label: 'live CCB tool host (mcp serve --tool-profile full, no user config)',
    meta: { ccb_version: version, entry: 'claude-code-best/dist/cli-node.js' },
    tools,
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

interface Args {
  official?: string
  ccb?: string
  ccbLive: boolean
  out?: string
  allow: string[]
}

function parseArgs(argv: string[]): Args {
  const args: Args = { ccbLive: false, allow: [] }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (value === undefined) throw new Error(`missing value for ${arg}`)
      return value
    }
    if (arg === '--official') args.official = next()
    else if (arg === '--ccb') args.ccb = next()
    else if (arg === '--ccb-live') args.ccbLive = true
    else if (arg === '--out') args.out = next()
    else if (arg === '--allow')
      args.allow.push(
        ...next()
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean),
      )
    else throw new Error(`unknown argument: ${arg}`)
  }
  return args
}

const USAGE = `usage: npx tsx scripts/agent-remote/cc5-tool-drift.mts --official <tools.json> \\
         (--ccb <tools.json> | --ccb-live) [--out <report.md>] [--allow name,name]
See the file header for accepted input shapes.`

/** Used by the CLI entry point and by the unit test (so exit codes are covered without spawning). */
export async function runCli(argv: string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const args = parseArgs(argv)
  if (!args.official) {
    process.stderr.write(`${USAGE}\n`)
    return 2
  }
  if (Boolean(args.ccb) === args.ccbLive) {
    process.stderr.write(`exactly one of --ccb <file> or --ccb-live is required\n${USAGE}\n`)
    return 2
  }
  const official = loadToolFile(args.official)
  const ccb = args.ccb ? loadToolFile(args.ccb) : await loadLiveCcbTools()
  const report = diffToolSets(official, ccb, { allow: args.allow })
  const markdown = renderMarkdown(report)
  if (args.out) writeFileSync(resolve(args.out), markdown)
  else process.stdout.write(markdown)
  process.stderr.write(`${summaryLine(report)}\n`)
  return report.hasUnexpectedDrift ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(
        `cc5-tool-drift: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 2
    },
  )
}
