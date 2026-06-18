// SkillDraftStore — staging area for skill-training candidates (SkillOpt feature).
//
// A "draft" is a proposed change to ONE skill, produced by a training run, an AI
// revision (in response to a user comment), or a manual user edit. It is staged
// under ~/.openclaude/skill-drafts/<runId>/<skill-name>/ and is the single artifact
// that the diff / confirm / comment-iterate / manual-edit UX all operate on:
//
//   old side of the diff  = the current AUTHORITATIVE skill (SkillStore.view)
//   new side of the diff  = this draft
//   merge                 = an explicit SkillStore.save()/delete() at the gateway
//
// The draft layer NEVER writes to the authoritative library. That decoupling is the
// whole point: training/iteration can churn freely here while the live skill is
// untouched until the user confirms. Discard = delete the run dir (no-op on live).
//
// Serialization is deliberately reused from SkillStore (parseFrontmatter /
// formatFrontmatter / validateSkillName) so there is exactly one SKILL.md format —
// a promoted draft is byte-compatible with what SkillStore.save() expects.
//
// Layout:
//   ~/.openclaude/skill-drafts/<runId>/
//     <skill-name>/
//       SKILL.md     — candidate frontmatter + body (absent for op='delete')
//       draft.json   — SkillDraftRecord metadata (op, baseVersion, rationale, ...)

