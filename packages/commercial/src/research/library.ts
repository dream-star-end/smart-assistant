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
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getResearchConfigPublic } from "../admin/researchConfig.js";
import { query } from "../db/queries.js";
import { ingestBlob, type IngestOutcome } from "./researchHandlers.js";
import { defaultBlobDir, writeBlobBytesDefault } from "./researchProxy.js";
import {
  getBlob as storeGetBlob,
  putBlob as storePutBlob,
  putDocument as storePutDocument,
} from "./store.js";

/** 与容器路径(researchProxy MAX_BLOB_BYTES)同一上限。 */
export const MAX_LIBRARY_UPLOAD_BYTES = 25 * 1024 * 1024;

export interface LibraryDocRow {
  docId: string;
  title: string | null;
  lang: string;
  spanCount: number;
  createdAt: string;
}

/** 列本用户文献库(最多 500 篇,新入库在前)。只回元数据,权威 span 文本不外泄。 */
export async function listLibraryDocuments(userId: string): Promise<LibraryDocRow[]> {
  const r = await query<{
    doc_id: string;
    title: string | null;
    lang: string;
    span_count: number;
    created_at: Date;
  }>(
    `SELECT doc_id, title, lang,
            COALESCE(jsonb_array_length(normalized_json->'spans'), 0)::int AS span_count,
            created_at
       FROM research_documents
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 500`,
    [userId],
  );
  return r.rows.map((row) => ({
    docId: row.doc_id,
    title: row.title,
    lang: row.lang,
    spanCount: row.span_count,
    createdAt: row.created_at.toISOString(),
  }));
}

/** 删单篇(tenant 隔离)。返回是否真删了一行。 */
export async function deleteLibraryDocument(userId: string, docId: string): Promise<boolean> {
  const r = await query(
    "DELETE FROM research_documents WHERE user_id = $1 AND doc_id = $2",
    [userId, docId],
  );
  return (r.rowCount ?? 0) > 0;
}

export type LibraryUploadOutcome = IngestOutcome & { blobId?: string };

/**
 * UI 直传字节 → blob 落盘/落库 → ingestBlob 铸权威文档(与 oc-ingest 完全同一条铸造
 * 链)。research_config 未开启 → { ok:false, reason:'research disabled' }(调用方 503)。
 */
export async function uploadAndIngestDocument(
  userId: number,
  bytes: Buffer,
  mime: string,
  filename?: string,
): Promise<LibraryUploadOutcome | { disabled: true }> {
  const cfg = await getResearchConfigPublic();
  if (!cfg.enabled) return { disabled: true };

  const blobId = randomUUID();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const storagePath = path.join(defaultBlobDir(), `${userId}-${blobId}`);
  await writeBlobBytesDefault(storagePath, bytes);
  await storePutBlob({ blobId, userId, sha256, sizeBytes: bytes.length, storagePath, mime });

  const outcome = await ingestBlob(
    { userId, blobId, filename, engine: cfg.config.ingest.engine },
    {
      getBlob: async (uid, bid) => {
        const b = await storeGetBlob(uid, bid);
        return b ? { storagePath: b.storagePath, mime: b.mime } : null;
      },
      readBlobBytes: (p) => readFile(p),
      putDocument: (uid, doc) => storePutDocument({ userId: uid, doc }),
    },
  );
  return { ...outcome, blobId };
}
