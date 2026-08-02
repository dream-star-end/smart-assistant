#!/usr/bin/env node
/**
 * Stage one exact-prompt candidate and arm it for one synthetic V5 account.
 *
 * This is deliberately not a deployment lane and never acquires a production
 * mutation lease itself. Every command, including a dry run, must be invoked
 * by scripts/with-production-mutation-lease.sh. The wrapper supplies a nonce
 * whose root-owned proof file is re-checked on kl-mirror before every remote
 * operation.
 *
 * Mutation is opt-in:
 *   scripts/with-production-mutation-lease.sh \
 *     node scripts/v5-synthetic-eval-overlay.mjs prepare ... --apply
 *
 * Without --apply, prepare/clear/recover only validate and print a plan.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ALLOWED_SYNTHETIC_UIDS = Object.freeze([247, 626]);
export const STAGING_ROOT = "/var/lib/openclaude-v5/synthetic-eval-overlay";
export const ACTIVE_RECORD =
  "/run/openclaude-v5/synthetic-eval-overlay-active.json";
export const RECORD_LOCK =
  "/run/openclaude-v5/synthetic-eval-overlay.lock";
export const MANUAL_LEASE_PROOF =
  "/run/openclaude-v5/production-mutation.lock.manual-holder";
export const MAX_RECORD_TTL_SECONDS = 1_500;

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const RUNTIME_PATHS = Object.freeze([
  "packages/gateway/src/promptSlots.ts",
  "packages/commercial/agent-sandbox/platform-runtime/prompts",
  "packages/commercial/agent-sandbox/ccb-baseline",
]);
const PROMPTS_PATH =
  "packages/commercial/agent-sandbox/platform-runtime/prompts";
const PROMPT_SLOTS_PATH = "packages/gateway/src/promptSlots.ts";
const BASELINE_PATH = "packages/commercial/agent-sandbox/ccb-baseline";
const AGENTS_PATH = `${BASELINE_PATH}/AGENTS.md`;
const CLAUDE_PATH = `${BASELINE_PATH}/CLAUDE.md`;
const SKILLS_PATH = `${BASELINE_PATH}/skills`;
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = path.resolve(here, "..");

function fail(message) {
  throw new Error(message);
}

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

export function assertAllowedUid(value) {
  const uid = Number(value);
  if (!Number.isSafeInteger(uid) || !ALLOWED_SYNTHETIC_UIDS.includes(uid)) {
    fail(`synthetic exact-eval uid must be one of ${ALLOWED_SYNTHETIC_UIDS.join(",")}`);
  }
  return uid;
}

export function assertLeaseEnvironment(env = process.env) {
  const nonce = env.OC_V5_MANUAL_LEASE_NONCE ?? "";
  const proof = env.OC_V5_MANUAL_LEASE_PROOF ?? "";
  if (!NONCE_RE.test(nonce) || proof !== MANUAL_LEASE_PROOF) {
    fail(
      "run this command through scripts/with-production-mutation-lease.sh; " +
        "valid OC_V5_MANUAL_LEASE_NONCE/proof were not supplied",
    );
  }
  return { nonce, proof };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: options.encoding ?? "utf8",
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8")
      : result.stderr ?? "";
    const stdout = Buffer.isBuffer(result.stdout)
      ? result.stdout.toString("utf8")
      : result.stdout ?? "";
    fail(
      `${command} ${args.join(" ")} failed (${result.status}): ${stderr || stdout}`.trim(),
    );
  }
  return result.stdout;
}

function git(repoRoot, args, encoding = "utf8") {
  return run("git", ["-C", repoRoot, ...args], { encoding });
}

export function resolveExactCommit(repoRoot, commit) {
  if (!COMMIT_RE.test(commit)) fail(`git commit must be a full 40-hex SHA: ${commit}`);
  const resolved = String(git(repoRoot, ["rev-parse", `${commit}^{commit}`])).trim();
  if (resolved !== commit) fail(`git commit did not resolve exactly: ${commit}`);
  return resolved;
}

function isAllowedDiffPath(file) {
  if (file === PROMPT_SLOTS_PATH) return true;
  if (file.startsWith(`${PROMPTS_PATH}/`)) return true;
  // The supervisor owns a compiled exact skill inventory. Overlaying a
  // different skills tree would either fail its baseline gate or evaluate a
  // runtime surface not represented by this prompt-only lane.
  if (file === AGENTS_PATH || file === CLAUDE_PATH) return true;
  // Tests are evaluation evidence only. Runtime/import dependencies remain
  // outside this suffix and are rejected below.
  return /(^|\/)(?:__tests__\/[^/]+|[^/]+)\.test\.[cm]?[jt]sx?$/.test(file);
}

export function assertCandidateDiffAllowed(repoRoot, baseCommit, candidateCommit) {
  resolveExactCommit(repoRoot, baseCommit);
  resolveExactCommit(repoRoot, candidateCommit);
  const ancestor = spawnSync(
    "git",
    ["-C", repoRoot, "merge-base", "--is-ancestor", baseCommit, candidateCommit],
    { encoding: "utf8" },
  );
  if (ancestor.error) throw ancestor.error;
  if (ancestor.status !== 0) {
    fail("candidate commit must be a descendant of the exact stable base commit");
  }
  const raw = git(
    repoRoot,
    [
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${baseCommit}..${candidateCommit}`,
    ],
  );
  const changed = String(raw).split("\0").filter(Boolean);
  const rejected = changed.filter((file) => !isAllowedDiffPath(file));
  if (rejected.length > 0) {
    fail(
      "candidate changes files outside the exact prompt/test allowlist: " +
        rejected.join(", "),
    );
  }
  return changed;
}

function listTreeFiles(root, current = root) {
  const files = [];
  for (const name of readdirSync(current).sort()) {
    const absolute = path.join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) fail(`staged tree contains a symlink: ${absolute}`);
    if (stat.isDirectory()) {
      files.push(...listTreeFiles(root, absolute));
      continue;
    }
    if (!stat.isFile()) fail(`staged tree contains a non-file entry: ${absolute}`);
    files.push(absolute);
  }
  return files;
}

/**
 * Directory digests are SHA-256 over sorted:
 *   <sha256(file bytes)><two spaces><relative POSIX path><newline>
 * Empty trees hash as SHA-256 of the empty byte sequence.
 */
export function hashTree(root) {
  const resolvedRoot = realpathSync(root);
  const digest = createHash("sha256");
  for (const absolute of listTreeFiles(resolvedRoot)) {
    const relative = path.relative(resolvedRoot, absolute).split(path.sep).join("/");
    digest.update(`${sha256(readFileSync(absolute))}  ${relative}\n`);
  }
  return digest.digest("hex");
}

function hashRegularFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail(`expected a regular non-symlink file: ${file}`);
  }
  return sha256(readFileSync(file));
}

export function validateManifest(manifest) {
  if (
    !exactKeys(manifest, ["schemaVersion", "baseCommit", "candidateCommit", "files"])
    || manifest.schemaVersion !== 1
    || !COMMIT_RE.test(manifest.baseCommit ?? "")
    || !COMMIT_RE.test(manifest.candidateCommit ?? "")
    || !exactKeys(manifest.files, [
      "promptsTree",
      "promptSlots",
      "agents",
      "claude",
      "skillsTree",
    ])
  ) {
    fail("synthetic eval manifest shape is invalid");
  }
  for (const [name, digest] of Object.entries(manifest.files)) {
    if (!SHA256_RE.test(digest)) fail(`manifest digest ${name} is invalid`);
  }
  return manifest;
}

export function buildCandidateBundle({
  repoRoot,
  baseCommit,
  candidateCommit,
}) {
  assertCandidateDiffAllowed(repoRoot, baseCommit, candidateCommit);
  const bundleRoot = mkdtempSync(path.join(tmpdir(), "oc-v5-synthetic-eval-"));
  const treeRoot = path.join(bundleRoot, "tree");
  try {
    const archive = git(
      repoRoot,
      ["archive", "--format=tar", candidateCommit, "--", ...RUNTIME_PATHS],
      "buffer",
    );
    run("mkdir", ["-p", treeRoot]);
    run("tar", ["-xf", "-", "-C", treeRoot], {
      input: archive,
      encoding: "buffer",
    });

    const manifest = validateManifest({
      schemaVersion: 1,
      baseCommit,
      candidateCommit,
      files: {
        promptsTree: hashTree(path.join(treeRoot, PROMPTS_PATH)),
        promptSlots: hashRegularFile(path.join(treeRoot, PROMPT_SLOTS_PATH)),
        agents: hashRegularFile(path.join(treeRoot, AGENTS_PATH)),
        claude: hashRegularFile(path.join(treeRoot, CLAUDE_PATH)),
        skillsTree: hashTree(path.join(treeRoot, SKILLS_PATH)),
      },
    });
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
    const manifestSha = sha256(manifestBytes);
    writeFileSync(path.join(bundleRoot, "manifest.json"), manifestBytes, {
      mode: 0o600,
    });
    const tarball = run("tar", ["-cf", "-", "-C", bundleRoot, "manifest.json", "tree"], {
      encoding: "buffer",
    });
    return {
      bundleRoot,
      manifest,
      manifestBytes,
      manifestSha,
      tarball,
      tarSha: sha256(tarball),
    };
  } catch (error) {
    rmSync(bundleRoot, { force: true, recursive: true });
    throw error;
  }
}

