#!/usr/bin/env tsx
/**
 * OCV5-20 §2.8 incidents / trailer "only grow, never drop" gate.
 * Does not replace check-v5-incident-regressions.ts; it adds the union
 * baseline ratchet. Tree hash equality is not a skip condition.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LedgerIncident = {
  id: string;
  rootFixCommit?: string;
  coverageCommits?: string[];
};

export type IncidentManifest = {
  incidents: LedgerIncident[];
};

export type LedgerBaseline = {
  schema: number;
  frozenAt: string;
  auroraTip: string;
  selfhostTip: string;
  incidentIds: string[];
  incidents: Record<string, { rootFixCommit: string; coverageCommits?: string[] }>;
  importedTrailerHistoryTips: string[];
  historicallyPresentIds: string[];
};

export type Tombstone = {
  id: string;
  removedAt: string;
  removedInCommit: string;
  reason: string;
  approver: string;
  codeStillInTree: string;
};

export type TombstoneFile = {
  schema: number;
  tombstones: Tombstone[];
};

export type SupersetInput = {
  root?: string;
  baseline?: LedgerBaseline;
  mergedIncidents?: LedgerIncident[];
  tombstones?: Tombstone[];
  trailerTips?: string[];
  skipGit?: boolean;
};

export type SupersetResult = { ok: true } | { ok: false; errors: string[] };

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

export function parseImportedTrailerTips(checkerSource: string): string[] {
  const block = /const IMPORTED_TRAILER_HISTORY_TIPS = \[([\s\S]*?)\] as const/.exec(checkerSource);
  if (!block) return [];
  return [...block[1].matchAll(/"([0-9a-f]{40})"/g)].map((m) => m[1]);
}

function isAncestor(root: string, sha: string, head = "HEAD"): boolean {
  try {
    git(root, "cat-file", "-e", `${sha}^{commit}`);
    execFileSync("git", ["merge-base", "--is-ancestor", sha, head], { cwd: root });
    return true;
  } catch {
    return false;
  }
}

export function checkIncidentLedgerSuperset(input: SupersetInput = {}): SupersetResult {
  const errors: string[] = [];
  const root = input.root ?? DEFAULT_ROOT;
  const baseline = input.baseline ?? (JSON.parse(
    readFileSync(join(root, "e2e/session-display/incident-ledger-baseline.json"), "utf8"),
  ) as LedgerBaseline);
  const merged = input.mergedIncidents ?? ((JSON.parse(
    readFileSync(join(root, "e2e/session-display/incidents.json"), "utf8"),
  ) as IncidentManifest).incidents);
  const tombstones = input.tombstones ?? ((existsSync(join(root, "e2e/session-display/incident-tombstones.json"))
    ? (JSON.parse(readFileSync(join(root, "e2e/session-display/incident-tombstones.json"), "utf8")) as TombstoneFile).tombstones
    : []));
  const trailerTips = input.trailerTips ?? parseImportedTrailerTips(
    readFileSync(join(root, "scripts/check-v5-incident-regressions.ts"), "utf8"),
  );

  if (baseline.schema !== 1) errors.push(`baseline schema must be 1, got ${baseline.schema}`);
  if (!Array.isArray(baseline.incidentIds) || baseline.incidentIds.length === 0) {
    errors.push("baseline.incidentIds must be a non-empty union");
  }

  const mergedIds = new Set(merged.map((item) => item.id));
  const tombstoneIds = new Set(tombstones.map((item) => item.id));
  const missing = baseline.incidentIds.filter((id) => !mergedIds.has(id) && !tombstoneIds.has(id));
  if (missing.length > 0) {
    errors.push(`merged incidents missing baseline ids (no tombstone): ${missing.join(", ")}`);
  }

  for (const id of baseline.incidentIds) {
    const frozen = baseline.incidents[id];
    if (!frozen?.rootFixCommit) {
      errors.push(`baseline missing rootFixCommit for ${id}`);
      continue;
    }
    const live = merged.find((item) => item.id === id);
    if (!live) continue;
    if (live.rootFixCommit !== frozen.rootFixCommit) {
      errors.push(`${id}: rootFixCommit rewritten ${frozen.rootFixCommit} → ${live.rootFixCommit}`);
    }
    const frozenCoverage = frozen.coverageCommits ?? [];
    const liveCoverage = live.coverageCommits ?? [];
    for (const sha of frozenCoverage) {
      if (!liveCoverage.includes(sha)) {
        errors.push(`${id}: coverage commit ${sha} was shortened/removed`);
      }
    }
    if (!input.skipGit) {
      for (const sha of [live.rootFixCommit, ...liveCoverage]) {
        if (sha && !isAncestor(root, sha)) {
          errors.push(`${id}: lineage ${sha} is not an ancestor of HEAD`);
        }
      }
    }
  }

  const missingTips = baseline.importedTrailerHistoryTips.filter((tip) => !trailerTips.includes(tip));
  if (missingTips.length > 0) {
    errors.push(`IMPORTED_TRAILER_HISTORY_TIPS missing baseline tips: ${missingTips.join(", ")}`);
  }
  if (!input.skipGit) {
    for (const tip of baseline.importedTrailerHistoryTips) {
      if (!isAncestor(root, tip)) {
        errors.push(`trailer tip ${tip.slice(0, 12)} is not an ancestor of HEAD`);
      }
    }
  }

  for (const id of baseline.historicallyPresentIds ?? []) {
    if (!mergedIds.has(id) && !tombstoneIds.has(id)) {
      errors.push(`historicallyPresentId ${id} is in neither incidents nor tombstones`);
    }
  }

  for (const stone of tombstones) {
    const fields: Array<keyof Tombstone> = [
      "id", "removedAt", "removedInCommit", "reason", "approver", "codeStillInTree",
    ];
    for (const field of fields) {
      if (!String(stone[field] ?? "").trim()) {
        errors.push(`tombstone ${stone.id ?? "?"} missing ${field}`);
      }
    }
    if (stone.removedAt && !/^2026-[0-9]{2}-[0-9]{2}$/.test(stone.removedAt)) {
      errors.push(`tombstone ${stone.id} removedAt must be YYYY-MM-DD`);
    }
    if (!input.skipGit && stone.codeStillInTree && !isAncestor(root, stone.codeStillInTree)) {
      errors.push(`tombstone ${stone.id}: codeStillInTree ${stone.codeStillInTree} is not a HEAD ancestor`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

function isCli(): boolean {
  const thisFile = resolve(fileURLToPath(import.meta.url));
  return process.argv[1] ? resolve(process.argv[1]) === thisFile : false;
}

if (isCli()) {
  const result = checkIncidentLedgerSuperset();
  if (!result.ok) {
    for (const err of result.errors) {
      process.stderr.write(`[incident-ledger-superset] ${err}\n`);
    }
    process.stderr.write(`[incident-ledger-superset] FAIL: ${result.errors.length} error(s)\n`);
    process.exit(1);
  }
  process.stdout.write("[incident-ledger-superset] PASS: merged incidents/trailers are a superset of the dual-branch baseline\n");
}