import { randomUUID } from 'node:crypto'
import { type Dirent, existsSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { paths } from './paths.js'
import {
  type SkillFrontmatter,
  formatFrontmatter,
  parseFrontmatter,
  validateSkillName,
} from './skillStore.js'

const VALID_RUN_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/

/** What a draft proposes against the authoritative library. */
export type SkillDraftOp = 'create' | 'update' | 'delete'

/** Who authored the current draft content (for audit / UI badge). */
export type SkillDraftAuthor = 'ai' | 'user'

/** Sidecar metadata persisted next to each draft's SKILL.md (draft.json). */
export interface SkillDraftRecord {
  runId: string
  name: string
  op: SkillDraftOp
  /** Authoritative version this draft was derived from (diff "old" side); null for a brand-new skill. */
  baseVersion: string | null
  /** Why this change — training evidence, or a user's comment note. */
  rationale: string
  authoredBy: SkillDraftAuthor
  createdAt: string
  updatedAt: string
}

/** Full draft content + its sidecar record. */
export interface SkillDraftContent {
  /** Candidate frontmatter (create/update). For op='delete' only `name` is meaningful. */
  meta: SkillFrontmatter
  /** Candidate markdown body (empty for op='delete'). */
  body: string
  /** Full candidate SKILL.md as it would be written (empty for op='delete'). */
  rawContent: string
  record: SkillDraftRecord
}

/** Lightweight per-draft summary for listing a run's drafts. */
export interface SkillDraftSummary {
  name: string
  op: SkillDraftOp
  baseVersion: string | null
  rationale: string
  authoredBy: SkillDraftAuthor
  updatedAt: string
}

export interface WriteSkillDraftInput {
  runId: string
  meta: SkillFrontmatter
  body: string
  op?: SkillDraftOp
  rationale?: string
  authoredBy?: SkillDraftAuthor
  /**
   * Authoritative version this draft is derived from (diff "old" side). Set on the
   * first write of a run; omit on re-writes to preserve the prior value. `null` marks
   * a brand-new skill with no authoritative base.
   */
  baseVersion?: string | null
}

/**
 * Validate + lexically resolve the drafts root once. It need not exist yet (created
 * safely on first write); on every write/delete we re-verify containment via realpath
 * so a symlinked path can never widen the write surface beyond HOME.
 */
function resolveDraftsRoot(): string {
  const root = paths.skillDraftsDir
  const resolved = existsSync(root) ? realpathSync(root) : resolve(root)
  const homeResolved = existsSync(paths.home) ? realpathSync(paths.home) : resolve(paths.home)
  if (resolved !== homeResolved && !resolved.startsWith(homeResolved + sep)) {
    throw new Error(`skillDraftsDir must resolve within home (${paths.home})`)
  }
  return resolved
}

export class SkillDraftStore {
  /** Lexically/realpath-resolved drafts root (contained within HOME). */
  private readonly root: string

  constructor() {
    this.root = resolveDraftsRoot()
  }

  /** Per-run directory (validated runId). */
  private runDir(runId: string): string {
    if (!VALID_RUN_ID_RE.test(runId)) throw new Error(`invalid runId: ${runId}`)
    return join(this.root, runId)
  }

  /**
   * Stage (create or overwrite) a draft for one skill within a run. Idempotent per
   * (runId, name): re-writing updates the candidate and bumps updatedAt while
   * preserving the original createdAt. Returns {ok,error} mirroring SkillStore.save.
   */
  async writeDraft(input: WriteSkillDraftInput): Promise<{ ok: boolean; error?: string }> {
    const op: SkillDraftOp = input.op ?? 'update'
    const name = input.meta?.name ?? ''
    const v = validateSkillName(name)
    if (!v.ok) return { ok: false, error: v.error }
    if (!VALID_RUN_ID_RE.test(input.runId)) return { ok: false, error: 'invalid runId' }
    if (op !== 'delete') {
      if (!input.meta.description || input.meta.description.length > 1024) {
        return { ok: false, error: 'description required, max 1024 chars' }
      }
    }

    const skillDir = join(this.runDir(input.runId), name)
    await mkdir(skillDir, { recursive: true })
    // Re-verify the staged dir stays within the drafts root (guards symlinked dirs).
    const realDir = await realpath(skillDir)
    if (!realDir.startsWith(this.root + sep)) {
      return { ok: false, error: 'draft directory resolves outside drafts root' }
    }

    // Preserve original createdAt across re-writes.
    const now = new Date().toISOString()
    const existing = await this.readRecord(input.runId, name)
    const record: SkillDraftRecord = {
      runId: input.runId,
      name,
      op,
      baseVersion: existing?.baseVersion ?? null,
      rationale: input.rationale ?? existing?.rationale ?? '',
      authoredBy: input.authoredBy ?? 'ai',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    // Caller may pin the authoritative base version on the first write; re-writes
    // omit it and inherit the prior value (preserved via `existing` above).
    if (typeof input.baseVersion !== 'undefined') {
      record.baseVersion = input.baseVersion ?? null
    }

    if (op === 'delete') {
      // A delete proposal carries no SKILL.md; remove any prior candidate body.
      await this.atomicWrite(join(realDir, 'draft.json'), `${JSON.stringify(record, null, 2)}\n`)
      await rm(join(realDir, 'SKILL.md'), { force: true }).catch(() => {})
      return { ok: true }
    }

    const content = `${formatFrontmatter(input.meta)}\n\n${input.body.trim()}\n`
    await this.atomicWrite(join(realDir, 'SKILL.md'), content)
    await this.atomicWrite(join(realDir, 'draft.json'), `${JSON.stringify(record, null, 2)}\n`)
    return { ok: true }
  }

  /** Set the authoritative base version a draft is diffed against. */
  async setBaseVersion(runId: string, name: string, baseVersion: string | null): Promise<void> {
    const record = await this.readRecord(runId, name)
    if (!record) return
    record.baseVersion = baseVersion
    record.updatedAt = new Date().toISOString()
    const realDir = await realpath(join(this.runDir(runId), name))
    if (!realDir.startsWith(this.root + sep)) return
    await this.atomicWrite(join(realDir, 'draft.json'), `${JSON.stringify(record, null, 2)}\n`)
  }

  /** Read one draft's full content + record, or null if absent. */
  async readDraft(runId: string, name: string): Promise<SkillDraftContent | null> {
    if (!validateSkillName(name).ok) return null
    const record = await this.readRecord(runId, name)
    if (!record) return null
    if (record.op === 'delete') {
      return {
        meta: { name, description: '' },
        body: '',
        rawContent: '',
        record,
      }
    }
    const raw = await this.safeRead(join(this.runDir(runId), name, 'SKILL.md'))
    if (!raw) return null
    const { meta, body } = parseFrontmatter(raw)
    if (!meta.name || !meta.description) return null
    return {
      meta: {
        name: meta.name,
        description: meta.description,
        version: meta.version,
        tags: Array.isArray(meta.tags) ? meta.tags : undefined,
        related_skills: Array.isArray(meta.related_skills) ? meta.related_skills : undefined,
        created_at: meta.created_at,
        updated_at: meta.updated_at,
      },
      body,
      rawContent: raw,
      record,
    }
  }

  /** List all drafts staged for a run (summaries only). */
  async listDrafts(runId: string): Promise<SkillDraftSummary[]> {
    if (!VALID_RUN_ID_RE.test(runId)) return []
    const dir = join(this.root, runId)
    if (!existsSync(dir)) return []
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const out: SkillDraftSummary[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!validateSkillName(entry.name).ok) continue
      const record = await this.readRecord(runId, entry.name)
      if (!record) continue
      out.push({
        name: record.name,
        op: record.op,
        baseVersion: record.baseVersion,
        rationale: record.rationale,
        authoredBy: record.authoredBy,
        updatedAt: record.updatedAt,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Discard a single draft within a run. */
  async deleteDraft(runId: string, name: string): Promise<{ ok: boolean }> {
    if (!VALID_RUN_ID_RE.test(runId) || !validateSkillName(name).ok) return { ok: false }
    const dir = join(this.root, runId, name)
    if (!existsSync(dir)) return { ok: true }
    const realDir = await realpath(dir)
    if (!realDir.startsWith(this.root + sep)) return { ok: false }
    await rm(realDir, { recursive: true, force: true })
    return { ok: true }
  }

  /** Discard an entire run's drafts (zero effect on the authoritative library). */
  async deleteRun(runId: string): Promise<{ ok: boolean }> {
    if (!VALID_RUN_ID_RE.test(runId)) return { ok: false }
    const dir = join(this.root, runId)
    if (!existsSync(dir)) return { ok: true }
    const realDir = await realpath(dir)
    if (!realDir.startsWith(this.root + sep)) return { ok: false }
    await rm(realDir, { recursive: true, force: true })
    return { ok: true }
  }

  private async readRecord(runId: string, name: string): Promise<SkillDraftRecord | null> {
    const raw = await this.safeRead(join(this.runDir(runId), name, 'draft.json'))
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as SkillDraftRecord
      if (parsed && typeof parsed.name === 'string' && typeof parsed.op === 'string') return parsed
    } catch {}
    return null
  }

  /** Read a file iff it is a regular file contained within the drafts root. */
  private async safeRead(filePath: string): Promise<string | null> {
    if (!existsSync(filePath)) return null
    const st = await lstat(filePath)
    if (!st.isFile()) return null
    const realFile = await realpath(filePath)
    if (!realFile.startsWith(this.root + sep)) return null
    return await readFile(realFile, 'utf-8')
  }

  /** Atomic write via sibling temp + rename; rejects a symlinked target. */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    if (existsSync(filePath)) {
      const st = await lstat(filePath)
      if (st.isSymbolicLink()) throw new Error(`refusing to write through symlink: ${filePath}`)
    }
    const dir = filePath.slice(0, filePath.lastIndexOf(sep))
    if (!isAbsolute(filePath)) throw new Error(`draft write path must be absolute: ${filePath}`)
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, content)
      await rename(tmp, filePath)
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
}
