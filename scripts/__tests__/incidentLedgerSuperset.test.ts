import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkIncidentLedgerSuperset,
  parseImportedTrailerTips,
  type LedgerBaseline,
  type LedgerIncident,
  type Tombstone,
} from "../check-incident-ledger-superset.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/incident-ledger");
const PHASE_B = "INC-20260827-PHASE-B-DEFER-VANISH";

function loadIds(name: string): string[] {
  return (JSON.parse(readFileSync(path.join(fixtures, name), "utf8")) as { ids: string[] }).ids;
}

function baseline(): LedgerBaseline {
  return JSON.parse(
    readFileSync(path.join(root, "e2e/session-display/incident-ledger-baseline.json"), "utf8"),
  ) as LedgerBaseline;
}

function asIncidents(ids: string[]): LedgerIncident[] {
  const frozen = baseline().incidents;
  return ids.map((id) => ({
    id,
    rootFixCommit: frozen[id]?.rootFixCommit ?? "0002df13",
    coverageCommits: frozen[id]?.coverageCommits ?? [],
  }));
}

const trailerTips = parseImportedTrailerTips(
  readFileSync(path.join(root, "scripts/check-v5-incident-regressions.ts"), "utf8"),
);

describe("incident ledger superset", () => {
  test("current tree is a superset of the dual-branch baseline", () => {
    const result = checkIncidentLedgerSuperset({ root });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  });

  test("replay: 4a03d9200 has PHASE-B, 24d43a6cf dropped it without tombstone → FAIL", () => {
    const parent = loadIds("parent-4a03d9200.ids.json");
    const child = loadIds("child-24d43a6cf.ids.json");
    assert.ok(parent.includes(PHASE_B));
    assert.ok(!child.includes(PHASE_B));
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      baseline: baseline(),
      mergedIncidents: asIncidents(child),
      tombstones: [],
      trailerTips,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => err.includes(PHASE_B)), result.ok ? "" : result.errors.join("\n"));
  });

  test("union of both sides passes", () => {
    const selfhost = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents;
    const auroraIds = loadIds("aurora-tip.ids.json");
    const byId = new Map(selfhost.map((item) => [item.id, item]));
    for (const id of auroraIds) {
      if (!byId.has(id)) byId.set(id, { id, rootFixCommit: baseline().incidents[id]?.rootFixCommit ?? "deadbeef" });
    }
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      baseline: baseline(),
      mergedIncidents: [...byId.values()],
      tombstones: [],
      trailerTips,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  });

  test("selecting aurora-only ids (missing selfhost PHASE-B) fails", () => {
    const auroraIds = loadIds("aurora-tip.ids.json");
    assert.ok(!auroraIds.includes(PHASE_B));
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      baseline: baseline(),
      mergedIncidents: asIncidents(auroraIds),
      tombstones: [],
      trailerTips,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => err.includes(PHASE_B)));
  });

  test("B7: fake approver human without Tombstone-Approval trailer is red", () => {
    const selfhost = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents.filter((item) => item.id !== PHASE_B);
    const stone: Tombstone = {
      id: PHASE_B,
      removedAt: "2026-08-27",
      removedInCommit: "24d43a6cf",
      reason: "fence proofPending baseline; replay fixture",
      approver: "human",
      codeStillInTree: "0002df137",
      approval: { trailer: "looks-approved", commit: "notasha" },
    };
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: null,
      baseline: baseline(),
      mergedIncidents: selfhost,
      tombstones: [stone],
      trailerTips,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => /approval|40-hex|Tombstone-Approval/.test(err)));
  });

  test("B7: fake approver, mismatched trailer, and fictional deletion SHA are red", () => {
    const selfhost = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents.filter((item) => item.id !== PHASE_B);
    const stone: Tombstone = {
      id: PHASE_B,
      removedAt: "2026-08-27",
      removedInCommit: "a".repeat(40),
      reason: "fence proofPending baseline; replay fixture",
      approver: "fake-approver",
      codeStillInTree: "0002df137",
      approval: {
        trailer: `Tombstone-Approval: ${PHASE_B} claimed-boss`,
        commit: "b".repeat(40),
      },
    };
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: null,
      baseline: baseline(),
      mergedIncidents: selfhost,
      tombstones: [stone],
      trailerTips,
    });
    assert.equal(result.ok, false);
    const blob = result.ok ? "" : result.errors.join("\n");
    assert.ok(/trusted human|dual DAG|trailer approver/.test(blob), blob);
  });

  test("B7: trusted approver with real dual-DAG SHAs may tombstone under skipGit", () => {
    const selfhost = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents.filter((item) => item.id !== PHASE_B);
    const stone: Tombstone = {
      id: PHASE_B,
      removedAt: "2026-08-27",
      removedInCommit: "24d43a6cf3a83609a598a1798fe90076fff29a5e",
      reason: "fence proofPending baseline; replay fixture",
      approver: "dream-star-end",
      codeStillInTree: "0002df137deb056dfc501146aa621dcfb912bf0e",
      approval: {
        trailer: `Tombstone-Approval: ${PHASE_B} dream-star-end`,
        commit: "0002df137deb056dfc501146aa621dcfb912bf0e",
      },
    };
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: null,
      baseline: baseline(),
      mergedIncidents: selfhost,
      tombstones: [stone],
      trailerTips,
    });
    assert.equal(result.ok, true, result.ok ? "" : result.errors.join("\n"));
  });

  test("B7: rewriting an existing tombstone in place is red", () => {
    const selfhost = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents.filter((item) => item.id !== PHASE_B);
    const original: Tombstone = {
      id: PHASE_B,
      removedAt: "2026-08-27",
      removedInCommit: "24d43a6cf3a83609a598a1798fe90076fff29a5e",
      reason: "original reason",
      approver: "dream-star-end",
      codeStillInTree: "0002df137deb056dfc501146aa621dcfb912bf0e",
      approval: {
        trailer: `Tombstone-Approval: ${PHASE_B} dream-star-end`,
        commit: "0002df137deb056dfc501146aa621dcfb912bf0e",
      },
    };
    const rewritten: Tombstone = { ...original, reason: "rewritten in place" };
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: null,
      baseline: baseline(),
      mergedIncidents: selfhost,
      previousTombstones: [original],
      tombstones: [rewritten],
      trailerTips,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => err.includes("rewritten in place")), result.ok ? "" : result.errors.join("\n"));
  });

  test("B6: wrong sha256 pin is red even when previous freeze exists", () => {
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: baseline(),
      pin: "0".repeat(64),
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => /sha256/.test(err) && /pin/.test(err)), result.ok ? "" : result.errors.join("\n"));
  });

  test("B6: shrinking baseline together with the ledger is still red", () => {
    const full = baseline();
    const shrunk = {
      ...full,
      incidentIds: full.incidentIds.filter((id) => id !== PHASE_B),
      historicallyPresentIds: [],
    };
    delete shrunk.incidents[PHASE_B];
    const merged = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents.filter((item) => item.id !== PHASE_B);
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: full,
      baseline: shrunk,
      mergedIncidents: merged,
      tombstones: [],
      trailerTips,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => err.includes("shrank") && err.includes(PHASE_B)));
  });

  test("B7: deleting a previous tombstone is red", () => {
    const stone: Tombstone = {
      id: PHASE_B,
      removedAt: "2026-08-27",
      removedInCommit: "24d43a6cf3a83609a598a1798fe90076fff29a5e",
      reason: "x",
      approver: "dream-star-end",
      codeStillInTree: "0002df137deb056dfc501146aa621dcfb912bf0e",
      approval: {
        trailer: `Tombstone-Approval: ${PHASE_B} dream-star-end`,
        commit: "0002df137deb056dfc501146aa621dcfb912bf0e",
      },
    };
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      previousBaseline: null,
      baseline: baseline(),
      mergedIncidents: (JSON.parse(
        readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
      ) as { incidents: LedgerIncident[] }).incidents,
      previousTombstones: [stone],
      tombstones: [],
      trailerTips,
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => err.includes("tombstones shrank")));
  });

  test("dropping a trailer tip fails", () => {
    const selfhost = (JSON.parse(
      readFileSync(path.join(root, "e2e/session-display/incidents.json"), "utf8"),
    ) as { incidents: LedgerIncident[] }).incidents;
    const frozen = baseline();
    const droppedTip = frozen.importedTrailerHistoryTips.at(-1);
    assert.ok(droppedTip);
    const result = checkIncidentLedgerSuperset({
      root,
      skipGit: true,
      baseline: frozen,
      mergedIncidents: selfhost,
      tombstones: [],
      trailerTips: trailerTips.filter((tip) => tip !== droppedTip),
    });
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.errors.some((err) => err.includes("TRAILER") || err.includes("trailer") || err.includes("missing baseline tips")));
  });
});
