/** Operator-only, migration-free preparation of the selfhost Box API model.
 * Default is read-only. `stage` creates a staged catalog row and a disabled,
 * admin-visible pricing row at the current Opus 5.5 rate. It never activates
 * the model, flips runtime flags, launches Box, or touches commercial prod. */
import { hostname } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { getPool, closePool } from "../../packages/commercial/src/db/index.js";
import { assertModelCatalogAdminPoolConfigured,
  closeModelCatalogAdminPool } from
  "../../packages/commercial/src/db/modelCatalogAdmin.js";
import { createStaged, normalizeVersionInput,
  validateVersionSemantics } from
  "../../packages/commercial/src/admin/modelCatalogOps.js";
import { writeAdminAudit } from "../../packages/commercial/src/admin/audit.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";

const MODEL = "box-api-claude-opus-5-5";
const SOURCE = "claude-opus-5-5";
const UID = 3n;
const VERSION = { model_id: MODEL, engine: "ccb", provider_id: "box_cli",
  upstream_model_id: SOURCE, context_window: 200_000,
  capability_profile: { supports_vision: false,
    reasoning: { supported: [], codex_model_default: null },
    ccb: { capability_zero: true, supports_thinking: false } } } as const;
type CatalogRow = { entry_id: string; state: string; engine: string;
  provider_id: string; upstream_model_id: string; context_window: number;
  capability_profile: unknown };
type PriceRow = { model_id: string; display_name: string;
  input_per_mtok: string; output_per_mtok: string;
  cache_read_per_mtok: string; cache_write_per_mtok: string;
  multiplier: string; enabled: boolean; visibility: string;
  sort_order: number; default_effort: string | null;
  extra_system_prompt: string | null; min_plan_code: string | null;
  lock_version: number };
const PRICE_COLUMNS = `model_id,display_name,input_per_mtok::text,output_per_mtok::text,
  cache_read_per_mtok::text,cache_write_per_mtok::text,multiplier::text,
  enabled,visibility,sort_order,default_effort,extra_system_prompt,
  min_plan_code,lock_version`;
