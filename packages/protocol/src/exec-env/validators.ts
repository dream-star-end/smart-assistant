/**
 * OCV5-890 Layer 3 — Execution Environment pure validators, OCV5-800 schema-filtered
 * argument hashing, monotonic policy tightening, and cross-pool read-only tool checks.
 *
 * L0 Contract Invariant (R2-contract-node): ZERO `node:*` imports allowed.
 * All canonical hashing delegates to `../remotePool/canonical.js`.
 */
import { isAdvisorReadOnlyMcpTool } from '../advisorReadOnly.js'
import {
  assertWellFormedJsonValue,
  remoteCanonicalJson,
  remoteCanonicalSha256,
} from '../remotePool/canonical.js'
import {
  EXECUTION_POLICY_MODES,
  TOOL_CALL_ATTESTATION_KINDS,
  type ExecutionPolicyEnvelope,
  type ExecutionPolicyMode,
  type ToolCallAttestation,
  type ToolCallAttestationKind,
  type ToolCallEnvelope,
} from './contracts.js'

const SHA256_RE = /^[a-f0-9]{64}$/
const IDENT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

const ATTESTATION_KIND_SET: ReadonlySet<string> = new Set<string>(TOOL_CALL_ATTESTATION_KINDS)
const POLICY_MODE_SET: ReadonlySet<string> = new Set<string>(EXECUTION_POLICY_MODES)

const POLICY_MODE_STRICTNESS: Readonly<Record<ExecutionPolicyMode, number>> = Object.freeze({
  normal: 0,
  read_only: 1,
  hermetic_no_tools: 2,
})

const TOOL_CALL_ENVELOPE_KEYS: ReadonlySet<string> = new Set<string>([
  'schemaVersion',
  'leaseId',
  'turnId',
  'callId',
  'idempotencyKey',
  'canonicalName',
  'arguments',
  'argsSha256',
  'attestation',
  'timeoutMs',
])

const TOOL_CALL_ATTESTATION_KEYS: ReadonlySet<string> = new Set<string>([
  'kind',
  'argsSha256',
  'observedAt',
  'grantId',
  'rawFrameSha256',
  'filteredKeys',
])

const EXECUTION_POLICY_KEYS: ReadonlySet<string> = new Set<string>([
  'schemaVersion',
  'mode',
  'allowedTools',
  'deniedTools',
  'allowNetworkEgress',
  'allowWorkspaceWrite',
  'allowSubprocessSpawn',
  'maxToolCallsPerTurn',
  'policyDigest',
])

/**
 * Cross-pool canonical read-only inspection tools (in addition to ADVISOR_READ_ONLY_MCP_TOOLS).
 * Unknown tools fail closed (return false).
 */
export const CANONICAL_READ_ONLY_TOOLS: ReadonlySet<string> = new Set<string>([
  'read_file',
  'read',
  'view_file',
  'view_file_outline',
  'view_code_item',
  'list_dir',
  'ls',
  'glob',
  'find_by_name',
  'grep',
  'grep_search',
  'ripgrep',
  'search_files',
  'stat',
  'get_file_info',
  'web_search',
  'search_web',
  'web_fetch',
  'read_url_content',
  'list_resources',
  'read_resource',
  'search_extra_tools',
  'searchextratools',
  'askuserquestion',
  'ask_user_question',
  'ask_question',
  'exit_plan_mode',
  'exitplanmode',
  'oc_read',
  'oc_find',
  'oc_tree',
])

const EXTRA_READ_ONLY_MEMORY_MCP_TOOLS: ReadonlySet<string> = new Set<string>([
  'oc_read',
  'oc_find',
  'oc_tree',
])

const READ_ONLY_MEMORY_MCP_PREFIXES = [
  'mcp_openclaude-memory_',
  'mcp__openclaude-memory__',
] as const

const MUTATING_ARG_BOOLEAN_FLAGS = [
  'write',
  'overwrite',
  'append',
  'inPlace',
  'in_place',
  'delete',
  'remove',
  'mutate',
  'fix',
] as const

const SAFE_READ_ONLY_HTTP_METHODS: ReadonlySet<string> = new Set<string>([
  'GET',
  'HEAD',
  'OPTIONS',
])

