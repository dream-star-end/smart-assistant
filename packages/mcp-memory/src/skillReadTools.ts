/**
 * Shared read-only skill discovery & view handlers for BOTH the `openclaude-memory`
 * MCP server (`index.ts`) and the one-shot `oc-memory` CLI (`ocMemoryCli.ts`).
 *
 * Keeping these read paths in a single zero-side-effect module lets local native
 * Antigravity swarm workers (which do not receive MCP servers from the CLI binary)
 * search and view platform/user/project skills directly via `oc-memory skill-search`
 * and `oc-memory skill-view` with zero gateway bearer token, zero SQLite writes,
 * and zero network calls (`allowSideEffects: false`).
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import {
  parseFrontmatter,
  paths,
  recordLocalSkillSearchHits,
  recordLocalSkillView,
  searchArchivedSkills,
  searchSkillMetadata,
  type SkillStore,
} from '@openclaude/storage'
import { postJsonToGateway } from './gatewayClient.js'

export interface SkillReadToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface SkillReadContext {
  agentId: string
  env: NodeJS.ProcessEnv
  /**
   * True for the long-lived MCP server (enables master semantic ranking + local
   * usage counters); false for the read-only `oc-memory` CLI (strictly pure local
   * filesystem reads: zero SQLite opens/writes and zero remote HTTP calls).
   */
  allowSideEffects: boolean
}

function readEvalArm(env: NodeJS.ProcessEnv): {
  exclude: string
  draftName: string
  draftDir: string
} {
  return {
    exclude: (env.OPENCLAUDE_SKILL_EVAL_EXCLUDE ?? '').trim(),
    draftName: (env.OPENCLAUDE_SKILL_EVAL_DRAFT_NAME ?? '').trim(),
    draftDir: (env.OPENCLAUDE_SKILL_EVAL_DRAFT_DIR ?? '').trim(),
  }
}

function normalizeSafeRelativeSubfile(relPath: string): string | null {
  let cleanRel = relPath.trim().replace(/\\/g, '/')
  while (cleanRel.startsWith('./')) cleanRel = cleanRel.slice(2)
  cleanRel = cleanRel.replace(/^\/+/, (m) => m) // keep leading slash so isAbsolute catches it
  if (!cleanRel || isAbsolute(cleanRel) || cleanRel.includes('\0')) return null
  const segments = cleanRel.split('/').filter(Boolean)
  if (segments.length === 0 || segments.some((s) => s === '.' || s === '..')) return null
  return segments.join('/')
}

type DraftFileReadResult =
  | { kind: 'ok'; content: string }
  | { kind: 'missing' }
  | { kind: 'invalid' }

