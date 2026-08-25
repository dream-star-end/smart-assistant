/**
 * Gateway-owned project memory promotion ledger.
 *
 * Files under ~/.openclaude/projects/<id>/{memory,memory-candidates} are
 * content carriers. Injection and project-search only accept rows in this
 * SQLite ledger whose content hash still matches the file. HMAC keys never
 * leave the gateway process — this table lives in taskboard.db, not in the
 * project data directory, and is never passed to model children.
 *
 * Candidates are no longer a human approval queue: createCandidate promotes
 * immediately (actor AUTO_PROMOTE_ACTOR) so a memory reaches injection without
 * a user round-trip. What the two stages still buy us is the audit trail —
 * create_candidate and promote stay separate events, the candidate file keeps
 * the pre-promotion bytes, and deprecate remains the user's undo.
 */

import { randomUUID } from 'node:crypto'
import { MEMORY_FILE_RE } from './memoryFrontmatter.js'
import { BOARD_PROJECT_ID_RE, incrementProjectContextVersion } from './projectContext.js'
import { planCandidateFileName, ProjectMemoryDir, sha256Hex } from './projectMemoryDir.js'

export const PROJECT_MEMORY_LEDGER_SCHEMA_VERSION = 1

/** Promote actor written by the automatic path, so audits can tell it from a user. */
export const AUTO_PROMOTE_ACTOR = 'auto-promote'

