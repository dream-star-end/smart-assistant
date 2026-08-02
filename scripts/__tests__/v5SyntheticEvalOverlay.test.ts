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
      /secureStat\(cronPath, "file", undefined, \[0, 1000\]\)/,
    );
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
    assert.match(REMOTE_HELPER_SOURCE, /function inspectWorkspaceArtifacts\(\)/);
    assert.match(REMOTE_HELPER_SOURCE, /function captureCopiedWorkspace\(root\)/);
    assert.match(REMOTE_HELPER_SOURCE, /workspace-artifact-evidence/);
    assert.match(REMOTE_HELPER_SOURCE, /workspace artifact symlink is forbidden/);
    assert.match(REMOTE_HELPER_SOURCE, /workspace artifact path escaped its root/);
    assert.match(REMOTE_HELPER_SOURCE, /\["cp", evidence\.container \+ ":" \+ workspace \+ "\/\.", copyRoot\]/);
    assert.match(REMOTE_HELPER_SOURCE, /workspace artifact changed during complete capture/);
    assert.match(REMOTE_HELPER_SOURCE, /contentBase64: bytes\.toString\("base64"\)/);
    assert.match(REMOTE_HELPER_SOURCE, /FROM authority_turn_dispatches atd/);
    assert.match(REMOTE_HELPER_SOURCE, /d\.attempt_no=atd\.attempt_no/);
    assert.match(REMOTE_HELPER_SOURCE, /ccb_authority_dispatch_attempt/);
    assert.match(REMOTE_HELPER_SOURCE, /codex_server_trace/);
    assert.match(REMOTE_HELPER_SOURCE, /ref_type='usage_record'/);
    assert.match(REMOTE_HELPER_SOURCE, /BigInt\(entry\.delta\) >= 0n/);
    assert.match(
      REMOTE_HELPER_SOURCE,
      /ledger\.reduce\(\(sum, entry\) => sum - BigInt\(entry\.delta\), 0n\)/,
    );
    assert.match(REMOTE_HELPER_SOURCE, /temporary evaluation workspace already exists/);
    assert.match(REMOTE_HELPER_SOURCE, /unrelatedNewUsageCount/);
    assert.match(REMOTE_HELPER_SOURCE, /runtime tuple is incomplete/);
    assert.doesNotMatch(REMOTE_HELPER_SOURCE, /OC_V5_SKIP_MUTATION_LEASE/);
  });

  test("remote helper keeps root-only by default and limits the cron owner exception", () => {
    const start = REMOTE_HELPER_SOURCE.indexOf("function secureStat(");
    const end = REMOTE_HELPER_SOURCE.indexOf("\nfunction assertLease()", start);
    assert.ok(start >= 0 && end > start);
    const source = REMOTE_HELPER_SOURCE.slice(start, end);
    const load = (stat: {
      uid: number;
      mode: number;
      isSymbolicLink: () => boolean;
      isFile: () => boolean;
      isDirectory: () => boolean;
    }) => new Function(
      "fs",
      `function fail(message) { throw new Error(message); }\n${source}\nreturn secureStat;`,
    )({ lstatSync: () => stat }) as (
      target: string,
      kind: "file" | "dir",
      mode?: number,
      allowedUids?: number[],
    ) => unknown;
    const regular = (uid: number, mode = 0o644) => ({
      uid,
      mode,
      isSymbolicLink: () => false,
      isFile: () => true,
      isDirectory: () => false,
    });

    assert.throws(() => load(regular(1000))("cron.yaml", "file"), /unexpected owner/);
    assert.doesNotThrow(() => load(regular(0))("cron.yaml", "file", undefined, [0, 1000]));
    assert.doesNotThrow(() => load(regular(1000))("cron.yaml", "file", undefined, [0, 1000]));
    assert.throws(
      () => load(regular(1001))("cron.yaml", "file", undefined, [0, 1000]),
      /unexpected owner/,
    );
    assert.throws(
      () => load({ ...regular(1000), isSymbolicLink: () => true })(
        "cron.yaml",
        "file",
        undefined,
        [0, 1000],
      ),
      /symlink is forbidden/,
    );
    assert.throws(
      () => load({ ...regular(1000), isFile: () => false })(
        "cron.yaml",
        "file",
        undefined,
        [0, 1000],
      ),
      /expected regular file/,
    );
    assert.throws(
      () => load(regular(1000, 0o664))(
        "cron.yaml",
        "file",
        undefined,
        [0, 1000],
      ),
      /group\/other writable/,
    );
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

  test("dynamic input identity rejects a broken symlink instead of recording it absent", () => {
    const assignment = REMOTE_HELPER_SOURCE.match(
      /const DYNAMIC_INPUT_SOURCE = (\[[\s\S]*?\]\.join\("\\n"\));/,
    );
    assert.ok(assignment?.[1]);
    const probeSource = new Function(`return ${assignment[1]};`)() as string;
    const start = probeSource.indexOf("const sha=");
    const end = probeSource.indexOf("\nconst agentRoot=", start);
    assert.ok(start >= 0 && end > start);
    const identity = new Function(
      "fs",
      "path",
      "createHash",
      `${probeSource.slice(start, end)}; return identity;`,
    )(fs, path, createHash) as (target: string) => Record<string, unknown>;

    const directory = temp("v5-synthetic-dynamic-input-");
    const absent = path.join(directory, "absent");
    assert.deepEqual(identity(absent), { state: "absent" });
    const broken = path.join(directory, "broken");
    symlinkSync(path.join(directory, "missing-target"), broken);
    assert.throws(() => identity(broken), /dynamic input symlink/);
  });

  test("workspace capture executes symlink, path-escape, special-node, and TOCTOU guards", () => {
    const start = REMOTE_HELPER_SOURCE.indexOf("function captureCopiedWorkspace(root) {");
    const end = REMOTE_HELPER_SOURCE.indexOf("\nfunction inspectWorkspaceArtifacts()", start);
    assert.ok(start >= 0 && end > start);
    const source = REMOTE_HELPER_SOURCE.slice(start, end);
    const fail = (message: string): never => { throw new Error(message); };
    const sha256 = (value: string | Buffer): string =>
      createHash("sha256").update(value).digest("hex");
    const load = (fsValue: typeof fs = fs, pathValue: typeof path = path) =>
      new Function(
        "fs",
        "path",
        "createHash",
        "sha256",
        "fail",
        `${source}; return captureCopiedWorkspace;`,
      )(fsValue, pathValue, createHash, sha256, fail) as (
        root: string,
      ) => { identity: Record<string, unknown>; entries: unknown[] };

    const normal = temp("v5-synthetic-workspace-capture-");
    write(normal, "nested/output.txt", "complete bytes\n");
    const captured = load()(normal);
    assert.equal(captured.identity.state, "tree");
    assert.equal(captured.identity.files, 1);
    assert.equal(captured.identity.directories, 1);
    assert.equal(captured.entries.length, 2);

    const linked = temp("v5-synthetic-workspace-symlink-");
    symlinkSync("missing-target", path.join(linked, "broken"));
    assert.throws(() => load()(linked), /workspace artifact symlink is forbidden/);

    const special = temp("v5-synthetic-workspace-special-");
    execFileSync("mkfifo", [path.join(special, "pipe")]);
    assert.throws(() => load()(special), /contains a non-file entry/);

    const escapedPath = new Proxy(path, {
      get(target, property, receiver) {
        if (property === "relative") return () => "../escaped";
        return Reflect.get(target, property, receiver);
      },
    });
    assert.throws(() => load(fs, escapedPath)(normal), /path escaped its root/);

    const changing = temp("v5-synthetic-workspace-changing-");
    const changingFile = path.join(changing, "output.txt");
    writeFileSync(changingFile, "stable bytes\n", { mode: 0o644 });
    let fileStats = 0;
    const changingFs = new Proxy(fs, {
      get(target, property, receiver) {
        if (property !== "lstatSync") return Reflect.get(target, property, receiver);
        return (file: fs.PathLike) => {
          const stat = fs.lstatSync(file);
          if (String(file) !== changingFile || ++fileStats !== 2) return stat;
          return new Proxy(stat, {
            get(statTarget, statProperty) {
              if (statProperty === "mtimeMs") return statTarget.mtimeMs + 1;
              const value = Reflect.get(statTarget, statProperty, statTarget);
              return typeof value === "function" ? value.bind(statTarget) : value;
            },
          });
        };
      },
    });
    assert.throws(
      () => load(changingFs)(changing),
      /file changed while capturing/,
    );
  });

  test("workspace evidence rejects a live identity change across docker copy", () => {
    const captureStart = REMOTE_HELPER_SOURCE.indexOf("function captureCopiedWorkspace(root) {");
    const captureEnd = REMOTE_HELPER_SOURCE.indexOf("\nfunction inspectWorkspaceArtifacts()", captureStart);
    const inspectStart = captureEnd + 1;
    const inspectEnd = REMOTE_HELPER_SOURCE.indexOf("\nfunction inspectTurnEvidence()", inspectStart);
    assert.ok(captureStart >= 0 && captureEnd > captureStart && inspectEnd > inspectStart);
    const captureSource = REMOTE_HELPER_SOURCE.slice(captureStart, captureEnd);
    const inspectSource = REMOTE_HELPER_SOURCE.slice(inspectStart, inspectEnd);
    const fail = (message: string): never => { throw new Error(message); };
    const sha256 = (value: string | Buffer): string =>
      createHash("sha256").update(value).digest("hex");
    const capture = new Function(
      "fs", "path", "createHash", "sha256", "fail",
      `${captureSource}; return captureCopiedWorkspace;`,
    )(fs, path, createHash, sha256, fail);

    const stagingRoot = temp("v5-synthetic-workspace-live-");
    const manifestSha = "a".repeat(64);
    mkdirSync(path.join(stagingRoot, manifestSha), { mode: 0o700 });
    const content = Buffer.from("stable bytes\n");
    const fileSha = sha256(content);
    const before = {
      state: "tree",
      files: 1,
      directories: 0,
      sha256: sha256(`F  ${fileSha}  output.txt\n`),
    };
    let probes = 0;
    const payload = {
      uid: 247,
      engine: "ccb",
      agentId: "main",
      caseId: "toctou_case",
      workspaceMode: "temporary",
      expectedIdentity: before,
      manifestSha,
      recordNonce: "b".repeat(32),
    };
    const inspect = new Function(
      "payload", "inspectContainer", "dockerExecJson", "DYNAMIC_INPUT_SOURCE",
      "STAGING_ROOT", "validateStage", "fs", "path", "spawnSync",
      "captureCopiedWorkspace", "sha256", "fsyncDirectory", "secureStat", "fail",
      `${inspectSource}; return inspectWorkspaceArtifacts;`,
    )(
      payload,
      () => ({ container: "oc-v5-u247", containerId: "c".repeat(64) }),
      () => ({ temporaryWorkspace: probes++ === 0 ? before : { ...before, sha256: "d".repeat(64) } }),
      "ignored",
      stagingRoot,
      () => undefined,
      fs,
      path,
      (_command: string, args: string[]) => {
        writeFileSync(path.join(args[2], "output.txt"), content, { mode: 0o644 });
        return { status: 0, stdout: "", stderr: "" };
      },
      capture,
      sha256,
      () => undefined,
      () => undefined,
      fail,
    ) as () => unknown;
    assert.throws(() => inspect(), /changed during complete capture/);
  });
});