export function assertDeploySnapshot(snapshot, expectedBase, expectedLockVersion) {
  if (
    !exactKeys(snapshot, [
      "phase",
      "activeSlot",
      "candidateSlot",
      "activeRelease",
      "candidateRelease",
      "cohortPercent",
      "lockVersion",
      "sourceCommit",
      "enabledCron",
      "dispatchCount",
      "openDispatchCount",
      "usageCount",
      "usageMaxId",
      "cronFileEnabled",
      "v3State",
      "syntheticContainerId",
    ])
    || snapshot.phase !== "stable"
    || !["A", "B"].includes(snapshot.activeSlot)
    || snapshot.candidateSlot !== null
    || snapshot.candidateRelease !== null
    || snapshot.cohortPercent !== 0
    || !Number.isSafeInteger(snapshot.lockVersion)
    || snapshot.lockVersion < 1
    || snapshot.sourceCommit !== expectedBase
    || snapshot.enabledCron !== 0
    || !Number.isSafeInteger(snapshot.dispatchCount)
    || snapshot.dispatchCount < 0
    || snapshot.openDispatchCount !== 0
    || !Number.isSafeInteger(snapshot.usageCount)
    || snapshot.usageCount < 0
    || !Number.isSafeInteger(snapshot.usageMaxId)
    || snapshot.usageMaxId < 0
    || snapshot.cronFileEnabled !== 0
    || snapshot.v3State !== "inactive"
    || (
      snapshot.syntheticContainerId !== null
      && (
        typeof snapshot.syntheticContainerId !== "string"
        || !/^[0-9a-f]{64}$/.test(snapshot.syntheticContainerId)
      )
    )
    || typeof snapshot.activeRelease !== "string"
    || !snapshot.activeRelease.startsWith("/opt/openclaude/openclaude-v5-releases/rel-")
  ) {
    fail("production is not an exact stable/cohort-0/cron-free base for this evaluation");
  }
  if (
    expectedLockVersion !== undefined
    && snapshot.lockVersion !== expectedLockVersion
  ) {
    fail("deploy_state lock_version changed during synthetic evaluation preparation");
  }
  return snapshot;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/*
 * The same self-contained helper is evaluated by the remote Node binary for
 * every operation. It only accepts fixed production paths and validates the
 * wrapper proof before reading or mutating anything.
 */
export const REMOTE_HELPER_SOURCE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { createHash, randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");
const { spawnSync } = require("node:child_process");

const STAGING_ROOT = "/var/lib/openclaude-v5/synthetic-eval-overlay";
const ACTIVE_RECORD = "/run/openclaude-v5/synthetic-eval-overlay-active.json";
const RECORD_LOCK = "/run/openclaude-v5/synthetic-eval-overlay.lock";
const RECORD_LOCK_REAPER = "/run/openclaude-v5/synthetic-eval-overlay.lock.reaper";
const PROOF = "/run/openclaude-v5/production-mutation.lock.manual-holder";
const RELEASE_ROOT = "/opt/openclaude/openclaude-v5-releases";
const SHA = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const NONCE = /^[0-9a-f]{32}$/;
const UIDS = new Set([247, 626]);
const MAX_TTL = 1500;
const RECORD_LOCK_MAX_AGE_MS = 300000;
const [, , action, payload64] = process.argv;
const payload = JSON.parse(Buffer.from(payload64 || "", "base64").toString("utf8"));

function fail(message) { throw new Error(message); }
function sha256(input) { return createHash("sha256").update(input).digest("hex"); }
function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function assertUid(uid) {
  if (!Number.isSafeInteger(uid) || !UIDS.has(uid)) fail("uid is not an approved synthetic account");
}
function assertRoot() {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    fail("remote synthetic overlay helper must run as root");
  }
}
function secureStat(target, kind, mode, allowedUids = [0]) {
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) fail("symlink is forbidden: " + target);
  if (!allowedUids.includes(stat.uid)) fail("path has an unexpected owner: " + target);
  if ((stat.mode & 0o022) !== 0) fail("path is group/other writable: " + target);
  if (kind === "file" && !stat.isFile()) fail("expected regular file: " + target);
  if (kind === "dir" && !stat.isDirectory()) fail("expected directory: " + target);
  if (mode !== undefined && (stat.mode & 0o777) !== mode) {
    fail("unexpected mode for " + target);
  }
  return stat;
}
function assertLease() {
  assertRoot();
  if (!NONCE.test(payload.leaseNonce || "") || payload.leaseProof !== PROOF) {
    fail("external production-mutation lease environment proof is invalid");
  }
  secureStat(PROOF, "file", 0o600);
  if (fs.readFileSync(PROOF, "utf8").trim() !== payload.leaseNonce) {
    fail("external production-mutation lease proof does not match its holder");
  }
}
function psql(sql) {
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is unavailable");
  const result = spawnSync(
    "psql",
    [process.env.DATABASE_URL, "-X", "-v", "ON_ERROR_STOP=1", "-tAq"],
    { encoding: "utf8", input: sql, maxBuffer: 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) fail("deploy_state query failed: " + (result.stderr || result.stdout));
  return result.stdout.trim();
}
function countEnabledCronFile(activeRelease, uid) {
  const cronPath =
    "/var/lib/docker/volumes/oc-v5-data-u" + uid + "/_data/cron.yaml";
  if (!fs.existsSync(cronPath)) return 0;
  // Persistent agent data is written by the enforced container identity
  // (1000:1000); legacy/root-created files remain valid. This exception is
  // fixed here and is never taken from the remote payload.
  secureStat(cronPath, "file", undefined, [0, 1000]);
  const requireFromRelease = createRequire(path.join(activeRelease, "package.json"));
  const yaml = requireFromRelease("yaml");
  const parsed = yaml.parse(fs.readFileSync(cronPath, "utf8"));
  const jobs = parsed && Array.isArray(parsed.jobs) ? parsed.jobs : [];
  return jobs.filter((job) => job && job.enabled !== false).length;
}
function readSnapshot() {
  assertUid(payload.uid);
  if (!COMMIT.test(payload.expectedBase || "")) fail("expected base commit is invalid");
  const sql = [
    "SELECT json_build_object(",
    " 'phase', phase,",
    " 'activeSlot', active_slot,",
    " 'candidateSlot', candidate_slot,",
    " 'activeRelease', active_release,",
    " 'candidateRelease', candidate_release,",
    " 'cohortPercent', cohort_percent,",
    " 'lockVersion', lock_version,",
    " 'enabledCron', COALESCE((",
    "   SELECT jobs_enabled FROM cron_wake_index",
    "    WHERE user_id = " + payload.uid + " AND runtime_channel = 'v5'",
    " ), 0),",
    " 'dispatchCount', (SELECT count(*)::int FROM turn_dispatches",
    "   WHERE user_id = " + payload.uid + "),",
    " 'openDispatchCount', (SELECT count(*)::int FROM turn_dispatches",
    "   WHERE user_id = " + payload.uid,
    "     AND status IN ('admitted','accepted','rejecting')),",
    " 'usageCount', (SELECT count(*)::int FROM usage_records",
    "   WHERE user_id = " + payload.uid + "),",
    " 'usageMaxId', COALESCE((SELECT max(id) FROM usage_records",
    "   WHERE user_id = " + payload.uid + "), 0)",
    ")::text FROM deploy_state WHERE singleton = true;",
  ].join("\n");
  const raw = psql(sql);
  if (!raw) fail("deploy_state singleton is missing");
  const state = JSON.parse(raw);
  if (
    state.phase !== "stable"
    || !["A", "B"].includes(state.activeSlot)
    || state.candidateSlot !== null
    || state.candidateRelease !== null
    || state.cohortPercent !== 0
    || !Number.isSafeInteger(state.lockVersion)
    || state.lockVersion < 1
    || state.enabledCron !== 0
    || !Number.isSafeInteger(state.dispatchCount)
    || state.dispatchCount < 0
    || state.openDispatchCount !== 0
    || !Number.isSafeInteger(state.usageCount)
    || state.usageCount < 0
    || !Number.isSafeInteger(state.usageMaxId)
    || state.usageMaxId < 0
  ) {
    fail("deploy_state is not stable/candidate-null/cohort-0/cron-free");
  }
  if (
    payload.expectedLockVersion !== undefined
    && state.lockVersion !== payload.expectedLockVersion
  ) {
    fail("deploy_state lock_version changed during preparation");
  }
  if (
    typeof state.activeRelease !== "string"
    || !state.activeRelease.startsWith(RELEASE_ROOT + "/rel-")
  ) {
    fail("active stable release path is invalid");
  }
  const releaseReal = fs.realpathSync(state.activeRelease);
  if (
    releaseReal !== state.activeRelease
    || !releaseReal.startsWith(RELEASE_ROOT + "/rel-")
  ) {
    fail("active release is not the exact trusted release directory");
  }
  secureStat(releaseReal, "dir");
  const markerPath = path.join(releaseReal, ".complete");
  secureStat(markerPath, "file");
  const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
  if (!COMMIT.test(marker.sourceCommit || "") || marker.sourceCommit !== payload.expectedBase) {
    fail("active stable release sourceCommit is not the exact evaluation base");
  }
  const cronFileEnabled = countEnabledCronFile(releaseReal, payload.uid);
  if (cronFileEnabled !== 0) fail("synthetic account has enabled cron.yaml jobs");
  const v3 = spawnSync("systemctl", ["is-active", "openclaude-v3"], {
    encoding: "utf8",
  });
  const v3State = (v3.stdout || "").trim();
  if (v3State !== "inactive") fail("openclaude-v3 is not inactive");
  const syntheticContainer = spawnSync(
    "docker",
    ["inspect", "-f", "{{.Id}}", "oc-v5-u" + payload.uid],
    { encoding: "utf8" },
  );
  if (syntheticContainer.error) throw syntheticContainer.error;
  const syntheticContainerId = syntheticContainer.status === 0
    ? syntheticContainer.stdout.trim()
    : null;
  if (
    syntheticContainerId !== null
    && !/^[0-9a-f]{64}$/.test(syntheticContainerId)
  ) {
    fail("synthetic account container identity is invalid");
  }
  return {
    ...state,
    sourceCommit: marker.sourceCommit,
    cronFileEnabled,
    v3State,
    syntheticContainerId,
  };
}
function listFiles(root, current = root) {
  const files = [];
  for (const name of fs.readdirSync(current).sort()) {
    const absolute = path.join(current, name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) fail("staged tree contains a symlink: " + absolute);
    if (stat.uid !== 0) fail("staged tree entry is not root-owned: " + absolute);
    if ((stat.mode & 0o022) !== 0) fail("staged tree entry is group/other writable: " + absolute);
    if (stat.isDirectory()) files.push(...listFiles(root, absolute));
    else if (stat.isFile()) files.push(absolute);
    else fail("staged tree contains a non-file entry: " + absolute);
  }
  return files;
}
function hashTree(root) {
  const realRoot = fs.realpathSync(root);
  const digest = createHash("sha256");
  for (const absolute of listFiles(realRoot)) {
    const relative = path.relative(realRoot, absolute).split(path.sep).join("/");
    digest.update(sha256(fs.readFileSync(absolute)) + "  " + relative + "\n");
  }
  return digest.digest("hex");
}
function hashFile(file) {
  secureStat(file, "file");
  return sha256(fs.readFileSync(file));
}
function validateStage(stage) {
  const stageReal = fs.realpathSync(stage);
  if (
    stageReal !== stage
    || !stageReal.startsWith(fs.realpathSync(STAGING_ROOT) + path.sep)
  ) {
    fail("staging realpath escaped its fixed root");
  }
  secureStat(stage, "dir", 0o700);
  const manifestPath = path.join(stage, "manifest.json");
  secureStat(manifestPath, "file", 0o600);
  const bytes = fs.readFileSync(manifestPath);
  const stageManifestSha = payload.manifestSha || path.basename(stage);
  if (!SHA.test(stageManifestSha) || sha256(bytes) !== stageManifestSha) {
    fail("manifest SHA does not match stage identity");
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    !exactKeys(manifest, ["schemaVersion", "baseCommit", "candidateCommit", "files"])
    || manifest.schemaVersion !== 1
    || !COMMIT.test(manifest.baseCommit || "")
    || !COMMIT.test(manifest.candidateCommit || "")
    || (payload.expectedBase !== undefined && manifest.baseCommit !== payload.expectedBase)
    || (payload.candidateCommit !== undefined && manifest.candidateCommit !== payload.candidateCommit)
    || !exactKeys(manifest.files, [
      "promptsTree", "promptSlots", "agents", "claude", "skillsTree",
    ])
    || Object.values(manifest.files).some((digest) => typeof digest !== "string" || !SHA.test(digest))
  ) {
    fail("staged manifest shape/identity is invalid");
  }
  const tree = path.join(stage, "tree");
  secureStat(tree, "dir", 0o755);
  const actual = {
    promptsTree: hashTree(path.join(tree, "packages/commercial/agent-sandbox/platform-runtime/prompts")),
    promptSlots: hashFile(path.join(tree, "packages/gateway/src/promptSlots.ts")),
    agents: hashFile(path.join(tree, "packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md")),
    claude: hashFile(path.join(tree, "packages/commercial/agent-sandbox/ccb-baseline/CLAUDE.md")),
    skillsTree: hashTree(path.join(tree, "packages/commercial/agent-sandbox/ccb-baseline/skills")),
  };
  for (const [name, digest] of Object.entries(actual)) {
    if (manifest.files[name] !== digest) fail("staged digest mismatch: " + name);
  }
  return manifest;
}
function normalizeTree(root) {
  const visit = (current) => {
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink()) fail("symlink is forbidden in uploaded stage");
    if (stat.isDirectory()) {
      fs.chownSync(current, 0, 0);
      fs.chmodSync(current, current === root ? 0o755 : 0o755);
      for (const name of fs.readdirSync(current)) visit(path.join(current, name));
      return;
    }
    if (!stat.isFile()) fail("uploaded stage contains a non-file entry");
    fs.chownSync(current, 0, 0);
    fs.chmodSync(current, 0o644);
  };
  visit(root);
}
function ensureFixedRoots() {
  fs.mkdirSync(STAGING_ROOT, { recursive: true, mode: 0o700 });
  fs.chownSync(STAGING_ROOT, 0, 0);
  fs.chmodSync(STAGING_ROOT, 0o700);
  secureStat(STAGING_ROOT, "dir", 0o700);
  secureStat(path.dirname(ACTIVE_RECORD), "dir");
}
function processStartTime(pid) {
  try {
    const stat = fs.readFileSync("/proc/" + pid + "/stat", "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return fields[19] && /^\d+$/.test(fields[19]) ? fields[19] : null;
  } catch {
    return null;
  }
}
function bootId() {
  const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[0-9a-f-]{36}$/.test(value)) fail("record lock boot id is invalid");
  return value;
}
function parseLockOwner(value) {
  if (
    !exactKeys(value, [
      "schemaVersion", "pid", "processStartTime", "bootId", "nonce",
      "createdAt", "expiresAt",
    ])
    || value.schemaVersion !== 1
    || !Number.isSafeInteger(value.pid)
    || value.pid <= 0
    || !/^\d+$/.test(value.processStartTime || "")
    || !/^[0-9a-f-]{36}$/.test(value.bootId || "")
    || !NONCE.test(value.nonce || "")
    || !Number.isFinite(Date.parse(value.createdAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.parse(value.createdAt)
    || Date.parse(value.expiresAt) - Date.parse(value.createdAt) > RECORD_LOCK_MAX_AGE_MS
  ) {
    fail("record lock owner is invalid");
  }
  return value;
}
function withOwnerLock(target, allowStaleReap, operation) {
  ensureFixedRoots();
  const currentBootId = bootId();
  const currentStartTime = processStartTime(process.pid);
  if (!currentStartTime) fail("cannot identify record lock process");
  const createdAtMs = Date.now();
  const owner = {
    schemaVersion: 1,
    pid: process.pid,
    processStartTime: currentStartTime,
    bootId: currentBootId,
    nonce: randomBytes(16).toString("hex"),
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + RECORD_LOCK_MAX_AGE_MS).toISOString(),
  };
  const ownerBytes = JSON.stringify(owner) + "\n";
  const temporary =
    target + ".candidate." + process.pid + "." + owner.nonce;
  let acquired = false;
  for (let attempt = 0; attempt < 10 && !acquired; attempt += 1) {
    let fd = null;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, ownerBytes);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
      fs.chownSync(temporary, 0, 0);
      fs.chmodSync(temporary, 0o600);
      fs.linkSync(temporary, target);
      fsyncDirectory(path.dirname(target));
      acquired = true;
    } catch (error) {
      if (fd !== null) fs.closeSync(fd);
      if (error.code !== "EEXIST") throw error;
      let stale = false;
      try {
        const stat = fs.lstatSync(target);
        if (stat.isFile() && !stat.isSymbolicLink()) {
          secureStat(target, "file", 0o600);
          const current = parseLockOwner(
            JSON.parse(fs.readFileSync(target, "utf8")),
          );
          stale =
            current.bootId !== currentBootId
            || processStartTime(current.pid) !== current.processStartTime;
          if (!stale && Date.now() >= Date.parse(current.expiresAt)) {
            fail("expired record lock still has a live exact owner");
          }
        } else if (stat.isDirectory() && !stat.isSymbolicLink()) {
          stale = Date.now() - stat.mtimeMs >= RECORD_LOCK_MAX_AGE_MS;
        } else {
          fail("record lock has an unsafe type");
        }
      } catch (readError) {
        if (readError.code === "ENOENT") continue;
        throw readError;
      }
      if (!stale || !allowStaleReap) fail("record lock is held by a live owner");
      const quarantine =
        target + ".stale." + process.pid + "." + owner.nonce + "." + attempt;
      try {
        fs.renameSync(target, quarantine);
        fs.rmSync(quarantine, { recursive: true, force: true });
        fsyncDirectory(path.dirname(target));
      } catch (replaceError) {
        if (replaceError.code !== "ENOENT") throw replaceError;
      }
    } finally {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
  if (!acquired) fail("record lock acquisition did not converge");
  const assertHeld = () => {
    secureStat(target, "file", 0o600);
    if (fs.readFileSync(target, "utf8") !== ownerBytes) {
      fail("record lock ownership was lost");
    }
    if (
      processStartTime(process.pid) !== currentStartTime
      || Date.now() >= Date.parse(owner.expiresAt)
    ) {
      fail("record lock owner expired");
    }
  };
  try {
    assertHeld();
    return operation(assertHeld);
  } finally {
    assertHeld();
    fs.unlinkSync(target);
    fsyncDirectory(path.dirname(target));
  }
}
function withRecordLock(operation) {
  return withOwnerLock(
    RECORD_LOCK_REAPER,
    true,
    () => withOwnerLock(RECORD_LOCK, true, operation),
  );
}
function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function installStage() {
  if (!payload.apply) return { applied: false, stage: STAGING_ROOT + "/" + payload.manifestSha };
  if (!SHA.test(payload.manifestSha || "") || !SHA.test(payload.tarSha || "")) {
    fail("stage archive identity is invalid");
  }
  if (!NONCE.test(payload.recordNonce || "")) fail("record nonce is invalid");
  ensureFixedRoots();
  const archive = fs.readFileSync(0);
  if (sha256(archive) !== payload.tarSha) fail("uploaded stage tar SHA mismatch");
  const listing = spawnSync("tar", ["-tf", "-"], { input: archive, encoding: "utf8" });
  if (listing.status !== 0) fail("cannot list stage archive");
  for (const entry of listing.stdout.split("\n").filter(Boolean)) {
    if (path.isAbsolute(entry) || entry.split("/").includes("..")) {
      fail("unsafe stage archive path: " + entry);
    }
  }
  const incoming = path.join(STAGING_ROOT, ".staging-" + payload.recordNonce);
  if (fs.existsSync(incoming)) fail("staging nonce path already exists");
  fs.mkdirSync(incoming, { mode: 0o700 });
  fs.chownSync(incoming, 0, 0);
  try {
    const extracted = spawnSync(
      "tar",
      ["-xf", "-", "-C", incoming, "--no-same-owner", "--no-same-permissions"],
      { input: archive, encoding: "utf8" },
    );
    if (extracted.status !== 0) fail("cannot extract stage archive: " + extracted.stderr);
    const top = fs.readdirSync(incoming).sort();
    if (top.join(",") !== "manifest.json,tree") fail("stage archive has unexpected top-level entries");
    normalizeTree(path.join(incoming, "tree"));
    fs.chownSync(path.join(incoming, "manifest.json"), 0, 0);
    fs.chmodSync(path.join(incoming, "manifest.json"), 0o600);
    fs.chmodSync(incoming, 0o700);
    validateStage(incoming);
    const finalPath = path.join(STAGING_ROOT, payload.manifestSha);
    if (fs.existsSync(finalPath)) {
      validateStage(finalPath);
      fs.rmSync(incoming, { recursive: true });
      return { applied: true, reused: true, stage: finalPath };
    }
    fs.renameSync(incoming, finalPath);
    fsyncDirectory(STAGING_ROOT);
    validateStage(finalPath);
    return { applied: true, reused: false, stage: finalPath };
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    throw error;
  }
}
function parseRecord(raw, allowExpired = true) {
  const record = JSON.parse(raw);
  const expected = record.state === "active"
    ? ["schemaVersion", "state", "uid", "nonce", "manifestSha", "preparedAt", "expiresAt", "containerId"]
    : ["schemaVersion", "state", "uid", "nonce", "manifestSha", "preparedAt", "expiresAt"];
  if (
    !exactKeys(record, expected)
    || record.schemaVersion !== 1
    || !["prepared", "active"].includes(record.state)
    || !UIDS.has(record.uid)
    || !NONCE.test(record.nonce || "")
    || !SHA.test(record.manifestSha || "")
    || !Number.isFinite(Date.parse(record.preparedAt))
    || !Number.isFinite(Date.parse(record.expiresAt))
    || Date.parse(record.expiresAt) <= Date.parse(record.preparedAt)
    || Date.parse(record.expiresAt) - Date.parse(record.preparedAt) > MAX_TTL * 1000
    || (!allowExpired && Date.now() >= Date.parse(record.expiresAt))
    || (record.state === "active" && !/^[0-9a-f]{64}$/.test(record.containerId || ""))
  ) {
    fail("active record is invalid");
  }
  return record;
}
function readRecord(allowExpired = true) {
  secureStat(ACTIVE_RECORD, "file", 0o600);
  return parseRecord(fs.readFileSync(ACTIVE_RECORD, "utf8"), allowExpired);
}
function writePreparedRecord(assertHeld) {
  if (!payload.apply) {
    return {
      applied: false,
      record: ACTIVE_RECORD,
      nonce: payload.recordNonce,
      manifestSha: payload.manifestSha,
    };
  }
  assertUid(payload.uid);
  if (
    !NONCE.test(payload.recordNonce || "")
    || !SHA.test(payload.manifestSha || "")
    || !Number.isSafeInteger(payload.ttlSeconds)
    || payload.ttlSeconds < 60
    || payload.ttlSeconds > MAX_TTL
  ) {
    fail("prepared record arguments are invalid");
  }
  ensureFixedRoots();
  validateStage(path.join(STAGING_ROOT, payload.manifestSha));
  if (fs.existsSync(ACTIVE_RECORD)) {
    const existing = readRecord();
    if (
      existing.nonce === payload.recordNonce
      && existing.manifestSha === payload.manifestSha
      && existing.uid === payload.uid
      && Date.now() < Date.parse(existing.expiresAt)
    ) {
      return { applied: true, reused: true, record: existing };
    }
    fail("another synthetic evaluation active record exists; clear it by its exact nonce");
  }
  const preparedAt = new Date();
  const expiresAt = new Date(preparedAt.getTime() + payload.ttlSeconds * 1000);
  const record = {
    schemaVersion: 1,
    state: "prepared",
    uid: payload.uid,
    nonce: payload.recordNonce,
    manifestSha: payload.manifestSha,
    preparedAt: preparedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
  const parent = path.dirname(ACTIVE_RECORD);
  const temporary = ACTIVE_RECORD + ".tmp." + payload.recordNonce;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(record) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.chownSync(temporary, 0, 0);
  fs.chmodSync(temporary, 0o600);
  assertHeld();
  fs.renameSync(temporary, ACTIVE_RECORD);
  fsyncDirectory(parent);
  const persisted = readRecord();
  if (persisted.nonce !== payload.recordNonce) fail("prepared record did not persist exactly");
  return { applied: true, reused: false, record: persisted };
}
function removeRecord(recover, assertHeld) {
  if (!NONCE.test(payload.recordNonce || "")) fail("record nonce is invalid");
  const recordExists = fs.existsSync(ACTIVE_RECORD);
  const record = recordExists ? readRecord() : null;
  if (record && record.nonce !== payload.recordNonce) {
    fail("refusing to clear/recover a record with a different nonce");
  }
  if (
    record
    && payload.manifestSha !== undefined
    && record.manifestSha !== payload.manifestSha
  ) {
    fail("refusing to recover a record with a different manifest");
  }
  if (!payload.apply) {
    return { applied: false, recover, record, manifestSha: payload.manifestSha || null };
  }
  assertHeld();
  if (record) {
    fs.unlinkSync(ACTIVE_RECORD);
    fsyncDirectory(path.dirname(ACTIVE_RECORD));
  }
  const incoming = path.join(STAGING_ROOT, ".staging-" + payload.recordNonce);
  fs.rmSync(incoming, { recursive: true, force: true });
  if (recover) {
    const manifestSha = record?.manifestSha || payload.manifestSha;
    if (!SHA.test(manifestSha || "")) {
      fail("recover without a record requires the exact manifest SHA");
    }
    const stage = path.join(STAGING_ROOT, manifestSha);
    if (fs.existsSync(stage)) {
      validateStage(stage);
      assertHeld();
      fs.rmSync(stage, { recursive: true });
      fsyncDirectory(STAGING_ROOT);
    }
  }
  return {
    applied: true,
    recover,
    recordFound: record !== null,
    nonce: payload.recordNonce,
    manifestSha: record?.manifestSha || payload.manifestSha || null,
  };
}

const CONTAINER_HASH_SOURCE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { createHash } = require("node:crypto");',
  'const sha = (value) => createHash("sha256").update(value).digest("hex");',
  'function files(root,current=root){const out=[];for(const name of fs.readdirSync(current).sort()){const absolute=path.join(current,name);const stat=fs.lstatSync(absolute);if(stat.isSymbolicLink())throw new Error("symlink:"+absolute);if(stat.isDirectory())out.push(...files(root,absolute));else if(stat.isFile())out.push(absolute);else throw new Error("non-file:"+absolute)}return out}',
  'function tree(root){const real=fs.realpathSync(root);const hash=createHash("sha256");for(const absolute of files(real)){const rel=path.relative(real,absolute).split(path.sep).join("/");hash.update(sha(fs.readFileSync(absolute))+"  "+rel+"\\n")}return hash.digest("hex")}',
  'const regular=(file)=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error("not regular:"+file);return sha(fs.readFileSync(file))};',
  'process.stdout.write(JSON.stringify({promptsTree:tree("/run/oc/synthetic-eval/prompts"),promptSlots:regular("/opt/openclaude/packages/gateway/src/promptSlots.ts"),agents:regular("/opt/openclaude/AGENTS.md"),claude:regular("/run/oc/claude-config/CLAUDE.md"),skillsTree:tree("/run/oc/claude-config/skills")}));',
].join("\n");

const EXTRA_PROMPT_SOURCE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { createHash } = require("node:crypto");',
  'const [engine,sessionKey] = process.argv.slice(1);',
  'const sha = (value) => createHash("sha256").update(value).digest("hex");',
  'const candidates=[];',
  'for(const name of fs.readdirSync("/proc")){if(!/^[0-9]+$/.test(name))continue;const root="/proc/"+name;try{const args=fs.readFileSync(root+"/cmdline").toString("utf8").split("\\0").filter(Boolean);const env=Object.fromEntries(fs.readFileSync(root+"/environ").toString("utf8").split("\\0").filter(Boolean).map((entry)=>{const index=entry.indexOf("=");return index<0?[entry,""]:[entry.slice(0,index),entry.slice(index+1)]}));let promptPath=null;if(engine==="ccb"&&env.OPENCLAUDE_SESSION_KEY===sessionKey){const index=args.indexOf("--append-system-prompt-file");if(index>=0)promptPath=args[index+1]||null}else if(engine==="codex"&&args.some((arg)=>arg==="app-server")){for(let index=0;index<args.length-1;index++){if(args[index]!=="-c"||!args[index+1].startsWith("model_instructions_file="))continue;let value=args[index+1].slice("model_instructions_file=".length);if(value.startsWith("\\""))value=JSON.parse(value);promptPath=value;break}}if(promptPath)candidates.push({pid:Number(name),args,promptPath,startTime:fs.readFileSync(root+"/stat","utf8").split(" ")[21]})}catch{}}',
  'let candidate;if(engine==="ccb"){if(candidates.length!==1)throw new Error("expected exactly one session-bound CCB process, got "+candidates.length);candidate=candidates[0]}else{if(candidates.length<1)throw new Error("no Codex app-server process found");candidates.sort((left,right)=>BigInt(left.startTime)<BigInt(right.startTime)?-1:BigInt(left.startTime)>BigInt(right.startTime)?1:0);if(candidates.length>1&&candidates[0].startTime===candidates[1].startTime)throw new Error("cannot identify the unique earliest Codex app-server");candidate=candidates[0]}',
  'if(!path.isAbsolute(candidate.promptPath)||path.basename(candidate.promptPath)!=="extra-prompt.md")throw new Error("invalid extra prompt path");',
  'const before=fs.lstatSync(candidate.promptPath);if(!before.isFile()||before.isSymbolicLink())throw new Error("extra prompt is not a regular file");',
  'const bytes=fs.readFileSync(candidate.promptPath);if(bytes.length>2097152)throw new Error("extra prompt evidence exceeds 2 MiB");',
  'const after=fs.lstatSync(candidate.promptPath);const startAfter=fs.readFileSync("/proc/"+candidate.pid+"/stat","utf8").split(" ")[21];',
  'if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||candidate.startTime!==startAfter)throw new Error("extra prompt/process changed while hashing");',
  'process.stdout.write(JSON.stringify({pid:candidate.pid,startTime:candidate.startTime,path:candidate.promptPath,bytes:bytes.length,sha256:sha(bytes),cmdlineSha256:sha(Buffer.from(candidate.args.join("\\0")+"\\0")),candidateCount:candidates.length,selection:engine==="ccb"?"exact-session-key":"earliest-in-fresh-exclusive-container",contentBase64:bytes.toString("base64")}));',
].join("\n");

