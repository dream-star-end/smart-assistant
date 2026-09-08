// Identity-compat asset resolver — A4 layer 2 (lossless persona/skill assets).
//
// Receives an ALREADY-VALIDATED master IdentityCompatProfile (protocol layer 1
// owns registration, wire projection and per-execution readiness) and resolves
// it against the concrete local facts the persona/skill surfaces consume:
//
//   - structural validation of the on-disk facts the reviewed contract froze:
//     both cfg entries exist; the registered localPersonaPath matches the
//     legacy entry's actual independent persona file; effective permissionMode
//     (agent-level ?? openclaude.json defaults) is EQUAL on both sides; the two
//     Core memory dirs are the same physical store (realpath); neither side has
//     an unregistered SOUL.md. Any mismatch is a precise typed conflict — this
//     layer never writes, migrates, relinks or overwrites anything, and it never
//     invents a permission ordering to "fix" a difference.
//   - a SOUL assembly read FRESH on every call from three verbatim segments
//     (trusted compat explanation + read-only market persona + the registered
//     local manual). Sources stay separate files; no NLP rewriting, no copying
//     the old manual into the managed market file.
//
// Memory contents are never read here — only existence/realpath checks.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { IdentityCompatProfile } from '@openclaude/protocol'
import { paths } from './paths.js'
import { readAgentsConfig, readConfig, type AgentDef, type OpenClaudeConfig } from './config.js'

export type IdentityPermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan'

export type IdentityAssetsErrorCode =
  | 'COMPAT_CONFIG_CONFLICT'
  | 'COMPAT_PERMISSION_CONFLICT'
  | 'COMPAT_SKILL_CONFLICT'

export class IdentityAssetsError extends Error {
  constructor(
    readonly code: IdentityAssetsErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'IdentityAssetsError'
  }
}

export function isIdentityAssetsError(err: unknown): err is IdentityAssetsError {
  return err instanceof IdentityAssetsError
}

export const IDENTITY_COMPAT_SOUL_START = '<!-- oc-identity-compat:start -->'
export const IDENTITY_COMPAT_SOUL_END = '<!-- oc-identity-compat:end -->'

export interface IdentityCompatSoulSegments {
  compatExplanation: string
  marketPersona: string
  localManual: string
}

export interface IdentityCompatSoul {
  /** Ready-to-use SOUL slot content (includes the `# WHO I AM` header). */
  content: string
  segments: IdentityCompatSoulSegments
  canonicalPersonaSha256: string
  localManualSha256: string
}

export interface IdentityCompatAssets {
  profile: IdentityCompatProfile
  /** Absolute path of the registered, editable local manual. */
  localManualPath: string
  /** Absolute path of the read-only canonical (market) persona file. */
  canonicalPersonaPath: string
  /** The permission mode both ids effectively resolve to (undefined = engine default on both sides). */
  effectivePermissionMode: IdentityPermissionMode | undefined
  /**
   * Assemble the shared SOUL. Reads both persona files FRESH on every call
   * (safe-turn refresh: local-manual edits apply on the next build) and
   * re-checks SOUL absence so a newly planted SOUL.md cannot preempt the
   * registered assembly. Throws IdentityAssetsError on drift — never falls
   * back to a single-source persona.
   */
  buildSoul(): IdentityCompatSoul
}

