/**
 * Shared transactional PostgreSQL mock for `PgArtifactBlobMetaStore` tests (`OCV5-928`).
 *
 * Supports multi-connection `pool.connect()` with real per-key `pg_advisory_xact_lock`
 * serialization across concurrent callers, `findNewestMediaBlob`, `registerLogicalMediaBlobAtomically`,
 * `softDeleteLogicalMediaBlobs`, `listTenantBlobs`, `statBlob`, `findBlobBySha256`, and `softDeleteBlob`.
 */
import pg from 'pg'

export interface CasMetaMockPoolOptions {
  readonly fixedIso?: string
  readonly stepMsPerInsert?: boolean
  readonly throwOnSelect?: () => boolean
}

function rowMatchesMediaLookup(
  row: Record<string, unknown>,
  tenantId: string,
  kindFilter: string | null,
  safeName: string,
  relPaths: readonly string[],
  digestPrefix: string | null,
): boolean {
  if (row.tenant_id !== tenantId || row.deleted_at !== null) return false
  if (row.kind !== 'upload' && row.kind !== 'generated') return false
  if (kindFilter !== null && row.kind !== kindFilter) return false
  if (row.logical_name === safeName) return true
  if (typeof row.container_relative_path === 'string' && relPaths.includes(row.container_relative_path)) {
    return true
  }
  return digestPrefix !== null && row.sha256 === digestPrefix
}