export const PROJECT_MEMORY_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS tb_project_memory_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  action TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  actor TEXT NOT NULL,
  source_agent TEXT,
  source_session TEXT,
  source_ticket TEXT,
  supersedes TEXT,
  expires TEXT,
  idempotency_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tb_pmem_event_project
  ON tb_project_memory_event(project_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tb_pmem_event_idem
  ON tb_project_memory_event(project_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS tb_project_memory_candidate (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  file TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  source_agent TEXT,
  source_session TEXT,
  source_ticket TEXT,
  supersedes TEXT,
  expires TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tb_pmem_cand_project
  ON tb_project_memory_candidate(project_id, status, slug);

CREATE TABLE IF NOT EXISTS tb_project_memory_official (
  project_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  file TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  event_id TEXT NOT NULL,
  expires TEXT,
  deprecated INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT,
  source_agent TEXT,
  source_session TEXT,
  source_ticket TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, slug)
);
`

export interface SqlStatement {
  get(...params: unknown[]): unknown
  all(...params: unknown[]): unknown[]
  run(...params: unknown[]): { changes: number }
}

export interface SqlDb {
  exec(sql: string): unknown
  prepare(sql: string): SqlStatement
  transaction<T>(fn: () => T): () => T
}

export type CandidateStatus = 'pending' | 'conflict' | 'rejected' | 'promoted'
export type LedgerAction = 'create_candidate' | 'promote' | 'reject' | 'deprecate' | 'conflict'

export interface ProjectMemoryCandidateRow {
  id: string
  projectId: string
  slug: string
  file: string
  contentSha256: string
  status: CandidateStatus
  version: number
  sourceAgent: string | null
  sourceSession: string | null
  sourceTicket: string | null
  supersedes: string | null
  expires: string | null
  createdAt: number
  updatedAt: number
}

export interface ProjectMemoryOfficialRow {
  projectId: string
  slug: string
  contentSha256: string
  file: string
  version: number
  eventId: string
  expires: string | null
  deprecated: boolean
  supersedes: string | null
  sourceAgent: string | null
  sourceSession: string | null
  sourceTicket: string | null
  updatedAt: number
}

export interface CreateCandidateInput {
  projectId: string
  slug: string
  content: string
  actor: string
  auto?: boolean
  today?: string
  sourceAgent?: string | null
  sourceSession?: string | null
  sourceTicket?: string | null
  supersedes?: string | null
  idempotencyKey?: string | null
}

export type CreateCandidateResult =
  | {
      ok: true
      candidate: ProjectMemoryCandidateRow
      idempotent?: boolean
      alreadyOfficial?: boolean
      /** Official row the candidate became (null only when auto-promotion was skipped). */
      official?: ProjectMemoryOfficialRow | null
      autoPromoted?: boolean
    }
  | { ok: false; error: 'invalid' | 'forbidden' | 'scan_rejected' | 'invalid_id'; detail: string }

export type PromoteResult =
  | { ok: true; official: ProjectMemoryOfficialRow; idempotent?: boolean }
  | {
      ok: false
      error: 'not_found' | 'version_conflict' | 'hash_mismatch' | 'already_official' | 'not_pending'
      current?: number
    }

function assertBoardId(id: string): string {
  const trimmed = id.trim().toLowerCase()
  if (!BOARD_PROJECT_ID_RE.test(trimmed)) throw new Error(`invalid boardProjectId: ${id}`)
  return trimmed
}

function mapCandidate(row: Record<string, unknown>): ProjectMemoryCandidateRow {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    slug: String(row.slug),
    file: String(row.file),
    contentSha256: String(row.content_sha256),
    status: row.status as CandidateStatus,
    version: Number(row.version),
    sourceAgent: (row.source_agent as string) ?? null,
    sourceSession: (row.source_session as string) ?? null,
    sourceTicket: (row.source_ticket as string) ?? null,
    supersedes: (row.supersedes as string) ?? null,
    expires: (row.expires as string) ?? null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

function mapOfficial(row: Record<string, unknown>): ProjectMemoryOfficialRow {
  return {
    projectId: String(row.project_id),
    slug: String(row.slug),
    contentSha256: String(row.content_sha256),
    file: String(row.file),
    version: Number(row.version),
    eventId: String(row.event_id),
    expires: (row.expires as string) ?? null,
    deprecated: Number(row.deprecated) === 1,
    supersedes: (row.supersedes as string) ?? null,
    sourceAgent: (row.source_agent as string) ?? null,
    sourceSession: (row.source_session as string) ?? null,
    sourceTicket: (row.source_ticket as string) ?? null,
    updatedAt: Number(row.updated_at),
  }
}

export function ensureProjectMemoryLedger(db: SqlDb): void {
  db.exec(PROJECT_MEMORY_LEDGER_DDL)
}

export function officialManifestSha256(rows: readonly ProjectMemoryOfficialRow[]): string {
  const lines = rows
    .filter((r) => !r.deprecated)
    .slice()
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((r) => `${r.slug}:${r.contentSha256}`)
  return sha256Hex(lines.join('\n'))
}

export class ProjectMemoryLedger {
  constructor(private readonly db: SqlDb) {}

  listCandidates(
    projectId: string,
    status?: CandidateStatus | CandidateStatus[],
  ): ProjectMemoryCandidateRow[] {
    const id = assertBoardId(projectId)
    const rows = this.db
      .prepare(
        `SELECT * FROM tb_project_memory_candidate WHERE project_id = ? ORDER BY created_at DESC`,
      )
      .all(id) as Record<string, unknown>[]
    const mapped = rows.map(mapCandidate)
    if (!status) return mapped
    const set = new Set(Array.isArray(status) ? status : [status])
    return mapped.filter((r) => set.has(r.status))
  }

  listOfficial(
    projectId: string,
    opts: { includeDeprecated?: boolean } = {},
  ): ProjectMemoryOfficialRow[] {
    const id = assertBoardId(projectId)
    const rows = this.db
      .prepare(
        `SELECT * FROM tb_project_memory_official WHERE project_id = ? ORDER BY slug`,
      )
      .all(id) as Record<string, unknown>[]
    const mapped = rows.map(mapOfficial)
    return opts.includeDeprecated ? mapped : mapped.filter((r) => !r.deprecated)
  }

  getCandidate(projectId: string, candidateId: string): ProjectMemoryCandidateRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tb_project_memory_candidate WHERE project_id = ? AND id = ?`)
      .get(assertBoardId(projectId), candidateId) as Record<string, unknown> | undefined
    return row ? mapCandidate(row) : null
  }

  getCandidateByFile(projectId: string, file: string): ProjectMemoryCandidateRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tb_project_memory_candidate WHERE project_id = ? AND file = ?`)
      .get(assertBoardId(projectId), file) as Record<string, unknown> | undefined
    return row ? mapCandidate(row) : null
  }

  getOfficial(projectId: string, slug: string): ProjectMemoryOfficialRow | null {
    const row = this.db
      .prepare(`SELECT * FROM tb_project_memory_official WHERE project_id = ? AND slug = ?`)
      .get(assertBoardId(projectId), slug) as Record<string, unknown> | undefined
    return row ? mapOfficial(row) : null
  }

  async createCandidate(input: CreateCandidateInput): Promise<CreateCandidateResult> {
    if (!BOARD_PROJECT_ID_RE.test(input.projectId.trim())) {
      return { ok: false, error: 'invalid_id', detail: input.projectId }
    }
    const projectId = assertBoardId(input.projectId)
    const slug = input.slug.trim()
    if (!MEMORY_FILE_RE.test(slug) || slug.toLowerCase() === 'project.md') {
      return { ok: false, error: 'invalid', detail: slug }
    }
    if (input.idempotencyKey) {
      const existingEvent = this.db
        .prepare(
          `SELECT id FROM tb_project_memory_event WHERE project_id = ? AND idempotency_key = ?`,
        )
        .get(projectId, input.idempotencyKey) as { id: string } | undefined
      if (existingEvent) {
        const existing = this.db
          .prepare(
            `SELECT * FROM tb_project_memory_candidate WHERE project_id = ? AND slug = ? ORDER BY created_at DESC`,
          )
          .get(projectId, slug) as Record<string, unknown> | undefined
        if (existing) return await this.settleCreated(projectId, mapCandidate(existing), true)
      }
    }

    const dir = new ProjectMemoryDir(projectId)
    const official = this.getOfficial(projectId, slug)
    const pending = this.listCandidates(projectId).filter(
      (c) => c.slug === slug && (c.status === 'pending' || c.status === 'conflict'),
    )
    const prepared = dir.prepareCandidateBody(slug, input.content, {
      auto: input.auto,
      today: input.today,
    })
    if (!prepared.ok) return prepared

    if (official && official.contentSha256 === prepared.sha256 && !official.deprecated) {
      return {
        ok: true,
        alreadyOfficial: true,
        official,
        autoPromoted: false,
        candidate: {
          id: 'already-official',
          projectId,
          slug,
          file: official.slug,
          contentSha256: prepared.sha256,
          status: 'promoted',
          version: official.version,
          sourceAgent: input.sourceAgent ?? null,
          sourceSession: input.sourceSession ?? null,
          sourceTicket: input.sourceTicket ?? null,
          supersedes: input.supersedes ?? null,
          expires: official.expires,
          createdAt: official.updatedAt,
          updatedAt: official.updatedAt,
        },
        idempotent: true,
      }
    }

    const hashTaken = pending.find((c) => c.contentSha256 === prepared.sha256)
    if (hashTaken) {
      return await this.settleCreated(projectId, hashTaken, true)
    }

    const conflictWithPending = pending.some((c) => c.contentSha256 !== prepared.sha256)
    const conflictWithOfficial = Boolean(official && official.contentSha256 !== prepared.sha256 && !official.deprecated)
    const conflict = conflictWithPending || conflictWithOfficial

    const now = Date.now()
    const id = randomUUID()
    const hashedName = `${slug.replace(/\.md$/i, '').slice(0, 40)}--${prepared.sha256.slice(0, 16)}.md`
    const existingMatch = dir.candidateFileExists(hashedName)
      ? Boolean(await dir.readCandidate(hashedName, prepared.sha256))
      : false
    const file = planCandidateFileName({
      slug,
      contentSha256: prepared.sha256,
      fileExists: (f) => dir.candidateFileExists(f),
      existingMatchesHash: (f) =>
        f === hashedName &&
        existingMatch &&
        pending.some((c) => c.contentSha256 === prepared.sha256),
      fallbackId: id,
    })
    const written = await dir.writeCandidate(slug, input.content, {
      auto: input.auto,
      today: input.today,
      file,
      stored: prepared.stored,
      exclusive: true,
    })
    if (!written.ok) {
      if (written.error === 'exists') {
        const same = await dir.readCandidate(file, prepared.sha256)
        if (same) {
          const listed = pending.find((c) => c.contentSha256 === prepared.sha256)
          if (listed) return await this.settleCreated(projectId, listed, true)
        }
        return { ok: false, error: 'invalid', detail: written.detail }
      }
      return { ok: false, error: written.error, detail: written.detail }
    }
    const status: CandidateStatus = conflict ? 'conflict' : 'pending'
    const parsed = await dir.readCandidate(written.file, written.sha256)
    const expires = parsed?.expires ?? null

    const apply = this.db.transaction(() => {
      if (conflictWithPending) {
        this.db
          .prepare(
            `UPDATE tb_project_memory_candidate SET status = 'conflict', updated_at = ?
             WHERE project_id = ? AND slug = ? AND status IN ('pending','conflict')`,
          )
          .run(now, projectId, slug)
      }
      this.db
        .prepare(
          `INSERT INTO tb_project_memory_candidate (
            id, project_id, slug, file, content_sha256, status, version,
            source_agent, source_session, source_ticket, supersedes, expires,
            created_at, updated_at
          ) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          projectId,
          slug,
          written.file,
          written.sha256,
          status,
          input.sourceAgent ?? null,
          input.sourceSession ?? null,
          input.sourceTicket ?? null,
          input.supersedes ?? null,
          expires,
          now,
          now,
        )
      const insertEvent = (action: LedgerAction, idempotencyKey: string | null) => {
        this.db
          .prepare(
            `INSERT INTO tb_project_memory_event (
              id, project_id, slug, action, content_sha256, actor,
              source_agent, source_session, source_ticket, supersedes, expires,
              idempotency_key, created_at
            ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            projectId,
            slug,
            action,
            written.sha256,
            input.actor,
            input.sourceAgent ?? null,
            input.sourceSession ?? null,
            input.sourceTicket ?? null,
            input.supersedes ?? null,
            expires,
            idempotencyKey,
            now,
          )
      }
      insertEvent('create_candidate', input.idempotencyKey ?? null)
      // Colliding content no longer parks the write: the conflict is only worth an
      // audit row, because auto-promotion below lets the newest content win.
      if (conflict) insertEvent('conflict', null)
    })
    apply()
    const row = this.getCandidate(projectId, id)
    if (!row) throw new Error('candidate insert vanished')
    return await this.settleCreated(projectId, row)
  }

  /**
   * Auto-promotion, applied to every candidate the ledger hands back.
   *
   * Promotion is the existing CAS path, so same-slug rewrites keep their version
   * chain and supersedes semantics, and a replay lands on promote's idempotent
   * branch. The one case we refuse to decide automatically is content the user
   * deprecated: resurrecting exactly those bytes would make the undo button a
   * no-op, so the candidate stays pending for a manual call.
   */
  private async settleCreated(
    projectId: string,
    candidate: ProjectMemoryCandidateRow,
    idempotent = false,
  ): Promise<CreateCandidateResult> {
    let official: ProjectMemoryOfficialRow | null = null
    if (candidate.status !== 'rejected') {
      const current = this.getOfficial(projectId, candidate.slug)
      if (!(current?.deprecated && current.contentSha256 === candidate.contentSha256)) {
        const promoted = await this.promote({
          projectId,
          candidateId: candidate.id,
          expectedVersion: candidate.version,
          actor: AUTO_PROMOTE_ACTOR,
        })
        if (promoted.ok) official = promoted.official
      }
    }
    const row = this.getCandidate(projectId, candidate.id) ?? candidate
    return {
      ok: true,
      candidate: row,
      official,
      autoPromoted: official !== null,
      ...(idempotent ? { idempotent: true } : {}),
    }
  }

  async promote(opts: {
    projectId: string
    candidateId: string
    expectedVersion: number
    actor: string
  }): Promise<PromoteResult> {
    const projectId = assertBoardId(opts.projectId)
    const candidate = this.getCandidate(projectId, opts.candidateId)
    if (!candidate) return { ok: false, error: 'not_found' }
    if (candidate.status === 'promoted') {
      const official = this.getOfficial(projectId, candidate.slug)
      if (official) return { ok: true, official, idempotent: true }
      return { ok: false, error: 'not_pending' }
    }
    if (candidate.status === 'rejected') {
      return { ok: false, error: 'not_pending' }
    }
    if (candidate.version !== opts.expectedVersion) {
      return { ok: false, error: 'version_conflict', current: candidate.version }
    }
    const existing = this.getOfficial(projectId, candidate.slug)
    if (existing && existing.contentSha256 === candidate.contentSha256 && !existing.deprecated) {
      this.db
        .prepare(
          `UPDATE tb_project_memory_candidate SET status = 'promoted', updated_at = ? WHERE id = ?`,
        )
        .run(Date.now(), candidate.id)
      return { ok: true, official: existing, idempotent: true }
    }
    const dir = new ProjectMemoryDir(projectId)
    const copied = await dir.copyCandidateToOfficial(
      candidate.file,
      candidate.slug,
      candidate.contentSha256,
    )
    if (!copied.ok) return { ok: false, error: copied.error === 'missing' ? 'not_found' : 'hash_mismatch' }
    const now = Date.now()
    const eventId = randomUUID()
    const nextVersion = existing ? existing.version + 1 : 1
    const apply = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO tb_project_memory_official (
            project_id, slug, content_sha256, file, version, event_id, expires,
            deprecated, supersedes, source_agent, source_session, source_ticket, updated_at
          ) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,?)
          ON CONFLICT(project_id, slug) DO UPDATE SET
            content_sha256 = excluded.content_sha256,
            file = excluded.file,
            version = excluded.version,
            event_id = excluded.event_id,
            expires = excluded.expires,
            deprecated = 0,
            supersedes = excluded.supersedes,
            source_agent = excluded.source_agent,
            source_session = excluded.source_session,
            source_ticket = excluded.source_ticket,
            updated_at = excluded.updated_at`,
        )
        .run(
          projectId,
          candidate.slug,
          copied.sha256,
          candidate.slug,
          nextVersion,
          eventId,
          candidate.expires,
          candidate.supersedes,
          candidate.sourceAgent,
          candidate.sourceSession,
          candidate.sourceTicket,
          now,
        )
      this.db
        .prepare(
          `UPDATE tb_project_memory_candidate SET status = 'promoted', updated_at = ? WHERE id = ?`,
        )
        .run(now, candidate.id)
      this.db
        .prepare(
          `INSERT INTO tb_project_memory_event (
            id, project_id, slug, action, content_sha256, actor,
            source_agent, source_session, source_ticket, supersedes, expires,
            idempotency_key, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          eventId,
          projectId,
          candidate.slug,
          'promote',
          copied.sha256,
          opts.actor,
          candidate.sourceAgent,
          candidate.sourceSession,
          candidate.sourceTicket,
          candidate.supersedes,
          candidate.expires,
          `promote:${candidate.id}:${copied.sha256}`,
          now,
        )
    })
    apply()
    bumpProjectContextVersion(this.db, projectId, now)
    await incrementProjectContextVersion(projectId).catch(() => {})
    const official = this.getOfficial(projectId, candidate.slug)
    if (!official) throw new Error('official upsert vanished')
    return { ok: true, official }
  }

  reject(opts: {
    projectId: string
    candidateId: string
    expectedVersion: number
    actor: string
  }):
    | { ok: true; candidate: ProjectMemoryCandidateRow; idempotent?: boolean }
    | { ok: false; error: 'not_found' | 'version_conflict' | 'not_pending'; current?: number } {
    const projectId = assertBoardId(opts.projectId)
    const candidate = this.getCandidate(projectId, opts.candidateId)
    if (!candidate) return { ok: false, error: 'not_found' }
    if (candidate.status === 'rejected') return { ok: true, candidate, idempotent: true }
    if (candidate.version !== opts.expectedVersion) {
      return { ok: false, error: 'version_conflict', current: candidate.version }
    }
    if (candidate.status === 'promoted') return { ok: false, error: 'not_pending' }
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE tb_project_memory_candidate SET status = 'rejected', version = version + 1, updated_at = ? WHERE id = ?`,
      )
      .run(now, candidate.id)
    this.db
      .prepare(
        `INSERT INTO tb_project_memory_event (
          id, project_id, slug, action, content_sha256, actor,
          source_agent, source_session, source_ticket, supersedes, expires,
          idempotency_key, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        projectId,
        candidate.slug,
        'reject',
        candidate.contentSha256,
        opts.actor,
        candidate.sourceAgent,
        candidate.sourceSession,
        candidate.sourceTicket,
        candidate.supersedes,
        candidate.expires,
        `reject:${candidate.id}`,
        now,
      )
    return { ok: true, candidate: this.getCandidate(projectId, candidate.id)! }
  }

  deprecate(opts: {
    projectId: string
    slug: string
    expectedVersion: number
    actor: string
  }):
    | { ok: true; official: ProjectMemoryOfficialRow; idempotent?: boolean }
    | { ok: false; error: 'not_found' | 'version_conflict'; current?: number } {
    const projectId = assertBoardId(opts.projectId)
    const official = this.getOfficial(projectId, opts.slug)
    if (!official) return { ok: false, error: 'not_found' }
    if (official.deprecated) return { ok: true, official, idempotent: true }
    if (official.version !== opts.expectedVersion) {
      return { ok: false, error: 'version_conflict', current: official.version }
    }
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE tb_project_memory_official SET deprecated = 1, version = version + 1, updated_at = ? WHERE project_id = ? AND slug = ?`,
      )
      .run(now, projectId, opts.slug)
    this.db
      .prepare(
        `INSERT INTO tb_project_memory_event (
          id, project_id, slug, action, content_sha256, actor,
          source_agent, source_session, source_ticket, supersedes, expires,
          idempotency_key, created_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        projectId,
        opts.slug,
        'deprecate',
        official.contentSha256,
        opts.actor,
        official.sourceAgent,
        official.sourceSession,
        official.sourceTicket,
        official.supersedes,
        official.expires,
        `deprecate:${opts.slug}:${official.version}`,
        now,
      )
    bumpProjectContextVersion(this.db, projectId, now)
    void incrementProjectContextVersion(projectId).catch(() => {})
    return { ok: true, official: this.getOfficial(projectId, opts.slug)! }
  }
}

function bumpProjectContextVersion(db: SqlDb, projectId: string, now: number): void {
  try {
    db.prepare(
      `UPDATE tb_project SET context_version = context_version + 1, updated_at = ? WHERE id = ?`,
    ).run(now, projectId)
  } catch {
    /* ledger-only tests / personal sqlite without the column */
  }
}

