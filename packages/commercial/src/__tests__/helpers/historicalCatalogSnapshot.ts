/**
 * loadCatalogSnapshot() against a schema frozen before 0224/0256.
 *
 * HEAD SQL selects model_pricing.min_plan_code (0224) and promo_label (0256).
 * Single-migration replay tests stop before those columns exist, so they must
 * not call the production loader. This helper uses the same snapshot object
 * and catalog/alias queries, with plan-gate columns filled as null.
 */
import { getPool } from "../../db/index.js";
import {
  ModelCatalogSnapshot,
  parseCapabilityProfile,
  type ModelCatalogEntry,
  type ModelCatalogPricing,
  type ModelCatalogState,
  type ModelEngine,
} from "../../billing/modelCatalog.js";

type CatalogRow = {
  entry_id: string;
  model_id: string;
  engine: string;
  provider_id: string | null;
  upstream_model_id: string | null;
  context_window: number | null;
  capability_profile: unknown;
  capability_schema_version: number;
  state: string;
  lock_version: number;
};

type PricingRow = {
  model_id: string;
  display_name: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string;
  cache_write_per_mtok: string;
  multiplier: string;
  visibility: string;
  sort_order: number;
  default_effort: string | null;
};

export async function loadCatalogSnapshotPrePlanGate(): Promise<ModelCatalogSnapshot> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const epochRes = await client.query<{ epoch: string }>(
      "SELECT epoch::text AS epoch FROM model_security_epoch",
    );
    if (epochRes.rows.length !== 1) {
      throw new Error("model_security_epoch: expected exactly one row");
    }
    const catalog = await client.query<CatalogRow>(
      `SELECT entry_id::text AS entry_id, model_id, engine, provider_id, upstream_model_id,
              context_window, capability_profile, capability_schema_version, state, lock_version
         FROM model_catalog`,
    );
    const aliases = await client.query<{ alias: string; entry_id: string }>(
      "SELECT alias, entry_id::text AS entry_id FROM model_aliases",
    );
    const pricing = await client.query<PricingRow>(
      `SELECT p.model_id, p.display_name,
              p.input_per_mtok::text       AS input_per_mtok,
              p.output_per_mtok::text      AS output_per_mtok,
              p.cache_read_per_mtok::text  AS cache_read_per_mtok,
              p.cache_write_per_mtok::text AS cache_write_per_mtok,
              p.multiplier::text           AS multiplier,
              p.visibility, p.sort_order, p.default_effort
         FROM model_pricing p`,
    );
    await client.query("COMMIT");

    const entries: ModelCatalogEntry[] = catalog.rows.map((r) => ({
      entryId: Number(r.entry_id),
      modelId: r.model_id,
      engine: r.engine as ModelEngine,
      providerId: r.provider_id,
      upstreamModelId: r.upstream_model_id,
      contextWindow: r.context_window,
      capabilityProfile: parseCapabilityProfile(r.model_id, r.capability_profile),
      capabilitySchemaVersion: r.capability_schema_version,
      state: r.state as ModelCatalogState,
      lockVersion: r.lock_version,
    }));
    const pricingMap = new Map<string, ModelCatalogPricing>();
    for (const r of pricing.rows) {
      pricingMap.set(r.model_id, {
        modelId: r.model_id,
        displayName: r.display_name,
        inputPerMtok: BigInt(r.input_per_mtok),
        outputPerMtok: BigInt(r.output_per_mtok),
        cacheReadPerMtok: BigInt(r.cache_read_per_mtok),
        cacheWritePerMtok: BigInt(r.cache_write_per_mtok),
        multiplier: r.multiplier,
        visibility: r.visibility as ModelCatalogPricing["visibility"],
        sortOrder: r.sort_order,
        defaultEffort: r.default_effort,
        minPlanCode: null,
        minPlanTier: null,
        minPlanName: null,
        promoLabel: null,
      });
    }
    return new ModelCatalogSnapshot({
      entries,
      aliases: new Map(aliases.rows.map((row) => [row.alias, Number(row.entry_id)])),
      pricing: pricingMap,
      securityEpoch: BigInt(epochRes.rows[0]!.epoch),
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* original error wins */
    }
    throw err;
  } finally {
    client.release();
  }
}
