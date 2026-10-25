/** Readonly P0 adapters. No catalog, worker, source repair, or production integration. */
import { createAuthorityPaths } from './authorityPaths.js'
import { assertIdentityCompatExecution, type IdentityCompatAssets } from './identityCompatAssets.js'
import type { MemoryDir } from './memoryDir.js'
import { parseMemoryFrontmatter } from './memoryFrontmatter.js'
import { loadFrozenProjectContext } from './projectContextFrozen.js'
import { openProjectFormalReadonly } from './projectFormalLedger.js'
import {
  contextAccess, contextContentHash, contextEligibility, contextScopeKey,
  type ContextAuthority, type ContextReadOptions, type ContextRejection, type GatewayContextAuthority,
} from './contextEligibility.js'

export interface SourceDescriptor {
  readonly sourceId: string
  readonly scopeKey: string
  readonly kind: 'core-index' | 'project-memory'
  readonly sourceVersion: string
  /** Logical locator generated here, never a model-provided filesystem path. */
  readonly locator: string
  readonly content: string
  /** Ledger and frontmatter expiry both apply. */
  readonly expires: readonly string[]
}
export type ContextSources =
  | { readonly status: 'ready'; readonly sources: readonly SourceDescriptor[] }
  | { readonly status: 'unavailable'; readonly reason: ContextRejection }

function descriptor(authority: GatewayContextAuthority, kind: SourceDescriptor['kind'], locator: string,
  content: string, expires: readonly string[] = []): SourceDescriptor {
  const scopeKey = contextScopeKey(authority)
  return Object.freeze({ sourceId: contextContentHash(JSON.stringify([scopeKey, kind, locator])), scopeKey,
    kind, sourceVersion: contextContentHash(content), locator, content, expires: Object.freeze([...expires]) })
}
function unavailable(reason: ContextRejection): ContextSources { return { status: 'unavailable', reason } }

/** Trusted composition supplies the already-selected reader for this exact authority.
 * Pick deliberately excludes migration, reconciliation, list and write APIs. Do not
 * construct this handle from request parameters, temporary HOME or fallback roots.
 * Registration checks remain owned by resolveIdentityCompatAssets; realpath is not a grant.
 */
export interface ContextCoreSource {
  readonly reader: Pick<MemoryDir, 'renderForInjectionReadonly'>
  readonly identityCompat?: IdentityCompatAssets
}
export async function readCoreContextSource(authority: ContextAuthority, options: ContextReadOptions,
  source: ContextCoreSource): Promise<ContextSources> {
  const access = contextAccess(authority, options)
  if (!access.allowed) return unavailable(access.reason)
  if (authority.runtime !== 'gateway') return unavailable('cli_lease_blocked')
  if (source.identityCompat) assertIdentityCompatExecution(source.identityCompat, authority.effectiveAgentId)
  const content = await source.reader.renderForInjectionReadonly(25 * 1024, 200, { today: options.today })
  // Recheck revocation/expiry after an asynchronous read; never reuse a warmed allow.
  const after = contextAccess(authority, options)
  if (!after.allowed) return unavailable(after.reason)
  if (!content) return { status: 'ready', sources: Object.freeze([]) }
  const current = descriptor(authority, 'core-index', 'MEMORY.md', content)
  const eligible = contextEligibility(authority, options, current, current)
  return eligible.allowed ? { status: 'ready', sources: Object.freeze([current]) } : unavailable(eligible.reason)
}

/** Formal root only. The legacy frozen loader takes a write lock, so is not on
 * this whitelist. Missing/invalid formal data rejects this source, never falls back.
 * No skills/assets/user/session enumeration is admitted by this P0 adapter.
 */
export async function readFormalProjectContextSources(authority: ContextAuthority,
  options: ContextReadOptions): Promise<ContextSources> {
  const access = contextAccess(authority, options)
  if (!access.allowed) return unavailable(access.reason)
  if (authority.runtime !== 'gateway') return unavailable('cli_lease_blocked')
  if (authority.mode !== 'formal' || !authority.boardProjectId || authority.contextVersion === null) {
    return unavailable('source_unavailable')
  }
  const locations = createAuthorityPaths(authority.root)
  const ledger = openProjectFormalReadonly(locations)
  try {
    const frozen = await loadFrozenProjectContext({ boardProjectId: authority.boardProjectId, formal: { paths: locations, ledger } })
    if (frozen.contextVersion !== authority.contextVersion) return unavailable('source_changed')
    const rows = ledger.snapshot(authority.boardProjectId).official
    const sources: SourceDescriptor[] = []
    for (const memory of frozen.officialMemory) {
      const row = rows.find(item => item.slug === memory.slug)
      if (!row || row.deprecated || !memory.content || row.contentSha256 !== memory.contentSha256) continue
      const expires = [row.expires, parseMemoryFrontmatter(memory.content).fm.expires]
        .filter((value): value is string => typeof value === 'string')
      const current = descriptor(authority, 'project-memory', `project:${frozen.boardProjectId}/memory/${memory.slug}`, memory.content, expires)
      if (current.sourceVersion !== row.contentSha256) continue
      if (contextEligibility(authority, options, current, current).allowed) sources.push(current)
    }
    const after = contextAccess(authority, options)
    if (!after.allowed) return unavailable(after.reason)
    return { status: 'ready', sources: Object.freeze(sources) }
  } finally { ledger.close() }
}