function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function asPlainObject(raw: unknown, code: string): Record<string, unknown> {
  need(isPlainRecord(raw), code)
  assertWellFormedJsonValue(raw, true)
  return raw
}

function assertAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  code: string,
): void {
  for (const key of Object.keys(obj)) {
    need(allowed.has(key), code)
  }
}

function isValidIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 10 || value.length > 64) return false
  return Number.isFinite(Date.parse(value))
}

/**
 * OCV5-800 protocol-level schema projection:
 * When `inputSchema.properties` is a non-empty plain object, projects only keys declared in
 * `inputSchema.properties`, naturally stripping CLI-private UI fields such as `toolSummary`.
 * When `inputSchema` is absent or lacks non-empty `properties`, falls back to the full `args` map.
 *
 * Byte-for-byte compatible with Python `filter_args_by_schema` in
 * `scripts/agent-remote/core/canonical.py`.
 */
export function filterArgsByInputSchema(
  args: Readonly<Record<string, unknown>>,
  inputSchema?: Readonly<Record<string, unknown>> | null,
): Record<string, unknown> {
  need(isPlainRecord(args), 'EXEC_TOOL_ARGS_INVALID')
  assertWellFormedJsonValue(args, false)

  const props =
    inputSchema !== undefined &&
    inputSchema !== null &&
    isPlainRecord(inputSchema) &&
    isPlainRecord(inputSchema.properties)
      ? inputSchema.properties
      : null

  const propKeys = props ? Object.keys(props) : []
  const filtered: Record<string, unknown> = {}

  if (propKeys.length > 0 && props !== null) {
    for (const key of Object.keys(args)) {
      if (Object.prototype.hasOwnProperty.call(props, key) && args[key] !== undefined) {
        filtered[key] = args[key]
      }
    }
    return filtered
  }

  for (const key of Object.keys(args)) {
    if (args[key] !== undefined) {
      filtered[key] = args[key]
    }
  }
  return filtered
}

/**
 * Computes canonical SHA-256 over schema-filtered tool arguments (OCV5-800).
 * Falls back to full canonical SHA-256 when `inputSchema.properties` is absent or empty.
 */
export function computeSchemaFilteredArgsSha256(
  args: Readonly<Record<string, unknown>>,
  inputSchema?: Readonly<Record<string, unknown>> | null,
): string {
  return remoteCanonicalSha256(filterArgsByInputSchema(args, inputSchema))
}

export interface SchemaFilteredHashGoldenVector {
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly inputSchema: Readonly<Record<string, unknown>> | null
  readonly filteredCanonical: string
  readonly sha256: string
}

const RAW_SCHEMA_FILTERED_VECTORS: ReadonlyArray<{
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
  readonly inputSchema: Readonly<Record<string, unknown>> | null
  readonly filteredCanonical: string
}> = [
  {
    name: 'strip_cli_tool_summary_and_ui_fields',
    args: {
      CommandLine: 'git status --short',
      WaitMsBeforeAsync: 5000,
      toolSummary: 'Check git status',
      _cliUiBadge: 'shell',
    },
    inputSchema: {
      type: 'object',
      properties: {
        CommandLine: { type: 'string' },
        WaitMsBeforeAsync: { type: 'integer' },
      },
      required: ['CommandLine'],
    },
    filteredCanonical: '{"CommandLine":"git status --short","WaitMsBeforeAsync":5000}',
  },
  {
    name: 'fallback_full_args_when_schema_missing_properties',
    args: {
      path: 'src/index.ts',
      line: 42,
      toolSummary: 'Inspect entrypoint',
    },
    inputSchema: { type: 'object' },
    filteredCanonical: '{"line":42,"path":"src/index.ts","toolSummary":"Inspect entrypoint"}',
  },
  {
    name: 'utf8_byte_order_unicode_with_schema_projection',
    args: {
      '😀': 'smile',
      '\uFFFD': 'replacement',
      '中文': 'ok',
      toolSummary: 'Ignored CLI summary',
    },
    inputSchema: {
      type: 'object',
      properties: {
        '😀': { type: 'string' },
        '\uFFFD': { type: 'string' },
        '中文': { type: 'string' },
      },
    },
    filteredCanonical: `{"中文":"ok","${'\uFFFD'}":"replacement","😀":"smile"}`,
  },
]

