#!/usr/bin/env node
/**
 * Execute one exact synthetic V5 evaluation arm under one production-mutation
 * lease. This process owns the whole critical section:
 *
 * stable precheck → overlay prepare → supported reprovision → actual container
 * hashes → one foreground true turn → actual extra-prompt bytes → postcheck →
 * exact overlay recovery → supported reprovision back to standard stable.
 *
 * The two supplied helpers are immutable, root-owned files:
 *   - reprovision helper: uses the supported admin restart API, triggers a cold
 *     provision, and prints JSON containing a fresh 64-hex `id`.
 *   - turn helper: executes one true turn and prints either its JSON result or
 *     the absolute path of a JSON result containing `peer_id`.
 *
 * Helpers do not inherit the production mutation lease proof. Only this runner
 * and the fixed overlay driver can mutate the evaluation record.
 */

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  MANUAL_LEASE_PROOF,
  assertAllowedUid,
  assertCandidateDiffAllowed,
  assertDeploySnapshot,
  assertLeaseEnvironment,
  buildCandidateBundle,
  runRemote,
} from "./v5-synthetic-eval-overlay.mjs";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{8,160}$/;
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 1_050;
const HELPER_TIMEOUT_MS = 180_000;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const overlayDriver = resolve(here, "v5-synthetic-eval-overlay.mjs");

function fail(message) {
  throw new Error(message);
}

function takeValue(args, index, option) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return args[index + 1];
}

export function parseRunArmArgs(args) {
  if (args.length === 0 || ["-h", "--help", "help"].includes(args[0])) {
    return { command: "help" };
  }
  const options = { command: "run-arm", apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--apply") {
      options.apply = true;
      continue;
    }
    const value = takeValue(args, index, option);
    index += 1;
    if (option === "--arm") options.arm = value;
    else if (option === "--uid") options.uid = assertAllowedUid(value);
    else if (option === "--engine") options.engine = value;
    else if (option === "--agent-id") options.agentId = value;
    else if (option === "--base-sha") options.baseCommit = value;
    else if (option === "--candidate-sha") options.candidateCommit = value;
    else if (option === "--reprovision-helper") options.reprovisionHelper = value;
    else if (option === "--reprovision-helper-sha") options.reprovisionHelperSha = value;
    else if (option === "--reprovision-helper-root") options.reprovisionHelperRoot = value;
    else if (option === "--reprovision-helper-tree-sha") options.reprovisionHelperTreeSha = value;
    else if (option === "--turn-helper") options.turnHelper = value;
    else if (option === "--turn-helper-sha") options.turnHelperSha = value;
    else if (option === "--turn-helper-root") options.turnHelperRoot = value;
    else if (option === "--turn-helper-tree-sha") options.turnHelperTreeSha = value;
    else if (option === "--evidence-file") options.evidenceFile = value;
    else if (option === "--timeout-seconds") options.timeoutSeconds = Number(value);
    else fail(`unknown option: ${option}`);
  }
  options.timeoutSeconds ??= DEFAULT_TIMEOUT_SECONDS;
  if (
    !["A", "B"].includes(options.arm)
    || options.uid === undefined
    || !["ccb", "codex"].includes(options.engine)
    || !AGENT_ID_RE.test(options.agentId ?? "")
    || !COMMIT_RE.test(options.baseCommit ?? "")
    || !COMMIT_RE.test(options.candidateCommit ?? "")
    || !SHA256_RE.test(options.reprovisionHelperSha ?? "")
    || !SHA256_RE.test(options.reprovisionHelperTreeSha ?? "")
    || !SHA256_RE.test(options.turnHelperSha ?? "")
    || !SHA256_RE.test(options.turnHelperTreeSha ?? "")
    || !Number.isSafeInteger(options.timeoutSeconds)
    || options.timeoutSeconds < 60
    || options.timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    fail("run-arm arguments are incomplete or invalid");
  }
  for (const [name, path] of [
    ["reprovision helper", options.reprovisionHelper],
    ["reprovision helper root", options.reprovisionHelperRoot],
    ["turn helper", options.turnHelper],
    ["turn helper root", options.turnHelperRoot],
    ["evidence file", options.evidenceFile],
  ]) {
    if (
      typeof path !== "string"
      || !isAbsolute(path)
      || resolve(path) !== path
      || path.includes("\0")
    ) {
      fail(`${name} must be an absolute normalized path`);
    }
  }
  if (!options.evidenceFile.endsWith(".json")) {
    fail("evidence file must end with .json");
  }
  if (options.arm === "A" && options.candidateCommit !== options.baseCommit) {
    fail("arm A must stage the exact stable base commit");
  }
  if (options.arm === "B" && options.candidateCommit === options.baseCommit) {
    fail("arm B must stage a distinct prompt candidate");
  }
  return options;
}