const DYNAMIC_INPUT_SOURCE = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { createHash } = require("node:crypto");',
  'const [agentId,caseId,phase] = process.argv.slice(1);',
  'if(!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)||!/^[A-Za-z0-9_-]{1,80}$/.test(caseId)||!["pre","post"].includes(phase))throw new Error("invalid dynamic input identity");',
  'const sha=(value)=>createHash("sha256").update(value).digest("hex");',
  'function identity(target){let stat;try{stat=fs.lstatSync(target)}catch(error){if(error&&error.code==="ENOENT")return {state:"absent"};throw error}if(stat.isSymbolicLink())throw new Error("dynamic input symlink:"+target);const root=fs.realpathSync(target);if(root!==target)throw new Error("dynamic input path is not canonical:"+target);if(stat.isFile()){const bytes=fs.readFileSync(root);return {state:"file",bytes:bytes.length,sha256:sha(bytes)}}if(!stat.isDirectory())throw new Error("dynamic input has unsafe type:"+target);const hash=createHash("sha256");let files=0;let directories=0;function walk(current){for(const name of fs.readdirSync(current).sort()){const absolute=path.join(current,name);const child=fs.lstatSync(absolute);if(child.isSymbolicLink())throw new Error("dynamic input symlink:"+absolute);const relative=path.relative(root,absolute).split(path.sep).join("/");if(child.isDirectory()){directories++;hash.update("D  "+relative+"\\n");walk(absolute)}else if(child.isFile()){files++;hash.update("F  "+sha(fs.readFileSync(absolute))+"  "+relative+"\\n")}else throw new Error("dynamic input has unsafe entry:"+absolute)}}walk(root);return {state:"tree",files,directories,sha256:hash.digest("hex")}}',
  'const agentRoot="/home/agent/.openclaude/agents/"+agentId;',
  'const temporary="/tmp/oc-synthetic-eval-"+caseId;',
  'const value={agentClaude:identity(agentRoot+"/CLAUDE.md"),agentMemoryIndex:identity(agentRoot+"/MEMORY.md"),agentMemoryTree:identity(agentRoot+"/memory"),userSoul:identity("/home/agent/.openclaude/SOUL.md"),userProfile:identity("/home/agent/.openclaude/USER.md"),userSkills:identity("/home/agent/.openclaude/hub/skills"),workspace:identity("/home/agent/.openclaude/workspace"),temporaryWorkspace:identity(temporary)};',
  'if(phase==="pre"&&value.temporaryWorkspace.state!=="absent")throw new Error("temporary evaluation workspace already exists");',
  'process.stdout.write(JSON.stringify(value));',
].join("\n");

