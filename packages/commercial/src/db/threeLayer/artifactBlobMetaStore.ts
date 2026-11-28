/**
 * OCV5-890 / OCV5-928 — `PgArtifactBlobMetaStore` (`artifact_blobs`, `artifact_blob_uploads`).
 *
 * Layer: platform-pg (L2, subdomain db-core rank 0).
 * Zero `process.env`; zero dynamic SQL interpolation; all functions <= 85L, CC <= 15.
 */
import { randomUUID } from 'node:crypto'
import {
  ARTIFACT_BLOB_MAX_BYTES,
  validateArtifactBlobRef,
  type ArtifactBlobKind,
  type ArtifactBlobRef,
  type ArtifactBlobStorageBackend,
} from '@openclaude/protocol'
import {
  BLOB_KIND_SET,
  CHUNK_BYTES_MAX,
  CHUNK_BYTES_MIN,
  CHUNK_COUNT_MAX,
  IDENT_8_128_RE,
  SHA256_RE,
  TENANT_ID_RE,
  assertCondition,
  assertNonEmptyString,
  dedupeCapStrings,
  parseJsonValue,
  toIsoString,
  withTransaction,
  type ArtifactBlobUploadPartMeta,
  type ArtifactBlobUploadRecord,
  type CompleteBlobRowInput,
  type GcUnreferencedBlobsOptions,
  type GcUnreferencedBlobsResult,
  type InitiateBlobUploadMetaInput,
  type PgQueryable,
  type PgTransactionPool,
  type RecordBlobPartResult,
} from './types.js'

interface BlobRow extends Record<string, unknown> {
  blob_id: string
  tenant_id: string
  sha256: string
  size_bytes: string | number
  mime_type: string
  kind: string
  logical_name: string | null
  container_relative_path: string | null
  storage_backend: string
  storage_uri: string
  created_at: unknown
}

function mapBlobRow(row: BlobRow): ArtifactBlobRef {
  return validateArtifactBlobRef({
    blobId: String(row.blob_id),
    tenantId: String(row.tenant_id),
    sha256: String(row.sha256),
    sizeBytes: Number(row.size_bytes),
    mimeType: String(row.mime_type),
    kind: row.kind as ArtifactBlobKind,
    ...(row.logical_name === null || row.logical_name === undefined
      ? {}
      : { logicalName: String(row.logical_name) }),
    ...(row.container_relative_path === null || row.container_relative_path === undefined
      ? {}
      : { containerRelativePath: String(row.container_relative_path) }),
    storageBackend: row.storage_backend as ArtifactBlobStorageBackend,
    storageUri: String(row.storage_uri),
    createdAt: toIsoString(row.created_at),
  })
}

interface BlobUploadRow extends Record<string, unknown> {
  upload_id: string
  tenant_id: string
  kind: string
  filename: string
  mime_type: string
  expected_size_bytes: string | number
  chunk_bytes: string | number
  chunk_count: string | number
  received_parts_json: unknown
  status: string
  completed_blob_id: string | null
  created_at: unknown
  updated_at: unknown
}

function parseReceivedParts(raw: unknown): Record<string, ArtifactBlobUploadPartMeta> {
  const parsed = parseJsonValue(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: Record<string, ArtifactBlobUploadPartMeta> = {}
  for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const part = v as Record<string, unknown>
      if (typeof part.sizeBytes === 'number' && typeof part.sha256 === 'string') {
        out[k] = { sizeBytes: part.sizeBytes, sha256: part.sha256 }
      }
    }
  }
  return out
}

function mapBlobUploadRow(row: BlobUploadRow): ArtifactBlobUploadRecord {
  const parts = parseReceivedParts(row.received_parts_json)
  return Object.freeze({
    uploadId: String(row.upload_id),
    tenantId: String(row.tenant_id),
    kind: row.kind as ArtifactBlobKind,
    filename: String(row.filename),
    mimeType: String(row.mime_type),
    expectedSizeBytes: Number(row.expected_size_bytes),
    chunkBytes: Number(row.chunk_bytes),
    chunkCount: Number(row.chunk_count),
    receivedParts: Object.freeze(parts),
    status: row.status as 'open' | 'completed' | 'aborted',
    completedBlobId: row.completed_blob_id ?? null,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  })
}

