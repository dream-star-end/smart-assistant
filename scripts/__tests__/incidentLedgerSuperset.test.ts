import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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

// OCV5-188: executes the unmodified candidate CLI against metadata fixtures.
// No marker is installed here: this does NOT claim historical trailer coverage,
// nor execution of the synthetic proof artifact. Full repository gate is separate.
const severityCheckerPath = path.join(root, "scripts/check-v5-incident-regressions.ts");
const severityCheckerBytes = readFileSync(severityCheckerPath);
const severityCheckerHash = createHash("sha256").update(severityCheckerBytes).digest("hex");
const severityLoader = createRequire(import.meta.url).resolve("tsx");
const severityCatalog = [
  "P0 accepted", "P1 accepted", "P2 accepted", "P3 rejected", "lowercase rejected",
  "empty rejected", "numeric rejected", "missing rejected", "padded rejected",
  "regressions required", "proof declaration required", "artifact required",
  "assertion required", "runner required", "lineage required", "pending ceiling preserved",
] as const;

type SeverityFixture = {
  dir: string;
  manifest: { schema: number; scope: string; fixedLiveMatrix: object[]; incidents: any[] };
  unanchored: string;
  write: (rel: string, data: string) => void;
};
function makeSeverityFixture(): SeverityFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "oc-incident-severity-"));
  const write = (rel: string, data: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), data);
  };
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Incident Fixture", "-c", "user.email=fixture@example.invalid", ...args], {
    cwd: dir, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  }).trim();
  try {
    write("README.md", "isolated metadata admission fixture\n");
    git("init", "-q"); git("add", "."); git("commit", "-qm", "chore: fixture baseline");
    const unanchored = git("rev-parse", "HEAD").slice(0, 8);
    write("scripts/check-v5-incident-regressions.ts", severityCheckerBytes.toString("utf8"));
    write("package.json", JSON.stringify({ type: "module", fixture: "scripts/__tests__/p2Fixture.test.ts" }));
    write("scripts/__tests__/p2Fixture.test.ts", "// P2_UNIT_ASSERTION\n");
    write("scripts/p2-proof-fixture.ts", "// P2_PROOF_ASSERTION\n");
    write(".github/workflows/v5-ci.yml", "# test:v5:ops\n");
    write("scripts/deploy-v5.sh", "# p2-proof-fixture.ts\n");
    write("e2e/session-display/run.sh", 'MATRIX=(gpt-5.6-luna deepseek-v4-flash)\nOC_E2E_REQUIRE_DIRECT_TIMELINE=1\nOC_E2E_EMAIL="v5-evals@claudeai.chat"\nexport CI=1\n');
    mkdirSync(path.join(dir, "e2e/session-display/tests"), { recursive: true });
    git("add", "."); git("commit", "-qm", "test: fixture proof metadata");
    const rootFixCommit = git("rev-parse", "HEAD").slice(0, 8);
    const manifest = {
      schema: 2, scope: "metadata fixture; not a live deployment proof",
      fixedLiveMatrix: [{ engine: "codex", model: "gpt-5.6-luna" }, { engine: "ccb", model: "deepseek-v4-flash" }],
      incidents: [{ id: "INC-20260909-P2-GATE-SCHEMA", occurredAt: "2026-09-09", severity: "P2",
        symptom: "synthetic metadata admission", rootFixCommit,
        regressions: [
          { layer: "unit", path: "scripts/__tests__/p2Fixture.test.ts", assertion: "P2_UNIT_ASSERTION" },
          { layer: "deploy-gate", path: "scripts/p2-proof-fixture.ts", assertion: "P2_PROOF_ASSERTION" },
        ],
      }],
    };
    return { dir, write, manifest, unanchored };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
function runSeverityCli(f: SeverityFixture) {
  f.write("e2e/session-display/incidents.json", JSON.stringify(f.manifest));
  const result = spawnSync(process.execPath, ["--import", severityLoader, path.join(f.dir, "scripts/check-v5-incident-regressions.ts")], {
    cwd: f.dir, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: f.dir, LANG: "C.UTF-8", TZ: "UTC", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return { exit: result.status, signal: result.signal, error: result.error?.message ?? null,
    stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("incident severity CLI admission", () => {
  for (const name of severityCatalog) {
    test(name, () => {
      let f: SeverityFixture | undefined;
      let phase = "fixture";
      let before: ReturnType<typeof runSeverityCli> | undefined;
      let actual: ReturnType<typeof runSeverityCli> | undefined;
      let failure: string | null = null;
      let expected: { exit: string; reason: string } = { exit: "0", reason: "PASS" };
      try {
        f = makeSeverityFixture();
        // Every negative begins with the same real valid P2 fixture, not a
        // disconnected mock validator. P0/P1 positives also verify no regression.
        const item = f.manifest.incidents[0];
        if (name === "P0 accepted") item.severity = "P0";
        if (name === "P1 accepted") item.severity = "P1";
        phase = "positive precondition";
        before = runSeverityCli(f);
        assert.equal(before.error, null, JSON.stringify(before));
        assert.equal(before.signal, null, JSON.stringify(before));
        assert.equal(before.exit, 0, JSON.stringify(before));
        assert.match(before.stdout, /\[incident-regressions\] PASS:/);
        if (name.endsWith("accepted")) { actual = before; return; }
        phase = "mutation";
        let reason: RegExp;
        switch (name) {
          case "P3 rejected": item.severity = "P3"; reason = /severity must be P0\/P1\/P2/; break;
          case "lowercase rejected": item.severity = "p2"; reason = /severity must be P0\/P1\/P2/; break;
          case "empty rejected": item.severity = ""; reason = /severity must be P0\/P1\/P2/; break;
          case "numeric rejected": item.severity = 2; reason = /severity must be P0\/P1\/P2/; break;
          case "missing rejected": delete item.severity; reason = /severity must be P0\/P1\/P2/; break;
          case "padded rejected": item.severity = " P2 "; reason = /severity must be P0\/P1\/P2/; break;
          case "regressions required": item.regressions = []; reason = /no automated regression/; break;
          case "proof declaration required": item.regressions.pop(); reason = /必须写 proofPending/; break;
          case "artifact required": rmSync(path.join(f.dir, "scripts/p2-proof-fixture.ts")); reason = /missing scripts\/p2-proof-fixture/; break;
          case "assertion required": item.regressions[1].assertion = "ABSENT_ASSERTION"; reason = /找不到 assertion 锚点/; break;
          case "runner required": f.write("scripts/deploy-v5.sh", "# no proof call\n"); reason = /未调用 scripts\/p2-proof-fixture/; break;
          case "lineage required": item.rootFixCommit = f.unanchored; reason = /没有动过任何一条登记的证据/; break;
          case "pending ceiling preserved":
            item.regressions.pop();
            item.proofPending = { reason: "isolated valid unit-only record", since: "2026-09-09" };
            f.manifest.incidents = Array.from({ length: 12 }, (_, i) => ({ ...item, id: `INC-20260909-P2-PENDING-${String(i).padStart(2, "0")}` }));
            reason = /proofPending 事故 12 条 > 基线 11/; break;
          default: throw new Error(`unexpected catalog member: ${name}`);
        }
        expected = { exit: "nonzero", reason: reason.source };
        phase = "mutated CLI";
        actual = runSeverityCli(f);
        assert.equal(actual.error, null, JSON.stringify(actual));
        assert.equal(actual.signal, null, JSON.stringify(actual));
        assert.ok(typeof actual.exit === "number" && actual.exit !== 0, JSON.stringify(actual));
        assert.match(actual.stderr, reason);
        assert.doesNotMatch(actual.stdout, /\[incident-regressions\] PASS:/);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      } finally {
        if (f) rmSync(f.dir, { recursive: true, force: true });
        console.log(JSON.stringify({ contractId: `incident-severity:${name}`, catalogCount: severityCatalog.length,
          phase, sourceHash: severityCheckerHash, expected,
          precondition: before ? { exit: before.exit, signal: before.signal, error: before.error, pass: before.stdout.includes("[incident-regressions] PASS:") } : null,
          actual: actual ?? before ?? { notRun: true }, failure,
          cleanup: { directoryRemoved: f ? !existsSync(f.dir) : true },
          boundary: "real checker CLI/Git/metadata; synthetic proof not executed; no historical marker" }));
      }
    });
  }
});
