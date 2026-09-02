/**
 * skill_save argument normalization (pure, no side effects; unit-tested).
 *
 * Deferred-tool wrappers (claude-code-best ExecuteExtraTool) skip schema validation
 * for MCP tools, so models send `content`/`desc` instead of `body`/`description`, or
 * `tags` as a comma string. Without this the crash surfaces deep in skillStore
 * ("Cannot read properties of undefined (reading 'trim')", "tags.join is not a
 * function") with no actionable hint for the model.
 */
import { validateSkillName } from '@openclaude/storage'

export type SkillSaveArgs = {
  name: string
  description: string
  body: string
  tags?: string[]
  force: boolean
}

export function normalizeSkillSaveArgs(
  raw: unknown,
): { ok: true; args: SkillSaveArgs } | { ok: false; error: string } {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const name = typeof a.name === 'string' ? a.name.trim() : ''
  const nameCheck = validateSkillName(name)
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error ?? 'invalid skill name' }
  const descriptionRaw = a.description ?? a.desc ?? a.summary
  const description = typeof descriptionRaw === 'string' ? descriptionRaw.trim() : ''
  if (!description) {
    return { ok: false, error: 'description required (string: 1-2 sentences on when to use the skill)' }
  }
  const bodyRaw = a.body ?? a.content ?? a.markdown ?? a.instructions
  const body = typeof bodyRaw === 'string' ? bodyRaw : ''
  if (!body.trim()) {
    const hint = bodyRaw === undefined ? ' — pass the full markdown in the `body` field' : ''
    return { ok: false, error: `body required (markdown string)${hint}` }
  }
  let tags: string[] | undefined
  if (a.tags !== undefined && a.tags !== null) {
    const list = Array.isArray(a.tags) ? a.tags : typeof a.tags === 'string' ? a.tags.split(/[,\n]/) : null
    if (!list) return { ok: false, error: 'tags must be an array of strings' }
    tags = list
      .map((t) => (typeof t === 'string' ? t.trim() : typeof t === 'number' ? String(t) : ''))
      .filter(Boolean)
  }
  return { ok: true, args: { name, description, body, ...(tags ? { tags } : {}), force: a.force === true } }
}