function readEvalDraftFile(draftDir: string, relPath: string): DraftFileReadResult {
  if (!draftDir) return { kind: 'missing' }
  const cleanRel = normalizeSafeRelativeSubfile(relPath)
  if (!cleanRel) return { kind: 'invalid' }
  let rootReal: string
  try {
    rootReal = realpathSync(draftDir)
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
    return code === 'ENOENT' ? { kind: 'missing' } : { kind: 'invalid' }
  }
  const target = resolve(rootReal, cleanRel)
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`
  if (!target.startsWith(rootPrefix)) return { kind: 'invalid' }
  try {
    const st = lstatSync(target)
    if (st.isSymbolicLink() || !st.isFile()) return { kind: 'invalid' }
    const targetReal = realpathSync(target)
    if (!targetReal.startsWith(rootPrefix)) return { kind: 'invalid' }
    return { kind: 'ok', content: readFileSync(targetReal, 'utf8') }
  } catch (err: unknown) {
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code?: unknown }).code : undefined
    return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'missing' } : { kind: 'invalid' }
  }
}

function isMainSkillFileAlias(subfile: string | undefined): boolean {
  if (!subfile || !subfile.trim()) return true
  const clean = normalizeSafeRelativeSubfile(subfile)
  return clean !== null && clean.toUpperCase() === 'SKILL.MD'
}

const DRAFT_INTERNAL_STAGING_FILES = new Set(['draft.json', 'evals.json'])

function readValidEvalDraftMeta(
  draftDir: string,
  draftName: string,
): { description: string; tags?: string[]; related_skills?: string[] } | null {
  const res = readEvalDraftFile(draftDir, 'SKILL.md')
  if (res.kind !== 'ok') return null
  const { meta } = parseFrontmatter(res.content)
  const desc = typeof meta.description === 'string' ? meta.description.trim() : ''
  if (!desc) return null
  if (meta.name && meta.name !== draftName) return null
  return {
    description: desc,
    tags: Array.isArray(meta.tags) ? meta.tags : undefined,
    related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
  }
}

/**
 * Apply skill-eval arm overrides (`exclude` hides target; `draft` swaps candidate
 * metadata, or hides target fail-closed when the candidate draft is unavailable).
 */
export function applySkillEvalArmToList<
  T extends { name: string; description: string; tags?: string[]; related_skills?: string[] },
>(list: T[], env: NodeJS.ProcessEnv): T[] {
  const { exclude, draftName, draftDir } = readEvalArm(env)
  let out = list
  if (exclude) out = out.filter((s) => s.name !== exclude)
  if (draftName) {
    const draftMeta = readValidEvalDraftMeta(draftDir, draftName)
    if (!draftMeta) {
      // Fail-closed: never expose the published skill description as a substitute
      // when the draft arm's candidate SKILL.md is missing, deleted, or invalid.
      out = out.filter((s) => s.name !== draftName)
    } else {
      out = out.map((s) =>
        s.name === draftName
          ? {
              ...s,
              description: draftMeta.description,
              tags: draftMeta.tags,
              related_skills: draftMeta.related_skills,
            }
          : s,
      )
    }
  }
  return out
}

/**
 * v3 semantic skill ranking via the master embedding relay. Fail-open to keyword
 * search whenever master relay env is absent or fails. Only invoked when
 * `allowSideEffects: true` (never called by the read-only local CLI).
 */
async function semanticSkillRank(
  list: Array<{ name: string; description: string; tags?: string[]; related_skills?: string[] }>,
  query: string,
  limit: number | undefined,
  env: NodeJS.ProcessEnv,
): Promise<Array<{ name: string; score: number }> | null> {
  const base = env.OPENCLAUDE_V3_MASTER_BASE_URL?.trim()
  const token = env.OPENCLAUDE_V3_CONTAINER_TOKEN?.trim()
  if (!base || !token || list.length === 0) return null
  try {
    const res = await postJsonToGateway(`${base.replace(/\/+$/, '')}/internal/v3/skill-embed`, {
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        query,
        limit,
        skills: list.map((s) => ({
          name: s.name,
          description: s.description,
          tags: s.tags,
          related_skills: s.related_skills,
        })),
      }),
      timeoutMs: 3500,
    })
    if (res.statusCode < 200 || res.statusCode >= 300) return null
    const data = JSON.parse(res.body) as { ok?: boolean; ranked?: unknown }
    if (!data.ok || !Array.isArray(data.ranked)) return null
    const ranked = data.ranked.filter(
      (r): r is { name: string; score: number } =>
        !!r && typeof r.name === 'string' && typeof r.score === 'number',
    )
    return ranked.length > 0 ? ranked : null
  } catch {
    return null
  }
}

function readError(msg: string): SkillReadToolResult {
  return { content: [{ type: 'text', text: msg }], isError: true }
}

export async function handleSkillListRead(
  skills: SkillStore,
  ctx: SkillReadContext,
  args?: { source?: string },
): Promise<SkillReadToolResult> {
  const env = ctx.env
  let list = applySkillEvalArmToList(await skills.list(), env)
  const sourceFilter = args?.source?.trim().toLowerCase()
  if (sourceFilter) {
    if (sourceFilter !== 'platform' && sourceFilter !== 'user') {
      return readError(`invalid --source "${args?.source}" (expected platform or user)`)
    }
    list = list.filter((s) => s.source === sourceFilter)
  }
  if (list.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: sourceFilter
            ? `No ${sourceFilter} skills found.`
            : 'No skills yet. Use `skill_save` to distill successful task resolutions into reusable skills.',
        },
      ],
    }
  }
  const platform = list.filter((s) => s.source === 'platform')
  const user = list.filter((s) => s.source === 'user')
  const lines = [`You have ${list.length} skill(s):`, '']
  const pushSection = (heading: string, items: typeof list) => {
    if (items.length === 0) return
    lines.push(heading)
    lines.push('')
    for (const s of items) {
      lines.push(`### ${s.name}`)
      lines.push(s.description)
      if (s.tags && s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`)
      lines.push('')
    }
  }
  pushSection('## Platform baseline (read-only)', platform)
  pushSection('## User-created', user)
  lines.push('Use `skill_view(name)` (or `oc-memory skill-view <name>`) to load full instructions for any skill above.')
  lines.push(
    'Baseline skills cannot be overwritten via `skill_save` (name is reserved) or deleted via `skill_delete`.',
  )
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

export async function handleSkillSearchRead(
  skills: SkillStore,
  args: { query: string; limit?: number } | undefined,
  ctx: SkillReadContext,
): Promise<SkillReadToolResult> {
  const env = ctx.env
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!query) return readError('query required')

  const { exclude, draftName, draftDir } = readEvalArm(env)
  const list = applySkillEvalArmToList(await skills.list(), env)

  if (ctx.allowSideEffects) {
    const semantic = await semanticSkillRank(list, query, args?.limit, env)
    if (semantic) {
      const byName = new Map(list.map((s) => [s.name, s]))
      const matched = semantic.map((r) => ({ r, s: byName.get(r.name) })).filter((x) => x.s)
      if (matched.length > 0) {
        await recordLocalSkillSearchHits(
          matched.map(({ r }) => r.name),
          'user',
        ).catch(() => {})
        const lines = [`Found ${matched.length} relevant skill(s) for "${query}" (semantic):`, '']
        for (const { r, s } of matched) {
          lines.push(`### ${r.name} [source: ${s!.source}, relevance: ${r.score.toFixed(3)}]`)
          lines.push(s!.description)
          if (s!.tags && s!.tags.length > 0) lines.push(`tags: ${s!.tags.join(', ')}`)
          if (s!.related_skills && s!.related_skills.length > 0)
            lines.push(`related_skills: ${s!.related_skills.join(', ')}`)
          lines.push('')
        }
        lines.push('Next: call `skill_view(name)` (or `oc-memory skill-view <name>`) for the best match before applying it.')
        return { content: [{ type: 'text', text: lines.join('\n') }] }
      }
    }
  }

  const hits = searchSkillMetadata(list, query, args?.limit)
  if (hits.length === 0) {
    const archivedRaw = await searchArchivedSkills(paths.sharedSkillsDir, query, 3, {
      agentId: ctx.agentId,
    }).catch(() => [])
    const hiddenNames = new Set<string>()
    if (exclude) hiddenNames.add(exclude)
    if (draftName && !readValidEvalDraftMeta(draftDir, draftName)) hiddenNames.add(draftName)
    const archivedHits =
      hiddenNames.size > 0 ? archivedRaw.filter((h) => !hiddenNames.has(h.target)) : archivedRaw
    const baseLines = [
      `No matching skills found for "${query}".`,
      'Try a broader query or call `skill_list()` (or `oc-memory skill-list`) to browse all available skills.',
      'If this was a reusable workflow you just validated, create it with `skill_save` after the task is complete.',
    ]
    if (archivedHits.length > 0) {
      baseLines.push(
        '',
        'Archived skills that match this topic (previously auto-archived due to inactivity; can be restored anytime via Archived Records or `/api/skills/archive/restore`):',
        ...archivedHits.map(
          (h) => `- **${h.target}** — ${h.description || h.snippet || h.reason} (id: ${h.id})`,
        ),
      )
    }
    return {
      content: [
        {
          type: 'text',
          text: baseLines.join('\n'),
        },
      ],
    }
  }

  const lines = [`Found ${hits.length} matching skill(s) for "${query}":`, '']
  if (ctx.allowSideEffects) {
    await recordLocalSkillSearchHits(
      hits.map((s) => s.name),
      'user',
    ).catch(() => {})
  }
  for (const s of hits) {
    lines.push(`### ${s.name} [source: ${s.source}, score: ${s.score}]`)
    lines.push(s.description)
    if (s.tags && s.tags.length > 0) lines.push(`tags: ${s.tags.join(', ')}`)
    if (s.related_skills && s.related_skills.length > 0)
      lines.push(`related_skills: ${s.related_skills.join(', ')}`)
    if (s.matched.length > 0) lines.push(`matched: ${s.matched.join(', ')}`)
    lines.push('')
  }
  lines.push('Next: call `skill_view(name)` (or `oc-memory skill-view <name>`) for the best match before applying it.')
  return { content: [{ type: 'text', text: lines.join('\n') }] }
}

