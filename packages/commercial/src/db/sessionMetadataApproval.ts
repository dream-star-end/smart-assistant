/** PG-only display metadata; callers provide the same runner as their business/receipt transaction. */
import type { ClientSessionMetaPatch } from '@openclaude/storage'
import { query, type QueryRunner } from './queries.js'
export interface SessionMetadataSnapshot { id: string; title: string; pinned: boolean; updatedAt: number; version: string }
interface Row { id: string; title: string; pinned: number; updated_at: string; version: string }
export class SessionMetadataConflict extends Error { constructor() { super('SESSION_METADATA_CONFLICT'); this.name = 'SessionMetadataConflict' } }
function snapshot(row: Row): SessionMetadataSnapshot {
  const updatedAt = Number(row.updated_at)
  if (!Number.isSafeInteger(updatedAt) || updatedAt < 0) throw new Error('Invalid session metadata version')
  return { id: row.id, title: row.title, pinned: Number(row.pinned) === 1, updatedAt, version: row.version }
}
const fields = 'id,title,pinned,updated_at,xmin::text AS version'
export async function readSessionMetadata(owner: string, id: string, runner?: QueryRunner): Promise<SessionMetadataSnapshot | null> {
  const result = await query<Row>(`SELECT ${fields} FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [id, owner], runner)
  return result.rows[0] ? snapshot(result.rows[0]) : null
}
export type SessionMetadataPatchResult = { ok: true; updatedAt: number; version: string } | { ok: false; error: 'not_found' | 'project_not_found' }
/** All legacy fields still use one UPDATE and the caller's transaction; approval adapters accept only title/pinned. */
export async function patchSessionMetadataInTx(runner: QueryRunner, id: string, owner: string, patch: ClientSessionMetaPatch, expectedXmin?: string): Promise<SessionMetadataPatchResult> {
  const result = await query<Row>(`SELECT ${fields} FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, [id, owner], runner)
  const row = result.rows[0]
  if (!row) return { ok: false, error: 'not_found' }
  if (expectedXmin !== undefined && row.version !== expectedXmin) throw new SessionMetadataConflict()
  if (patch.projectId !== undefined && patch.projectId !== null) {
    const project = await query('SELECT 1 FROM chat_projects WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL', [patch.projectId, owner], runner)
    if (!project.rows[0]) return { ok: false, error: 'project_not_found' }
  }
  if (expectedXmin !== undefined && patch.modelId === undefined && patch.projectId === undefined && patch.archived === undefined && (patch.title === undefined || patch.title === row.title) && (patch.pinned === undefined || patch.pinned === (Number(row.pinned) === 1))) {
    return { ok: true, updatedAt: snapshot(row).updatedAt, version: row.version }
  }
  const sets = ['updated_at=GREATEST(updated_at+1,(floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::BIGINT)']
  const params: unknown[] = []
  const add = (column: 'title' | 'model_id' | 'project_id' | 'pinned' | 'archived_at', value: unknown) => { params.push(value); sets.push(`${column}=$${params.length}`) }
  if (patch.title !== undefined) add('title', patch.title)
  if (patch.modelId !== undefined) add('model_id', patch.modelId)
  if (patch.projectId !== undefined) add('project_id', patch.projectId)
  if (patch.pinned !== undefined) add('pinned', patch.pinned ? 1 : 0)
  if (patch.archived !== undefined) add('archived_at', patch.archived ? Date.now() : null)
  params.push(id, owner)
  const idParam = params.length - 1
  let cas = ''
  if (expectedXmin !== undefined) { params.push(expectedXmin); cas = ` AND xmin::text=$${params.length}` }
  const written = await query<Row>(`UPDATE client_sessions SET ${sets.join(',')} WHERE id=$${idParam} AND user_id=$${idParam + 1} AND deleted_at IS NULL${cas} RETURNING ${fields}`, params, runner)
  if (!written.rows[0]) { if (expectedXmin !== undefined) throw new SessionMetadataConflict(); return { ok: false, error: 'not_found' } }
  const fresh = snapshot(written.rows[0])
  return { ok: true, updatedAt: fresh.updatedAt, version: fresh.version }
}
