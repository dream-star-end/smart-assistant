/**
 * 用户文献库(research_documents)的用户会话向核心逻辑。
 *
 * 背景:oc-ingest 入库后用户此前**没有任何管理入口**(看不到库里有什么、删不掉、
 * 也不能在 UI 主动上传入库)。本模块给 /api/me/research/library* 端点提供:
 *   - list:列出本用户的权威文档(标题/语言/片段数/入库时间,不外泄权威 span 文本)
 *   - delete:删除单篇(tenant 隔离;已铸造的历史引用 manifest 不受影响,后续
 *     cite/check 回查不到该文档会按 fail-closed 判 unsupported —— 语义正确)
 *   - upload+ingest:UI 直传字节 → 落 blob → 复用容器路径同一 ingestBlob 铸权威文档
 *     (单一铸造入口,不另起第二套解析逻辑)
 *
 * 鉴权在 http/handlers.ts(requireAuth);这里只做数据逻辑,userId 由调用方传入。
 */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { getResearchConfigPublic } from '../admin/researchConfig.js'
import { query } from '../db/queries.js'
import { ingestBlob, type IngestOutcome } from './researchHandlers.js'
import { defaultBlobDir, writeBlobBytesDefault } from './researchProxy.js'
import {
  getBlob as storeGetBlob,
  putBlob as storePutBlob,
  putDocument as storePutDocument,
} from './store.js'
import { isResearchWorkspaceEnabled } from './workspaceFlag.js'

export { isResearchWorkspaceEnabled, libraryListProjectIdFromUrl, RESEARCH_WORKSPACE_FLAG } from './workspaceFlag.js'

/** 与 storage CHAT_PROJECT_PER_USER_LIMIT 对齐。 */
const CHAT_PROJECT_PER_USER_LIMIT = 100

const DEFAULT_RESEARCH_PROJECT_NAME = '默认课题'

/** 课题不存在 / 文档不存在。proxy 映射 400。 */
export class WorkspaceProjectError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceProjectError'
  }
}

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505'
}

/** 与容器路径(researchProxy MAX_BLOB_BYTES)同一上限。 */
export const MAX_LIBRARY_UPLOAD_BYTES = 25 * 1024 * 1024

export interface LibraryDocRow {
  docId: string
  title: string | null
  lang: string
  spanCount: number
  createdAt: string
}

/** 列本用户文献库(最多 500 篇,新入库在前)。只回元数据,权威 span 文本不外泄。
 *  传入 projectId 时按 membership 过滤(跨租户/他人课题 → 空列表,不泄漏存在性)。 */
export async function listLibraryDocuments(userId: string, projectId?: string): Promise<LibraryDocRow[]> {
  const r = await query<{
    doc_id: string
    title: string | null
    lang: string
    span_count: number
    created_at: Date
  }>(
    projectId
      ? `SELECT d.doc_id, d.title, d.lang,
                COALESCE(jsonb_array_length(d.normalized_json->'spans'), 0)::int AS span_count,
                d.created_at
           FROM research_documents d
           INNER JOIN research_library_memberships m
             ON m.user_id = d.user_id AND m.doc_id = d.doc_id
          WHERE d.user_id = $1 AND m.project_id = $2
          ORDER BY d.created_at DESC
          LIMIT 500`
      : `SELECT doc_id, title, lang,
                COALESCE(jsonb_array_length(normalized_json->'spans'), 0)::int AS span_count,
                created_at
           FROM research_documents
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 500`,
    projectId ? [userId, projectId] : [userId],
  )
  return r.rows.map((row) => ({
    docId: row.doc_id,
    title: row.title,
    lang: row.lang,
    spanCount: row.span_count,
    createdAt: row.created_at.toISOString(),
  }))
}

export async function ownedChatProjectExists(userId: string, projectId: string): Promise<boolean> {
  const r = await query(
    'SELECT 1 FROM chat_projects WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL',
    [projectId, userId],
  )
  return (r.rowCount ?? 0) > 0
}

/** 把尚无任何 membership 的文档挂到默认课题。已有 membership 的不重复。 */
export async function backfillUnassignedMemberships(userId: string, defaultProjectId: string): Promise<number> {
  const r = await query(
    `INSERT INTO research_library_memberships (user_id, doc_id, project_id)
     SELECT d.user_id, d.doc_id, $2
       FROM research_documents d
      WHERE d.user_id = $1
        AND NOT EXISTS (
          SELECT 1 FROM research_library_memberships m
           WHERE m.user_id = d.user_id AND m.doc_id = d.doc_id
        )
     ON CONFLICT (user_id, doc_id, project_id) DO NOTHING`,
    [userId, defaultProjectId],
  )
  return r.rowCount ?? 0
}

/**
 * 懒创建该用户的默认课题(最多一次)。unique 冲突(并发双写)回读已有行。
 * 随后回填无 membership 的已有文档。
 */