function assertion(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function exactCatalog(row: CatalogRow): boolean {
  return row.engine === VERSION.engine && row.provider_id === VERSION.provider_id
    && row.upstream_model_id === VERSION.upstream_model_id
    && row.context_window === VERSION.context_window
    && isDeepStrictEqual(row.capability_profile, VERSION.capability_profile)
    && ["staged", "active", "disabled"].includes(row.state);
}
function exactPrice(row: PriceRow, source: PriceRow): boolean {
  return row.model_id === MODEL && row.display_name === "Box Claude Opus 5.5"
    && row.visibility === "admin" && !row.enabled && row.sort_order === 289
    && row.default_effort === null && row.extra_system_prompt === null
    && row.min_plan_code === null
    && row.input_per_mtok === source.input_per_mtok
    && row.output_per_mtok === source.output_per_mtok
    && row.cache_read_per_mtok === source.cache_read_per_mtok
    && row.cache_write_per_mtok === source.cache_write_per_mtok
    && Number(row.multiplier) === Number(source.multiplier);
}
async function main(): Promise<void> {
  const mode = process.argv[2] ?? "plan";
  assertion(mode === "plan" || mode === "stage", "BOX_CATALOG_MODE_INVALID");
  assertion(hostname() === "v3-dev-sg" && getRuntimeChannel() === "v5"
    && process.env.OCV5_289_ACK_ACCOUNT_ID === "20"
    && process.env.OCV5_289_ACK_USER_ID === "3",
  "BOX_CATALOG_SELFHOST_BOUNDARY_INVALID");
  if (mode === "stage") assertion(process.env.OCV5_289_CATALOG_STAGE_ACK === "1",
    "BOX_CATALOG_STAGE_ACK_REQUIRED");
  const normalized = normalizeVersionInput(VERSION);
  assertion(validateVersionSemantics(normalized).length === 0,
    "BOX_CATALOG_VERSION_INVALID");
  const pool = getPool();
  try {
    const db = await pool.query<{ name: string }>("SELECT current_database() AS name");
    assertion(db.rows[0]?.name === "openclaude_v5_selfhost", "BOX_CATALOG_DATABASE_INVALID");
    const source = await pool.query<PriceRow>(
      `SELECT ${PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1`, [SOURCE]);
    const rate = source.rows[0];
    assertion(source.rows.length === 1 && rate?.enabled && rate.visibility === "public"
      && [rate.input_per_mtok, rate.output_per_mtok,
        rate.cache_read_per_mtok, rate.cache_write_per_mtok]
        .every((v) => /^\d+$/.test(v) && BigInt(v) >= 0n)
      && BigInt(rate.input_per_mtok) > 0n && BigInt(rate.output_per_mtok) > 0n
      && Number(rate.multiplier) > 0 && Number(rate.multiplier) <= 5,
    "BOX_CATALOG_SOURCE_PRICE_INVALID");
    let catalog = await pool.query<CatalogRow>(
      `SELECT entry_id::text,state,engine,provider_id,upstream_model_id,
          context_window,capability_profile FROM model_catalog WHERE model_id=$1
          AND state IN ('staged','active','disabled')`, [MODEL]);
    assertion(catalog.rows.length <= 1
      && (!catalog.rows[0] || exactCatalog(catalog.rows[0])),
    "BOX_CATALOG_EXISTING_CONFLICT");
    let price = await pool.query<PriceRow>(
      `SELECT ${PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1`, [MODEL]);
    assertion(price.rows.length <= 1
      && (!price.rows[0] || exactPrice(price.rows[0], rate)),
    "BOX_CATALOG_PRICE_CONFLICT");
    if (mode === "stage" && !catalog.rows[0]) {
      await assertModelCatalogAdminPoolConfigured();
      await createStaged(VERSION, { adminId: UID,
        userAgent: "ocv5-289-box-catalog-stage" });
      catalog = await pool.query<CatalogRow>(
        `SELECT entry_id::text,state,engine,provider_id,upstream_model_id,
            context_window,capability_profile FROM model_catalog WHERE model_id=$1
            AND state IN ('staged','active','disabled')`, [MODEL]);
      assertion(catalog.rows.length === 1 && catalog.rows[0]!.state === "staged"
        && exactCatalog(catalog.rows[0]!), "BOX_CATALOG_STAGE_UNPROVEN");
    }
    if (mode === "stage" && !price.rows[0]) {
      assertion(catalog.rows[0]?.state === "staged", "BOX_CATALOG_PRICE_REQUIRES_STAGE");
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query<PriceRow>(
          `SELECT ${PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1 FOR SHARE`, [SOURCE]);
        assertion(locked.rows.length === 1 && locked.rows[0]?.enabled
          && isDeepStrictEqual(locked.rows[0], rate),
        "BOX_CATALOG_SOURCE_PRICE_CHANGED");
        const inserted = await client.query<PriceRow>(
          `INSERT INTO model_pricing
             (model_id,display_name,input_per_mtok,output_per_mtok,
              cache_read_per_mtok,cache_write_per_mtok,multiplier,
              enabled,visibility,sort_order,updated_by,default_effort,
              extra_system_prompt,min_plan_code)
           VALUES ($1,$2,$3,$4,$5,$6,$7,false,'admin',289,$8,NULL,NULL,NULL)
           ON CONFLICT (model_id) DO NOTHING
           RETURNING ${PRICE_COLUMNS}`,
          [MODEL, "Box Claude Opus 5.5", rate.input_per_mtok,
            rate.output_per_mtok, rate.cache_read_per_mtok,
            rate.cache_write_per_mtok, rate.multiplier, UID.toString()]);
        if (inserted.rowCount === 1) {
          await writeAdminAudit(client, { adminId: UID, action: "pricing.create",
            target: `model:${MODEL}`, before: null,
            after: { model_id: MODEL, enabled: false, visibility: "admin",
              priceSource: SOURCE, sourceLockVersion: rate.lock_version,
              inputPerMtok: rate.input_per_mtok,
              outputPerMtok: rate.output_per_mtok,
              cacheReadPerMtok: rate.cache_read_per_mtok,
              cacheWritePerMtok: rate.cache_write_per_mtok,
              multiplier: rate.multiplier } });
        } else {
          const concurrent = await client.query<PriceRow>(
            `SELECT ${PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1`, [MODEL]);
          assertion(concurrent.rows.length === 1 && exactPrice(concurrent.rows[0]!, rate),
            "BOX_CATALOG_PRICE_CONCURRENT_CONFLICT");
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      } finally { client.release(); }
      price = await pool.query<PriceRow>(
        `SELECT ${PRICE_COLUMNS} FROM model_pricing WHERE model_id=$1`, [MODEL]);
    }
    assertion(mode !== "stage" || (catalog.rows[0]?.state === "staged"
      && price.rows.length === 1 && exactPrice(price.rows[0]!, rate)),
    "BOX_CATALOG_STAGED_STATE_INVALID");
    process.stdout.write(JSON.stringify({ model: MODEL, mode,
      catalogState: catalog.rows[0]?.state ?? "absent",
      pricingState: price.rows[0] ? "disabled-admin" : "absent",
      sourceModel: SOURCE, sourceRateLockVersion: rate.lock_version,
      exposed: false, migrationRun: false }) + "\n");
  } finally {
    await Promise.allSettled([closePool(), closeModelCatalogAdminPool()]);
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.message)
    ? error.message : "BOX_CATALOG_STAGE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