function dockerExecJson(container, source, args = []) {
  const result = spawnSync(
    "docker",
    ["exec", container, "node", "-e", source, ...args],
    { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail("docker evidence probe failed: " + (result.stderr || result.stdout));
  }
  return JSON.parse(result.stdout);
}

function inspectContainer() {
  assertUid(payload.uid);
  if (!SHA.test(payload.manifestSha || "") || !NONCE.test(payload.recordNonce || "")) {
    fail("container evidence identity is invalid");
  }
  if (!/^[0-9a-f]{64}$/.test(payload.containerId || "")) {
    fail("container evidence Docker identity is invalid");
  }
  const container = "oc-v5-u" + payload.uid;
  const inspected = spawnSync("docker", ["inspect", container], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (inspected.error) throw inspected.error;
  if (inspected.status !== 0) fail("cannot inspect synthetic eval container");
  const info = JSON.parse(inspected.stdout)[0];
  if (info.Id !== payload.containerId || info.State?.Running !== true) {
    fail("synthetic eval container identity/state changed");
  }
  const record = readRecord(false);
  if (
    record.state !== "active"
    || record.uid !== payload.uid
    || record.nonce !== payload.recordNonce
    || record.manifestSha !== payload.manifestSha
    || record.containerId !== payload.containerId
  ) {
    fail("active record is not bound to the evaluated container");
  }
  const labels = info.Config?.Labels || {};
  if (
    labels["openclaude.synthetic-eval.manifest-sha"] !== payload.manifestSha
    || labels["openclaude.synthetic-eval.nonce"] !== payload.recordNonce
    || labels["openclaude.synthetic-eval.uid"] !== String(payload.uid)
  ) {
    fail("synthetic eval container labels are not exact");
  }
  const manifestDir = path.join(STAGING_ROOT, payload.manifestSha);
  const manifest = validateStage(manifestDir);
  const tree = path.join(manifestDir, "tree");
  const requiredMounts = new Map([
    ["/run/oc/synthetic-eval/prompts", path.join(tree, "packages/commercial/agent-sandbox/platform-runtime/prompts")],
    ["/opt/openclaude/packages/gateway/src/promptSlots.ts", path.join(tree, "packages/gateway/src/promptSlots.ts")],
    ["/opt/openclaude/AGENTS.md", path.join(tree, "packages/commercial/agent-sandbox/ccb-baseline/AGENTS.md")],
    ["/run/oc/claude-config/CLAUDE.md", path.join(tree, "packages/commercial/agent-sandbox/ccb-baseline/CLAUDE.md")],
    ["/run/oc/claude-config/skills", path.join(tree, "packages/commercial/agent-sandbox/ccb-baseline/skills")],
  ]);
  for (const [destination, source] of requiredMounts) {
    const matches = (info.Mounts || []).filter((mount) => mount.Destination === destination);
    if (
      matches.length !== 1
      || matches[0].Type !== "bind"
      || matches[0].RW !== false
      || matches[0].Source !== source
    ) {
      fail("synthetic eval mount is not exact: " + destination);
    }
  }
  const env = Object.fromEntries((info.Config?.Env || []).map((entry) => {
    const index = entry.indexOf("=");
    return index < 0 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
  }));
  if (env.OPENCLAUDE_PLATFORM_PROMPTS_DIR !== "/run/oc/synthetic-eval/prompts") {
    fail("synthetic eval prompt directory env is not exact");
  }
  const runtimeTuple = {
    image: env.OC_RUNTIME_IMAGE || info.Config?.Image || null,
    imageId:
      env.OC_RUNTIME_IMAGE_ID
      || labels["com.openclaude.runtime.image_id"]
      || info.Image
      || null,
    runtimeRelease:
      env.OC_RUNTIME_RELEASE
      || labels["com.openclaude.runtime.release"]
      || null,
    platformBundle:
      env.OC_PLATFORM_BUNDLE
      || labels["com.openclaude.runtime.bundle_rev"]
      || null,
  };
  if (
    Object.values(runtimeTuple).some(
      (value) => typeof value !== "string" || value.length === 0,
    )
  ) {
    fail("synthetic eval container runtime tuple is incomplete");
  }
  const actual = dockerExecJson(container, CONTAINER_HASH_SOURCE);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    fail("fresh container prompt hashes differ from staged manifest");
  }
  return {
    uid: payload.uid,
    container,
    containerId: info.Id,
    startedAt: info.State.StartedAt,
    manifestSha: payload.manifestSha,
    nonce: payload.recordNonce,
    runtimeTuple,
    hashes: actual,
  };
}

function inspectExtraPrompt() {
  if (!["ccb", "codex"].includes(payload.engine)) fail("extra prompt engine is invalid");
  if (
    typeof payload.sessionKey !== "string"
    || !/^agent:[A-Za-z0-9_-]+:webchat:dm:[A-Za-z0-9_-]{8,160}$/.test(payload.sessionKey)
  ) {
    fail("extra prompt session key is invalid");
  }
  const evidence = inspectContainer();
  return {
    ...evidence,
    extraPrompt: dockerExecJson(
      evidence.container,
      EXTRA_PROMPT_SOURCE,
      [payload.engine, payload.sessionKey],
    ),
  };
}

function inspectDynamicInputs() {
  if (
    typeof payload.agentId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.agentId)
    || typeof payload.caseId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.caseId)
    || !["pre", "post"].includes(payload.phase)
  ) {
    fail("dynamic input evidence identity is invalid");
  }
  const evidence = inspectContainer();
  return {
    ...evidence,
    phase: payload.phase,
    inputs: dockerExecJson(
      evidence.container,
      DYNAMIC_INPUT_SOURCE,
      [payload.agentId, payload.caseId, payload.phase],
    ),
  };
}