function realPathOrNull(p: string): string | null {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Mirror of sessionManager's effective-permission computation: agent-level value ?? openclaude.json defaults. */
function effectivePermissionMode(
  agent: AgentDef,
  config: OpenClaudeConfig | null,
): IdentityPermissionMode | undefined {
  return agent.permissionMode ?? config?.defaults?.permissionMode ?? undefined
}

/** The persona file an agents.yaml entry actually points at (relative resolves against HOME; unset → per-agent default). */
function personaCandidate(agent: AgentDef): string {
  if (!agent.persona) return paths.agentClaudeMd(agent.id)
  return isAbsolute(agent.persona) ? resolve(agent.persona) : resolve(paths.home, agent.persona)
}

function assertNoUnregisteredSoul(profile: IdentityCompatProfile): void {
  for (const id of [profile.legacyAgentId, profile.canonicalAgentId]) {
    const soulPath = join(paths.agentDir(id), 'SOUL.md')
    if (existsSync(soulPath)) {
      throw new IdentityAssetsError(
        'COMPAT_CONFIG_CONFLICT',
        `unregistered SOUL.md exists at ${soulPath}; the compat persona must not be silently preempted or overlaid — resolve explicitly`,
      )
    }
  }
}

function assertCoreEquivalence(profile: IdentityCompatProfile): void {
  // Read-only equivalence proof; never relinks. Both missing = nothing to diverge.
  const legacyReal = realPathOrNull(paths.agentMemoryDir(profile.legacyAgentId))
  const canonicalReal = realPathOrNull(paths.agentMemoryDir(profile.canonicalAgentId))
  if (legacyReal !== canonicalReal) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `Core memory dirs must be the same physical store (realpath legacy=${legacyReal ?? '(missing)'} canonical=${canonicalReal ?? '(missing)'}); this layer never migrates or relinks — resolve the drift manually`,
    )
  }
}

function buildCompatExplanation(profile: IdentityCompatProfile): string {
  return [
    '## 身份兼容说明(受信注册)',
    '',
    `本实例已由 master 显式登记身份兼容 profile \`${profile.profileId}\`:真实执行 Agent 是 canonical \`${profile.canonicalAgentId}\`;\`${profile.legacyAgentId}\` 只是历史 claim/脚本标签,不是另一个执行身份。旧手册中自称 agentId=\`${profile.legacyAgentId}\`、\`--owner agent:${profile.legacyAgentId}\` 与原脚本路径一律按历史标签原样理解,不改变真实执行 ID。`,
    '',
    '### 已知冲突优先级(登记口径;不改动下方两份原文)',
    '',
    '- 旧手册「绿级 chore 可自动批准」不再生效:没有用户明确批准,不自动 approve(市场底线优先)。',
    '- cron 参数改动一律按黄级处理;巡检 cron、预算、评审器等更高层人批红线不因本兼容扩大。',
    '- 旧手册的选型器、既有模型选择例外与工作循环保留,但不覆盖市场 capability readiness、模型可用性、调用方 toolset cap 或更高层禁止。',
    '- 本兼容不扩大模型、toolset 或 capability 授权;两 ID 有效 permissionMode 相同是准入前提。',
  ].join('\n')
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function buildIdentityCompatSoul(
  profile: IdentityCompatProfile,
  localManualPath: string,
  canonicalPersonaPath: string,
): IdentityCompatSoul {
  // Fresh re-check: a SOUL planted after resolution must still not preempt.
  assertNoUnregisteredSoul(profile)
  if (!isRegularFile(canonicalPersonaPath)) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `canonical market persona disappeared: ${canonicalPersonaPath}`,
    )
  }
  if (!isRegularFile(localManualPath)) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `registered local manual disappeared: ${localManualPath}`,
    )
  }
  const marketPersona = readFileSync(canonicalPersonaPath, 'utf-8').trim()
  const localManual = readFileSync(localManualPath, 'utf-8').trim()
  const compatExplanation = buildCompatExplanation(profile)
  const content = [
    '# WHO I AM (Agent Persona)',
    '',
    IDENTITY_COMPAT_SOUL_START,
    compatExplanation,
    IDENTITY_COMPAT_SOUL_END,
    '',
    `## 市场人格底线(只读;canonical \`${profile.canonicalAgentId}\`)`,
    '',
    marketPersona,
    '',
    `## 本实例运行手册(登记的本地资源 \`${profile.localPersonaPath}\`;经既有 \`${profile.legacyAgentId}\` persona 编辑入口维护)`,
    '',
    localManual,
  ].join('\n')
  return {
    content,
    segments: { compatExplanation, marketPersona, localManual },
    canonicalPersonaSha256: sha256Hex(marketPersona),
    localManualSha256: sha256Hex(localManual),
  }
}