export function createMockCasMetaPgPool(opts?: CasMetaMockPoolOptions) {
  const rows: Array<Record<string, unknown>> = []
  const lockChains = new Map<string, Promise<void>>()
  let insertCalls = 0

  const executeSql = async (
    sql: string,
    params: readonly unknown[] = [],
    heldReleases?: Array<() => void>,
  ) => {
    const norm = sql.replace(/\s+/g, ' ').trim()
    if (norm === 'BEGIN' || norm === 'COMMIT' || norm === 'ROLLBACK') {
      if ((norm === 'COMMIT' || norm === 'ROLLBACK') && heldReleases) {
        while (heldReleases.length > 0) heldReleases.pop()!()
      }
      return { rows: [], rowCount: 0 }
    }
    if (norm.startsWith('SELECT pg_advisory_xact_lock')) {
      const key = String(params[0] ?? 'global')
      const prev = lockChains.get(key) ?? Promise.resolve()
      let releaseFn!: () => void
      const gate = new Promise<void>((resolve) => {
        releaseFn = resolve
      })
      const next = prev.then(() => gate)
      lockChains.set(key, next)
      await prev
      heldReleases?.push(releaseFn)
      return { rows: [], rowCount: 1 }
    }
    if (opts?.throwOnSelect?.() && norm.startsWith('SELECT')) {
      throw new Error('CAS_PG_METADATA_DOWN')
    }
    if (norm.startsWith('INSERT INTO artifact_blobs')) {
      insertCalls += 1
      const createdAt =
        opts?.fixedIso ??
        (opts?.stepMsPerInsert ? new Date(Date.now() + insertCalls).toISOString() : new Date().toISOString())
      const row: Record<string, unknown> = {
        blob_id: String(params[0]),
        tenant_id: String(params[1]),
        sha256: String(params[2]),
        size_bytes: Number(params[3]),
        mime_type: String(params[4]),
        kind: String(params[5]),
        logical_name: params[6] === null ? null : String(params[6]),
        container_relative_path: params[7] === null ? null : String(params[7]),
        storage_backend: String(params[8]),
        storage_uri: String(params[9]),
        created_at: createdAt,
        deleted_at: null,
      }
      rows.unshift(row)
      return { rows: [row], rowCount: 1 }
    }
    if (norm.startsWith('UPDATE artifact_blobs SET deleted_at') && norm.includes('logical_name = $3')) {
      const [tenantId, kind, safeName, relPath, digestPrefix] = [
        String(params[0]),
        String(params[1]),
        String(params[2]),
        String(params[3]),
        params[4] === null ? null : String(params[4]),
      ]
      const matched: Array<{ blob_id: string }> = []
      for (const r of rows) {
        if (rowMatchesMediaLookup(r, tenantId, kind, safeName, [relPath], digestPrefix)) {
          r.deleted_at = new Date().toISOString()
          matched.push({ blob_id: String(r.blob_id) })
        }
      }
      return { rows: matched, rowCount: matched.length }
    }
    if (norm.startsWith('UPDATE artifact_blobs SET deleted_at')) {
      const hit = rows.find(
        (r) => r.tenant_id === String(params[0]) && r.blob_id === String(params[1]) && r.deleted_at === null,
      )
      if (!hit) return { rows: [], rowCount: 0 }
      hit.deleted_at = new Date().toISOString()
      return { rows: [{ blob_id: hit.blob_id }], rowCount: 1 }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND blob_id = $2')) {
      const hit = rows.find(
        (r) => r.tenant_id === String(params[0]) && r.blob_id === String(params[1]) && r.deleted_at === null,
      )
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND sha256 = $2')) {
      const active = rows.filter(
        (r) => r.tenant_id === String(params[0]) && r.sha256 === String(params[1]) && r.deleted_at === null,
      )
      return { rows: active.slice(0, 1), rowCount: active.length > 0 ? 1 : 0 }
    }
    if (norm.includes('AND logical_name = $3') && norm.includes('LIMIT 1') && !norm.includes('ANY($4')) {
      const hit = rows.find(
        (r) =>
          r.tenant_id === String(params[0]) &&
          r.kind === String(params[1]) &&
          r.logical_name === String(params[2]) &&
          r.deleted_at === null,
      )
      return { rows: hit ? [hit] : [], rowCount: hit ? 1 : 0 }
    }
    if (norm.includes('container_relative_path = ANY($4::text[])')) {
      const tenantId = String(params[0])
      const kindFilter = params[1] === null || params[1] === undefined ? null : String(params[1])
      const safeName = String(params[2])
      const relPaths = Array.isArray(params[3]) ? params[3].map(String) : []
      const digestPrefix = params[4] === null || params[4] === undefined ? null : String(params[4])
      const explicitlyDeletedByName = rows.some(
        (d) =>
          d.tenant_id === tenantId &&
          d.deleted_at !== null &&
          (d.logical_name === safeName ||
            (typeof d.container_relative_path === 'string' && relPaths.includes(d.container_relative_path))),
      )
      const effectiveDigest = explicitlyDeletedByName ? null : digestPrefix
      const hits = rows.filter((r) =>
        rowMatchesMediaLookup(r, tenantId, kindFilter, safeName, relPaths, effectiveDigest),
      )
      hits.sort((a, b) => {
        const ka = a.kind === 'upload' ? 0 : 1
        const kb = b.kind === 'upload' ? 0 : 1
        return ka - kb
      })
      return { rows: hits.slice(0, 1), rowCount: hits.length > 0 ? 1 : 0 }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND kind = $2 AND deleted_at IS NULL')) {
      const active = rows.filter(
        (r) => r.tenant_id === String(params[0]) && r.kind === String(params[1]) && r.deleted_at === null,
      )
      return { rows: active, rowCount: active.length }
    }
    if (norm.includes('FROM artifact_blobs WHERE tenant_id = $1 AND deleted_at IS NULL')) {
      const active = rows.filter((r) => r.tenant_id === String(params[0]) && r.deleted_at === null)
      return { rows: active, rowCount: active.length }
    }
    return { rows: [], rowCount: 0 }
  }

  const pool = new pg.Pool({ max: 1, idleTimeoutMillis: 1 })
  Reflect.set(pool, 'query', (sql: string, params?: readonly unknown[]) => executeSql(sql, params))
  Reflect.set(pool, 'connect', async () => {
    const heldReleases: Array<() => void> = []
    return {
      query: (sql: string, params?: readonly unknown[]) => executeSql(sql, params, heldReleases),
      release: () => {
        while (heldReleases.length > 0) heldReleases.pop()!()
      },
    }
  })

  return {
    pool,
    rows,
    getActiveCount: () => rows.filter((r) => r.deleted_at === null).length,
    getInsertCalls: () => insertCalls,
  }
}