export const SCHEMA_FILTERED_HASH_GOLDEN_VECTORS: readonly SchemaFilteredHashGoldenVector[] =
  Object.freeze(
    RAW_SCHEMA_FILTERED_VECTORS.map((entry) => {
      const filtered = filterArgsByInputSchema(entry.args, entry.inputSchema)
      const canonical = remoteCanonicalJson(filtered)
      need(canonical === entry.filteredCanonical, 'EXEC_GOLDEN_VECTOR_CANONICAL_MISMATCH')
      return Object.freeze({
        ...entry,
        sha256: remoteCanonicalSha256(filtered),
      })
    }),
  )

export function computeToolIdempotencyKey(
  leaseId: string,
  turnId: string,
  callId: string,
): string {
  need(
    typeof leaseId === 'string' &&
      IDENT_RE.test(leaseId) &&
      typeof turnId === 'string' &&
      IDENT_RE.test(turnId) &&
      typeof callId === 'string' &&
      IDENT_RE.test(callId),
    'EXEC_TOOL_IDEMPOTENCY_INPUT_INVALID',
  )
  const hash = remoteCanonicalSha256({
    domain: 'oc-tool-idempotency-v1',
    leaseId,
    turnId,
    callId,
  })
  return `idem-${hash.slice(0, 32)}`
}

function validateToolCallAttestation(raw: unknown): ToolCallAttestation {
  const a = asPlainObject(raw, 'EXEC_TOOL_ATTESTATION_INVALID')
  assertAllowedKeys(a, TOOL_CALL_ATTESTATION_KEYS, 'EXEC_TOOL_ATTESTATION_INVALID')

  need(
    typeof a.kind === 'string' &&
      ATTESTATION_KIND_SET.has(a.kind) &&
      typeof a.argsSha256 === 'string' &&
      SHA256_RE.test(a.argsSha256) &&
      isValidIsoTimestamp(a.observedAt),
    'EXEC_TOOL_ATTESTATION_INVALID',
  )
  if (a.grantId !== undefined) {
    need(typeof a.grantId === 'string' && IDENT_RE.test(a.grantId), 'EXEC_TOOL_ATTESTATION_INVALID')
  }
  if (a.rawFrameSha256 !== undefined) {
    need(
      typeof a.rawFrameSha256 === 'string' && SHA256_RE.test(a.rawFrameSha256),
      'EXEC_TOOL_ATTESTATION_INVALID',
    )
  }
  let filteredKeys: readonly string[] | undefined
  if (a.filteredKeys !== undefined) {
    need(
      Array.isArray(a.filteredKeys) && a.filteredKeys.length > 0 && a.filteredKeys.length <= 256,
      'EXEC_TOOL_ATTESTATION_INVALID',
    )
    const seen = new Set<string>()
    for (const k of a.filteredKeys) {
      need(typeof k === 'string' && k.length > 0 && k.length <= 128 && !seen.has(k), 'EXEC_TOOL_ATTESTATION_INVALID')
      seen.add(k)
    }
    filteredKeys = Object.freeze([...(a.filteredKeys as string[])])
  }

  return Object.freeze({
    kind: a.kind as ToolCallAttestationKind,
    argsSha256: a.argsSha256,
    observedAt: a.observedAt,
    ...(a.grantId === undefined ? {} : { grantId: a.grantId as string }),
    ...(a.rawFrameSha256 === undefined ? {} : { rawFrameSha256: a.rawFrameSha256 as string }),
    ...(filteredKeys === undefined ? {} : { filteredKeys }),
  })
}

