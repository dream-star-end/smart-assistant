/**
 * Strict allowlist schema + validator for marketplace AGENT manifests (RFC M3 / D2).
 *
 * An agent carries a capability surface (model + toolsets + persona + skill deps),
 * so unlike an inert skill it must be locked down hard. The validator:
 *   - accepts ONLY the allowlisted fields (unknown/forbidden fields are rejected),
 *   - forbids the privilege-bearing AgentDef fields outright (mcpServers / cwd /
 *     provider / runnerKind / routes / teams / permissionMode / persona-as-path),
 *   - requires a non-empty toolsets list drawn ONLY from the vetted set
 *     (never "default = all"),
 *   - requires model ∈ the v5 public model set,
 *   - takes persona as INLINE text (scanned by the caller via the skill scanner),
 *   - takes Skills + Plugins as typed capability references. Legacy skillDeps is
 *     still accepted and emitted so an older runtime can read a new manifest.
 *
 * permissionMode is intentionally absent: the platform fixes it at runtime; a
 * marketplace agent can never request bypassPermissions.
 */

import type { MarketplaceCapabilityRef } from '@openclaude/protocol'

export type { MarketplaceCapabilityKind, MarketplaceCapabilityRef } from '@openclaude/protocol'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,63}$/

/** Vetted public toolsets a marketplace agent may declare. MUST stay in sync with
 *  the in-container config.toolsets the entrypoint seeds. A toolset not mapped to
 *  any MCP in-container is harmless (mounts nothing), but we still gate to the
 *  known-safe set so the manifest is auditable. */
export const VETTED_AGENT_TOOLSETS = ['core', 'browser', 'research', 'web_context'] as const

/** The exhaustive set of fields a manifest may contain. Anything else is rejected. */
const ALLOWED_FIELDS = new Set([
  'name',
  'description',
  'tags',
  'version',
  'model',
  'toolsets',
  'capabilities',
  'skillDeps',
  'persona',
  'displayName',
  'avatarEmoji',
  'greeting',
])

/** Explicitly-forbidden privilege-bearing fields (clear error if present). */
const FORBIDDEN_FIELDS = [
  'mcpServers',
  'cwd',
  'provider',
  'runnerKind',
  'runner',
  'routes',
  'teams',
  'permissionMode',
  'personaPath',
  'persona_file',
]

export interface AgentManifest {
  name: string
  description: string
  tags: string[]
  version: string
  model: string
  toolsets: string[]
  capabilities: MarketplaceCapabilityRef[]
  /** Legacy compatibility projection of all skill capabilities. */
  skillDeps: string[]
  persona: string
  displayName?: string
  avatarEmoji?: string
  greeting?: string
}

export type ValidateResult = { ok: true; manifest: AgentManifest } | { ok: false; errors: string[] }

export interface ValidateOpts {
  /** Allowed toolset names (defaults to VETTED_AGENT_TOOLSETS). */
  vettedToolsets?: ReadonlySet<string> | readonly string[]
  /** v5 public model ids the manifest.model must belong to. */
  allowedModels: ReadonlySet<string>
  /** Marketplace listing slug, used to reject a direct self-dependency. */
  artifactSlug?: string
}

const MAX_CAPABILITIES = 32

function parseLegacySkillDeps(value: unknown, errors: string[]): string[] {
  const skillDeps: string[] = []
  if (value === undefined) return skillDeps
  if (!Array.isArray(value)) {
    errors.push('skillDeps 须为数组')
    return skillDeps
  }
  for (const s of value) {
    if (typeof s !== 'string' || !SLUG_RE.test(s)) errors.push(`skillDep "${String(s)}" 非法 slug`)
    else if (!skillDeps.includes(s)) skillDeps.push(s)
  }
  return skillDeps
}

function parseCapabilities(value: unknown, artifactSlug: string | undefined, errors: string[]) {
  const capabilities: MarketplaceCapabilityRef[] = []
  if (value === undefined) return capabilities
  if (!Array.isArray(value)) {
    errors.push('capabilities 须为数组')
    return capabilities
  }
  if (value.length > MAX_CAPABILITIES) errors.push(`capabilities 最多 ${MAX_CAPABILITIES} 项`)
  const seen = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`capabilities[${index}] 须为对象`)
      continue
    }
    const item = raw as Record<string, unknown>
    const unknown = Object.keys(item).find((key) => !['kind', 'slug', 'optional'].includes(key))
    if (unknown) errors.push(`capabilities[${index}] 未知字段：${unknown}`)
    const kind = item.kind
    const slug = item.slug
    const optional = item.optional ?? false
    if (kind !== 'skill' && kind !== 'plugin') {
      errors.push(`capabilities[${index}].kind 须为 skill 或 plugin`)
      continue
    }
    if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
      errors.push(`capabilities[${index}].slug 非法`)
      continue
    }
    if (typeof optional !== 'boolean') {
      errors.push(`capabilities[${index}].optional 须为布尔值`)
      continue
    }
    if (artifactSlug && slug === artifactSlug) {
      errors.push(`capability "${slug}" 不得依赖自身`)
      continue
    }
    const key = `${kind}:${slug}`
    if (seen.has(key)) {
      errors.push(`capability 重复：${key}`)
      continue
    }
    seen.add(key)
    capabilities.push({ kind, slug, optional })
  }
  return capabilities
}

const MAX = {
  name: 64,
  description: 1024,
  version: 16,
  model: 128,
  persona: 64 * 1024,
  displayName: 64,
  avatarEmoji: 16,
  greeting: 512,
  tag: 64,
  slug: 64,
}