function assertRootOwnedSafe(path, kind, exactMode) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) fail(`${path} must not be a symlink`);
  if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
    fail(`${path} must be root-owned and not group/other writable`);
  }
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory()) {
    fail(`${path} has the wrong type`);
  }
  if (exactMode !== undefined && (stat.mode & 0o777) !== exactMode) {
    fail(`${path} must have mode ${exactMode.toString(8)}`);
  }
  return stat;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function hashSafeTree(root) {
  assertRootOwnedSafe(root, "dir");
  const rootReal = realpathSync(root);
  const hash = createHash("sha256");
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = resolve(directory, name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) fail(`${absolute} must not be a symlink`);
      if (stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
        fail(`${absolute} must be root-owned and not group/other writable`);
      }
      if (stat.isDirectory()) {
        walk(absolute);
      } else if (stat.isFile()) {
        const relative = absolute.slice(rootReal.length + 1);
        hash.update(`${sha256File(absolute)}  ${relative}\n`);
      } else {
        fail(`${absolute} must be a regular file or directory`);
      }
    }
  };
  walk(rootReal);
  return hash.digest("hex");
}

export function verifyHelper(
  path,
  expectedSha,
  helperRoot,
  expectedTreeSha,
) {
  assertRootOwnedSafe(path, "file");
  const real = realpathSync(path);
  if (real !== path) fail(`helper path must already be canonical: ${path}`);
  assertRootOwnedSafe(helperRoot, "dir");
  const rootReal = realpathSync(helperRoot);
  if (
    rootReal !== helperRoot
    || (real !== rootReal && !real.startsWith(`${rootReal}/`))
  ) {
    fail(`helper must be inside its canonical frozen root: ${path}`);
  }
  const actualSha = sha256File(path);
  if (actualSha !== expectedSha) fail(`helper SHA mismatch: ${path}`);
  const treeSha256 = hashSafeTree(rootReal);
  if (treeSha256 !== expectedTreeSha) {
    fail(`helper dependency tree SHA mismatch: ${helperRoot}`);
  }
  return { path, sha256: actualSha, root: rootReal, treeSha256 };
}

function helperEnvironment(options, phase) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        name !== "OC_V5_MANUAL_LEASE_NONCE"
        && name !== "OC_V5_MANUAL_LEASE_PROOF",
    ),
  );
  const env = {
    ...inherited,
    OC_SYNTHETIC_EVAL_ARM: options.arm,
    OC_SYNTHETIC_EVAL_UID: String(options.uid),
    OC_SYNTHETIC_EVAL_ENGINE: options.engine,
    OC_SYNTHETIC_EVAL_AGENT_ID: options.agentId,
    OC_SYNTHETIC_EVAL_BASE_SHA: options.baseCommit,
    OC_SYNTHETIC_EVAL_CANDIDATE_SHA: options.candidateCommit,
    OC_SYNTHETIC_EVAL_PHASE: phase,
  };
  return env;
}

