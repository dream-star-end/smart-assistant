import assert from "node:assert/strict";

/** Fixed v1 projection recorded from the old98 synthetic uid3 Haiku catalog.
 * Owner/format must not create CONFIG_CHANGED for older gateway/egress pairs. */
export const BOX_LOCAL_CATALOG_V1_REVISION = "c740fdfdd0e204f1be741962ab8f19c88921e41ff8f891f6e1e0883ef3adcc91";

export async function proveLocalCatalogOwner(api: {
  localCatalogOwner: (legacyWire: Record<string, unknown>) => Promise<Record<string, unknown>>;
}): Promise<string> {
  const legacyWire = {
    models: [{ model_id: "box-api-claude-haiku-5-5", display_name: "box-api-claude-haiku-5-5",
      engine: "ccb", provider_id: "box_cli", context_window: 200000, supported_efforts: ["low"],
      supports_vision: false, capability_zero: true, supports_thinking: false, default_effort: "low",
      available: true, input_per_mtok: "100", output_per_mtok: "500", cache_read_per_mtok: "10",
      cache_write_per_mtok: "100", multiplier: "1.000" }],
    projection_revision: BOX_LOCAL_CATALOG_V1_REVISION,
    availability_revision: "fixture-availability", security_epoch: "5", aliases: {}, agent_cost_overrides: {},
  };
  const result = await api.localCatalogOwner(legacyWire);
  assert.equal(result.wireOwner, "box-native-v1", "LOCAL_OWNER_NOT_ISSUED");
  assert.equal(result.descriptorOwner, "box-native-v1", "LOCAL_OWNER_NOT_FORWARDED");
  assert.equal(result.coldOwner, "box-native-v1", "LOCAL_OWNER_LOST_ON_COLD_LKG");
  assert.equal(result.projectionFormat, 2, "LOCAL_OWNER_LEGACY_CACHE_NOT_UPGRADED");
  assert.equal(result.fullFetches, 1, "LOCAL_OWNER_EXPECT_ONE_UPGRADE_FULL_FETCH");
  assert.equal(result.projectionRevision, BOX_LOCAL_CATALOG_V1_REVISION, "LOCAL_OWNER_V1_REVISION_CHANGED");
  assert.deepEqual(result.token, { v: 1, kind: "local_catalog",
    projectionRevision: BOX_LOCAL_CATALOG_V1_REVISION, securityEpoch: "5" }, "LOCAL_OWNER_V1_TOKEN_CHANGED");
  assert.equal(result.gateKind, "local_catalog", "LOCAL_OWNER_V1_TOKEN_REJECTED");
  return "[ocv5-518-local-catalog-owner] PASS — the trusted owner reaches a cold delegate descriptor after legacy LKG upgrade while the original v1 token remains accepted";
}
