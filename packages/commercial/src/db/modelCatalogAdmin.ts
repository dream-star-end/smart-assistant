import type { Pool } from "pg";

import { loadConfig } from "../config.js";
import { createPool } from "./index.js";

let adminPool: Pool | null = null;

function databaseUser(raw: string, field: string): string {
  const user = decodeURIComponent(new URL(raw).username);
  if (!user) throw new Error(`${field} must include an explicit database username`);
  return user;
}

/**
 * catalog mutation 专用 pool。普通 app DATABASE_URL 永远不能借此回退成 owner/app 连接。
 */
export function getModelCatalogAdminPool(): Pool {
  if (adminPool) return adminPool;
  const cfg = loadConfig();
  const adminUrl = cfg.MODEL_CATALOG_ADMIN_DATABASE_URL;
  if (!adminUrl) {
    throw new Error("MODEL_CATALOG_ADMIN_DATABASE_URL is required for model catalog administration");
  }
  const appUser = databaseUser(cfg.DATABASE_URL, "DATABASE_URL");
  const adminUser = databaseUser(adminUrl, "MODEL_CATALOG_ADMIN_DATABASE_URL");
  if (appUser === adminUser) {
    throw new Error("model catalog admin and application database roles must be distinct");
  }
  adminPool = createPool({ connectionString: adminUrl, max: 5 });
  return adminPool;
}

/** 启动期 fail-fast；不等首个 admin mutation 才暴露错误。 */
export async function assertModelCatalogAdminPoolConfigured(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.MODEL_CATALOG_ADMIN_DATABASE_URL) {
    throw new Error("MODEL_CATALOG_ADMIN_DATABASE_URL is required for model catalog administration");
  }
  const expectedAdmin = databaseUser(
    cfg.MODEL_CATALOG_ADMIN_DATABASE_URL,
    "MODEL_CATALOG_ADMIN_DATABASE_URL",
  );
  const appUser = databaseUser(cfg.DATABASE_URL, "DATABASE_URL");
  const p = getModelCatalogAdminPool();
  const r = await p.query<{ admin_user: string }>("SELECT current_user AS admin_user");
  if (r.rows[0]?.admin_user !== expectedAdmin || r.rows[0].admin_user === appUser) {
    throw new Error("model catalog admin connection resolved to an unexpected database role");
  }
}

export function setModelCatalogAdminPoolOverride(pool: Pool): void {
  if (adminPool && adminPool !== pool) {
    throw new Error("model catalog admin pool already initialized; close it before override");
  }
  adminPool = pool;
}

export async function closeModelCatalogAdminPool(): Promise<void> {
  if (!adminPool) return;
  const p = adminPool;
  adminPool = null;
  await p.end();
}

export function resetModelCatalogAdminPoolOverride(): void {
  adminPool = null;
}