function validateBlobRowInput(blobRow: CompleteBlobRowInput): ArtifactBlobRef {
  return validateArtifactBlobRef({
    blobId: blobRow.blobId,
    tenantId: blobRow.tenantId,
    sha256: blobRow.sha256,
    sizeBytes: blobRow.sizeBytes,
    mimeType: blobRow.mimeType,
    kind: blobRow.kind,
    ...(blobRow.logicalName === undefined ? {} : { logicalName: blobRow.logicalName }),
    ...(blobRow.containerRelativePath === undefined
      ? {}
      : { containerRelativePath: blobRow.containerRelativePath }),
    storageBackend: blobRow.storageBackend ?? 'local_cas',
    storageUri: blobRow.storageUri,
    ...(blobRow.createdAt === undefined ? {} : { createdAt: blobRow.createdAt }),
  })
}

async function insertArtifactBlobRow(
  queryable: PgQueryable,
  validated: ArtifactBlobRef,
): Promise<ArtifactBlobRef> {
  const res = await queryable.query<BlobRow>(
    `INSERT INTO artifact_blobs (
       blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
       logical_name, container_relative_path, storage_backend, storage_uri
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
               logical_name, container_relative_path, storage_backend, storage_uri, created_at`,
    [
      validated.blobId,
      validated.tenantId,
      validated.sha256,
      validated.sizeBytes,
      validated.mimeType,
      validated.kind,
      validated.logicalName ?? null,
      validated.containerRelativePath ?? null,
      validated.storageBackend ?? 'local_cas',
      validated.storageUri!,
    ],
  )
  return mapBlobRow(res.rows[0]!)
}

async function executeGcBlobsQuery(
  pool: PgQueryable,
  cutoffIso: string,
  liveIds: string[],
  tenantId: string | undefined,
  dryRun: boolean | undefined,
): Promise<readonly string[]> {
  if (dryRun) {
    const res =
      tenantId !== undefined
        ? await pool.query<{ blob_id: string }>(
            `SELECT blob_id
               FROM artifact_blobs
              WHERE deleted_at IS NULL
                AND created_at < $1::timestamptz
                AND NOT (blob_id = ANY($2::text[]))
                AND tenant_id = $3`,
            [cutoffIso, liveIds, tenantId],
          )
        : await pool.query<{ blob_id: string }>(
            `SELECT blob_id
               FROM artifact_blobs
              WHERE deleted_at IS NULL
                AND created_at < $1::timestamptz
                AND NOT (blob_id = ANY($2::text[]))`,
            [cutoffIso, liveIds],
          )
    return Object.freeze(res.rows.map((r) => String(r.blob_id)))
  }

  const res =
    tenantId !== undefined
      ? await pool.query<{ blob_id: string }>(
          `UPDATE artifact_blobs
              SET deleted_at = NOW()
            WHERE deleted_at IS NULL
              AND created_at < $1::timestamptz
              AND NOT (blob_id = ANY($2::text[]))
              AND tenant_id = $3
            RETURNING blob_id`,
          [cutoffIso, liveIds, tenantId],
        )
      : await pool.query<{ blob_id: string }>(
          `UPDATE artifact_blobs
              SET deleted_at = NOW()
            WHERE deleted_at IS NULL
              AND created_at < $1::timestamptz
              AND NOT (blob_id = ANY($2::text[]))
            RETURNING blob_id`,
          [cutoffIso, liveIds],
        )
  return Object.freeze(res.rows.map((r) => String(r.blob_id)))
}

export class PgArtifactBlobMetaStore {
  private readonly pool: PgTransactionPool

  constructor(pool: PgTransactionPool) {
    this.pool = pool
  }

