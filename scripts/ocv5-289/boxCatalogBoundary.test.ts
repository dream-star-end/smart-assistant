import test from "node:test";
import assert from "node:assert/strict";
import { sameSelfhostCatalogEndpoint } from "./boxCatalogBoundary.js";

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
