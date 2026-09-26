import test from "node:test";
import assert from "node:assert/strict";
import { boxCatalogActivationAction, sameSelfhostCatalogEndpoint } from
  "./boxCatalogBoundary.js";

const app = "postgres://app:synthetic@127.0.0.1:5432/openclaude_v5_selfhost";
const admin = "postgres://catalog_admin:synthetic@127.0.0.1:5432/openclaude_v5_selfhost";
test("catalog staging permits only separate roles on the same exact selfhost endpoint", () => {
  assert.equal(sameSelfhostCatalogEndpoint(app, admin), true);
  for (const bad of [
    "postgres://catalog_admin:synthetic@127.0.0.1:5432/commercial_prod",
    "postgres://catalog_admin:synthetic@127.0.0.2:5432/openclaude_v5_selfhost",
    "postgres://catalog_admin:synthetic@127.0.0.1:5433/openclaude_v5_selfhost",
    "postgres://catalog_admin:synthetic@127.0.0.1:5432/openclaude_v5_selfhost?host=elsewhere",
    "postgres://app:synthetic@127.0.0.1:5432/openclaude_v5_selfhost",
    "postgres://catalog_admin@127.0.0.1:5432/openclaude_v5_selfhost",
  ]) assert.equal(sameSelfhostCatalogEndpoint(app, bad), false, bad);
});
test("catalog activation never enables pricing before the staged catalog transition", () => {
  assert.equal(boxCatalogActivationAction("staged", false), "activate");
  assert.equal(boxCatalogActivationAction("disabled", false), "activate");
  assert.equal(boxCatalogActivationAction("active", true), "already_active");
  for (const [state, enabled] of [["staged", true], ["active", false],
    ["disabled", true]]) {
    assert.throws(() => boxCatalogActivationAction(String(state), Boolean(enabled)),
      /BOX_CATALOG_STATE_MIRROR_INVALID/);
  }
});