  async initiateUpload(meta: InitiateBlobUploadMetaInput): Promise<ArtifactBlobUploadRecord> {
    const uploadId = meta.uploadId ?? `upl-${randomUUID()}`
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    assertCondition(TENANT_ID_RE.test(meta.tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(BLOB_KIND_SET.has(meta.kind), 'BLOB_KIND_INVALID')
    assertNonEmptyString(meta.filename, 'BLOB_FILENAME_INVALID', 256)
    assertNonEmptyString(meta.mimeType, 'BLOB_MIME_TYPE_INVALID', 128)
    assertCondition(
      typeof meta.expectedSizeBytes === 'number' &&
        Number.isSafeInteger(meta.expectedSizeBytes) &&
        meta.expectedSizeBytes >= 0 &&
        meta.expectedSizeBytes <= ARTIFACT_BLOB_MAX_BYTES,
      'BLOB_EXPECTED_SIZE_INVALID',
    )
    assertCondition(
      typeof meta.chunkBytes === 'number' &&
        Number.isSafeInteger(meta.chunkBytes) &&
        meta.chunkBytes >= CHUNK_BYTES_MIN &&
        meta.chunkBytes <= CHUNK_BYTES_MAX,
      'BLOB_CHUNK_BYTES_INVALID',
    )
    assertCondition(
      typeof meta.chunkCount === 'number' &&
        Number.isSafeInteger(meta.chunkCount) &&
        meta.chunkCount >= 1 &&
        meta.chunkCount <= CHUNK_COUNT_MAX,
      'BLOB_CHUNK_COUNT_INVALID',
    )

    const res = await this.pool.query<BlobUploadRow>(
      `INSERT INTO artifact_blob_uploads (
         upload_id, tenant_id, kind, filename, mime_type,
         expected_size_bytes, chunk_bytes, chunk_count
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING upload_id, tenant_id, kind, filename, mime_type, expected_size_bytes,
                 chunk_bytes, chunk_count, received_parts_json, status, completed_blob_id,
                 created_at, updated_at`,
      [
        uploadId,
        meta.tenantId,
        meta.kind,
        meta.filename,
        meta.mimeType,
        meta.expectedSizeBytes,
        meta.chunkBytes,
        meta.chunkCount,
      ],
    )
    return mapBlobUploadRow(res.rows[0]!)
  }

  async getUpload(uploadId: string): Promise<ArtifactBlobUploadRecord | null> {
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    const res = await this.pool.query<BlobUploadRow>(
      `SELECT upload_id, tenant_id, kind, filename, mime_type, expected_size_bytes,
              chunk_bytes, chunk_count, received_parts_json, status, completed_blob_id,
              created_at, updated_at
         FROM artifact_blob_uploads
        WHERE upload_id = $1`,
      [uploadId],
    )
    return res.rows[0] ? mapBlobUploadRow(res.rows[0]) : null
  }

  async recordPart(
    uploadId: string,
    index: number,
    sizeBytes: number,
    partSha256: string,
    expectedTenantId?: string,
  ): Promise<RecordBlobPartResult> {
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    if (expectedTenantId !== undefined) {
      assertCondition(TENANT_ID_RE.test(expectedTenantId), 'BLOB_TENANT_ID_INVALID')
    }
    assertCondition(
      typeof index === 'number' && Number.isSafeInteger(index) && index >= 0,
      'BLOB_PART_INDEX_INVALID',
    )
    assertCondition(
      typeof sizeBytes === 'number' && Number.isSafeInteger(sizeBytes) && sizeBytes >= 0,
      'BLOB_PART_SIZE_INVALID',
    )
    assertCondition(
      typeof partSha256 === 'string' && SHA256_RE.test(partSha256),
      'BLOB_PART_SHA256_INVALID',
    )

    return withTransaction(this.pool, async (client) => {
      const res = await client.query<BlobUploadRow>(
        `SELECT upload_id, tenant_id, kind, filename, mime_type,
                expected_size_bytes, chunk_bytes, chunk_count,
                received_parts_json, status, completed_blob_id, created_at, updated_at
           FROM artifact_blob_uploads
          WHERE upload_id = $1
          FOR UPDATE`,
        [uploadId],
      )
      const row = res.rows[0]
      assertCondition(row !== undefined, 'BLOB_UPLOAD_NOT_FOUND')
      if (expectedTenantId !== undefined) {
        assertCondition(String(row.tenant_id) === expectedTenantId, 'BLOB_UPLOAD_TENANT_MISMATCH')
      }
      assertCondition(row.status === 'open', 'BLOB_UPLOAD_NOT_OPEN')
      assertCondition(index < Number(row.chunk_count), 'BLOB_PART_INDEX_OUT_OF_RANGE')
      assertCondition(sizeBytes <= Number(row.chunk_bytes), 'BLOB_PART_SIZE_EXCEEDED')

      const parts = parseReceivedParts(row.received_parts_json)
      const key = String(index)
      const existing = parts[key]
      if (existing) {
        if (existing.sha256 === partSha256 && existing.sizeBytes === sizeBytes) {
          return 'idempotent'
        }
        throw new Error('BLOB_PART_SHA256_MISMATCH')
      }

      let totalBytes = sizeBytes
      for (const p of Object.values(parts)) {
        totalBytes += p.sizeBytes
      }
      assertCondition(
        totalBytes <= Number(row.expected_size_bytes) && totalBytes <= ARTIFACT_BLOB_MAX_BYTES,
        'BLOB_UPLOAD_SIZE_EXCEEDED',
      )

      parts[key] = { sizeBytes, sha256: partSha256 }
      await client.query(
        `UPDATE artifact_blob_uploads
            SET received_parts_json = $2::jsonb,
                updated_at = NOW()
          WHERE upload_id = $1`,
        [uploadId, JSON.stringify(parts)],
      )
      return 'recorded'
    })
  }

  async abortUpload(tenantId: string, uploadId: string): Promise<boolean> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    return withTransaction(this.pool, async (client) => {
      const res = await client.query<{ tenant_id: string; status: string }>(
        'SELECT tenant_id, status FROM artifact_blob_uploads WHERE upload_id = $1 FOR UPDATE',
        [uploadId],
      )
      const row = res.rows[0]
      if (!row) return false
      assertCondition(String(row.tenant_id) === tenantId, 'BLOB_UPLOAD_TENANT_MISMATCH')
      if (row.status !== 'open') return false
      await client.query(
        `UPDATE artifact_blob_uploads
            SET status = 'aborted',
                updated_at = NOW()
          WHERE upload_id = $1 AND tenant_id = $2 AND status = 'open'`,
        [uploadId, tenantId],
      )
      return true
    })
  }

  async completeUpload(uploadId: string, blobRow: CompleteBlobRowInput): Promise<ArtifactBlobRef> {
    assertCondition(IDENT_8_128_RE.test(uploadId), 'BLOB_UPLOAD_ID_INVALID')
    const validated = validateBlobRowInput(blobRow)

    return withTransaction(this.pool, async (client) => {
      const uploadRes = await client.query<BlobUploadRow>(
        `SELECT upload_id, tenant_id, kind, filename, mime_type,
                expected_size_bytes, chunk_bytes, chunk_count,
                received_parts_json, status, completed_blob_id, created_at, updated_at
           FROM artifact_blob_uploads
          WHERE upload_id = $1
          FOR UPDATE`,
        [uploadId],
      )
      const upload = uploadRes.rows[0]
      assertCondition(upload !== undefined, 'BLOB_UPLOAD_NOT_FOUND')
      assertCondition(upload.status === 'open', 'BLOB_UPLOAD_NOT_OPEN')
      assertCondition(String(upload.tenant_id) === validated.tenantId, 'BLOB_UPLOAD_TENANT_MISMATCH')

      const inserted = await insertArtifactBlobRow(client, validated)
      await client.query(
        `UPDATE artifact_blob_uploads
            SET status = 'completed',
                completed_blob_id = $2,
                updated_at = NOW()
          WHERE upload_id = $1`,
        [uploadId, validated.blobId],
      )
      return inserted
    })
  }

  async insertBlob(blobRow: CompleteBlobRowInput): Promise<ArtifactBlobRef> {
    const validated = validateBlobRowInput(blobRow)
    return insertArtifactBlobRow(this.pool, validated)
  }

  async statBlob(tenantId: string, blobId: string): Promise<ArtifactBlobRef | null> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(IDENT_8_128_RE.test(blobId), 'BLOB_ID_INVALID')
    const res = await this.pool.query<BlobRow>(
      `SELECT blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
              logical_name, container_relative_path, storage_backend, storage_uri, created_at
         FROM artifact_blobs
        WHERE tenant_id = $1 AND blob_id = $2 AND deleted_at IS NULL`,
      [tenantId, blobId],
    )
    return res.rows[0] ? mapBlobRow(res.rows[0]) : null
  }