function captureCopiedWorkspace(root) {
  const rootReal = fs.realpathSync(root);
  if (rootReal !== root) fail("copied workspace path is not canonical");
  const entries = [];
  const hash = createHash("sha256");
  let files = 0;
  let directories = 0;
  function walk(current) {
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const before = fs.lstatSync(absolute);
      if (before.isSymbolicLink()) fail("workspace artifact symlink is forbidden: " + absolute);
      if (![0, 1000].includes(before.uid) || (before.mode & 0o022) !== 0) {
        fail("workspace artifact has unsafe owner or mode: " + absolute);
      }
      const relative = path.relative(rootReal, absolute).split(path.sep).join("/");
      if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
        fail("workspace artifact path escaped its root");
      }
      if (before.isDirectory()) {
        directories += 1;
        entries.push({ path: relative, type: "directory", mode: before.mode & 0o777 });
        hash.update("D  " + relative + "\n");
        walk(absolute);
        const after = fs.lstatSync(absolute);
        if (
          !after.isDirectory()
          || after.isSymbolicLink()
          || before.dev !== after.dev
          || before.ino !== after.ino
          || before.mtimeMs !== after.mtimeMs
        ) {
          fail("workspace artifact directory changed while capturing: " + absolute);
        }
      } else if (before.isFile()) {
        const bytes = fs.readFileSync(absolute);
        const after = fs.lstatSync(absolute);
        if (
          !after.isFile()
          || after.isSymbolicLink()
          || before.dev !== after.dev
          || before.ino !== after.ino
          || before.size !== after.size
          || before.mtimeMs !== after.mtimeMs
        ) {
          fail("workspace artifact file changed while capturing: " + absolute);
        }
        const digest = sha256(bytes);
        files += 1;
        entries.push({
          path: relative,
          type: "file",
          mode: before.mode & 0o777,
          bytes: bytes.length,
          sha256: digest,
          contentBase64: bytes.toString("base64"),
        });
        hash.update("F  " + digest + "  " + relative + "\n");
      } else {
        fail("workspace artifact contains a non-file entry: " + absolute);
      }
    }
  }
  walk(rootReal);
  return {
    identity: {
      state: "tree",
      files,
      directories,
      sha256: hash.digest("hex"),
    },
    entries,
  };
}

