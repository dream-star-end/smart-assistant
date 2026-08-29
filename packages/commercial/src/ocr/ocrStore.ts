import type { QueryResult, QueryResultRow } from 'pg'

export type OcrJobStatus =
  | 'submitting'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface OcrJob {
  id: string
  userId: number
  providerTaskId: string | null
  status: OcrJobStatus
  phase: string
  filename: string
  contentType: string
  sizeBytes: number
  pagesTotal: number | null
  markdownPath: string | null
  jsonlPath: string | null
  errorCode: string | null
  errorMessage: string | null
  cancelRequestedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

interface OcrJobRow {
  id: string
  user_id: string
  provider_task_id: string | null
  status: OcrJobStatus
  phase: string
  filename: string
  content_type: string
  size_bytes: string
  pages_total: number | null
  markdown_path: string | null
  jsonl_path: string | null
  error_code: string | null
  error_message: string | null
  cancel_requested_at: Date | null
  expires_at: Date | null
  created_at: Date
  updated_at: Date
}

export interface OcrQueryRunner {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>
}

export interface CreateOcrJobInput {
  id: string
  userId: number
  filename: string
  contentType: string
  sizeBytes: number
}

export interface CompleteOcrJobInput {
  id: string
  userId: number
  pagesTotal: number
  markdownPath: string
  jsonlPath: string
}

export interface ExpiredOcrArtifact {
  id: string
  userId: number
  markdownPath: string | null
  jsonlPath: string | null
}

export interface OcrJobStore {
  create(input: CreateOcrJobInput): Promise<OcrJob>
  get(userId: number, id: string): Promise<OcrJob | null>
  markSubmitted(
    userId: number,
    id: string,
    providerTaskId: string,
    status: OcrJobStatus,
  ): Promise<void>
  markProgress(
    userId: number,
    id: string,
    status: 'queued' | 'running',
    phase: string,
  ): Promise<void>
  markCompleted(input: CompleteOcrJobInput): Promise<boolean>
  markFailed(userId: number, id: string, code: string, message: string): Promise<void>
  cancel(userId: number, id: string): Promise<OcrJob | null>
  listExpired(limit: number): Promise<ExpiredOcrArtifact[]>
  deleteExpired(userId: number, id: string): Promise<void>
}

const JOB_COLUMNS = `id, user_id::text, provider_task_id, status, phase, filename,
  content_type, size_bytes::text, pages_total, markdown_path, jsonl_path,
  error_code, error_message, cancel_requested_at, expires_at, created_at, updated_at`

function mapJob(row: OcrJobRow): OcrJob {
  return {
    id: row.id,
    userId: Number(row.user_id),
    providerTaskId: row.provider_task_id,
    status: row.status,
    phase: row.phase,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    pagesTotal: row.pages_total,
    markdownPath: row.markdown_path,
    jsonlPath: row.jsonl_path,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cancelRequestedAt: row.cancel_requested_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class PgOcrJobStore implements OcrJobStore {
  constructor(private readonly db: OcrQueryRunner) {}

  async create(input: CreateOcrJobInput): Promise<OcrJob> {
    const result = await this.db.query<OcrJobRow>(
      `INSERT INTO ocr_jobs (id,user_id,filename,content_type,size_bytes)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${JOB_COLUMNS}`,
      [input.id, input.userId, input.filename, input.contentType, input.sizeBytes],
    )
    return mapJob(result.rows[0]!)
  }

  async get(userId: number, id: string): Promise<OcrJob | null> {
    const result = await this.db.query<OcrJobRow>(
      `SELECT ${JOB_COLUMNS} FROM ocr_jobs WHERE user_id=$1 AND id=$2`,
      [userId, id],
    )
    return result.rows[0] ? mapJob(result.rows[0]) : null
  }

  async markSubmitted(
    userId: number,
    id: string,
    providerTaskId: string,
    status: OcrJobStatus,
  ): Promise<void> {
    await this.db.query(
      `UPDATE ocr_jobs
          SET provider_task_id=$3,status=$4,phase=$4,updated_at=NOW()
        WHERE user_id=$1 AND id=$2 AND status='submitting'`,
      [userId, id, providerTaskId, status],
    )
  }

  async markProgress(
    userId: number,
    id: string,
    status: 'queued' | 'running',
    phase: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE ocr_jobs
          SET status=$3,phase=$4,updated_at=NOW()
        WHERE user_id=$1 AND id=$2 AND status IN ('queued','running')`,
      [userId, id, status, phase],
    )
  }

  async markCompleted(input: CompleteOcrJobInput): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE ocr_jobs
          SET status='completed',phase='completed',pages_total=$3,
              markdown_path=$4,jsonl_path=$5,error_code=NULL,error_message=NULL,
              expires_at=NOW()+INTERVAL '7 days',updated_at=NOW()
        WHERE user_id=$1 AND id=$2 AND status IN ('queued','running')
          AND cancel_requested_at IS NULL`,
      [input.userId, input.id, input.pagesTotal, input.markdownPath, input.jsonlPath],
    )
    return (result.rowCount ?? 0) === 1
  }

  async markFailed(userId: number, id: string, code: string, message: string): Promise<void> {
    await this.db.query(
      `UPDATE ocr_jobs
          SET status='failed',phase='failed',error_code=$3,error_message=$4,
              expires_at=COALESCE(expires_at,NOW()+INTERVAL '7 days'),updated_at=NOW()
        WHERE user_id=$1 AND id=$2 AND status IN ('submitting','queued','running')
          AND cancel_requested_at IS NULL`,
      [userId, id, code, message],
    )
  }

  async cancel(userId: number, id: string): Promise<OcrJob | null> {
    const result = await this.db.query<OcrJobRow>(
      `UPDATE ocr_jobs
          SET status=CASE WHEN status IN ('completed','failed') THEN status ELSE 'cancelled' END,
              phase=CASE WHEN status IN ('completed','failed') THEN phase ELSE 'cancelled' END,
              cancel_requested_at=CASE WHEN status IN ('completed','failed')
                THEN cancel_requested_at ELSE COALESCE(cancel_requested_at,NOW()) END,
              expires_at=CASE WHEN status IN ('completed','failed') THEN expires_at
                ELSE COALESCE(expires_at,NOW()+INTERVAL '7 days') END,
              updated_at=NOW()
        WHERE user_id=$1 AND id=$2
        RETURNING ${JOB_COLUMNS}`,
      [userId, id],
    )
    return result.rows[0] ? mapJob(result.rows[0]) : null
  }

  async listExpired(limit: number): Promise<ExpiredOcrArtifact[]> {
    const result = await this.db.query<{
      id: string
      user_id: string
      markdown_path: string | null
      jsonl_path: string | null
    }>(
      `SELECT id,user_id::text,markdown_path,jsonl_path
         FROM ocr_jobs
        WHERE expires_at IS NOT NULL AND expires_at <= NOW()
        ORDER BY expires_at,id
        LIMIT $1`,
      [limit],
    )
    return result.rows.map((row) => ({
      id: row.id,
      userId: Number(row.user_id),
      markdownPath: row.markdown_path,
      jsonlPath: row.jsonl_path,
    }))
  }

  async deleteExpired(userId: number, id: string): Promise<void> {
    await this.db.query(
      `DELETE FROM ocr_jobs WHERE user_id=$1 AND id=$2
        AND expires_at IS NOT NULL AND expires_at <= NOW()`,
      [userId, id],
    )
  }
}