function asString(v: unknown, field: string, max: number, errors: string[]): string | null {
  if (typeof v !== 'string' || v.trim().length === 0) {
    errors.push(`${field} 必填且须为非空文本`)
    return null
  }
  if (v.length > max) {
    errors.push(`${field} 过长（上限 ${max}）`)
    return null
  }
  return v
}

/** Validate a raw agent manifest body into a normalized AgentManifest (or errors). */
export function validateAgentManifest(raw: unknown, opts: ValidateOpts): ValidateResult {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['manifest 须为对象'] }
  }
  const o = raw as Record<string, unknown>

  // reject forbidden + unknown fields outright
  for (const f of FORBIDDEN_FIELDS) {
    if (f in o) errors.push(`不允许的字段：${f}（市场智能体不得自带该能力面）`)
  }
  for (const k of Object.keys(o)) {
    if (!ALLOWED_FIELDS.has(k)) errors.push(`未知字段：${k}`)
  }

  const name = asString(o.name, 'name', MAX.name, errors)
  const description = asString(o.description, 'description', MAX.description, errors)
  const version = asString(o.version, 'version', MAX.version, errors)
  if (version && !/^\d+\.\d+\.\d+$/.test(version)) errors.push('version 须为 N.N.N')
  const persona = asString(o.persona, 'persona', MAX.persona, errors)
  const model = asString(o.model, 'model', MAX.model, errors)
  if (model && !opts.allowedModels.has(model)) errors.push(`model "${model}" 不在可用模型列表中`)

  // toolsets: required, non-empty, all vetted; NEVER default-to-all
  const vetted = new Set(opts.vettedToolsets ?? VETTED_AGENT_TOOLSETS)
  const toolsets: string[] = []
  if (!Array.isArray(o.toolsets) || o.toolsets.length === 0) {
    errors.push('toolsets 必填且非空（不可省略 = 不可默认全开）')
  } else {
    for (const t of o.toolsets) {
      if (typeof t !== 'string' || !vetted.has(t)) {
        errors.push(`toolset "${String(t)}" 不在白名单（${[...vetted].join(', ')}）`)
      } else if (!toolsets.includes(t)) {
        toolsets.push(t)
      }
    }
  }

  // capabilities supersedes skillDeps. If both are present their skill projection
  // must match exactly, otherwise old and new runtimes would install different bundles.
  const legacySkillDeps = parseLegacySkillDeps(o.skillDeps, errors)
  let capabilities = parseCapabilities(o.capabilities, opts.artifactSlug, errors)
  if (o.capabilities === undefined) {
    capabilities = legacySkillDeps.map((slug) => ({ kind: 'skill', slug, optional: false }))
  }
  if (capabilities.length > MAX_CAPABILITIES && o.capabilities === undefined)
    errors.push(`capabilities 最多 ${MAX_CAPABILITIES} 项`)
  const capabilitySkillDeps = capabilities
    .filter((item) => item.kind === 'skill')
    .map((item) => item.slug)
  // Plugin refs cannot be projected into the legacy Skill-only vocabulary. The
  // 0151 install trigger therefore gives Agents with a required Plugin an
  // old-reader-visible hash mismatch: rollback source hides them fail-closed,
  // while current source recognizes that exact marker and evaluates readiness.
  if (o.capabilities !== undefined && o.skillDeps !== undefined) {
    const a = [...capabilitySkillDeps].sort()
    const b = [...legacySkillDeps].sort()
    if (a.length !== b.length || a.some((slug, index) => slug !== b[index]))
      errors.push('capabilities 与 skillDeps 的技能集合不一致')
  }
  const skillDeps = capabilitySkillDeps

  // tags: optional
  const tags: string[] = []
  if (o.tags !== undefined) {
    if (!Array.isArray(o.tags)) errors.push('tags 须为数组')
    else
      for (const t of o.tags) {
        if (typeof t === 'string' && t.trim() && t.length <= MAX.tag) tags.push(t.trim())
      }
  }

  // optional cosmetics
  const displayName =
    o.displayName === undefined
      ? undefined
      : (asString(o.displayName, 'displayName', MAX.displayName, errors) ?? undefined)
  const avatarEmoji =
    o.avatarEmoji === undefined
      ? undefined
      : (asString(o.avatarEmoji, 'avatarEmoji', MAX.avatarEmoji, errors) ?? undefined)
  const greeting =
    o.greeting === undefined
      ? undefined
      : (asString(o.greeting, 'greeting', MAX.greeting, errors) ?? undefined)

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    manifest: {
      name: name as string,
      description: description as string,
      tags,
      version: version as string,
      model: model as string,
      toolsets,
      capabilities,
      skillDeps,
      persona: persona as string,
      ...(displayName ? { displayName } : {}),
      ...(avatarEmoji ? { avatarEmoji } : {}),
      ...(greeting ? { greeting } : {}),
    },
  }
}

/** Canonical serialization of a manifest = the raw_artifact stored + hashed.
 *  Stable key order so the artifact hash is deterministic. */
export function canonicalizeAgentManifest(m: AgentManifest): string {
  const ordered = {
    name: m.name,
    description: m.description,
    version: m.version,
    model: m.model,
    toolsets: m.toolsets,
    // Preserve the canonical bytes of legacy/no-capability Agents. Platform seeds
    // pin artifact hashes by version, so emitting a new empty key would break their
    // idempotent convergence without adding any semantics.
    ...(m.capabilities.length > 0 ? { capabilities: m.capabilities } : {}),
    skillDeps: m.skillDeps,
    tags: m.tags,
    persona: m.persona,
    ...(m.displayName ? { displayName: m.displayName } : {}),
    ...(m.avatarEmoji ? { avatarEmoji: m.avatarEmoji } : {}),
    ...(m.greeting ? { greeting: m.greeting } : {}),
  }
  return `${JSON.stringify(ordered, null, 2)}\n`
}