function inspectWorkspaceArtifacts() {
  if (
    typeof payload.agentId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.agentId)
    || typeof payload.caseId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.caseId)
    || !["ccb", "codex"].includes(payload.engine)
    || !["none", "temporary"].includes(payload.workspaceMode)
    || !payload.expectedIdentity
    || typeof payload.expectedIdentity !== "object"
    || !["absent", "tree"].includes(payload.expectedIdentity.state)
  ) {
    fail("workspace artifact evidence identity is invalid");
  }
  const evidence = inspectContainer();
  const liveBefore = dockerExecJson(
    evidence.container,
    DYNAMIC_INPUT_SOURCE,
    [payload.agentId, payload.caseId, "post"],
  ).temporaryWorkspace;
  if (JSON.stringify(liveBefore) !== JSON.stringify(payload.expectedIdentity)) {
    fail("workspace artifact live identity differs from post-turn evidence");
  }
  if (
    (payload.workspaceMode === "none" && liveBefore.state !== "absent")
    || (payload.workspaceMode === "temporary" && !["absent", "tree"].includes(liveBefore.state))
  ) {
    fail("workspace artifact state differs from case contract");
  }
  const stage = path.join(STAGING_ROOT, payload.manifestSha);
  validateStage(stage);
  const evidenceRoot = path.join(stage, "evidence");
  fs.mkdirSync(evidenceRoot, { mode: 0o700 });
  fs.chownSync(evidenceRoot, 0, 0);
  fs.chmodSync(evidenceRoot, 0o700);
  secureStat(evidenceRoot, "dir", 0o700);
  const stem = payload.recordNonce + "-" + payload.caseId;
  const copyRoot = path.join(evidenceRoot, ".copy-" + stem);
  const documentPath = path.join(evidenceRoot, stem + ".workspace.json");
  if (fs.existsSync(copyRoot) || fs.existsSync(documentPath)) {
    fail("workspace artifact evidence path already exists");
  }
  let captured = { identity: { state: "absent" }, entries: [] };
  try {
    if (liveBefore.state === "tree") {
      fs.mkdirSync(copyRoot, { mode: 0o700 });
      fs.chownSync(copyRoot, 0, 0);
      fs.chmodSync(copyRoot, 0o700);
      const workspace = "/tmp/oc-synthetic-eval-" + payload.caseId;
      const copied = spawnSync(
        "docker",
        ["cp", evidence.container + ":" + workspace + "/.", copyRoot],
        { encoding: "utf8" },
      );
      if (copied.error) throw copied.error;
      if (copied.status !== 0) {
        fail("workspace artifact docker copy failed: " + (copied.stderr || copied.stdout));
      }
      captured = captureCopiedWorkspace(copyRoot);
      const liveAfter = dockerExecJson(
        evidence.container,
        DYNAMIC_INPUT_SOURCE,
        [payload.agentId, payload.caseId, "post"],
      ).temporaryWorkspace;
      if (
        JSON.stringify(liveAfter) !== JSON.stringify(liveBefore)
        || JSON.stringify(captured.identity) !== JSON.stringify(liveBefore)
      ) {
        fail("workspace artifact changed during complete capture");
      }
    }
    const document = {
      schemaVersion: 1,
      uid: payload.uid,
      engine: payload.engine,
      agentId: payload.agentId,
      caseId: payload.caseId,
      workspaceMode: payload.workspaceMode,
      containerId: evidence.containerId,
      manifestSha: payload.manifestSha,
      identity: captured.identity,
      entries: captured.entries,
    };
    const bytes = Buffer.from(JSON.stringify(document) + "\n");
    const fd = fs.openSync(documentPath, "wx", 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chownSync(documentPath, 0, 0);
    fs.chmodSync(documentPath, 0o600);
    fsyncDirectory(evidenceRoot);
    secureStat(documentPath, "file", 0o600);
    return {
      state: captured.identity.state,
      identity: captured.identity,
      entryCount: captured.entries.length,
      remotePath: documentPath,
      bytes: bytes.length,
      sha256: sha256(bytes),
    };
  } finally {
    fs.rmSync(copyRoot, { recursive: true, force: true });
  }
}

