import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ActiveIncidentEntry, visibleIncidentsForUser } from "../selfheal/sweeper.js";

function payload(id: string) {
  return {
    type: "sys.incident" as const,
    incidentId: id,
    rev: 1,
    status: "open" as const,
    severity: "warning" as const,
    surface: "x",
    title: "t",
    message: "m",
    ts: 0,
  };
}
function entry(id: string, audience: string, recipients: string[] = []): ActiveIncidentEntry {
  return { payload: payload(id), audience, recipients: new Set(recipients) };
}

describe("visibleIncidentsForUser — B2 targeted-incident isolation", () => {
  const entries: ActiveIncidentEntry[] = [
    entry("all-1", "all"),
    entry("u-1", "user_ids", ["7"]),
    entry("u-2", "user_ids", ["9"]),
    entry("cohort-1", "surface_cohort"),
  ];
  const ids = (uid: string) => visibleIncidentsForUser(entries, uid).map((p) => p.incidentId).sort();

  it("everyone sees audience=all; its own recipient sees its user_ids incident", () => {
    assert.deepEqual(ids("7"), ["all-1", "u-1"]);
    assert.deepEqual(ids("9"), ["all-1", "u-2"]);
  });

  it("user_ids incidents NEVER leak across users (the B2 regression fence)", () => {
    assert.ok(!ids("7").includes("u-2"), "user 7 must not see user 9's incident");
    assert.ok(!ids("9").includes("u-1"), "user 9 must not see user 7's incident");
  });

  it("a non-recipient sees only broadcast — no targeted incident at all", () => {
    assert.deepEqual(ids("999"), ["all-1"]);
  });

  it("surface_cohort is fail-closed — visible to nobody (never broadcast)", () => {
    for (const uid of ["7", "9", "999"]) {
      assert.ok(!ids(uid).includes("cohort-1"), `surface_cohort must not leak to ${uid}`);
    }
  });
});
