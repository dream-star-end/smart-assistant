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

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CatalogConflictError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function glm53ZaiCapabilityProfileForEngine(
  liveProfile: unknown,
  engine: "ccb" | "zcode",
): Record<string, unknown> {
  const profile = asRecord(liveProfile, "glm-5.3-zai capability_profile");
  const reasoning = asRecord(profile.reasoning, "glm-5.3-zai capability_profile.reasoning");
  asRecord(profile.ccb, "glm-5.3-zai capability_profile.ccb");
  return {
    ...profile,
    reasoning: {
      ...reasoning,
      // ZCode 0.16.3's Anthropic transport emits reasoning parts but has no
      // per-turn effort control. Advertising high/max would create a UI knob
      // that the adapter must ignore. CCB rollback restores the proven pair.
      supported: engine === "zcode" ? [] : ["high", "max"],
      codex_model_default: null,
    },
  };
}

export function glm53ZaiSupportedEfforts(profile: unknown): string[] {
  const root = asRecord(profile, "glm-5.3-zai capability_profile");
  const reasoning = asRecord(root.reasoning, "glm-5.3-zai capability_profile.reasoning");
  if (!Array.isArray(reasoning.supported) || !reasoning.supported.every((v) => typeof v === "string")) {
    throw new CatalogConflictError("glm-5.3-zai capability_profile.reasoning.supported must be strings");
  }
  return [...reasoning.supported];
}

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
  const targetProfile = glm53ZaiCapabilityProfileForEngine(live.capability_profile, next.engine);
  const out = await switchVersion(
    {
      model_id: GLM53_ZAI_MODEL_ID,
      engine: next.engine,
      provider_id: next.provider_id,
      upstream_model_id: "glm-5.3",
      context_window: 1000000,
      capability_profile: targetProfile,
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
    || JSON.stringify(glm53ZaiSupportedEfforts(after.capability_profile))
      !== JSON.stringify(next.engine === "zcode" ? [] : ["high", "max"])
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