function inspectTurnEvidence() {
  assertUid(payload.uid);
  if (
    typeof payload.peerId !== "string"
    || !/^[A-Za-z0-9_-]{8,160}$/.test(payload.peerId)
    || typeof payload.clientMessageId !== "string"
    || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.clientMessageId)
    || typeof payload.agentId !== "string"
    || !/^[A-Za-z0-9_-]{1,80}$/.test(payload.agentId)
    || typeof payload.model !== "string"
    || !/^[A-Za-z0-9._-]{1,80}$/.test(payload.model)
    || !Number.isSafeInteger(payload.usageFloor)
    || payload.usageFloor < 0
    || !["ccb", "codex"].includes(payload.engine)
    || typeof payload.traceId !== "string"
    || !/^[0-9a-f]{32}$/.test(payload.traceId)
  ) {
    fail("turn evidence identity is invalid");
  }
  const peer = payload.peerId.replaceAll("'", "''");
  const clientMessageId = payload.clientMessageId.replaceAll("'", "''");
  const sql = [
    "WITH exact_dispatch AS (",
    " SELECT dispatch_id,user_id,session_id,client_message_id,agent_id,model,",
    "        billing_request_id,attempt_no,status,outcome,admitted_at,terminal_at",
    "   FROM turn_dispatches",
    "  WHERE user_id=" + payload.uid,
    "    AND session_id='" + peer + "'",
    "    AND client_message_id='" + clientMessageId + "'",
    "),",
    "authority_binding AS (",
    " SELECT atd.authority_turn_id,atd.user_id,atd.dispatch_model,",
    "        atd.canonical_model,atd.session_id,atd.dispatch_id,atd.attempt_no",
    "   FROM authority_turn_dispatches atd",
    "   JOIN exact_dispatch d",
    "     ON d.dispatch_id=atd.dispatch_id AND d.attempt_no=atd.attempt_no",
    "),",
    "root_usage AS (",
    " SELECT u.id,u.session_id,u.mode,u.model,u.request_id,u.dispatch_id,u.turn_key,",
    "        u.parent_turn_key,u.parent_session_id,u.delegate_agent_id,u.status,",
    "        u.input_tokens,u.output_tokens,u.cache_read_tokens,u.cache_write_tokens,",
    "        u.cost_credits,u.ledger_id::text,u.attempt_no,u.created_at",
    "   FROM usage_records u",
    "   JOIN exact_dispatch d",
    "     ON d.dispatch_id=u.dispatch_id AND d.attempt_no=u.attempt_no",
    "  WHERE u.user_id=" + payload.uid,
    "),",
    "root_turn AS (",
    " SELECT min(turn_key) AS turn_key,",
    "        count(DISTINCT turn_key) FILTER (WHERE turn_key IS NOT NULL) AS keys",
    "   FROM root_usage",
    "),",
    "delegate_usage AS (",
    " SELECT id,session_id,mode,model,request_id,dispatch_id,turn_key,",
    "        parent_turn_key,parent_session_id,delegate_agent_id,status,",
    "        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,",
    "        cost_credits,ledger_id::text,attempt_no,created_at",
    "   FROM usage_records",
    "  WHERE user_id=" + payload.uid,
    "    AND parent_session_id='" + peer + "'",
    "    AND parent_turn_key=(SELECT turn_key FROM root_turn)",
    "),",
    "bound_usage AS (",
    " SELECT id FROM root_usage",
    " UNION ALL",
    " SELECT id FROM delegate_usage",
    "),",
    "bound_ledger AS (",
    " SELECT id::text,delta::text,reason,ref_type,ref_id",
    "   FROM credit_ledger",
    "  WHERE user_id=" + payload.uid,
    "    AND ref_type='usage_record'",
    "    AND ref_id IN (SELECT id::text FROM bound_usage)",
    "),",
    "new_usage AS (",
    " SELECT id,session_id,mode,model,request_id,dispatch_id,turn_key,",
    "        parent_turn_key,parent_session_id,delegate_agent_id,status,",
    "        input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,",
    "        cost_credits,created_at",
    "   FROM usage_records",
    "  WHERE user_id=" + payload.uid + " AND id>" + payload.usageFloor,
    ")",
    "SELECT json_build_object(",
    " 'dispatchCount',(SELECT count(*)::int FROM exact_dispatch),",
    " 'dispatch',(SELECT row_to_json(exact_dispatch) FROM exact_dispatch),",
    " 'authorityBindings',COALESCE((SELECT json_agg(authority_binding ORDER BY authority_turn_id) FROM authority_binding),'[]'::json),",
    " 'rootTurnKey',(SELECT turn_key FROM root_turn),",
    " 'rootTurnKeyCount',(SELECT keys::int FROM root_turn),",
    " 'rootUsage',COALESCE((SELECT json_agg(root_usage ORDER BY id) FROM root_usage),'[]'::json),",
    " 'delegateUsage',COALESCE((SELECT json_agg(delegate_usage ORDER BY id) FROM delegate_usage),'[]'::json),",
    " 'ledger',COALESCE((SELECT json_agg(bound_ledger ORDER BY id::bigint) FROM bound_ledger),'[]'::json),",
    " 'newUsage',COALESCE((SELECT json_agg(new_usage ORDER BY id) FROM new_usage),'[]'::json),",
    " 'unrelatedNewUsageCount',(",
    "   SELECT count(*)::int FROM new_usage",
    "    WHERE id NOT IN (SELECT id FROM bound_usage)",
    " )",
    ")::text;",
  ].join("\n");
  const raw = psql(sql);
  if (!raw) fail("turn evidence query returned no row");
  const value = JSON.parse(raw);
  if (
    value.dispatchCount !== 1
    || !value.dispatch
    || value.dispatch.user_id !== payload.uid
    || value.dispatch.session_id !== payload.peerId
    || value.dispatch.client_message_id !== payload.clientMessageId
    || value.dispatch.agent_id !== payload.agentId
    || value.dispatch.model !== payload.model
    || value.dispatch.status !== "terminal"
    || value.dispatch.outcome !== "completed"
    || !Number.isSafeInteger(value.dispatch.attempt_no)
    || value.dispatch.attempt_no < 1
    || typeof value.rootTurnKey !== "string"
    || !/^[0-9a-f]{64}$/.test(value.rootTurnKey)
    || value.rootTurnKeyCount !== 1
    || !Array.isArray(value.rootUsage)
    || value.rootUsage.length < 1
    || !Array.isArray(value.delegateUsage)
    || !Array.isArray(value.authorityBindings)
    || !Array.isArray(value.ledger)
    || !Array.isArray(value.newUsage)
    || value.newUsage.length < 1
    || value.unrelatedNewUsageCount !== 0
    || value.newUsage.some(
      (row) =>
        !Number.isSafeInteger(row.id)
        || row.id <= payload.usageFloor
        || typeof row.request_id !== "string"
        || row.request_id.length === 0,
    )
    || new Set(value.newUsage.map((row) => row.id)).size !== value.newUsage.length
    || value.rootUsage.some(
      (row) =>
        row.dispatch_id !== value.dispatch.dispatch_id
        || row.attempt_no !== value.dispatch.attempt_no
        || row.turn_key !== value.rootTurnKey
        || row.status !== "success"
        || row.model !== payload.model,
    )
    || value.delegateUsage.some(
      (row) =>
        row.parent_session_id !== payload.peerId
        || row.parent_turn_key !== value.rootTurnKey
        || row.mode !== "delegate"
        || row.status !== "success",
    )
  ) {
    fail("turn dispatch/usage evidence is not exact");
  }
  if (payload.engine === "ccb") {
    const binding = value.authorityBindings[0];
    if (
      typeof value.dispatch.billing_request_id !== "string"
      || value.dispatch.billing_request_id.length === 0
      || value.authorityBindings.length !== 1
      || !binding
      || !/^[0-9a-f]{32}$/.test(binding.authority_turn_id || "")
      || binding.user_id !== payload.uid
      || binding.dispatch_id !== value.dispatch.dispatch_id
      || binding.attempt_no !== value.dispatch.attempt_no
      || binding.session_id !== payload.peerId
      || binding.dispatch_model !== value.dispatch.model
      || binding.canonical_model !== payload.model
    ) {
      fail("CCB authority/dispatch binding evidence is not exact");
    }
  } else if (
    value.authorityBindings.length !== 0
    || !value.rootUsage.some(
      (row) => row.request_id === value.dispatch.billing_request_id,
    )
  ) {
    fail("Codex trace/dispatch/usage binding evidence is not exact");
  }
  const usage = [...value.rootUsage, ...value.delegateUsage];
  const ledgerByUsage = new Map();
  for (const row of value.ledger) {
    if (
      typeof row.id !== "string"
      || !/^[1-9][0-9]*$/.test(row.id)
      || typeof row.ref_id !== "string"
      || row.ref_type !== "usage_record"
      || row.reason !== "chat"
      || typeof row.delta !== "string"
      || !/^-?[0-9]+$/.test(row.delta)
    ) {
      fail("turn ledger evidence has an invalid identity");
    }
    const rows = ledgerByUsage.get(row.ref_id) || [];
    rows.push(row);
    ledgerByUsage.set(row.ref_id, rows);
  }
  for (const row of usage) {
    const ledger = ledgerByUsage.get(String(row.id)) || [];
    if (BigInt(row.cost_credits) === 0n) {
      if (ledger.length !== 0) fail("zero-cost usage unexpectedly has ledger debits");
      continue;
    }
    if (
      typeof row.ledger_id !== "string"
      || !ledger.some((entry) => entry.id === row.ledger_id)
      || ledger.some((entry) => BigInt(entry.delta) >= 0n)
      || ledger.reduce((sum, entry) => sum - BigInt(entry.delta), 0n)
        !== BigInt(row.cost_credits)
    ) {
      fail("turn ledger evidence does not equal exact usage cost");
    }
  }
  value.billingBindingMode = payload.engine === "ccb"
    ? "ccb_authority_dispatch_attempt"
    : "codex_server_trace";
  return value;
}

