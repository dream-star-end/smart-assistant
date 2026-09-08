/**
 * check-v5-fix-trailers.sh — the selfhost pre-build Incident trailer gate.
 *
 * Builds a throwaway git repo with the same four inputs the real gate reads
 * (marker, checker source with IMPORTED_TRAILER_HISTORY_TIPS, incidents.json,
 * incident-waivers.json) and stacks commits on top to drive every verdict.
 * Rules must stay byte-for-byte aligned with check-v5-incident-regressions.ts;
 * the last test cross-checks that alignment on the real repo history.
 *
 * Run: npx tsx --test scripts/__tests__/v5FixTrailerGate.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const GATE = path.join(root, "scripts/check-v5-fix-trailers.sh");

type Verdict = { rc: number; out: string };

function runGate(repo: string, head = "HEAD"): Verdict {
  const r = spawnSync(GATE, ["--repo", repo, "--head", head, "--quiet"], { encoding: "utf8" });
  return { rc: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

class Repo {
  readonly dir: string;
  constructor() {
    this.dir = mkdtempSync(path.join(tmpdir(), "fix-trailer-gate-"));
    this.git("init", "-q", "-b", "main");
    this.git("config", "user.email", "t@example.com");
    this.git("config", "user.name", "t");
    this.git("config", "commit.gpgsign", "false");
  }
  git(...args: string[]): string {
    return execFileSync("git", args, { cwd: this.dir, encoding: "utf8" }).trim();
  }
  write(rel: string, content: string): void {
    const abs = path.join(this.dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  commit(message: string, files: Record<string, string>, opts: { date?: string } = {}): string {
    for (const [rel, content] of Object.entries(files)) this.write(rel, content);
    this.git("add", "-A");
    const env = opts.date
      ? { ...process.env, GIT_AUTHOR_DATE: opts.date, GIT_COMMITTER_DATE: opts.date }
      : process.env;
    execFileSync("git", ["commit", "-q", "-m", message], { cwd: this.dir, env });
    return this.git("rev-parse", "HEAD");
  }
  head(): string { return this.git("rev-parse", "HEAD"); }
  reset(sha: string): void { this.git("reset", "-q", "--hard", sha); }
  destroy(): void { rmSync(this.dir, { recursive: true, force: true }); }
}

const INC = "INC-20260901-PROBE-SLUG";

function checkerSource(frozenTips: string[]): string {
  const tips = frozenTips.map((t) => `  "${t}",`).join("\n");
  return `// stub of check-v5-incident-regressions.ts\nconst IMPORTED_TRAILER_HISTORY_TIPS = [\n${tips}\n] as const;\n`;
}
function incidentsJson(lineage: string[]): string {
  return JSON.stringify({
    schema: 2,
    scope: "test",
    fixedLiveMatrix: [],
    incidents: [{
      id: INC, occurredAt: "2026-09-01", severity: "P1", symptom: "probe",
      rootFixCommit: lineage[0] ?? "00000000", coverageCommits: lineage.slice(1), regressions: [],
    }],
  }, null, 2);
}
function waiversJson(waivers: Array<{ commit: string; expiresAt: string; emergencyMissingTrailer?: boolean }>): string {
  return JSON.stringify({
    schema: 1,
    scope: "test",
    waivers: waivers.map((w) => ({ reason: "probe", approvedBy: "probe", ...w })),
  }, null, 2);
}

/** Seed: one pre-anchor commit, then the marker (anchor). Returns anchor sha. */
function seed(repo: Repo): { preAnchor: string; anchor: string } {
  const preAnchor = repo.commit("fix(v5): before the gate existed\n\nIncident: nonsense", {
    "packages/commercial/src/a.ts": "1",
    "scripts/check-v5-incident-regressions.ts": checkerSource([]),
    "e2e/session-display/incidents.json": incidentsJson([]),
    "e2e/session-display/incident-waivers.json": waiversJson([]),
  }, { date: "2026-07-01T00:00:00Z" });
  const anchor = repo.commit("chore: enable trailer gate", {
    "e2e/session-display/incident-trailer-enforced-from": "# marker\n",
  }, { date: "2026-07-26T00:00:00Z" });
  return { preAnchor, anchor };
}

