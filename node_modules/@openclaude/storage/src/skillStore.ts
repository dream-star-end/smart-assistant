// SkillStore — per-agent skill library. Each skill is a directory:
//   ~/.openclaude/agents/<agentId>/skills/<skill-name>/
//     SKILL.md   — YAML frontmatter + markdown instructions
//     references/ — optional sub-docs (tier-3 progressive disclosure)
//     templates/  — optional output templates
//
// Skill name constraints: a-z 0-9 hyphen only, max 64 chars.
// Frontmatter: name, description (max 1024), version, tags[], related_skills[].
//
// Progressive disclosure:
//   tier 1 — list (name + description) → always visible in system prompt
//   tier 2 — view(name) → full SKILL.md
//   tier 3 — view(name, subfile) → a referenced file
//
// Ported from NousResearch/hermes-agent tools/skills_tool.py.

import { mkdir, readdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { paths } from './paths.js'

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024

const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

export interface SkillFrontmatter {
  name: string
  description: string
  version?: string
  tags?: string[]
  related_skills?: string[]
  created_at?: string
  updated_at?: string
}

export interface SkillMetadata extends SkillFrontmatter {
  path: string // absolute dir path
}

export interface SkillContent extends SkillMetadata {
  body: string // the markdown after frontmatter
  rawContent: string // full SKILL.md
}

export function validateSkillName(name: string): { ok: boolean; error?: string } {
  if (!name) return { ok: false, error: 'skill name required' }
  if (name.length > MAX_SKILL_NAME_LENGTH)
    return { ok: false, error: `name too long (max ${MAX_SKILL_NAME_LENGTH})` }
  if (!VALID_SKILL_NAME_RE.test(name))
    return { ok: false, error: 'name must be lowercase a-z 0-9 hyphens' }
  return { ok: true }
}

// Minimal YAML frontmatter parser — no external dep, handles the subset we care about
export function parseFrontmatter(raw: string): { meta: Partial<SkillFrontmatter>; body: string } {
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/)
  if (!fmMatch) return { meta: {}, body: raw }
  const fmText = fmMatch[1]
  const body = fmMatch[2] ?? ''
  const meta: Record<string, any> = {}
  let currentArray: string[] | null = null
  let currentArrayKey: string | null = null
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) {
      currentArray = null
      currentArrayKey = null
      continue
    }
    // Array item: "  - foo"
    const arrItem = line.match(/^\s*-\s*(.+)$/)
    if (arrItem && currentArray) {
      currentArray.push(stripQuotes(arrItem[1]))
      continue
    }
    // Key: value
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/)
    if (kv) {
      const key = kv[1]
      const rawVal = kv[2].trim()
      currentArray = null
      currentArrayKey = null
      if (!rawVal) {
        // next lines might be array
        currentArray = []
        currentArrayKey = key
        meta[key] = currentArray
        continue
      }
      // Inline array: [a, b, c]
      if (rawVal.startsWith('[') && rawVal.endsWith(']')) {
        meta[key] = rawVal
          .slice(1, -1)
          .split(',')
          .map((s) => stripQuotes(s.trim()))
          .filter(Boolean)
        continue
      }
      meta[key] = stripQuotes(rawVal)
    }
  }
  return { meta: meta as Partial<SkillFrontmatter>, body }
}

export function formatFrontmatter(meta: SkillFrontmatter): string {
  const lines = ['---']
  lines.push(`name: ${meta.name}`)
  lines.push(`description: ${JSON.stringify(meta.description)}`)
  if (meta.version) lines.push(`version: ${meta.version}`)
  if (meta.tags && meta.tags.length > 0) lines.push(`tags: [${meta.tags.join(', ')}]`)
  if (meta.related_skills && meta.related_skills.length > 0)
    lines.push(`related_skills: [${meta.related_skills.join(', ')}]`)
  if (meta.created_at) lines.push(`created_at: ${meta.created_at}`)
  if (meta.updated_at) lines.push(`updated_at: ${meta.updated_at}`)
  lines.push('---')
  return lines.join('\n')
}

function stripQuotes(s: string): string {
  s = s.trim()
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1)
  }
  return s
}

export class SkillStore {
  constructor(private agentId: string) {}

  async list(): Promise<SkillMetadata[]> {
    const dir = paths.agentSkillsDir(this.agentId)
    if (!existsSync(dir)) return []
    const entries = await readdir(dir, { withFileTypes: true })
    const result: SkillMetadata[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.')) continue
      const skillMd = paths.agentSkillMd(this.agentId, entry.name)
      if (!existsSync(skillMd)) continue
      try {
        const raw = await readFile(skillMd, 'utf-8')
        const { meta } = parseFrontmatter(raw)
        if (!meta.name || !meta.description) continue
        result.push({
          name: meta.name,
          description: meta.description,
          version: meta.version,
          tags: Array.isArray(meta.tags) ? meta.tags : undefined,
          related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
          created_at: meta.created_at,
          updated_at: meta.updated_at,
          path: paths.agentSkillDir(this.agentId, entry.name),
        })
      } catch {}
    }
    return result.sort((a, b) => a.name.localeCompare(b.name))
  }

  async view(name: string, subfile?: string): Promise<SkillContent | string | null> {
    const v = validateSkillName(name)
    if (!v.ok) return null
    if (subfile) {
      const safePath = resolve(paths.agentSkillDir(this.agentId, name), subfile)
      const base = resolve(paths.agentSkillDir(this.agentId, name))
      if (!safePath.startsWith(base)) return null // path traversal guard
      if (!existsSync(safePath)) return null
      return await readFile(safePath, 'utf-8')
    }
    const skillMd = paths.agentSkillMd(this.agentId, name)
    if (!existsSync(skillMd)) return null
    const raw = await readFile(skillMd, 'utf-8')
    const { meta, body } = parseFrontmatter(raw)
    if (!meta.name || !meta.description) return null
    return {
      name: meta.name,
      description: meta.description,
      version: meta.version,
      tags: Array.isArray(meta.tags) ? meta.tags : undefined,
      related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
      created_at: meta.created_at,
      updated_at: meta.updated_at,
      path: paths.agentSkillDir(this.agentId, name),
      body,
      rawContent: raw,
    }
  }

  async save(meta: SkillFrontmatter, body: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(meta.name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!meta.description || meta.description.length > MAX_SKILL_DESCRIPTION_LENGTH) {
      return { ok: false, error: `description required, max ${MAX_SKILL_DESCRIPTION_LENGTH} chars` }
    }
    const skillDir = paths.agentSkillDir(this.agentId, meta.name)
    const skillMd = paths.agentSkillMd(this.agentId, meta.name)
    const now = new Date().toISOString()
    const isNew = !existsSync(skillMd)
    const mergedMeta: SkillFrontmatter = {
      ...meta,
      version: meta.version ?? '1.0.0',
      created_at: meta.created_at ?? (isNew ? now : undefined),
      updated_at: now,
    }
    await mkdir(skillDir, { recursive: true })
    const content = `${formatFrontmatter(mergedMeta)}\n\n${body.trim()}\n`
    await writeFile(skillMd, content)
    return { ok: true }
  }

  async delete(name: string): Promise<{ ok: boolean; error?: string }> {
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    const dir = paths.agentSkillDir(this.agentId, name)
    if (!existsSync(dir)) return { ok: false, error: 'skill not found' }
    await rm(dir, { recursive: true, force: true })
    return { ok: true }
  }
}
