// OCV5-763: test the same logical DDL on each edition without importing the other
// edition's applied migration history. The commercial forward migration marks exact sections.
import { readFileSync, existsSync } from "node:fs";

const bundled = new Set(["0327_system_action_receipts", "0330_turn_lease_binding",
  "0331_refresh_reissue_client_ip", "0332_turn_dispatch_turn_key", "0333_remote_agent_pool",
  "0335_codex_remote_native", "0337_remote_engine_concurrency", "0339_remote_driver_core_v4"]);
export function migrationSourceVersion(version: string): string {
  if (!/^[0-9]{4}_[a-z0-9_]+$/.test(version)) throw new Error("invalid migration version");
  if (existsSync(new URL(`../../db/migrations/${version}.sql`, import.meta.url))) return version;
  if (!bundled.has(version)) throw new Error(`missing migration ${version}`);
  return "0340_commercial_sync_compat";
}
export function readMigrationSource(version: string): string {
  const actual = migrationSourceVersion(version);
  const sql = readFileSync(new URL(`../../db/migrations/${actual}.sql`, import.meta.url), "utf8");
  if (actual === version) return sql;
  const start = `-- sync-section: ${version}\n`;
  const end = `-- end-sync-section: ${version}`;
  if (sql.split(start).length !== 2 || sql.split(end).length !== 2) throw new Error(`missing or duplicated sync section ${version}`);
  return sql.split(start)[1]!.split(end)[0]!;
}
