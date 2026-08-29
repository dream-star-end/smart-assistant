#!/usr/bin/env tsx
/**
 * OCV5-20 §2.8 incidents / trailer "only grow, never drop" gate.
 * Candidate baseline must be a superset of the previous baseline from the
 * target branch / parent commit. Tombstones require a Tombstone-Approval
 * trailer and may only append.
 */
import { createHash } from "node:crypto";
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

export type TombstoneApproval = {
  trailer: string;
  commit: string;
};

export type Tombstone = {
  id: string;
  removedAt: string;
  removedInCommit: string;
  reason: string;
  approver: string;
  codeStillInTree: string;
  approval: TombstoneApproval;
};

export type TombstoneFile = {
  schema: number;
  tombstones: Tombstone[];
};

export type SupersetInput = {
  root?: string;
  baseline?: LedgerBaseline;
  previousBaseline?: LedgerBaseline | null;
  mergedIncidents?: LedgerIncident[];
  tombstones?: Tombstone[];
  previousTombstones?: Tombstone[];
  trailerTips?: string[];
  skipGit?: boolean;
  pin?: string;
  approvers?: string[];
};

export type SupersetResult = { ok: true } | { ok: false; errors: string[] };

const DEFAULT_ROOT = resolve(import.meta.dirname, "..");
const BASELINE_REL = "e2e/session-display/incident-ledger-baseline.json";
const TOMBSTONE_REL = "e2e/session-display/incident-tombstones.json";
const PIN_REL = "e2e/session-display/incident-ledger-baseline.sha256";
const APPROVERS_REL = "e2e/session-display/incident-tombstone-approvers.json";
const APPROVAL_RE = /^Tombstone-Approval: (INC-[0-9]{8}-[A-Z0-9-]{3,40}) (\S+)$/;

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

function gitShowJson<T>(root: string, rev: string, rel: string): T | null {
  try {
    return JSON.parse(git(root, "show", `${rev}:${rel}`)) as T;
  } catch {
    return null;
  }
}

export function loadPreviousBaseline(root: string): LedgerBaseline | null {
  const refs = [
    process.env.INCIDENT_LEDGER_BASE_REF,
    "origin/feat/v5-selfhost",
    "HEAD~1",
  ].filter((item): item is string => Boolean(item));
  for (const ref of refs) {
    const parsed = gitShowJson<LedgerBaseline>(root, ref, BASELINE_REL);
    if (parsed) return parsed;
  }
  return null;
}

