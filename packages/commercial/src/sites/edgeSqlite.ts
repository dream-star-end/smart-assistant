import { existsSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  SANDBOX_DEFAULT_DB_TIMEOUT_MS,
  assertSafeSiteSql,
  cleanupSiteDataExtras,
  resolveBetterSqliteModulePath,
  runInSiteSandbox,
} from './edgeSandbox.js'
import type { SiteDbInspectResponse, SiteDbQueryResponse } from './types.js'
import { SitesError } from './types.js'

const MAX_INSPECT_LIMIT = 200
const MAX_DB_IPC_OUTPUT_BYTES = 1024 * 1024

export { assertSafeSiteSql, cleanupSiteDataExtras, resolveBetterSqliteModulePath }

export function siteDbPathOf(siteDir: string): string {
  return join(siteDir, 'data', 'site.db')
}

export async function inspectSiteDatabase(
  siteDir: string,
  requestedTable?: string,
  requestedLimit = 100,
  slug = 'site',
): Promise<SiteDbInspectResponse> {
  const siteDataDir = join(siteDir, 'data')
  const dbPath = siteDbPathOf(siteDir)
  if (!existsSync(dbPath)) {
    return {
      connected: true,
      hasDatabaseFile: false,
      sizeBytes: 0,
      tables: [],
      selectedTable: null,
      columns: [],
      rows: [],
      truncated: false,
    }
  }
  const limit = Math.max(1, Math.min(MAX_INSPECT_LIMIT, Math.trunc(requestedLimit || 100)))
  const sizeBytes = statSync(dbPath).size
  try {
    const out = await runInSiteSandbox({
      slug,
      mode: 'db-inspect',
      siteDataDir,
      timeoutMs: SANDBOX_DEFAULT_DB_TIMEOUT_MS,
      maxResponseBytes: MAX_DB_IPC_OUTPUT_BYTES,
      initPayload: {
        table: requestedTable ?? null,
        limit,
        sizeBytes,
      },
    })
    return out as SiteDbInspectResponse
  } catch (err) {
    if (err instanceof SitesError) throw err
    const msg = (err as Error)?.message || 'SQLite 查询失败'
    if (msg === 'DB_TIMEOUT') {
      throw new SitesError('API_TIMEOUT', '数据库检查超时（已中止）', 504, true)
    }
    throw new SitesError('INVALID_INPUT', `SQLite 读取失败: ${msg}`, 400)
  }
}

export async function executeSiteSql(
  siteDir: string,
  sql: string,
  params: unknown[] = [],
  slug = 'site',
): Promise<SiteDbQueryResponse> {
  assertSafeSiteSql(sql)
  const siteDataDir = join(siteDir, 'data')
  mkdirSync(siteDataDir, { recursive: true })
  try {
    const out = await runInSiteSandbox({
      slug,
      mode: 'db-sql',
      siteDataDir,
      timeoutMs: SANDBOX_DEFAULT_DB_TIMEOUT_MS,
      maxResponseBytes: MAX_DB_IPC_OUTPUT_BYTES,
      initPayload: {
        sql,
        params,
      },
    })
    return out as SiteDbQueryResponse
  } catch (err) {
    if (err instanceof SitesError) throw err
    const msg = (err as Error)?.message || 'SQLite 执行失败'
    if (msg === 'DB_TIMEOUT') {
      throw new SitesError('API_TIMEOUT', 'SQL 执行超时（已中止）', 504, true)
    }
    throw new SitesError('INVALID_INPUT', `SQLite 执行失败: ${msg}`, 400)
  }
}
