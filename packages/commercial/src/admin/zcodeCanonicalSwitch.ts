/**
 * Post-deploy atomic switch of public glm-5.3-zai between ccb and zcode.
 * Uses audited admin catalog switchVersion. Never run from a pre-cutover migration.
 */
import { CatalogConflictError, switchVersion, type AdminOpsCtx } from "./modelCatalogOps.js";
import { query } from "../db/queries.js";

export const GLM53_ZAI_MODEL_ID = "glm-5.3-zai";

export type Glm53ZaiLiveRow = {
  entry_id: string;
  engine: string;
  provider_id: string | null;
  upstream_model_id: string | null;
  context_window: number | null;
  capability_profile: unknown;
  capability_schema_version: number;
  state: string;
  lock_version: number;
};

async function loadLive(): Promise<Glm53ZaiLiveRow> {
  const r = await query<Glm53ZaiLiveRow>(
    `SELECT entry_id::text AS entry_id, engine, provider_id, upstream_model_id,
            context_window, capability_profile, capability_schema_version,
            state, lock_version
       FROM model_catalog
      WHERE model_id = $1 AND state IN ('staged','active','disabled')
      ORDER BY (state = 'active') DESC, (state = 'staged') DESC, entry_id DESC
      LIMIT 1`,
    [GLM53_ZAI_MODEL_ID],
  );
  const row = r.rows[0];
  if (!row) throw new CatalogConflictError("glm-5.3-zai has no live catalog row");
  return row;
}

export function evaluateGlm53ZaiSwitch(
  live: Glm53ZaiLiveRow,
  direction: "ccb-to-zcode" | "zcode-to-ccb",
  expectedLockVersion: number,
): { engine: "ccb" | "zcode"; provider_id: "zai" | "zcode" } {
  if (live.upstream_model_id !== "glm-5.3") {
    throw new CatalogConflictError("glm-5.3-zai upstream_model_id must remain glm-5.3");
  }
  if (live.context_window !== 1000000) {
    throw new CatalogConflictError("glm-5.3-zai context_window must remain 1000000");
  }
  if (live.state !== "active") {
    throw new CatalogConflictError("glm-5.3-zai must be active to switch engine");
  }
  if (live.lock_version !== expectedLockVersion) {
    throw new CatalogConflictError(
      `lock_version mismatch (expected ${expectedLockVersion}, current ${live.lock_version})`,
    );
  }
  if (direction === "ccb-to-zcode") {
    if (live.engine !== "ccb" || live.provider_id !== "zai") {
      throw new CatalogConflictError("precondition failed: glm-5.3-zai is not ccb/zai");
    }
    return { engine: "zcode", provider_id: "zcode" };
  }
  if (live.engine !== "zcode" || live.provider_id !== "zcode") {
    throw new CatalogConflictError("precondition failed: glm-5.3-zai is not zcode/zcode");
  }
  return { engine: "ccb", provider_id: "zai" };
}

export async function switchGlm53ZaiEngine(
  direction: "ccb-to-zcode" | "zcode-to-ccb",
  expectedLockVersion: number,
  ctx: AdminOpsCtx,
): Promise<{ entry_id: string; engine: "ccb" | "zcode" }> {
  const live = await loadLive();
  const next = evaluateGlm53ZaiSwitch(live, direction, expectedLockVersion);
  const out = await switchVersion(
    {
      model_id: GLM53_ZAI_MODEL_ID,
      engine: next.engine,
      provider_id: next.provider_id,
      upstream_model_id: "glm-5.3",
      context_window: 1000000,
      capability_profile: live.capability_profile,
      capability_schema_version: live.capability_schema_version,
    },
    expectedLockVersion,
    ctx,
  );
  const after = await loadLive();
  if (
    after.engine !== next.engine
    || after.provider_id !== next.provider_id
    || after.upstream_model_id !== "glm-5.3"
  ) {
    throw new CatalogConflictError("postcondition failed: glm-5.3-zai engine switch did not land");
  }
  const pricing = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM model_pricing WHERE model_id=$1 AND enabled IS TRUE`,
    [GLM53_ZAI_MODEL_ID],
  );
  if (pricing.rows[0]?.n !== "1") {
    throw new CatalogConflictError("postcondition failed: glm-5.3-zai pricing row missing");
  }
  return { entry_id: out.entry_id, engine: next.engine };
}