/**
 * Validate the registered profile against the live local config/files and
 * return the asset handle both request entries share. Read-only; throws a
 * typed IdentityAssetsError on any frozen-fact mismatch (never "repairs").
 */
export async function resolveIdentityCompatAssets(input: {
  profile: IdentityCompatProfile
}): Promise<IdentityCompatAssets> {
  const { profile } = input
  const [agentsCfg, config] = await Promise.all([
    readAgentsConfig(),
    readConfig().catch(() => null),
  ])
  const legacy = agentsCfg.agents.find((a) => a.id === profile.legacyAgentId)
  const canonical = agentsCfg.agents.find((a) => a.id === profile.canonicalAgentId)
  if (!legacy || !canonical) {
    const missing = [!legacy && profile.legacyAgentId, !canonical && profile.canonicalAgentId]
      .filter(Boolean)
      .join(', ')
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `registered profile expects local agents.yaml entries for both ids (missing: ${missing})`,
    )
  }

  const localManualPath = resolve(paths.home, profile.localPersonaPath)
  if (!isRegularFile(localManualPath)) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `registered local manual is not an existing regular file: ${localManualPath}`,
    )
  }
  const manualReal = realPathOrNull(localManualPath)
  const legacyPersonaReal = realPathOrNull(personaCandidate(legacy))
  if (!manualReal || !legacyPersonaReal || manualReal !== legacyPersonaReal) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `legacy agent '${legacy.id}' persona (${legacy.persona ?? `default ${paths.agentClaudeMd(legacy.id)}`}) does not resolve to the registered local manual '${profile.localPersonaPath}'; registration and on-disk config disagree`,
    )
  }
  const canonicalPersonaPath = personaCandidate(canonical)
  const canonicalPersonaReal = realPathOrNull(canonicalPersonaPath)
  if (!canonicalPersonaReal || !isRegularFile(canonicalPersonaReal)) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `canonical market persona is not an existing regular file: ${canonicalPersonaPath}`,
    )
  }
  if (canonicalPersonaReal === manualReal) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `canonical persona and the registered local manual are the same file (${canonicalPersonaReal}); the contract requires two independent sources`,
    )
  }

  const legacyPerm = effectivePermissionMode(legacy, config)
  const canonicalPerm = effectivePermissionMode(canonical, config)
  if (legacyPerm !== canonicalPerm) {
    throw new IdentityAssetsError(
      'COMPAT_PERMISSION_CONFLICT',
      `effective permissionMode differs: legacy '${profile.legacyAgentId}'=${String(legacyPerm)} vs canonical '${profile.canonicalAgentId}'=${String(canonicalPerm)} (agent-level ?? openclaude.json defaults); no synthetic permission ordering — resolve explicitly`,
    )
  }

  assertCoreEquivalence(profile)
  assertNoUnregisteredSoul(profile)

  return {
    profile,
    localManualPath,
    canonicalPersonaPath,
    effectivePermissionMode: legacyPerm,
    buildSoul: () => buildIdentityCompatSoul(profile, localManualPath, canonicalPersonaPath),
  }
}

/** Execution identity guard: compat assets only ever run as the canonical id. */
export function assertIdentityCompatExecution(assets: IdentityCompatAssets, agentId: string): void {
  if (agentId !== assets.profile.canonicalAgentId) {
    throw new IdentityAssetsError(
      'COMPAT_CONFIG_CONFLICT',
      `identity-compat assets are registered for canonical execution id '${assets.profile.canonicalAgentId}' (got '${agentId}'); '${assets.profile.legacyAgentId}' is not an execution identity`,
    )
  }
}
