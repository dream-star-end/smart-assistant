#!/usr/bin/env tsx
/**
 * One-off migration for the project workspace (P2, M2–M5): make every live
 * project one object — a chat project with a work project behind it.
 *
 *   M2  live chat projects without a work project get a reserved board id
 *       (the container creates that board on first use; workspace stays the
 *       default one, so the agent's cwd does not change for these projects).
 *   M3  work projects (container taskboard) with no chat project get one,
 *       with the same name; archived boards become archived projects.
 *   M4  report only: per bound project, PROJECT.md is absent / empty / valid /
 *       hash-mismatched, and whether PG instructions differ. Nothing is
 *       written: the runtime only seeds a never-initialised, empty PROJECT.md
 *       and copies a mismatched one aside, so no instructions can be lost.
 *   M5  legacy orphan assets (project deleted before this release) → 未分类.
 *
 * Dry-run by default (JSON report). --apply runs M2/M3/M5 in one PG
 * transaction; it only fills NULL board ids, inserts new chat projects and
 * clears dangling asset project ids — nothing is deleted or overwritten.
 * Re-running is a no-op for anything already done.
 *
 * Usage (on the host; DATABASE_URL from the env file, never printed):
 *   DATABASE_URL=... npx tsx scripts/v5-selfhost-unify-projects.ts \
 *     --taskboard-db <snapshot of volume/taskboard.db> --volume-root <volume> \
 *     --tenant c:3 --report <file.json> [--apply]
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import pg from 'pg'

const PROJECT_INSTRUCTIONS_MAX = 4000

function arg(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function clip(raw: string): string {
  const t = raw
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/<!-- oc-project-instructions:(start|end) -->/g, '')
    .trim()
  return t.length > PROJECT_INSTRUCTIONS_MAX ? t.slice(0, PROJECT_INSTRUCTIONS_MAX) : t
}

function fileStatus(volumeRoot: string, boardId: string): { status: string; text: string | null } {
  const dir = join(volumeRoot, 'projects', boardId)
  let meta: { contentManifest?: { projectMdSha256?: string | null }; instructionsSha256?: string | null } = {}
  try {
    meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
  } catch {
    /* no meta yet */
  }
  let raw: string
  try {
    raw = readFileSync(join(dir, 'PROJECT.md'), 'utf8')
  } catch {
    return { status: 'absent', text: null }
  }
  const text = clip(raw)
  if (!text) return { status: 'empty', text: null }
  const expected = meta.contentManifest?.projectMdSha256 ?? meta.instructionsSha256 ?? null
  const sha = createHash('sha256').update(text, 'utf8').digest('hex')
  return { status: expected && sha === expected ? 'valid' : 'mismatch', text }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const taskboardDb = arg(argv, '--taskboard-db')
  const volumeRoot = arg(argv, '--volume-root')
  const tenant = arg(argv, '--tenant')
  const report = arg(argv, '--report')
  const apply = argv.includes('--apply')
  if (!taskboardDb || !volumeRoot || !tenant || !report) {
    throw new Error('required: --taskboard-db --volume-root --tenant --report')
  }
  if (!/^c:[0-9]+$/.test(tenant)) throw new Error('--tenant must look like c:<uid>')
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is required')

  const sqlite = new Database(taskboardDb, { readonly: true, fileMustExist: true })
  const boards = sqlite
    .prepare('SELECT id, key, name, archived_at FROM tb_project ORDER BY created_at')
    .all() as Array<{ id: string; key: string; name: string; archived_at: number | null }>
  sqlite.close()

  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    const projects = (
      await client.query(
        `SELECT id, name, instructions, board_project_id, is_research_default, deleted_at
           FROM chat_projects WHERE user_id = $1`,
        [tenant],
      )
    ).rows as Array<{
      id: string
      name: string
      instructions: string | null
      board_project_id: string | null
      is_research_default: boolean
      deleted_at: string | null
    }>
    const live = projects.filter((p) => p.deleted_at == null)
    const boundBoardIds = new Set(live.map((p) => p.board_project_id).filter((x): x is string => Boolean(x)))
    const anyBoardIds = new Set(projects.map((p) => p.board_project_id).filter((x): x is string => Boolean(x)))

    const m2 = live
      .filter((p) => !p.board_project_id && !p.is_research_default)
      .map((p) => ({ chatProjectId: p.id, name: p.name, reserveBoardId: randomUUID() }))
    // A board whose only chat project was deleted stays unclaimed on purpose
    // (the user deleted that project); only never-linked boards get a facade.
    const m3 = boards
      .filter((b) => !boundBoardIds.has(b.id) && !anyBoardIds.has(b.id))
      .map((b) => ({ boardProjectId: b.id, key: b.key, name: b.name, archived: b.archived_at != null, newChatProjectId: randomUUID() }))
    const m4 = live
      .filter((p) => p.board_project_id)
      .map((p) => {
        const f = fileStatus(volumeRoot, p.board_project_id as string)
        const pg = p.instructions ? clip(p.instructions) : ''
        return {
          chatProjectId: p.id,
          name: p.name,
          boardProjectId: p.board_project_id,
          projectMd: f.status,
          pgInstructions: pg ? 'present' : 'none',
          pgDiffersFromProjectMd: Boolean(pg && f.text !== null && pg !== f.text),
          // What the next turn will do under the B4 rule.
          nextTurn:
            f.status === 'valid'
              ? 'uses PROJECT.md'
              : f.status === 'mismatch'
                ? 'keeps file, copies it to PROJECT.conflict-*, injects no instructions until resolved'
                : pg
                  ? 'seeds PROJECT.md from PG once (if never initialised)'
                  : 'no instructions',
        }
      })
    const orphanRows = (
      await client.query(
        `SELECT a.id, a.project_id FROM project_assets a
           LEFT JOIN chat_projects p ON p.id = a.project_id AND p.user_id = a.user_id AND p.deleted_at IS NULL
          WHERE a.user_id = $1 AND a.deleted_at IS NULL AND a.project_id IS NOT NULL AND p.id IS NULL`,
        [tenant],
      )
    ).rows as Array<{ id: string; project_id: string }>

    let applied: { m2: number; m3: number; m5: number } | null = null
    if (apply) {
      await client.query('BEGIN')
      try {
        let a2 = 0
        for (const r of m2) {
          const res = await client.query(
            `UPDATE chat_projects SET board_project_id = $1, updated_at = GREATEST(updated_at + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
              WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL AND board_project_id IS NULL`,
            [r.reserveBoardId, r.chatProjectId, tenant],
          )
          a2 += res.rowCount ?? 0
        }
        let a3 = 0
        for (const r of m3) {
          const res = await client.query(
            `INSERT INTO chat_projects
               (id, user_id, name, instructions, color, sort_order, created_at, updated_at, deleted_at,
                is_research_default, board_project_id, archived_at)
             SELECT $1, $2, $3, NULL, NULL,
                    COALESCE((SELECT MAX(sort_order) + 1 FROM chat_projects WHERE user_id = $2 AND deleted_at IS NULL), 0),
                    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
                    (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint,
                    NULL, FALSE, $4,
                    CASE WHEN $5 THEN (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint ELSE NULL END
              WHERE NOT EXISTS (SELECT 1 FROM chat_projects WHERE user_id = $2 AND board_project_id = $4)`,
            [r.newChatProjectId, tenant, r.name.slice(0, 60), r.boardProjectId, r.archived],
          )
          a3 += res.rowCount ?? 0
        }
        const r5 = orphanRows.length
          ? await client.query(
              `UPDATE project_assets SET project_id = NULL, updated_at = GREATEST(updated_at + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint)
                WHERE user_id = $1 AND id = ANY($2::text[]) AND deleted_at IS NULL`,
              [tenant, orphanRows.map((r) => r.id)],
            )
          : { rowCount: 0 }
        await client.query('COMMIT')
        applied = { m2: a2, m3: a3, m5: r5.rowCount ?? 0 }
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }

    const out = {
      mode: apply ? 'apply' : 'dry-run',
      at: new Date().toISOString(),
      tenant,
      counts: {
        liveChatProjects: live.length,
        boards: boards.length,
        m2ReserveBoard: m2.length,
        m3CreateChatProject: m3.length,
        m4BoundProjects: m4.length,
        m4Mismatch: m4.filter((x) => x.projectMd === 'mismatch').length,
        m5OrphanAssets: orphanRows.length,
      },
      applied,
      m2,
      m3,
      m4,
      m5: orphanRows,
      reversal: {
        m2: 'UPDATE chat_projects SET board_project_id = NULL WHERE user_id = <tenant> AND id = ANY(<m2 chatProjectIds>) AND board_project_id = ANY(<m2 reserveBoardIds>)',
        m3: 'UPDATE chat_projects SET deleted_at = <now> WHERE user_id = <tenant> AND id = ANY(<m3 newChatProjectIds>)',
        m5: 'restore project_id from the pre-run pg_dump of project_assets',
      },
    }
    writeFileSync(report, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify({ mode: out.mode, counts: out.counts, applied }))
  } finally {
    await client.end()
  }
}

main().catch((err) => {
  console.error(`[unify-projects] ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