export async function handleSkillViewRead(
  skills: SkillStore,
  args: { name: string; subfile?: string } | undefined,
  ctx: SkillReadContext,
): Promise<SkillReadToolResult> {
  const env = ctx.env
  const name = typeof args?.name === 'string' ? args.name.trim() : ''
  if (!name) return readError('skill name required')
  const { exclude, draftName, draftDir } = readEvalArm(env)
  if (exclude && name === exclude) return readError('skill not found')
  if (draftName && name === draftName) {
    // Candidate SKILL.md must exist, pass containment checks, and carry valid
    // candidate metadata; if unavailable (missing/deleted/invalid draft), fail
    // closed for main body, subfiles, list, and search consistently.
    const draftMain = readEvalDraftFile(draftDir, 'SKILL.md')
    if (draftMain.kind !== 'ok' || !readValidEvalDraftMeta(draftDir, draftName)) {
      return readError('skill draft not found')
    }
    if (isMainSkillFileAlias(args?.subfile)) {
      return { content: [{ type: 'text', text: `[source: user]\n\n${draftMain.content}` }] }
    }
    const cleanSub = normalizeSafeRelativeSubfile(args!.subfile!)
    if (!cleanSub || DRAFT_INTERNAL_STAGING_FILES.has(cleanSub.toLowerCase())) {
      return readError('skill draft subfile not found')
    }
    // 1. Prefer an explicitly staged draft subfile if present; reject invalid/symlinked entries fail-closed.
    const draftSub = readEvalDraftFile(draftDir, cleanSub)
    if (draftSub.kind === 'ok') {
      return { content: [{ type: 'text', text: draftSub.content }] }
    }
    if (draftSub.kind === 'invalid') {
      return readError('skill draft subfile not found')
    }
    // 2. Real SkillDraftStore.writeDraft only stages SKILL.md and preserves unchanged
    //    published attachments upon merge. Mirror the post-merge view by reading unchanged
    //    attachments through SkillStore's validated subfile reader (never SKILL.md).
    const publishedSub = await skills.view(name, cleanSub)
    if (typeof publishedSub !== 'string') return readError('skill draft subfile not found')
    return { content: [{ type: 'text', text: publishedSub }] }
  }
  const v = await skills.view(name, args?.subfile)
  if (!v) return readError('skill not found')
  if (typeof v === 'string') {
    if (ctx.allowSideEffects) {
      await recordLocalSkillView(name, 'user').catch(() => {})
    }
    return { content: [{ type: 'text', text: v }] }
  }
  if (ctx.allowSideEffects) {
    const usageLayer = v.layer === 'hub' ? 'hub' : v.source === 'platform' ? 'platform' : 'user'
    await recordLocalSkillView(name, usageLayer).catch(() => {})
  }
  const header = `[source: ${v.source}]`
  return { content: [{ type: 'text', text: `${header}\n\n${v.rawContent}` }] }
}