export function validateToolCallEnvelope(
  raw: unknown,
  opts?: { readonly inputSchema?: Readonly<Record<string, unknown>> | null },
): ToolCallEnvelope {
  const e = asPlainObject(raw, 'EXEC_TOOL_CALL_ENVELOPE_INVALID')
  assertAllowedKeys(e, TOOL_CALL_ENVELOPE_KEYS, 'EXEC_TOOL_CALL_ENVELOPE_INVALID')

  need(
    e.schemaVersion === 1 &&
      typeof e.leaseId === 'string' &&
      IDENT_RE.test(e.leaseId) &&
      typeof e.turnId === 'string' &&
      IDENT_RE.test(e.turnId) &&
      typeof e.callId === 'string' &&
      IDENT_RE.test(e.callId) &&
      typeof e.idempotencyKey === 'string' &&
      typeof e.canonicalName === 'string' &&
      TOOL_NAME_RE.test(e.canonicalName) &&
      isPlainRecord(e.arguments) &&
      typeof e.argsSha256 === 'string' &&
      SHA256_RE.test(e.argsSha256),
    'EXEC_TOOL_CALL_ENVELOPE_INVALID',
  )

  if (e.timeoutMs !== undefined) {
    need(
      typeof e.timeoutMs === 'number' &&
        Number.isSafeInteger(e.timeoutMs) &&
        e.timeoutMs >= 1 &&
        e.timeoutMs <= 3_600_000,
      'EXEC_TOOL_CALL_ENVELOPE_INVALID',
    )
  }

  const expectedIdempotencyKey = computeToolIdempotencyKey(e.leaseId, e.turnId, e.callId)
  need(e.idempotencyKey === expectedIdempotencyKey, 'EXEC_TOOL_CALL_IDEMPOTENCY_MISMATCH')

  const attestation = validateToolCallAttestation(e.attestation)
  need(attestation.argsSha256 === e.argsSha256, 'EXEC_TOOL_CALL_ATTESTATION_HASH_MISMATCH')

  let expectedArgsHash: string
  if (opts?.inputSchema !== undefined) {
    expectedArgsHash = computeSchemaFilteredArgsSha256(e.arguments, opts.inputSchema)
  } else if (attestation.kind === 'schema_filtered_hook' && attestation.filteredKeys !== undefined) {
    const syntheticProps: Record<string, unknown> = {}
    for (const key of attestation.filteredKeys) {
      syntheticProps[key] = {}
    }
    expectedArgsHash = computeSchemaFilteredArgsSha256(e.arguments, {
      properties: syntheticProps,
    })
  } else {
    expectedArgsHash = remoteCanonicalSha256(e.arguments)
  }
  need(expectedArgsHash === e.argsSha256, 'EXEC_TOOL_CALL_ARGS_HASH_MISMATCH')

  return Object.freeze({
    schemaVersion: 1,
    leaseId: e.leaseId,
    turnId: e.turnId,
    callId: e.callId,
    idempotencyKey: expectedIdempotencyKey,
    canonicalName: e.canonicalName,
    arguments: structuredClone(e.arguments) as Readonly<Record<string, unknown>>,
    argsSha256: expectedArgsHash,
    attestation,
    ...(e.timeoutMs === undefined ? {} : { timeoutMs: e.timeoutMs as number }),
  })
}

function hasMutatingReadOnlyArgs(args: Readonly<Record<string, unknown>>): boolean {
  if (!isPlainRecord(args)) return true
  for (const flag of MUTATING_ARG_BOOLEAN_FLAGS) {
    if (args[flag] === true) return true
  }
  if (typeof args.method === 'string') {
    if (!SAFE_READ_ONLY_HTTP_METHODS.has(args.method.toUpperCase())) return true
  }
  return false
}

function isAllowedReadOnlyMemoryMcpTool(bareTool: string): boolean {
  return isAdvisorReadOnlyMcpTool(bareTool) || EXTRA_READ_ONLY_MEMORY_MCP_TOOLS.has(bareTool)
}

function isNonEmptyUntrimmedFreeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
}

function extractSingleKeyValue(
  args: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const present = keys.filter((k) => k in args)
  if (present.length !== 1) return { ok: false }
  return { ok: true, value: args[present[0]!] }
}

function extractExclusiveRecordField(
  args: Readonly<Record<string, unknown>>,
  keyA: string,
  keyB: string,
): { readonly ok: true; readonly value: Readonly<Record<string, unknown>> | undefined } | { readonly ok: false } {
  const valA = args[keyA]
  const valB = args[keyB]
  if (valA !== undefined && !isPlainRecord(valA)) return { ok: false }
  if (valB !== undefined && !isPlainRecord(valB)) return { ok: false }
  if (valA !== undefined && valB !== undefined) return { ok: false }
  return { ok: true, value: (valA ?? valB) as Readonly<Record<string, unknown>> | undefined }
}

