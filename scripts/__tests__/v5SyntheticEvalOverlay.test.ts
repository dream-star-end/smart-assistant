import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTIVE_RECORD,
  ALLOWED_SYNTHETIC_UIDS,
  MANUAL_LEASE_PROOF,
  MAX_RECORD_TTL_SECONDS,
  RECORD_LOCK,
  REMOTE_HELPER_SOURCE,
  STAGING_ROOT,
  assertAllowedUid,
  assertCandidateDiffAllowed,
  assertDeploySnapshot,
  assertLeaseEnvironment,
  buildCandidateBundle,
  hashTree,
  parseArgs,
  validateManifest,
} from "../v5-synthetic-eval-overlay.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const driver = path.join(root, "scripts/v5-synthetic-eval-overlay.mjs");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function temp(prefix: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function write(repo: string, relative: string, contents: string): void {
  const absolute = path.join(repo, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function repositoryFixture(): {
  repo: string;
  base: string;
  candidate: string;
  skillRejected: string;
  rejected: string;
} {
  const repo = temp("v5-synthetic-overlay-git-");
  git(repo, "init", "--initial-branch=main");
  git(repo, "config", "user.name", "Synthetic Eval Test");
  git(repo, "config", "user.email", "synthetic@example.test");
  write(
    repo,
    "packages/gateway/src/promptSlots.ts",
    "export const prompt = 'base';\n",
  );
  write(
    repo,
    "packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md",
    "base prompt\n",
  );
  write(
    repo,
    "packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md",
    "base agents\n",
  );
  write(
    repo,
    "packages/commercial/agent-sandbox/ccb-baseline/CLAUDE.md",
    "base claude\n",
  );
  write(
    repo,
    "packages/commercial/agent-sandbox/ccb-baseline/skills/one/SKILL.md",
    "base skill\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");

  write(
    repo,
    "packages/gateway/src/promptSlots.ts",
    "export const prompt = 'candidate';\n",
  );
  write(
    repo,
    "packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md",
    "candidate prompt\n",
  );
  write(
    repo,
    "packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md",
    "candidate agents\n",
  );
  write(
    repo,
    "packages/gateway/src/__tests__/platformPrompts.test.ts",
    "export const evidence = true;\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "allowed prompt candidate");
  const candidate = git(repo, "rev-parse", "HEAD");

  write(
    repo,
    "packages/commercial/agent-sandbox/ccb-baseline/skills/one/SKILL.md",
    "candidate skill\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-m", "unsupported skill overlay");
  const skillRejected = git(repo, "rev-parse", "HEAD");

  write(repo, "packages/gateway/src/server.ts", "export const changed = true;\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "unrelated runtime change");
  const rejected = git(repo, "rev-parse", "HEAD");
  return { repo, base, candidate, skillRejected, rejected };
}

describe("V5 synthetic exact-eval overlay driver", () => {
  test("locks identity and filesystem surfaces to two synthetic users and fixed roots", () => {
    assert.deepEqual(ALLOWED_SYNTHETIC_UIDS, [247, 626]);
    assert.equal(STAGING_ROOT, "/var/lib/openclaude-v5/synthetic-eval-overlay");
    assert.equal(
      ACTIVE_RECORD,
      "/run/openclaude-v5/synthetic-eval-overlay-active.json",
    );
    assert.equal(
      RECORD_LOCK,
      "/run/openclaude-v5/synthetic-eval-overlay.lock",
    );
    assert.equal(
      MANUAL_LEASE_PROOF,
      "/run/openclaude-v5/production-mutation.lock.manual-holder",
    );
    assert.equal(MAX_RECORD_TTL_SECONDS, 1_500);
    assert.equal(assertAllowedUid("247"), 247);
    assert.equal(assertAllowedUid(626), 626);
    for (const uid of [0, 1, 246, 248, 625, 627, Number.NaN, "247x"]) {
      assert.throws(() => assertAllowedUid(uid), /must be one of 247,626/);
    }
  });

  test("requires proof injected by the official external mutation-lease wrapper", () => {
    const nonce = "a".repeat(32);
    assert.deepEqual(
      assertLeaseEnvironment({
        OC_V5_MANUAL_LEASE_NONCE: nonce,
        OC_V5_MANUAL_LEASE_PROOF: MANUAL_LEASE_PROOF,
      }),
      { nonce, proof: MANUAL_LEASE_PROOF },
    );
    assert.throws(() => assertLeaseEnvironment({}), /with-production-mutation-lease/);
    assert.throws(
      () =>
        assertLeaseEnvironment({
          OC_V5_MANUAL_LEASE_NONCE: nonce,
          OC_V5_MANUAL_LEASE_PROOF: "/tmp/fake-proof",
        }),
      /with-production-mutation-lease/,
    );
    assert.throws(
      () =>
        assertLeaseEnvironment({
          OC_V5_MANUAL_LEASE_NONCE: "short",
          OC_V5_MANUAL_LEASE_PROOF: MANUAL_LEASE_PROOF,
        }),
      /with-production-mutation-lease/,
    );
  });

  test("is dry-run by default and makes every mutation explicit with --apply", () => {
    const sha = "a".repeat(40);
    const dry = parseArgs([
      "prepare",
      "--uid",
      "247",
      "--base-sha",
      sha,
      "--candidate-sha",
      sha,
    ]);
    assert.equal(dry.apply, false);
    assert.equal(dry.ttlSeconds, 1_500);
    const apply = parseArgs([
      "prepare",
      "--uid",
      "626",
      "--base-sha",
      sha,
      "--candidate-sha",
      sha,
      "--ttl-seconds",
      "1200",
      "--apply",
    ]);
    assert.equal(apply.apply, true);
    assert.equal(apply.ttlSeconds, 1_200);
    assert.equal(
      parseArgs([
        "prepare",
        "--uid",
        "247",
        "--base-sha",
        sha,
        "--candidate-sha",
        sha,
        "--nonce",
        "b".repeat(32),
      ]).recordNonce,
      "b".repeat(32),
    );
    assert.deepEqual(parseArgs(["clear", "--nonce", "c".repeat(32)]), {
      command: "clear",
      apply: false,
      recordNonce: "c".repeat(32),
    });
    assert.deepEqual(
      parseArgs([
        "recover",
        "--nonce",
        "d".repeat(32),
        "--manifest-sha",
        "e".repeat(64),
        "--apply",
      ]),
      {
        command: "recover",
        apply: true,
        recordNonce: "d".repeat(32),
        manifestSha: "e".repeat(64),
      },
    );
    assert.throws(
      () =>
        parseArgs([
          "prepare",
          "--uid",
          "1",
          "--base-sha",
          sha,
          "--candidate-sha",
          sha,
        ]),
      /must be one of/,
    );
    assert.throws(
      () =>
        parseArgs([
          "prepare",
          "--uid",
          "247",
          "--base-sha",
          sha,
          "--candidate-sha",
          sha,
          "--ttl-seconds",
          "1501",
        ]),
      /must be an integer/,
    );
    assert.throws(
      () => parseArgs(["clear", "--nonce", "e".repeat(32), "--uid", "247"]),
      /does not accept/,
    );
  });

  test("allows only prompt/baseline trees plus tests on a descendant commit", () => {
    const fixture = repositoryFixture();
    const changed = assertCandidateDiffAllowed(
      fixture.repo,
      fixture.base,
      fixture.candidate,
    );
    assert.deepEqual(changed.sort(), [
      "packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md",
      "packages/commercial/agent-sandbox/platform-runtime/prompts/platform-capabilities.md",
      "packages/gateway/src/__tests__/platformPrompts.test.ts",
      "packages/gateway/src/promptSlots.ts",
    ]);
    assert.throws(
      () =>
        assertCandidateDiffAllowed(
          fixture.repo,
          fixture.base,
          fixture.skillRejected,
        ),
      /outside the exact prompt\/test allowlist.*skills\/one\/SKILL\.md/,
    );
    assert.throws(
      () => assertCandidateDiffAllowed(fixture.repo, fixture.base, fixture.rejected),
      /outside the exact prompt\/test allowlist.*server\.ts/,
    );
    assert.throws(
      () =>
        assertCandidateDiffAllowed(
          fixture.repo,
          fixture.candidate,
          fixture.base,
        ),
      /must be a descendant/,
    );
    assert.throws(
      () =>
        assertCandidateDiffAllowed(
          fixture.repo,
          fixture.base.slice(0, 12),
          fixture.candidate,
        ),
      /full 40-hex SHA/,
    );
  });

  test("builds a complete immutable-candidate manifest with file and tree hashes", () => {
    const fixture = repositoryFixture();
    const bundle = buildCandidateBundle({
      repoRoot: fixture.repo,
      baseCommit: fixture.base,
      candidateCommit: fixture.candidate,
    });
    temporaryDirectories.push(bundle.bundleRoot);
    assert.match(bundle.manifestSha, /^[0-9a-f]{64}$/);
    assert.match(bundle.tarSha, /^[0-9a-f]{64}$/);
    assert.equal(bundle.manifest.baseCommit, fixture.base);
    assert.equal(bundle.manifest.candidateCommit, fixture.candidate);
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(bundle.bundleRoot, "manifest.json"), "utf8")),
      bundle.manifest,
    );
    for (const digest of Object.values(bundle.manifest.files)) {
      assert.match(digest, /^[0-9a-f]{64}$/);
    }
    assert.doesNotThrow(() => validateManifest(bundle.manifest));
    assert.throws(
      () => validateManifest({ ...bundle.manifest, extra: true }),
      /shape is invalid/,
    );
  });

  test("tree hashing is deterministic and rejects symlinks instead of following them", () => {
    const directory = temp("v5-synthetic-overlay-tree-");
    write(directory, "b/file.txt", "second\n");
    write(directory, "a/file.txt", "first\n");
    const first = hashTree(directory);
    assert.equal(hashTree(directory), first);
    write(directory, "a/file.txt", "changed\n");
    assert.notEqual(hashTree(directory), first);
    symlinkSync(path.join(directory, "b/file.txt"), path.join(directory, "link"));
    assert.throws(() => hashTree(directory), /contains a symlink/);
  });

  test("accepts only an exact stable candidate-null cohort-0 cron-free base snapshot", () => {
    const base = "a".repeat(40);
    const good = {
      phase: "stable",
      activeSlot: "B",
      candidateSlot: null,
      activeRelease: "/opt/openclaude/openclaude-v5-releases/rel-good",
      candidateRelease: null,
      cohortPercent: 0,
      lockVersion: 42,
      sourceCommit: base,
      enabledCron: 0,
      dispatchCount: 12,
      openDispatchCount: 0,
      usageCount: 30,
      usageMaxId: 55,
      cronFileEnabled: 0,
      v3State: "inactive",
      syntheticContainerId: "f".repeat(64),
    };
    assert.equal(assertDeploySnapshot(good, base, 42), good);
    for (const patch of [
      { phase: "canary" },
      { candidateSlot: "A" },
      { candidateRelease: "/candidate" },
      { cohortPercent: 1 },
      { lockVersion: 43 },
      { sourceCommit: "b".repeat(40) },
      { enabledCron: 1 },
      { dispatchCount: -1 },
      { openDispatchCount: 1 },
      { usageCount: -1 },
      { usageMaxId: -1 },
      { cronFileEnabled: 1 },
      { v3State: "active" },
      { syntheticContainerId: "short" },
      { activeRelease: "/tmp/fake-release" },
    ]) {
      assert.throws(
        () => assertDeploySnapshot({ ...good, ...patch }, base, 42),
        /not an exact stable|lock_version changed/,
      );
    }
  });

  test("CLI help is side-effect free and prepare fails before ssh without wrapper proof", () => {
    const help = spawnSync(process.execPath, [driver, "--help"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Dry run \(read-only\)/);
    assert.match(help.stdout, /Only synthetic UIDs 247 and 626/);

    const noLease = spawnSync(
      process.execPath,
      [
        driver,
        "prepare",
        "--uid",
        "247",
        "--base-sha",
        "a".repeat(40),
        "--candidate-sha",
        "a".repeat(40),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OC_V5_MANUAL_LEASE_NONCE: "",
          OC_V5_MANUAL_LEASE_PROOF: "",
          PATH: "/nonexistent",
        },
      },
    );
    assert.equal(noLease.status, 2);
    assert.match(noLease.stderr, /with-production-mutation-lease/);
    assert.doesNotMatch(noLease.stderr, /spawnSync ssh/);
  });

  test("remote helper hard-codes root-owned surfaces and nonce-CAS cleanup", () => {
    assert.doesNotThrow(
      () => new Function(REMOTE_HELPER_SOURCE),
      "the exact source sent to remote Node must parse",
    );
    assert.match(REMOTE_HELPER_SOURCE, /process\.getuid\(\) !== 0/);
    assert.match(
      REMOTE_HELPER_SOURCE,
      /production-mutation\.lock\.manual-holder/,
    );
    assert.match(REMOTE_HELPER_SOURCE, /state\.phase !== "stable"/);
    assert.match(REMOTE_HELPER_SOURCE, /state\.candidateSlot !== null/);
    assert.match(REMOTE_HELPER_SOURCE, /state\.cohortPercent !== 0/);
    assert.match(REMOTE_HELPER_SOURCE, /marker\.sourceCommit !== payload\.expectedBase/);
    assert.match(REMOTE_HELPER_SOURCE, /cronFileEnabled !== 0/);
    assert.match(REMOTE_HELPER_SOURCE, /fs\.renameSync\(temporary, ACTIVE_RECORD\)/);
    assert.match(
      REMOTE_HELPER_SOURCE,
      /fs\.linkSync\(temporary, target\)/,
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /processStartTime\(current\.pid\) !== current\.processStartTime/,
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /Date\.now\(\) >= Date\.parse\(current\.expiresAt\)/,
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /RECORD_LOCK_REAPER = "\/run\/openclaude-v5\/synthetic-eval-overlay\.lock\.reaper"/,
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /withOwnerLock\(\s+RECORD_LOCK_REAPER,\s+true,\s+\(\) => withOwnerLock\(RECORD_LOCK, true, operation\)/,
      "only the production-lease operator reaps stale locks while fencing gateway activation",
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /withRecordLock\(\(assertHeld\) => removeRecord\(false, assertHeld\)\)/,
    );
    assert.match(REMOTE_HELPER_SOURCE, /secureStat\(ACTIVE_RECORD, "file", 0o600\)/);
    assert.match(
      REMOTE_HELPER_SOURCE,
      /record\.nonce !== payload\.recordNonce/,
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /payload\.manifestSha \|\| path\.basename\(stage\)/,
      "recover must validate and remove a stage using the record-bound manifest SHA",
    );
    assert.match(
      REMOTE_HELPER_SOURCE,
      /recover without a record requires the exact manifest SHA/,
      "uncertain prepare commits must be recoverable by caller-known nonce and manifest",
    );
    assert.match(REMOTE_HELPER_SOURCE, /function inspectDynamicInputs\(\)/);
    assert.match(REMOTE_HELPER_SOURCE, /function inspectTurnEvidence\(\)/);
    assert.match(REMOTE_HELPER_SOURCE, /temporary evaluation workspace already exists/);
    assert.match(REMOTE_HELPER_SOURCE, /unrelatedNewUsageCount/);
    assert.match(REMOTE_HELPER_SOURCE, /runtime tuple is incomplete/);
    assert.doesNotMatch(REMOTE_HELPER_SOURCE, /OC_V5_SKIP_MUTATION_LEASE/);
  });

  test("local manifest tree hash equals the remote helper algorithm byte-for-byte", () => {
    const directory = temp("v5-synthetic-overlay-remote-hash-");
    write(directory, "z/file.txt", "z\n");
    write(directory, "a/nested/file.txt", "a\n");

    const start = REMOTE_HELPER_SOURCE.indexOf("function hashTree(root) {");
    const end = REMOTE_HELPER_SOURCE.indexOf("\nfunction hashFile(file)", start);
    assert.ok(start >= 0 && end > start);
    const source = REMOTE_HELPER_SOURCE.slice(start, end);
    const listFiles = (treeRoot: string, current = treeRoot): string[] => {
      const files: string[] = [];
      for (const name of fs.readdirSync(current).sort()) {
        const absolute = path.join(current, name);
        const stat = fs.lstatSync(absolute);
        if (stat.isDirectory()) files.push(...listFiles(treeRoot, absolute));
        else files.push(absolute);
      }
      return files;
    };
    const digest = (input: string | Buffer): string =>
      createHash("sha256").update(input).digest("hex");
    const remoteHashTree = new Function(
      "fs",
      "path",
      "createHash",
      "listFiles",
      "sha256",
      `${source}; return hashTree;`,
    )(fs, path, createHash, listFiles, digest) as (root: string) => string;
    assert.equal(remoteHashTree(directory), hashTree(directory));
  });
});