export async function ensureDefaultResearchProject(userId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM chat_projects
      WHERE user_id = $1 AND is_research_default IS TRUE AND deleted_at IS NULL
      LIMIT 1`,
    [userId],
  )
  if (existing.rows[0]) {
    await backfillUnassignedMemberships(userId, existing.rows[0].id)
    return existing.rows[0].id
  }

  const id = randomUUID()
  try {
    const countRow = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM chat_projects WHERE user_id = $1 AND deleted_at IS NULL',
      [userId],
    )
    if (Number(countRow.rows[0]?.n ?? 0) >= CHAT_PROJECT_PER_USER_LIMIT) {
      throw new WorkspaceProjectError('chat project limit exceeded')
    }
    await query(
      `INSERT INTO chat_projects
         (id, user_id, name, instructions, color, sort_order, created_at, updated_at, deleted_at, is_research_default)
       VALUES ($1, $2, $3, NULL, NULL, COALESCE((
         SELECT MAX(sort_order) + 1 FROM chat_projects WHERE user_id = $2 AND deleted_at IS NULL
       ), 0),
       (floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::BIGINT,
       (floor(EXTRACT(EPOCH FROM clock_timestamp())*1000))::BIGINT,
       NULL, TRUE)`,
      [id, userId, DEFAULT_RESEARCH_PROJECT_NAME],
    )
    await backfillUnassignedMemberships(userId, id)
    return id
  } catch (err) {
    if (err instanceof WorkspaceProjectError) throw err
    if (isPgUniqueViolation(err)) {
      const again = await query<{ id: string }>(
        `SELECT id FROM chat_projects
          WHERE user_id = $1 AND is_research_default IS TRUE AND deleted_at IS NULL
          LIMIT 1`,
        [userId],
      )
      if (again.rows[0]) {
        await backfillUnassignedMemberships(userId, again.rows[0].id)
        return again.rows[0].id
      }
    }
    throw err
  }
}

/** 显式 projectId 须为本用户活课题;缺省则懒创建默认课题。 */
export async function resolveWorkspaceProjectId(userId: string, projectId?: string): Promise<string> {
  if (projectId) {
    if (!(await ownedChatProjectExists(userId, projectId))) {
      throw new WorkspaceProjectError('project not found')
    }
    return projectId
  }
  return ensureDefaultResearchProject(userId)
}

export async function addMembership(userId: string, docId: string, projectId: string): Promise<void> {
  if (!(await ownedChatProjectExists(userId, projectId))) {
    throw new WorkspaceProjectError('project not found')
  }
  try {
    await query(
      `INSERT INTO research_library_memberships (user_id, doc_id, project_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, doc_id, project_id) DO NOTHING`,
      [userId, docId, projectId],
    )
  } catch (err) {
    const code = typeof err === 'object' && err !== null ? (err as { code?: string }).code : undefined
    if (code === '23503') throw new WorkspaceProjectError('document not found')
    throw err
  }
}

/** litrag 课题范围:按 added_at 新→旧,limit 含探测截断(调用方 cap 50)。 */
export async function listProjectDocIds(
  userId: string,
  projectId: string,
  limit: number,
): Promise<string[]> {
  const r = await query<{ doc_id: string }>(
    `SELECT doc_id FROM research_library_memberships
      WHERE user_id = $1 AND project_id = $2
      ORDER BY added_at DESC
      LIMIT $3`,
    [userId, projectId, limit],
  )
  return r.rows.map((row) => row.doc_id)
}

/** 删单篇(tenant 隔离)。返回是否真删了一行。 */
export async function deleteLibraryDocument(userId: string, docId: string): Promise<boolean> {
  const r = await query('DELETE FROM research_documents WHERE user_id = $1 AND doc_id = $2', [
    userId,
    docId,
  ])
  return (r.rowCount ?? 0) > 0
}

export type LibraryUploadOutcome = IngestOutcome & { blobId?: string }

/**
 * UI 直传字节 → blob 落盘/落库 → ingestBlob 铸权威文档(与 oc-ingest 完全同一条铸造
 * 链)。research_config 未开启 → { ok:false, reason:'research disabled' }(调用方 503)。
 */
export async function uploadAndIngestDocument(
  userId: number,
  bytes: Buffer,
  mime: string,
  filename?: string,
  projectId?: string,
): Promise<LibraryUploadOutcome | { disabled: true }> {
  const cfg = await getResearchConfigPublic()
  if (!cfg.enabled) return { disabled: true }

  let membershipProjectId: string | undefined
  if (isResearchWorkspaceEnabled()) {
    membershipProjectId = await resolveWorkspaceProjectId(String(userId), projectId)
  }

  const blobId = randomUUID()
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const storagePath = path.join(defaultBlobDir(), `${userId}-${blobId}`)
  await writeBlobBytesDefault(storagePath, bytes)
  await storePutBlob({ blobId, userId, sha256, sizeBytes: bytes.length, storagePath, mime })

  const outcome = await ingestBlob(
    { userId, blobId, filename, engine: cfg.config.ingest.engine },
    {
      getBlob: async (uid, bid) => {
        const b = await storeGetBlob(uid, bid)
        return b ? { storagePath: b.storagePath, mime: b.mime } : null
      },
      readBlobBytes: (p) => readFile(p),
      putDocument: (uid, doc) => storePutDocument({ userId: uid, doc }),
    },
  )
  if (outcome.ok && membershipProjectId) {
    await addMembership(String(userId), outcome.outline.docId, membershipProjectId)
    return {
      ...outcome,
      blobId,
      outline: { ...outcome.outline, projectId: membershipProjectId },
    }
  }
  return { ...outcome, blobId }
}