  async findBlobBySha256(tenantId: string, sha256: string): Promise<ArtifactBlobRef | null> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(SHA256_RE.test(sha256), 'BLOB_SHA256_INVALID')
    const res = await this.pool.query<BlobRow>(
      `SELECT blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
              logical_name, container_relative_path, storage_backend, storage_uri, created_at
         FROM artifact_blobs
        WHERE tenant_id = $1 AND sha256 = $2 AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT 1`,
      [tenantId, sha256],
    )
    return res.rows[0] ? mapBlobRow(res.rows[0]) : null
  }

  async softDeleteBlob(tenantId: string, blobId: string): Promise<boolean> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    assertCondition(IDENT_8_128_RE.test(blobId), 'BLOB_ID_INVALID')
    const res = await this.pool.query<{ blob_id: string }>(
      `UPDATE artifact_blobs
          SET deleted_at = NOW()
        WHERE tenant_id = $1 AND blob_id = $2 AND deleted_at IS NULL
        RETURNING blob_id`,
      [tenantId, blobId],
    )
    return res.rows.length > 0
  }

  async listTenantBlobs(
    tenantId: string,
    kind?: ArtifactBlobKind,
  ): Promise<readonly ArtifactBlobRef[]> {
    assertCondition(TENANT_ID_RE.test(tenantId), 'BLOB_TENANT_ID_INVALID')
    if (kind !== undefined) {
      assertCondition(BLOB_KIND_SET.has(kind), 'BLOB_KIND_INVALID')
      const res = await this.pool.query<BlobRow>(
        `SELECT blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
                logical_name, container_relative_path, storage_backend, storage_uri, created_at
           FROM artifact_blobs
          WHERE tenant_id = $1 AND kind = $2 AND deleted_at IS NULL
          ORDER BY created_at DESC, ctid DESC, blob_id DESC`,
        [tenantId, kind],
      )
      return Object.freeze(res.rows.map(mapBlobRow))
    }

    const res = await this.pool.query<BlobRow>(
      `SELECT blob_id, tenant_id, sha256, size_bytes, mime_type, kind,
              logical_name, container_relative_path, storage_backend, storage_uri, created_at
         FROM artifact_blobs
        WHERE tenant_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC, ctid DESC, blob_id DESC`,
      [tenantId],
    )
    return Object.freeze(res.rows.map(mapBlobRow))
  }

  async gcUnreferencedBlobs(opts: GcUnreferencedBlobsOptions): Promise<GcUnreferencedBlobsResult> {
    if (opts.completeReferenceProof !== true) throw new Error('BLOB_GC_INCOMPLETE_REFERENCE_PROOF')
    assertCondition(
      typeof opts.olderThanMs === 'number' &&
        Number.isFinite(opts.olderThanMs) &&
        opts.olderThanMs >= 0,
      'BLOB_GC_OLDER_THAN_INVALID',
    )
    if (opts.tenantId !== undefined) {
      assertCondition(TENANT_ID_RE.test(opts.tenantId), 'BLOB_TENANT_ID_INVALID')
    }
    const nowMs = opts.nowMs ?? Date.now()
    const cutoffIso = new Date(nowMs - opts.olderThanMs).toISOString()
    const liveIds = Array.isArray(opts.liveBlobIds)
      ? dedupeCapStrings(opts.liveBlobIds)
      : dedupeCapStrings([...opts.liveBlobIds])
    const markedDeletedBlobIds = await executeGcBlobsQuery(
      this.pool,
      cutoffIso,
      liveIds,
      opts.tenantId,
      opts.dryRun,
    )
    return Object.freeze({
      markedDeletedBlobIds,
      markedDeletedCount: markedDeletedBlobIds.length,
      cutoffIso,
    })
  }
}