describe("check-v5-fix-trailers.sh", () => {
  let repo: Repo;
  let anchor: string;
  before(() => { repo = new Repo(); ({ anchor } = seed(repo)); });
  after(() => repo.destroy());

  test("clean tip passes; commits before the anchor are never judged even with a bad trailer", () => {
    const v = runGate(repo.dir);
    assert.equal(v.rc, 0, v.out);
  });

  test("malformed trailer on a surface-touching fix(v5) → rc 1 with the offending sha and value", () => {
    const sha = repo.commit("fix(v5): p1\n\nIncident: OCV5-171 follow-up", { "packages/commercial/src/a.ts": "2" });
    const v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, new RegExp(`${sha.slice(0, 8)} .*格式非法:OCV5-171 follow-up`));
    repo.reset(anchor);
  });

  test("missing trailer → rc 1", () => {
    const sha = repo.commit("fix(v5): p2\n\nno trailer", { "packages/gateway/src/b.ts": "1" });
    const v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, new RegExp(`${sha.slice(0, 8)} .*缺 trailer`));
    repo.reset(anchor);
  });

  test("non-fix subjects and non-surface paths are ignored regardless of trailer", () => {
    repo.commit("feat(v5): not a fix\n\nIncident: whatever", { "packages/commercial/src/a.ts": "3" });
    repo.commit("fix(v5): docs only\n\nIncident: bogus", { "docs/x.md": "1" });
    repo.commit("fix(v5): scripts only\n\nIncident: bogus", { "scripts/tool.sh": "1" });
    assert.equal(runGate(repo.dir).rc, 0);
    repo.reset(anchor);
  });

  test("Incident: none needs a live waiver; expired waiver fails", () => {
    const sha = repo.commit("fix(v5): p3\n\nIncident: none (probe)", { "packages/web-react/src/c.tsx": "1" });
    let v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, /声明 Incident: none,但 .*没有对应 waiver/);

    repo.commit("chore: waiver", {
      "e2e/session-display/incident-waivers.json": waiversJson([{ commit: sha, expiresAt: "2099-01-01" }]),
    });
    v = runGate(repo.dir);
    assert.equal(v.rc, 0, v.out);

    repo.commit("chore: expire", {
      "e2e/session-display/incident-waivers.json": waiversJson([{ commit: sha, expiresAt: "2026-01-01" }]),
    });
    v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, /waiver 已于 2026-01-01 过期/);
    repo.reset(anchor);
  });

  test("valid INC id must exist and its lineage must contain the commit", () => {
    const sha = repo.commit(`fix(v5): p4\n\nIncident: ${INC}`, { "packages/storage/src/d.ts": "1" });
    let v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, /rootFixCommit\/coverageCommits 未包含本 commit/);

    repo.commit("chore: lineage", { "e2e/session-display/incidents.json": incidentsJson([sha.slice(0, 8)]) });
    v = runGate(repo.dir);
    assert.equal(v.rc, 0, v.out);

    repo.commit("fix(v5): p5 unknown id\n\nIncident: INC-20260909-DOES-NOT-EXIST", { "packages/protocol/src/e.ts": "1" });
    v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, /INC-20260909-DOES-NOT-EXIST 不在 .*incidents\.json 内/);
    repo.reset(anchor);
  });

  test("ancestors of a frozen import tip are exempt; commits after the tip are still judged", () => {
    const bad = repo.commit("fix(v5): shipped with bad trailer\n\nIncident: OCV5-1", { "packages/commercial/src/a.ts": "4" });
    assert.equal(runGate(repo.dir).rc, 1);
    // Freeze the shipped tip in the checker source (what a fence commit does).
    repo.commit("chore: freeze tip", { "scripts/check-v5-incident-regressions.ts": checkerSource([bad]) });
    assert.equal(runGate(repo.dir).rc, 0);
    // A new bad commit on top is not an ancestor of the frozen tip → red again.
    const after_ = repo.commit("fix(v5): new bad\n\nIncident: OCV5-2", { "packages/commercial/src/a.ts": "5" });
    const v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, new RegExp(after_.slice(0, 8)));
    repo.reset(anchor);
  });

  test("a frozen tip that is not an ancestor of HEAD fails closed instead of silently disabling the fence", () => {
    repo.commit("chore: bogus frozen tip", {
      "scripts/check-v5-incident-regressions.ts": checkerSource(["0123456789abcdef0123456789abcdef01234567"]),
    });
    const v = runGate(repo.dir);
    assert.equal(v.rc, 1);
    assert.match(v.out, /冻结的 trailer import tip 0123456789ab 不可达/);
    repo.reset(anchor);
  });

  test("gate is a no-op (rc 2) before the marker exists", () => {
    const fresh = new Repo();
    try {
      fresh.commit("init", {
        "scripts/check-v5-incident-regressions.ts": checkerSource([]),
        "e2e/session-display/incidents.json": incidentsJson([]),
        "e2e/session-display/incident-waivers.json": waiversJson([]),
      });
      assert.equal(runGate(fresh.dir).rc, 2);
    } finally {
      fresh.destroy();
    }
  });

  test("--head judges a non-HEAD revision using that revision's own registry files", () => {
    const good = repo.commit(`fix(v5): p6\n\nIncident: ${INC}`, { "packages/gateway/src/f.ts": "1" });
    repo.commit("chore: lineage", { "e2e/session-display/incidents.json": incidentsJson([good.slice(0, 8)]) });
    const registered = repo.head();
    repo.commit("fix(v5): p7 bad on top\n\nIncident: bad", { "packages/gateway/src/f.ts": "2" });
    assert.equal(runGate(repo.dir, registered).rc, 0);
    assert.equal(runGate(repo.dir, "HEAD").rc, 1);
    repo.reset(anchor);
  });
});

describe("parity with check-v5-incident-regressions.ts on the real repo", () => {
  test("bash gate and TS gate agree on the current HEAD", { timeout: 15 * 60_000 }, () => {
    const isGit = spawnSync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    if (isGit.status !== 0) return; // runtime snapshot without .git — nothing to compare
    const bash = runGate(root);
    const ts = spawnSync("npx", ["--no-install", "tsx", "scripts/check-v5-incident-regressions.ts"], {
      cwd: root, encoding: "utf8",
    });
    const tsTrailerRed = /Incident trailer 格式非法|缺 trailer|没有对应 waiver|waiver 已于 .* 过期|不在 incidents\.json 内|未包含本 commit/
      .test(`${ts.stdout}${ts.stderr}`);
    if (bash.rc === 2) return; // shallow clone etc. — TS gate skips the same way
    // The TS gate can be red for reasons outside trailer closure (assertion debt,
    // runner mapping…); only compare the trailer-closure verdict.
    assert.equal(bash.rc === 1, tsTrailerRed, `bash=${bash.rc} ts-trailer-red=${tsTrailerRed}\n${bash.out}`);
  });
});