function assertHelperTreesUnchanged(helpers) {
  for (const [name, helper] of Object.entries(helpers)) {
    if (hashSafeTree(helper.root) !== helper.treeSha256) {
      fail(`${name} helper dependency tree changed during the exact arm`);
    }
    if (sha256File(helper.path) !== helper.sha256) {
      fail(`${name} helper entry file changed during the exact arm`);
    }
  }
}

function readProcessIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const processGroupId = Number(fields[2]);
    const startTime = fields[19];
    if (
      !Number.isSafeInteger(processGroupId)
      || processGroupId <= 0
      || !/^\d+$/.test(startTime ?? "")
    ) {
      return null;
    }
    return { pid, processGroupId, startTime };
  } catch {
    return null;
  }
}

function assertRunnerCommandGroupLeader() {
  const identity = readProcessIdentity(process.pid);
  if (!identity || identity.processGroupId !== process.pid) {
    fail("run-arm must be the exact command-group leader supervised by the lease wrapper");
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function commandGroupChildren() {
  const children = [];
  for (const name of readdirSync("/proc")) {
    if (!/^[1-9]\d*$/.test(name)) continue;
    const identity = readProcessIdentity(Number(name));
    if (
      identity
      && identity.pid !== process.pid
      && identity.processGroupId === process.pid
    ) {
      children.push(identity);
    }
  }
  return children;
}

function signalExactProcess(identity, signal) {
  const current = readProcessIdentity(identity.pid);
  if (
    !current
    || current.startTime !== identity.startTime
    || current.processGroupId !== identity.processGroupId
  ) {
    return;
  }
  try {
    process.kill(identity.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function terminateCommandGroupChildren() {
  let found = false;
  for (let round = 0; round < 20; round += 1) {
    const children = commandGroupChildren();
    if (children.length === 0) return found;
    found = true;
    for (const child of children) signalExactProcess(child, "SIGTERM");
    sleepSync(100);
  }
  for (let round = 0; round < 20; round += 1) {
    const children = commandGroupChildren();
    if (children.length === 0) return found;
    found = true;
    for (const child of children) signalExactProcess(child, "SIGKILL");
    sleepSync(100);
  }
  fail("a helper descendant survived bounded TERM→KILL cleanup");
}

function runNodeHelper(path, env, timeoutMs) {
  const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
  // --foreground is intentional: descendants stay in the outer lease wrapper's
  // exact PGID, so lease loss kills all of them. Local timeout cleanup then
  // enumerates that PGID by PID+starttime and removes every member except us.
  const result = spawnSync("timeout", [
    "--foreground",
    "--kill-after=15s",
    `${timeoutSeconds}s`,
    process.execPath,
    path,
  ], {
    encoding: "utf8",
    env,
    timeout: timeoutMs + 20_000,
    killSignal: "SIGTERM",
    maxBuffer: 16 * 1024 * 1024,
  });
  const leakedDescendant = terminateCommandGroupChildren();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(
      `helper ${basename(path)} failed (${result.status}): ${
        result.stderr || result.stdout
      }`.trim(),
    );
  }
  if (leakedDescendant) {
    fail(`helper ${basename(path)} left a descendant process after exit`);
  }
  return result.stdout.trim();
}

function parseJsonOutput(stdout, label) {
  const lastLine = stdout.split("\n").filter(Boolean).at(-1) ?? "";
  if (isAbsolute(lastLine)) {
    const path = resolve(lastLine);
    if (path !== lastLine) fail(`${label} result path is not normalized`);
    assertRootOwnedSafe(path, "file");
    return {
      value: JSON.parse(readFileSync(path, "utf8")),
      source: { path, sha256: sha256File(path) },
    };
  }
  return { value: JSON.parse(lastLine), source: null };
}

export function parseReprovisionResult(stdout) {
  const parsed = parseJsonOutput(stdout, "reprovision");
  const value = parsed.value;
  if (
    !value
    || typeof value !== "object"
    || typeof value.id !== "string"
    || !/^[0-9a-f]{64}$/.test(value.id)
    || typeof value.started_at !== "string"
    || !Number.isFinite(Date.parse(value.started_at))
  ) {
    fail("reprovision helper result is invalid");
  }
  return { ...parsed, id: value.id, startedAt: value.started_at };
}

export function parseTurnResult(stdout) {
  const parsed = parseJsonOutput(stdout, "turn");
  const value = parsed.value;
  if (
    !value
    || typeof value !== "object"
    || typeof value.peer_id !== "string"
    || !PEER_ID_RE.test(value.peer_id)
  ) {
    fail("turn helper result must contain a valid peer_id");
  }
  return { ...parsed, peerId: value.peer_id };
}

function runOverlay(args, timeoutMs = HELPER_TIMEOUT_MS) {
  const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
  const result = spawnSync("timeout", [
    "--foreground",
    "--kill-after=15s",
    `${timeoutSeconds}s`,
    process.execPath,
    overlayDriver,
    ...args,
  ], {
    encoding: "utf8",
    env: process.env,
    timeout: timeoutMs + 20_000,
    killSignal: "SIGTERM",
    maxBuffer: 16 * 1024 * 1024,
  });
  const leakedDescendant = terminateCommandGroupChildren();
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fail(`overlay driver failed (${result.status}): ${result.stderr || result.stdout}`.trim());
  }
  if (leakedDescendant) {
    fail("overlay driver left a descendant process after exit");
  }
  return JSON.parse(result.stdout);
}

function remoteCommon(lease) {
  return {
    apply: true,
    leaseNonce: lease.nonce,
    leaseProof: lease.proof,
  };
}

function snapshot(lease, options, expectedLockVersion) {
  const value = runRemote("snapshot", {
    ...remoteCommon(lease),
    uid: options.uid,
    expectedBase: options.baseCommit,
    ...(expectedLockVersion === undefined ? {} : { expectedLockVersion }),
  });
  return assertDeploySnapshot(value, options.baseCommit, expectedLockVersion);
}

const LANE_FIELDS = [
  "phase",
  "activeSlot",
  "candidateSlot",
  "activeRelease",
  "candidateRelease",
  "cohortPercent",
  "lockVersion",
  "sourceCommit",
  "enabledCron",
  "cronFileEnabled",
  "v3State",
];

export function assertSameLane(before, after) {
  for (const field of LANE_FIELDS) {
    if (before[field] !== after[field]) {
      fail(`production lane changed during exact evaluation: ${field}`);
    }
  }
}

function safeWriteExclusive(path, bytes, mode = 0o600) {
  const fd = openSync(path, "wx", mode);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, mode);
}

function usage() {
  return `Usage:
  scripts/with-production-mutation-lease.sh node scripts/v5-synthetic-eval-run-arm.mjs \\
    --arm A|B --uid 247|626 --engine ccb|codex --agent-id <id> \\
    --base-sha <40hex> --candidate-sha <40hex> \\
    --reprovision-helper </absolute/helper.mjs> --reprovision-helper-sha <64hex> \\
    --reprovision-helper-root </absolute/frozen-tree> --reprovision-helper-tree-sha <64hex> \\
    --turn-helper </absolute/helper.mjs> --turn-helper-sha <64hex> \\
    --turn-helper-root </absolute/frozen-tree> --turn-helper-tree-sha <64hex> \\
    --evidence-file </secure/nonexistent/arm.json> [--timeout-seconds 900] --apply

Arm A requires candidate=base. Arm B requires a distinct descendant prompt-only
candidate. The entire arm and standard-container restoration run under one
official production-mutation lease.`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseRunArmArgs(argv);
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const lease = assertLeaseEnvironment();
  if (lease.proof !== MANUAL_LEASE_PROOF) fail("unexpected production lease proof path");
  assertRunnerCommandGroupLeader();
  assertCandidateDiffAllowed(repoRoot, options.baseCommit, options.candidateCommit);
  const helpers = {
    reprovision: verifyHelper(
      options.reprovisionHelper,
      options.reprovisionHelperSha,
      options.reprovisionHelperRoot,
      options.reprovisionHelperTreeSha,
    ),
    turn: verifyHelper(
      options.turnHelper,
      options.turnHelperSha,
      options.turnHelperRoot,
      options.turnHelperTreeSha,
    ),
  };
  const evidenceParent = dirname(options.evidenceFile);
  assertRootOwnedSafe(evidenceParent, "dir", 0o700);
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      applied: false,
      arm: options.arm,
      uid: options.uid,
      engine: options.engine,
      baseCommit: options.baseCommit,
      candidateCommit: options.candidateCommit,
      helpers,
      timeoutSeconds: options.timeoutSeconds,
    })}\n`);
    return 0;
  }

  const startedAt = new Date().toISOString();
  const pre = snapshot(lease, options);
  const prepareNonce = randomBytes(16).toString("hex");
  const identityBundle = buildCandidateBundle({
    repoRoot,
    baseCommit: options.baseCommit,
    candidateCommit: options.candidateCommit,
  });
  const expectedManifestSha = identityBundle.manifestSha;
  rmSync(identityBundle.bundleRoot, { recursive: true, force: true });
  let prepareAttempted = false;
  let prepared = null;
  let overlayContainer = null;
  let turn = null;
  let promptEvidence = null;
  let post = null;
  let restored = null;
  let restoreSnapshot = null;
  let primaryError = null;
  let cleanupError = null;

  try {
    prepareAttempted = true;
    prepared = runOverlay([
      "prepare",
      "--uid",
      String(options.uid),
      "--base-sha",
      options.baseCommit,
      "--candidate-sha",
      options.candidateCommit,
      "--nonce",
      prepareNonce,
      "--ttl-seconds",
      "1500",
      "--apply",
    ]);
    if (
      prepared.uid !== options.uid
      || !SHA256_RE.test(prepared.manifestSha ?? "")
      || prepared.manifestSha !== expectedManifestSha
      || prepared.nonce !== prepareNonce
    ) {
      fail("overlay prepare result is invalid");
    }

    const reprovisionOutput = runNodeHelper(
      options.reprovisionHelper,
      helperEnvironment(options, "overlay"),
      HELPER_TIMEOUT_MS,
    );
    const reprovisioned = parseReprovisionResult(reprovisionOutput);
    assertHelperTreesUnchanged(helpers);
    overlayContainer = runRemote("container-evidence", {
      ...remoteCommon(lease),
      uid: options.uid,
      expectedBase: options.baseCommit,
      candidateCommit: options.candidateCommit,
      manifestSha: prepared.manifestSha,
      recordNonce: prepared.nonce,
      containerId: reprovisioned.id,
    });
    if (overlayContainer.containerId !== reprovisioned.id) {
      fail("container evidence differs from reprovision result");
    }
    if (
      pre.syntheticContainerId !== null
      && overlayContainer.containerId === pre.syntheticContainerId
    ) {
      fail("overlay arm did not provision a fresh Docker container");
    }

    const turnOutput = runNodeHelper(
      options.turnHelper,
      helperEnvironment(options, "turn"),
      options.timeoutSeconds * 1_000,
    );
    turn = parseTurnResult(turnOutput);
    assertHelperTreesUnchanged(helpers);
    if (
      turn.value.container?.id !== undefined
      && turn.value.container.id !== overlayContainer.containerId
    ) {
      fail("turn result is bound to a different Docker container");
    }
    const sessionKey =
      `agent:${options.agentId}:webchat:dm:${turn.peerId}`;
    promptEvidence = runRemote("extra-prompt-evidence", {
      ...remoteCommon(lease),
      uid: options.uid,
      expectedBase: options.baseCommit,
      candidateCommit: options.candidateCommit,
      manifestSha: prepared.manifestSha,
      recordNonce: prepared.nonce,
      containerId: overlayContainer.containerId,
      engine: options.engine,
      sessionKey,
    });
    if (!SHA256_RE.test(promptEvidence.extraPrompt?.sha256 ?? "")) {
      fail("actual extra-prompt evidence is invalid");
    }

    post = snapshot(lease, options, pre.lockVersion);
    assertSameLane(pre, post);
    if (post.syntheticContainerId !== overlayContainer.containerId) {
      fail("post-turn snapshot is not bound to the evaluated container");
    }
    if (post.dispatchCount !== pre.dispatchCount + 1) {
      fail("exact arm did not create exactly one top-level turn dispatch");
    }
    if (post.usageCount <= pre.usageCount) {
      fail("exact arm created no authoritative usage evidence");
    }
  } catch (error) {
    primaryError = error;
  } finally {
    if (prepareAttempted) {
      try {
        runOverlay([
          "recover",
          "--nonce",
          prepareNonce,
          "--manifest-sha",
          expectedManifestSha,
          "--apply",
        ]);
        const restoreOutput = runNodeHelper(
          options.reprovisionHelper,
          helperEnvironment(options, "restore"),
          HELPER_TIMEOUT_MS,
        );
        const restoreResult = parseReprovisionResult(restoreOutput);
        assertHelperTreesUnchanged(helpers);
        restored = runRemote("standard-container-evidence", {
          ...remoteCommon(lease),
          uid: options.uid,
          containerId: restoreResult.id,
        });
        if (
          overlayContainer
          && restored.containerId === overlayContainer.containerId
        ) {
          fail("restoration did not create a fresh standard container");
        }
        restoreSnapshot = snapshot(lease, options, pre.lockVersion);
        assertSameLane(pre, restoreSnapshot);
        if (restoreSnapshot.syntheticContainerId !== restored.containerId) {
          fail("restored snapshot is not bound to the standard container");
        }
      } catch (error) {
        cleanupError = error;
      }
    }
  }

  const extraPromptPath =
    `${options.evidenceFile.slice(0, -".json".length)}.extra-prompt.md`;
  if (promptEvidence?.extraPrompt?.contentBase64) {
    const {
      contentBase64,
      ...extraPromptWithoutContent
    } = promptEvidence.extraPrompt;
    const bytes = Buffer.from(contentBase64, "base64");
    if (
      bytes.length !== promptEvidence.extraPrompt.bytes
      || createHash("sha256").update(bytes).digest("hex")
        !== promptEvidence.extraPrompt.sha256
    ) {
      primaryError ??= new Error("extra-prompt evidence bytes failed local verification");
    } else {
      safeWriteExclusive(extraPromptPath, bytes);
    }
    promptEvidence = {
      ...promptEvidence,
      extraPrompt: extraPromptWithoutContent,
    };
  }

  const completedAt = new Date().toISOString();
  const evidence = {
    schemaVersion: 1,
    status: primaryError || cleanupError ? "failed" : "completed",
    arm: options.arm,
    uid: options.uid,
    engine: options.engine,
    agentId: options.agentId,
    baseCommit: options.baseCommit,
    candidateCommit: options.candidateCommit,
    timeoutSeconds: options.timeoutSeconds,
    startedAt,
    completedAt,
    helpers,
    prepareNonce,
    expectedManifestSha,
    pre,
    prepared,
    overlayContainer,
    turn: turn && {
      peerId: turn.peerId,
      source: turn.source,
      resultSha256: createHash("sha256")
        .update(JSON.stringify(turn.value))
        .digest("hex"),
    },
    promptEvidence: promptEvidence && {
      ...promptEvidence,
      extraPrompt: {
        ...promptEvidence.extraPrompt,
        capturedPath: extraPromptPath,
      },
    },
    post,
    restored,
    restoreSnapshot,
    error: primaryError instanceof Error ? primaryError.message : null,
    cleanupError: cleanupError instanceof Error ? cleanupError.message : null,
  };
  safeWriteExclusive(
    options.evidenceFile,
    Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
  );
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  process.stdout.write(`${options.evidenceFile}\n`);
  return 0;
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `v5-synthetic-eval-run-arm: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 2;
  }
}
