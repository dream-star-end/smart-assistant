import { createHash } from 'node:crypto'
import { query, tx, type QueryRunner } from '../db/queries.js'
import type { PublicSnapshotManifest, TutorialBlobDraft } from './snapshotSanitizer.js'

export async function upsertTutorialBlobs(
  blobs: readonly TutorialBlobDraft[],
  runner: QueryRunner,
): Promise<void> {
  for (const blob of blobs) {
    await query(
      `INSERT INTO tutorial_blobs (sha256, kind, mime, bytes, body)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (sha256) DO NOTHING`,
      [blob.sha256, blob.kind, blob.mime, blob.bytes, blob.body],
      runner,
    )
  }
}

export async function replaceTutorialBlobRefs(
  publicationId: string,
  blobs: readonly TutorialBlobDraft[],
  runner: QueryRunner,
): Promise<void> {
  await query('DELETE FROM tutorial_blob_refs WHERE publication_id = $1::bigint', [publicationId], runner)
  for (const blob of blobs) {
    await query(
      `INSERT INTO tutorial_blob_refs (publication_id, sha256, role)
       VALUES ($1::bigint, $2, $3)`,
      [publicationId, blob.sha256, blob.role],
      runner,
    )
  }
}

export type PublicTutorialBlob = {
  sha256: string
  kind: string
  mime: string
  bytes: number
  body: Buffer
  role: string
}

export async function getApprovedTutorialBlob(
  sha256: string,
  runner?: QueryRunner,
): Promise<PublicTutorialBlob | null> {
  if (!/^[a-f0-9]{64}$/.test(sha256)) return null
  const result = await query<{
    sha256: string
    kind: string
    mime: string
    bytes: number
    body: Buffer
    role: string
  }>(
    `SELECT b.sha256, b.kind, b.mime, b.bytes, b.body, r.role
       FROM tutorial_blobs b
       JOIN tutorial_blob_refs r ON r.sha256 = b.sha256
       JOIN community_tutorials t ON t.id = r.publication_id
      WHERE b.sha256 = $1 AND t.status = 'approved'
      LIMIT 1`,
    [sha256],
    runner,
  )
  const row = result.rows[0]
  if (!row) return null
  const body = Buffer.isBuffer(row.body) ? row.body : Buffer.from(row.body)
  if (createHash('sha256').update(body).digest('hex') !== row.sha256) return null
  return {
    ...row,
    body,
  }
}

export async function listTutorialBlobRefs(
  publicationId: string,
  runner?: QueryRunner,
): Promise<Array<{ sha256: string; role: string; kind: string; mime: string; bytes: number }>> {
  const result = await query<{
    sha256: string
    role: string
    kind: string
    mime: string
    bytes: number
  }>(
    `SELECT r.sha256, r.role, b.kind, b.mime, b.bytes
       FROM tutorial_blob_refs r
       JOIN tutorial_blobs b ON b.sha256 = r.sha256
      WHERE r.publication_id = $1::bigint
      ORDER BY r.role`,
    [publicationId],
    runner,
  )
  return result.rows
}

export async function gcOrphanTutorialBlobs(runner?: QueryRunner): Promise<number> {
  const result = await query(
    `DELETE FROM tutorial_blobs b
      WHERE NOT EXISTS (
        SELECT 1 FROM tutorial_blob_refs r WHERE r.sha256 = b.sha256
      )`,
    [],
    runner,
  )
  return result.rowCount ?? 0
}

export async function persistSnapshotBlobs(args: {
  publicationId: string
  blobs: readonly TutorialBlobDraft[]
  manifest: PublicSnapshotManifest
  runner: QueryRunner
}): Promise<void> {
  await upsertTutorialBlobs(args.blobs, args.runner)
  await replaceTutorialBlobRefs(args.publicationId, args.blobs, args.runner)
}