function isReadOnlyExecuteExtraTool(
  args: Readonly<Record<string, unknown>> | undefined,
  depth: number,
): boolean {
  if (!args || !isPlainRecord(args)) return false
  const toolKey = extractSingleKeyValue(args, ['tool_name', 'toolName'])
  if (!toolKey.ok || !isNonEmptyUntrimmedFreeString(toolKey.value)) return false
  const inner = extractExclusiveRecordField(args, 'arguments', 'input')
  if (!inner.ok) return false
  return isReadOnlyAllowedCanonicalTool(toolKey.value, inner.value, depth + 1)
}

function isReadOnlyCallMcpTool(args: Readonly<Record<string, unknown>> | undefined): boolean {
  if (!args || !isPlainRecord(args)) return false
  const serverKey = extractSingleKeyValue(args, ['ServerName', 'server_name', 'serverName'])
  const toolKey = extractSingleKeyValue(args, ['ToolName', 'tool_name', 'toolName'])
  if (!serverKey.ok || !toolKey.ok || serverKey.value !== 'openclaude-memory') return false
  if (!isNonEmptyUntrimmedFreeString(toolKey.value) || !isAllowedReadOnlyMemoryMcpTool(toolKey.value)) {
    return false
  }
  const inner = extractExclusiveRecordField(args, 'Arguments', 'arguments')
  if (!inner.ok) return false
  return inner.value === undefined || !hasMutatingReadOnlyArgs(inner.value)
}

function isPrefixedReadOnlyMemoryTool(canonicalName: string): boolean {
  for (const prefix of READ_ONLY_MEMORY_MCP_PREFIXES) {
    if (canonicalName.startsWith(prefix)) {
      if (isAllowedReadOnlyMemoryMcpTool(canonicalName.slice(prefix.length))) return true
    }
  }
  return false
}

/**
 * Unified cross-pool read-only canonical tool predicate.
 * Fails closed for any unknown tool or mutating argument flag.
 */
export function isReadOnlyAllowedCanonicalTool(
  canonicalName: string,
  args?: Readonly<Record<string, unknown>>,
  depth = 0,
): boolean {
  if (depth > 2 || !isNonEmptyUntrimmedFreeString(canonicalName) || canonicalName.length > 128) {
    return false
  }
  if (args !== undefined && hasMutatingReadOnlyArgs(args)) return false

  const normalized = canonicalName.toLowerCase()
  if (normalized === 'executeextratool' || normalized === 'execute_extra_tool') {
    return isReadOnlyExecuteExtraTool(args, depth)
  }
  if (normalized === 'call_mcp_tool') {
    return isReadOnlyCallMcpTool(args)
  }
  return (
    CANONICAL_READ_ONLY_TOOLS.has(normalized) ||
    isAdvisorReadOnlyMcpTool(canonicalName) ||
    isPrefixedReadOnlyMemoryTool(canonicalName)
  )
}