function inspectStandardContainer() {
  assertUid(payload.uid);
  if (!/^[0-9a-f]{64}$/.test(payload.containerId || "")) {
    fail("standard container Docker identity is invalid");
  }
  if (fs.existsSync(ACTIVE_RECORD)) fail("synthetic eval record still exists after recovery");
  if (fs.existsSync(RECORD_LOCK)) fail("synthetic eval record lock still exists after recovery");
  if (fs.existsSync(RECORD_LOCK_REAPER)) {
    fail("synthetic eval record reaper still exists after recovery");
  }
  const container = "oc-v5-u" + payload.uid;
  const inspected = spawnSync("docker", ["inspect", container], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (inspected.error) throw inspected.error;
  if (inspected.status !== 0) fail("cannot inspect restored standard container");
  const info = JSON.parse(inspected.stdout)[0];
  if (info.Id !== payload.containerId || info.State?.Running !== true) {
    fail("restored standard container identity/state is invalid");
  }
  const labels = info.Config?.Labels || {};
  if (Object.keys(labels).some((key) => key.startsWith("openclaude.synthetic-eval."))) {
    fail("restored standard container retains synthetic eval labels");
  }
  const forbidden = new Set([
    "/run/oc/synthetic-eval/prompts",
    "/opt/openclaude/packages/gateway/src/promptSlots.ts",
  ]);
  if ((info.Mounts || []).some((mount) => forbidden.has(mount.Destination))) {
    fail("restored standard container retains synthetic eval mounts");
  }
  return {
    uid: payload.uid,
    container,
    containerId: info.Id,
    startedAt: info.State.StartedAt,
    standard: true,
  };
}

try {
  assertLease();
  let result;
  if (action === "snapshot") {
    result = readSnapshot();
  } else if (action === "install-stage") {
    readSnapshot();
    result = installStage();
  } else if (action === "prepare-record") {
    readSnapshot();
    result = withRecordLock(writePreparedRecord);
  } else if (action === "clear") {
    result = withRecordLock((assertHeld) => removeRecord(false, assertHeld));
  } else if (action === "recover") {
    result = withRecordLock((assertHeld) => removeRecord(true, assertHeld));
  } else if (action === "container-evidence") {
    result = inspectContainer();
  } else if (action === "extra-prompt-evidence") {
    result = inspectExtraPrompt();
  } else if (action === "dynamic-input-evidence") {
    result = inspectDynamicInputs();
  } else if (action === "workspace-artifact-evidence") {
    result = inspectWorkspaceArtifacts();
  } else if (action === "turn-evidence") {
    result = inspectTurnEvidence();
  } else if (action === "standard-container-evidence") {
    result = inspectStandardContainer();
  } else {
    fail("unknown remote helper action");
  }
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  process.stderr.write("synthetic-eval remote helper: " + (error && error.message || error) + "\n");
  process.exit(2);
}
`;

export function runRemote(action, payload, input) {
  const host = process.env.KL_HOST || "kl-mirror";
  const v5Env = process.env.V5_ENV || "/etc/openclaude/commercial-v5.env";
  if (!/^[A-Za-z0-9_.@-]+$/.test(host)) fail(`unsafe KL_HOST: ${host}`);
  if (!v5Env.startsWith("/") || v5Env.includes("\0")) fail(`unsafe V5_ENV: ${v5Env}`);
  const helper64 = Buffer.from(REMOTE_HELPER_SOURCE, "utf8").toString("base64");
  const payload64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  const remoteCommand =
    `set -a; . ${shellQuote(v5Env)} 2>/dev/null; ` +
    "exec node -e " +
    shellQuote('eval(Buffer.from(process.argv[1],"base64").toString("utf8"))') +
    ` ${shellQuote(helper64)} ${shellQuote(action)} ${shellQuote(payload64)}`;
  const output = run("ssh", [host, remoteCommand], {
    input,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  try {
    return JSON.parse(String(output));
  } catch {
    fail(`remote helper returned invalid JSON: ${String(output)}`);
  }
}

function takeValue(args, index, option) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return args[index + 1];
}

export function parseArgs(args) {
  if (args.length === 0 || ["-h", "--help", "help"].includes(args[0])) {
    return { command: "help" };
  }
  const command = args[0];
  if (!["prepare", "clear", "recover"].includes(command)) {
    fail(`unknown command: ${command}`);
  }
  const options = { command, apply: false };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--apply") {
      options.apply = true;
      continue;
    }
    const value = takeValue(args, index, option);
    index += 1;
    if (option === "--uid") options.uid = assertAllowedUid(value);
    else if (option === "--base-sha") options.baseCommit = value;
    else if (option === "--candidate-sha") options.candidateCommit = value;
    else if (option === "--ttl-seconds") options.ttlSeconds = Number(value);
    else if (option === "--nonce") options.recordNonce = value;
    else if (option === "--manifest-sha") options.manifestSha = value;
    else fail(`unknown option: ${option}`);
  }
  if (command === "prepare") {
    if (
      options.uid === undefined
      || !COMMIT_RE.test(options.baseCommit ?? "")
      || !COMMIT_RE.test(options.candidateCommit ?? "")
    ) {
      fail(
        "prepare requires --uid, --base-sha, and --candidate-sha",
      );
    }
    options.ttlSeconds ??= MAX_RECORD_TTL_SECONDS;
    if (
      !Number.isSafeInteger(options.ttlSeconds)
      || options.ttlSeconds < 60
      || options.ttlSeconds > MAX_RECORD_TTL_SECONDS
    ) {
      fail(`--ttl-seconds must be an integer from 60 to ${MAX_RECORD_TTL_SECONDS}`);
    }
    if (
      options.recordNonce !== undefined
      && !NONCE_RE.test(options.recordNonce)
    ) {
      fail("prepare --nonce must be exactly 32 lowercase hex characters");
    }
    if (options.manifestSha !== undefined) {
      fail("prepare does not accept --manifest-sha");
    }
  } else {
    if (!NONCE_RE.test(options.recordNonce ?? "")) {
      fail(`${command} requires --nonce with exactly 32 lowercase hex characters`);
    }
    for (const key of [
      "uid",
      "baseCommit",
      "candidateCommit",
      "ttlSeconds",
    ]) {
      if (options[key] !== undefined) {
        fail(`${command} does not accept --${key}`);
      }
    }
    if (
      options.manifestSha !== undefined
      && !SHA256_RE.test(options.manifestSha)
    ) {
      fail(`${command} --manifest-sha must be exactly 64 lowercase hex characters`);
    }
    if (command === "clear" && options.manifestSha !== undefined) {
      fail("clear does not accept --manifest-sha");
    }
  }
  return options;
}

function usage() {
  return `Usage:
  # Dry run (read-only)
  scripts/with-production-mutation-lease.sh node scripts/v5-synthetic-eval-overlay.mjs \\
    prepare --uid 247 --base-sha <40hex> --candidate-sha <40hex> \\
    [--ttl-seconds 1500]

  # Explicitly stage + atomically write a prepared record
  scripts/with-production-mutation-lease.sh node scripts/v5-synthetic-eval-overlay.mjs \\
    prepare ... --apply

  # Dry-run or apply cleanup; the current record must match this exact nonce
  scripts/with-production-mutation-lease.sh node scripts/v5-synthetic-eval-overlay.mjs \\
    clear --nonce <32hex> [--apply]
  scripts/with-production-mutation-lease.sh node scripts/v5-synthetic-eval-overlay.mjs \\
    recover --nonce <32hex> [--manifest-sha <64hex>] [--apply]

Only synthetic UIDs 247 and 626 are accepted. "clear" removes the active record;
"recover" additionally removes its immutable staged tree. No command acquires or
bypasses the official production-mutation lease.`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const lease = assertLeaseEnvironment();
  const common = {
    apply: options.apply,
    leaseNonce: lease.nonce,
    leaseProof: lease.proof,
  };
  if (options.command === "clear" || options.command === "recover") {
    const result = runRemote(options.command, {
      ...common,
      recordNonce: options.recordNonce,
      ...(options.manifestSha === undefined
        ? {}
        : { manifestSha: options.manifestSha }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  const recordNonce = options.recordNonce
    ?? randomBytes(16).toString("hex");
  const bundle = buildCandidateBundle({
    repoRoot: DEFAULT_REPO_ROOT,
    baseCommit: options.baseCommit,
    candidateCommit: options.candidateCommit,
  });
  try {
    const snapshot = runRemote("snapshot", {
      ...common,
      uid: options.uid,
      expectedBase: options.baseCommit,
    });
    assertDeploySnapshot(snapshot, options.baseCommit);
    if (!options.apply) {
      process.stdout.write(
        `${JSON.stringify({
          applied: false,
          uid: options.uid,
          baseCommit: options.baseCommit,
          candidateCommit: options.candidateCommit,
          manifestSha: bundle.manifestSha,
          recordNonce,
          stableLockVersion: snapshot.lockVersion,
          stage: `${STAGING_ROOT}/${bundle.manifestSha}/tree`,
          record: ACTIVE_RECORD,
        })}\n`,
      );
      return 0;
    }
    const remoteBase = {
      ...common,
      apply: true,
      uid: options.uid,
      expectedBase: options.baseCommit,
      expectedLockVersion: snapshot.lockVersion,
      candidateCommit: options.candidateCommit,
      manifestSha: bundle.manifestSha,
      recordNonce,
    };
    runRemote(
      "install-stage",
      { ...remoteBase, tarSha: bundle.tarSha },
      bundle.tarball,
    );
    const prepared = runRemote("prepare-record", {
      ...remoteBase,
      ttlSeconds: options.ttlSeconds,
    });
    process.stdout.write(
      `${JSON.stringify({
        applied: true,
        uid: options.uid,
        manifestSha: bundle.manifestSha,
        nonce: recordNonce,
        stage: `${STAGING_ROOT}/${bundle.manifestSha}/tree`,
        record: prepared.record,
      })}\n`,
    );
    return 0;
  } finally {
    rmSync(bundle.bundleRoot, { force: true, recursive: true });
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `v5-synthetic-eval-overlay: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