export function loadTrustedApprovers(root: string): string[] {
  const path = join(root, APPROVERS_REL);
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { approvers?: unknown };
  return Array.isArray(parsed.approvers)
    ? parsed.approvers.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function commitExists(root: string, sha: string): boolean {
  if (!/^[0-9a-f]{40}$/.test(sha)) return false;
  try {
    git(root, "cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

function commitInDualDag(root: string, sha: string, baseline: LedgerBaseline): boolean {
  if (!commitExists(root, sha)) return false;
  for (const tip of [baseline.auroraTip, baseline.selfhostTip]) {
    if (!tip) continue;
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", sha, tip], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return true;
    } catch {
      /* try the other recorded tip */
    }
  }
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

function stableTombstone(stone: Tombstone): string {
  return JSON.stringify({
    id: stone.id,
    removedAt: stone.removedAt,
    removedInCommit: stone.removedInCommit,
    reason: stone.reason,
    approver: stone.approver,
    codeStillInTree: stone.codeStillInTree,
    approval: {
      trailer: stone.approval?.trailer ?? "",
      commit: stone.approval?.commit ?? "",
    },
  });
}

export function loadPreviousTombstones(root: string): Tombstone[] {
  const refs = [
    process.env.INCIDENT_LEDGER_BASE_REF,
    "origin/feat/v5-selfhost",
    "HEAD~1",
  ].filter((item): item is string => Boolean(item));
  for (const ref of refs) {
    const parsed = gitShowJson<TombstoneFile>(root, ref, TOMBSTONE_REL);
    if (parsed?.tombstones) return parsed.tombstones;
  }
  return [];
}

export function checkIncidentLedgerSuperset(input: SupersetInput = {}): SupersetResult {
  const errors: string[] = [];
  const root = input.root ?? DEFAULT_ROOT;
  const baselinePath = join(root, BASELINE_REL);
  const baseline = input.baseline ?? (JSON.parse(readFileSync(baselinePath, "utf8")) as LedgerBaseline);
  const previous = input.previousBaseline === undefined
    ? (input.skipGit ? null : loadPreviousBaseline(root))
    : input.previousBaseline;
  const merged = input.mergedIncidents ?? ((JSON.parse(
    readFileSync(join(root, "e2e/session-display/incidents.json"), "utf8"),
  ) as IncidentManifest).incidents);
  const tombstoneFile = existsSync(join(root, TOMBSTONE_REL))
    ? (JSON.parse(readFileSync(join(root, TOMBSTONE_REL), "utf8")) as TombstoneFile)
    : { schema: 1, tombstones: [] as Tombstone[] };
  const tombstones = input.tombstones ?? tombstoneFile.tombstones;
  const previousTombstones = input.previousTombstones ?? (input.skipGit ? [] : loadPreviousTombstones(root));
  const trailerTips = input.trailerTips ?? parseImportedTrailerTips(
    readFileSync(join(root, "scripts/check-v5-incident-regressions.ts"), "utf8"),
  );
  const approvers = input.approvers ?? loadTrustedApprovers(root);

  if (baseline.schema !== 1) errors.push(`baseline schema must be 1, got ${baseline.schema}`);
  if (!Array.isArray(baseline.incidentIds) || baseline.incidentIds.length === 0) {
    errors.push("baseline.incidentIds must be a non-empty union");
  }

  if (previous) {
    const lost = previous.incidentIds.filter((id) => !baseline.incidentIds.includes(id));
    if (lost.length > 0) {
      errors.push(`baseline shrank versus previous freeze; missing ${lost.join(", ")}`);
    }
    const lostTips = previous.importedTrailerHistoryTips.filter((tip) => !baseline.importedTrailerHistoryTips.includes(tip));
    if (lostTips.length > 0) {
      errors.push(`baseline trailer tips shrank versus previous freeze; missing ${lostTips.join(", ")}`);
    }
    const lostHist = (previous.historicallyPresentIds ?? []).filter((id) => !(baseline.historicallyPresentIds ?? []).includes(id));
    if (lostHist.length > 0) {
      errors.push(`historicallyPresentIds shrank versus previous freeze; missing ${lostHist.join(", ")}`);
    }
  }

  const pinPath = join(root, PIN_REL);
  if (existsSync(pinPath) && input.baseline === undefined) {
    const expected = (input.pin ?? readFileSync(pinPath, "utf8")).trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(readFileSync(baselinePath)).digest("hex");
    if (expected && expected !== actual) {
      errors.push(`baseline sha256 ${actual} != pin ${expected}`);
    }
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

  const prevStoneIds = previousTombstones.map((item) => item.id);
  const lostStones = prevStoneIds.filter((id) => !tombstoneIds.has(id));
  if (lostStones.length > 0) {
    errors.push(`tombstones shrank; removed ${lostStones.join(", ")}`);
  }
  for (const prev of previousTombstones) {
    const current = tombstones.find((item) => item.id === prev.id);
    if (!current) continue;
    if (stableTombstone(current) !== stableTombstone(prev)) {
      errors.push(`tombstone ${prev.id} was rewritten in place; tombstone file is append-only`);
    }
  }

  if (tombstoneFile.schema !== undefined && tombstoneFile.schema !== 1 && input.tombstones === undefined) {
    errors.push(`tombstones schema must be 1, got ${tombstoneFile.schema}`);
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
    if (!/^[0-9a-f]{40}$/.test(stone.removedInCommit ?? "")) {
      errors.push(`tombstone ${stone.id} removedInCommit must be a full 40-hex SHA`);
    } else if (!commitExists(root, stone.removedInCommit) || !commitInDualDag(root, stone.removedInCommit, baseline)) {
      errors.push(`tombstone ${stone.id} removedInCommit ${stone.removedInCommit} is not a real commit in the dual DAG`);
    }
    if (stone.approver && !approvers.includes(stone.approver)) {
      errors.push(`tombstone ${stone.id} approver ${stone.approver} is not a trusted human identity`);
    }
    const approval = stone.approval;
    if (!approval?.trailer || !approval.commit) {
      errors.push(`tombstone ${stone.id} missing approval.trailer/commit`);
    } else {
      const match = APPROVAL_RE.exec(approval.trailer);
      if (!match) {
        errors.push(`tombstone ${stone.id} approval.trailer must be "Tombstone-Approval: <INC> <approver>"`);
      } else if (match[1] !== stone.id) {
        errors.push(`tombstone ${stone.id} approval trailer id mismatch`);
      } else if (match[2] !== stone.approver) {
        errors.push(`tombstone ${stone.id} approval trailer approver ${match[2]} != ${stone.approver}`);
      } else if (!approvers.includes(match[2])) {
        errors.push(`tombstone ${stone.id} approval trailer signer ${match[2]} is not a trusted human identity`);
      }
      if (!/^[0-9a-f]{40}$/.test(approval.commit)) {
        errors.push(`tombstone ${stone.id} approval.commit must be a full 40-hex SHA`);
      } else if (!commitExists(root, approval.commit)) {
        errors.push(`tombstone ${stone.id} approval.commit ${approval.commit} is not a real commit`);
      }
      if (!input.skipGit && approval.commit) {
        try {
          const body = git(root, "log", "-1", "--format=%B", approval.commit);
          if (!body.includes(approval.trailer)) {
            errors.push(`tombstone ${stone.id} approval trailer not in commit ${approval.commit.slice(0, 12)}`);
          }
          if (!isAncestor(root, approval.commit)) {
            errors.push(`tombstone ${stone.id} approval.commit is not a HEAD ancestor`);
          }
        } catch {
          errors.push(`tombstone ${stone.id} approval.commit ${approval.commit.slice(0, 12)} is not readable`);
        }
      }
    }
    const frozen = baseline.incidents[stone.id];
    if (frozen) {
      const allowed = [frozen.rootFixCommit, ...(frozen.coverageCommits ?? [])];
      if (stone.codeStillInTree && !allowed.some((sha) => stone.codeStillInTree.startsWith(sha) || sha.startsWith(stone.codeStillInTree.slice(0, 8)))) {
        errors.push(`tombstone ${stone.id} codeStillInTree is not the baseline lineage`);
      }
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