export function validateExecutionPolicyEnvelope(raw: unknown): ExecutionPolicyEnvelope {
  const p = asPlainObject(raw, 'EXEC_POLICY_ENVELOPE_INVALID')
  assertAllowedKeys(p, EXECUTION_POLICY_KEYS, 'EXEC_POLICY_ENVELOPE_INVALID')

  need(
    p.schemaVersion === 1 &&
      typeof p.mode === 'string' &&
      POLICY_MODE_SET.has(p.mode) &&
      Array.isArray(p.allowedTools) &&
      typeof p.allowNetworkEgress === 'boolean' &&
      typeof p.allowWorkspaceWrite === 'boolean' &&
      typeof p.allowSubprocessSpawn === 'boolean',
    'EXEC_POLICY_ENVELOPE_INVALID',
  )

  const allowedTools: string[] = []
  const seenAllowed = new Set<string>()
  for (const tool of p.allowedTools) {
    need(
      typeof tool === 'string' && TOOL_NAME_RE.test(tool) && !seenAllowed.has(tool),
      'EXEC_POLICY_ENVELOPE_INVALID',
    )
    seenAllowed.add(tool)
    allowedTools.push(tool)
  }

  let deniedTools: readonly string[] | undefined
  if (p.deniedTools !== undefined) {
    need(Array.isArray(p.deniedTools), 'EXEC_POLICY_ENVELOPE_INVALID')
    const deniedList: string[] = []
    const seenDenied = new Set<string>()
    for (const tool of p.deniedTools) {
      need(
        typeof tool === 'string' && TOOL_NAME_RE.test(tool) && !seenDenied.has(tool),
        'EXEC_POLICY_ENVELOPE_INVALID',
      )
      seenDenied.add(tool)
      deniedList.push(tool)
    }
    deniedTools = Object.freeze(deniedList)
  }

  if (p.maxToolCallsPerTurn !== undefined) {
    need(
      typeof p.maxToolCallsPerTurn === 'number' &&
        Number.isSafeInteger(p.maxToolCallsPerTurn) &&
        p.maxToolCallsPerTurn >= 0,
      'EXEC_POLICY_ENVELOPE_INVALID',
    )
  }
  if (p.policyDigest !== undefined) {
    need(typeof p.policyDigest === 'string' && SHA256_RE.test(p.policyDigest), 'EXEC_POLICY_ENVELOPE_INVALID')
  }

  const mode = p.mode as ExecutionPolicyMode
  if (mode === 'hermetic_no_tools') {
    need(
      allowedTools.length === 0 &&
        p.allowWorkspaceWrite === false &&
        p.allowSubprocessSpawn === false &&
        p.allowNetworkEgress === false,
      'EXEC_POLICY_HERMETIC_VIOLATION',
    )
  } else if (mode === 'read_only') {
    need(p.allowWorkspaceWrite === false, 'EXEC_POLICY_READ_ONLY_WRITE_FORBIDDEN')
    for (const tool of allowedTools) {
      need(isReadOnlyAllowedCanonicalTool(tool), 'EXEC_POLICY_READ_ONLY_TOOL_FORBIDDEN')
    }
  }

  return Object.freeze({
    schemaVersion: 1,
    mode,
    allowedTools: Object.freeze(allowedTools),
    ...(deniedTools === undefined ? {} : { deniedTools }),
    allowNetworkEgress: p.allowNetworkEgress,
    allowWorkspaceWrite: p.allowWorkspaceWrite,
    allowSubprocessSpawn: p.allowSubprocessSpawn,
    ...(p.maxToolCallsPerTurn === undefined
      ? {}
      : { maxToolCallsPerTurn: p.maxToolCallsPerTurn as number }),
    ...(p.policyDigest === undefined ? {} : { policyDigest: p.policyDigest as string }),
  })
}

/**
 * Verifies that `child` is a strict monotonic tightening of `parent`:
 * - Mode may only move `normal -> read_only -> hermetic_no_tools` (never relax).
 * - Child `allowedTools` may never add any tool absent from parent's effective allowed set.
 * - Boolean privileges (`allowWorkspaceWrite`, `allowNetworkEgress`, `allowSubprocessSpawn`)
 *   may only move `true -> false`.
 * - `maxToolCallsPerTurn` may only stay equal or decrease.
 */
export function isExecutionPolicyMonotonicTightening(
  parent: ExecutionPolicyEnvelope,
  child: ExecutionPolicyEnvelope,
): boolean {
  let validParent: ExecutionPolicyEnvelope
  let validChild: ExecutionPolicyEnvelope
  try {
    validParent = validateExecutionPolicyEnvelope(parent)
    validChild = validateExecutionPolicyEnvelope(child)
  } catch {
    return false
  }

  if (POLICY_MODE_STRICTNESS[validChild.mode] < POLICY_MODE_STRICTNESS[validParent.mode]) {
    return false
  }

  if (!validParent.allowWorkspaceWrite && validChild.allowWorkspaceWrite) return false
  if (!validParent.allowNetworkEgress && validChild.allowNetworkEgress) return false
  if (!validParent.allowSubprocessSpawn && validChild.allowSubprocessSpawn) return false

  if (validParent.maxToolCallsPerTurn !== undefined) {
    if (
      validChild.maxToolCallsPerTurn === undefined ||
      validChild.maxToolCallsPerTurn > validParent.maxToolCallsPerTurn
    ) {
      return false
    }
  }

  const parentAllowed = new Set<string>(validParent.allowedTools)
  const parentDenied = new Set<string>(validParent.deniedTools ?? [])
  const childDenied = new Set<string>(validChild.deniedTools ?? [])

  for (const tool of validChild.allowedTools) {
    if (!parentAllowed.has(tool)) return false
    if (parentDenied.has(tool) && !childDenied.has(tool)) return false
  }

  return true
}
