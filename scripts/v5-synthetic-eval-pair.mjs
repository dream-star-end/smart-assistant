#!/usr/bin/env node
/**
 * Purely offline validator/aggregator for one exact synthetic A/B pair.
 *
 * This script never talks to production. It accepts two completed run-arm
 * evidence files, verifies that every evaluation identity is the same except
 * for the explicitly arm-specific fields, verifies the captured full prompts
 * against a preregistered delta, and emits raw efficiency measurements without
 * making a winner/non-inferiority decision.
 */

import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SHA256_RE = /^[0-9a-f]{64}$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const SYNTHETIC_UIDS = new Set([247, 626]);
const VOLATILE_SNAPSHOT_FIELDS = new Set([
  "dispatchCount",
  "openDispatchCount",
  "usageCount",
  "usageMaxId",
  "syntheticContainerId",
]);

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, label) {
  if (!isRecord(value)) fail(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    fail(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function requireCommit(value, label) {
  if (typeof value !== "string" || !COMMIT_RE.test(value)) {
    fail(`${label} must be a lowercase 40-hex commit`);
  }
  return value;
}

function requireSafeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function canonicalValue(value, label = "JSON value") {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => canonicalValue(item, `${label}[${index}]`));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        canonicalValue(value[key], `${label}.${key}`),
      ]),
    );
  }
  fail(`${label} is not JSON-compatible`);
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSame(left, right, label) {
  if (canonicalJson(left) !== canonicalJson(right)) {
    fail(`${label} differs`);
  }
}

function takeValue(args, index, option) {
  if (index + 1 >= args.length || args[index + 1].startsWith("--")) {
    fail(`${option} requires a value`);
  }
  return args[index + 1];
}

function normalizedJsonPath(value, label) {
  if (
    typeof value !== "string"
    || !isAbsolute(value)
    || resolve(value) !== value
    || !value.endsWith(".json")
    || value.includes("\0")
  ) {
    fail(`${label} must be an absolute normalized .json path`);
  }
  return value;
}

export function parsePairArgs(args) {
  if (args.length === 0 || ["-h", "--help", "help"].includes(args[0])) {
    return { command: "help" };
  }
  const options = { command: "pair", apply: false };
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    if (option === "--apply") {
      options.apply = true;
      continue;
    }
    const value = takeValue(args, index, option);
    index += 1;
    if (option === "--arm-a") options.armA = value;
    else if (option === "--arm-b") options.armB = value;
    else if (option === "--output") options.output = value;
    else fail(`unknown option: ${option}`);
  }
  options.armA = normalizedJsonPath(options.armA, "arm A evidence");
  options.armB = normalizedJsonPath(options.armB, "arm B evidence");
  options.output = normalizedJsonPath(options.output, "output");
  if (
    options.armA === options.armB
    || options.output === options.armA
    || options.output === options.armB
  ) {
    fail("arm evidence and output paths must be distinct");
  }
  return options;
}

function readJsonEvidence(path, label) {
  assertSecureRegularFile(path, label);
  const bytes = readFileSync(path);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return {
    bytes,
    sha256: sha256(bytes),
    value: requireRecord(value, label),
  };
}

function assertSecureRegularFile(path, label) {
  if (
    typeof path !== "string"
    || !isAbsolute(path)
    || resolve(path) !== path
    || path.includes("\0")
  ) {
    fail(`${label} path must be absolute and normalized`);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    fail(`${label} must be a regular file, not a symlink`);
  }
  if (
    realpathSync(path) !== path
    || stat.uid !== 0
    || (stat.mode & 0o777) !== 0o600
  ) {
    fail(`${label} must be canonical, root-owned, and mode 0600`);
  }
  return stat;
}

function assertSecureDirectory(path, label) {
  const stat = lstatSync(path);
  if (
    stat.isSymbolicLink()
    || !stat.isDirectory()
    || realpathSync(path) !== path
    || stat.uid !== 0
    || (stat.mode & 0o777) !== 0o700
  ) {
    fail(`${label} must be a canonical root-owned directory with mode 0700`);
  }
  return stat;
}

function helperIdentity(evidence, label) {
  const helpers = requireRecord(evidence.helpers, `${label}.helpers`);
  const identity = {};
  for (const name of ["reprovision", "turn"]) {
    const helper = requireRecord(helpers[name], `${label}.helpers.${name}`);
    identity[name] = {
      sha256: requireSha(helper.sha256, `${label}.helpers.${name}.sha256`),
      treeSha256: requireSha(
        helper.treeSha256,
        `${label}.helpers.${name}.treeSha256`,
      ),
    };
  }
  return identity;
}

function staticSnapshotIdentity(snapshot, label) {
  const source = requireRecord(snapshot, label);
  requireString(source.activeRelease, `${label}.activeRelease`);
  if (requireSafeCount(source.lockVersion, `${label}.lockVersion`) < 1) {
    fail(`${label}.lockVersion must be positive`);
  }
  const identity = {};
  for (const key of Object.keys(source).sort()) {
    if (!VOLATILE_SNAPSHOT_FIELDS.has(key)) {
      identity[key] = canonicalValue(source[key], `${label}.${key}`);
    }
  }
  return identity;
}

function deploymentIdentity(evidence, label) {
  const pre = staticSnapshotIdentity(evidence.pre, `${label}.pre`);
  const post = staticSnapshotIdentity(evidence.post, `${label}.post`);
  const restored = staticSnapshotIdentity(
    evidence.restoreSnapshot,
    `${label}.restoreSnapshot`,
  );
  assertSame(pre, post, `${label} pre/post deployment identity`);
  assertSame(pre, restored, `${label} pre/restore deployment identity`);
  return pre;
}

function runtimeTupleIdentity(evidence, label) {
  const overlayContainer = requireRecord(
    evidence.overlayContainer,
    `${label}.overlayContainer`,
  );
  const runtimeTuple = requireRecord(
    overlayContainer.runtimeTuple,
    `${label}.overlayContainer.runtimeTuple`,
  );
  for (const field of ["image", "imageId", "runtimeRelease", "platformBundle"]) {
    requireString(
      runtimeTuple[field],
      `${label}.overlayContainer.runtimeTuple.${field}`,
    );
  }
  return canonicalValue(
    runtimeTuple,
    `${label}.overlayContainer.runtimeTuple`,
  );
}

function dynamicInputIdentity(evidence, label) {
  const dynamicInputs = requireRecord(
    evidence.dynamicInputs,
    `${label}.dynamicInputs`,
  );
  const preEvidence = requireRecord(
    dynamicInputs.pre,
    `${label}.dynamicInputs.pre`,
  );
  const postEvidence = requireRecord(
    dynamicInputs.post,
    `${label}.dynamicInputs.post`,
  );
  const preInputs = requireRecord(
    preEvidence.inputs,
    `${label}.dynamicInputs.pre.inputs`,
  );
  const postInputs = requireRecord(
    postEvidence.inputs,
    `${label}.dynamicInputs.post.inputs`,
  );
  for (const name of [
    "agentClaude",
    "agentMemoryIndex",
    "agentMemoryTree",
    "userSoul",
    "userProfile",
    "userSkills",
    "workspace",
  ]) {
    requireRecord(
      preInputs[name],
      `${label}.dynamicInputs.pre.inputs.${name}`,
    );
    requireRecord(
      postInputs[name],
      `${label}.dynamicInputs.post.inputs.${name}`,
    );
  }
  const preTemporary = requireRecord(
    preInputs.temporaryWorkspace,
    `${label}.dynamicInputs.pre.inputs.temporaryWorkspace`,
  );
  const postTemporary = requireRecord(
    postInputs.temporaryWorkspace,
    `${label}.dynamicInputs.post.inputs.temporaryWorkspace`,
  );
  if (preTemporary.state !== "absent") {
    fail(`${label} temporaryWorkspace must be absent before the turn`);
  }
  if (!["absent", "tree"].includes(postTemporary.state)) {
    fail(`${label} temporaryWorkspace post state must be absent or tree`);
  }
  const persistent = (inputs) =>
    Object.fromEntries(
      Object.entries(inputs)
        .filter(([name]) => name !== "temporaryWorkspace")
        .sort(([left], [right]) => left.localeCompare(right)),
    );
  assertSame(
    persistent(preInputs),
    persistent(postInputs),
    `${label} persistent dynamic inputs pre/post`,
  );
  return canonicalValue(preInputs, `${label}.dynamicInputs.pre.inputs`);
}

function turnHashIdentity(evidence, label) {
  const turn = requireRecord(evidence.turn, `${label}.turn`);
  const source = requireRecord(turn.source, `${label}.turn.source`);
  const caseSha256 = requireSha(
    source.sha256,
    `${label}.turn.source.sha256`,
  );
  const resultSha256 = requireSha(
    turn.resultSha256,
    `${label}.turn.resultSha256`,
  );
  if (caseSha256 !== resultSha256) {
    fail(`${label}.turn source/result SHA differ`);
  }
  let rawFramesSha256;
  let rawFramesBytes = null;
  if (turn.frames !== undefined) {
    const frames = requireRecord(turn.frames, `${label}.turn.frames`);
    rawFramesSha256 = requireSha(
      frames.sha256,
      `${label}.turn.frames.sha256`,
    );
    rawFramesBytes = requireSafeCount(
      frames.bytes,
      `${label}.turn.frames.bytes`,
    );
    requireString(frames.path, `${label}.turn.frames.path`);
    if (
      turn.rawFramesSha256 !== undefined
      && turn.rawFramesSha256 !== rawFramesSha256
    ) {
      fail(`${label}.turn raw frame hashes disagree`);
    }
  } else {
    rawFramesSha256 = requireSha(
      turn.rawFramesSha256,
      `${label}.turn.rawFramesSha256`,
    );
    if (turn.rawFramesBytes !== undefined) {
      rawFramesBytes = requireSafeCount(
        turn.rawFramesBytes,
        `${label}.turn.rawFramesBytes`,
      );
    }
  }
  return {
    caseSha256,
    rawFramesSha256,
    rawFramesBytes,
    resultSha256,
  };
}

function promptCapture(evidence, label) {
  const promptEvidence = requireRecord(
    evidence.promptEvidence,
    `${label}.promptEvidence`,
  );
  const extraPrompt = requireRecord(
    promptEvidence.extraPrompt,
    `${label}.promptEvidence.extraPrompt`,
  );
  const capturedPath = requireString(
    extraPrompt.capturedPath,
    `${label}.promptEvidence.extraPrompt.capturedPath`,
  );
  if (
    !isAbsolute(capturedPath)
    || resolve(capturedPath) !== capturedPath
    || capturedPath.includes("\0")
  ) {
    fail(`${label} capturedPath must be absolute and normalized`);
  }
  assertSecureRegularFile(capturedPath, `${label} captured prompt`);
  const bytes = readFileSync(capturedPath);
  const expectedBytes = requireSafeCount(
    extraPrompt.bytes,
    `${label}.promptEvidence.extraPrompt.bytes`,
  );
  if (bytes.length !== expectedBytes) {
    fail(`${label} captured prompt byte count differs from evidence`);
  }
  const expectedSha = requireSha(
    extraPrompt.sha256,
    `${label}.promptEvidence.extraPrompt.sha256`,
  );
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha) {
    fail(`${label} captured prompt SHA differs from evidence`);
  }
  return { bytes, sha256: actualSha };
}

export function controlledPromptDelta(baseBytes, candidateBytes) {
  const base = Buffer.from(baseBytes);
  const candidate = Buffer.from(candidateBytes);
  const shortest = Math.min(base.length, candidate.length);
  let prefixBytes = 0;
  while (
    prefixBytes < shortest
    && base[prefixBytes] === candidate[prefixBytes]
  ) {
    prefixBytes += 1;
  }
  let suffixBytes = 0;
  while (
    suffixBytes < shortest - prefixBytes
    && base[base.length - suffixBytes - 1]
      === candidate[candidate.length - suffixBytes - 1]
  ) {
    suffixBytes += 1;
  }
  const removedEnd = base.length - suffixBytes;
  const addedEnd = candidate.length - suffixBytes;
  const canonicalDelta = {
    schemaVersion: 1,
    prefixBytes,
    removedBase64: base.subarray(prefixBytes, removedEnd).toString("base64"),
    addedBase64: candidate.subarray(prefixBytes, addedEnd).toString("base64"),
    suffixBytes,
  };
  return {
    ...canonicalDelta,
    sha256: sha256(Buffer.from(JSON.stringify(canonicalDelta))),
    removedBytes: removedEnd - prefixBytes,
    addedBytes: addedEnd - prefixBytes,
  };
}

function validateArm(evidence, expectedArm, label) {
  if (evidence.schemaVersion !== 2) fail(`${label}.schemaVersion must be 2`);
  if (evidence.status !== "completed") fail(`${label}.status must be completed`);
  if (evidence.arm !== expectedArm) fail(`${label}.arm must be ${expectedArm}`);
  const uid = evidence.uid;
  if (!Number.isSafeInteger(uid) || !SYNTHETIC_UIDS.has(uid)) {
    fail(`${label}.uid is not an approved synthetic account`);
  }
  if (!["ccb", "codex"].includes(evidence.engine)) {
    fail(`${label}.engine must be ccb or codex`);
  }
  if (!AGENT_ID_RE.test(evidence.agentId ?? "")) {
    fail(`${label}.agentId is invalid`);
  }
  const model = requireString(evidence.model, `${label}.model`);
  if (!MODEL_ID_RE.test(model)) fail(`${label}.model is invalid`);
  const pairId = requireString(evidence.pairId, `${label}.pairId`);
  if (!AGENT_ID_RE.test(pairId)) fail(`${label}.pairId is invalid`);
  if (!["A_FIRST", "B_FIRST"].includes(evidence.order)) {
    fail(`${label}.order must be A_FIRST or B_FIRST`);
  }
  const order = evidence.order;
  const baseCommit = requireCommit(evidence.baseCommit, `${label}.baseCommit`);
  const candidateCommit = requireCommit(
    evidence.candidateCommit,
    `${label}.candidateCommit`,
  );
  if (expectedArm === "A" && candidateCommit !== baseCommit) {
    fail(`${label} arm A candidate must equal base`);
  }
  if (expectedArm === "B" && candidateCommit === baseCommit) {
    fail(`${label} arm B candidate must differ from base`);
  }
  const caseEvidence = requireRecord(
    evidence.evaluationCase,
    `${label}.evaluationCase`,
  );
  if (!AGENT_ID_RE.test(caseEvidence.id ?? "")) {
    fail(`${label}.evaluationCase.id is invalid`);
  }
  requireString(caseEvidence.category, `${label}.evaluationCase.category`);
  if (!["none", "temporary"].includes(caseEvidence.workspace)) {
    fail(`${label}.evaluationCase.workspace must be none or temporary`);
  }
  requireSha(
    caseEvidence.casePackSha256,
    `${label}.evaluationCase.casePackSha256`,
  );
  requireSha(
    caseEvidence.promptSha256,
    `${label}.evaluationCase.promptSha256`,
  );
  const caseIdentity = canonicalValue(
    caseEvidence,
    `${label}.evaluationCase`,
  );
  const dynamicPre = dynamicInputIdentity(evidence, label);
  const helpers = helperIdentity(evidence, label);
  const deployment = deploymentIdentity(evidence, label);
  const runtimeTuple = runtimeTupleIdentity(evidence, label);
  const expectedManifestSha = requireSha(
    evidence.expectedManifestSha,
    `${label}.expectedManifestSha`,
  );
  const prepared = requireRecord(evidence.prepared, `${label}.prepared`);
  if (
    requireSha(prepared.manifestSha, `${label}.prepared.manifestSha`)
      !== expectedManifestSha
  ) {
    fail(`${label} prepared manifest differs from expectedManifestSha`);
  }
  const expectedPromptDeltaSha = requireSha(
    evidence.expectedPromptDeltaSha,
    `${label}.expectedPromptDeltaSha`,
  );
  const turn = turnHashIdentity(evidence, label);
  const prompt = promptCapture(evidence, label);
  const efficiency = canonicalValue(
    requireRecord(evidence.efficiency, `${label}.efficiency`),
    `${label}.efficiency`,
  );
  if (Object.keys(efficiency).length === 0) {
    fail(`${label}.efficiency must contain raw metrics`);
  }
  return {
    uid,
    engine: evidence.engine,
    agentId: evidence.agentId,
    model,
    pairId,
    baseCommit,
    candidateCommit,
    caseIdentity,
    dynamicPre,
    helpers,
    deployment,
    runtimeTuple,
    expectedManifestSha,
    expectedPromptDeltaSha,
    order,
    turn,
    prompt,
    efficiency,
  };
}

export function aggregatePair(armAPath, armBPath) {
  const armAFile = readJsonEvidence(armAPath, "arm A evidence");
  const armBFile = readJsonEvidence(armBPath, "arm B evidence");
  const armA = validateArm(armAFile.value, "A", "arm A evidence");
  const armB = validateArm(armBFile.value, "B", "arm B evidence");

  for (const [field, left, right] of [
    ["baseCommit", armA.baseCommit, armB.baseCommit],
    ["uid", armA.uid, armB.uid],
    ["engine", armA.engine, armB.engine],
    ["agentId", armA.agentId, armB.agentId],
    ["model", armA.model, armB.model],
    ["pairId", armA.pairId, armB.pairId],
    ["order", armA.order, armB.order],
    ["evaluationCase", armA.caseIdentity, armB.caseIdentity],
    ["helper file/tree SHA identity", armA.helpers, armB.helpers],
    ["dynamicInputs.pre", armA.dynamicPre, armB.dynamicPre],
    ["deployment identity", armA.deployment, armB.deployment],
    ["runtime tuple", armA.runtimeTuple, armB.runtimeTuple],
    [
      "expectedPromptDeltaSha",
      armA.expectedPromptDeltaSha,
      armB.expectedPromptDeltaSha,
    ],
  ]) {
    assertSame(left, right, field);
  }

  const promptDelta = controlledPromptDelta(
    armA.prompt.bytes,
    armB.prompt.bytes,
  );
  if (promptDelta.sha256 !== armA.expectedPromptDeltaSha) {
    fail("captured full-prompt delta differs from preregistered expectedPromptDeltaSha");
  }

  const pairIdentity = {
    schemaVersion: 2,
    pairId: armA.pairId,
    order: armA.order,
    baseCommit: armA.baseCommit,
    candidateCommit: armB.candidateCommit,
    expectedPromptDeltaSha: armA.expectedPromptDeltaSha,
    uid: armA.uid,
    engine: armA.engine,
    agentId: armA.agentId,
    model: armA.model,
    evaluationCase: armA.caseIdentity,
    helpers: armA.helpers,
    preparedManifestSha256: {
      A: armA.expectedManifestSha,
      B: armB.expectedManifestSha,
    },
    dynamicInputs: { pre: armA.dynamicPre },
    deployment: armA.deployment,
    runtimeTuple: armA.runtimeTuple,
  };
  const pairIdentityHash = sha256(Buffer.from(canonicalJson(pairIdentity)));

  return {
    schemaVersion: 2,
    valid: true,
    pairIdentityHash,
    identity: canonicalValue(pairIdentity),
    armEvidenceSha256: {
      A: armAFile.sha256,
      B: armBFile.sha256,
    },
    promptDelta: {
      expectedSha256: armA.expectedPromptDeltaSha,
      actualSha256: promptDelta.sha256,
      prefixBytes: promptDelta.prefixBytes,
      suffixBytes: promptDelta.suffixBytes,
      removedBytes: promptDelta.removedBytes,
      addedBytes: promptDelta.addedBytes,
      armPromptSha256: {
        A: armA.prompt.sha256,
        B: armB.prompt.sha256,
      },
    },
    turnHashes: {
      A: armA.turn,
      B: armB.turn,
    },
    efficiencyRaw: {
      A: armA.efficiency,
      B: armB.efficiency,
    },
  };
}

function safeWriteExclusive(path, bytes) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  chmodSync(path, 0o600);
}

function usage() {
  return `Usage:
  node scripts/v5-synthetic-eval-pair.mjs \\
    --arm-a </secure/A.json> --arm-b </secure/B.json> \\
    --output </secure/nonexistent-pair.json> [--apply]

Without --apply, the command validates and prints the aggregate but writes
nothing. With --apply, output is created exclusively with mode 0600.`;
}

export function main(argv = process.argv.slice(2)) {
  const options = parsePairArgs(argv);
  if (options.command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  assertSecureDirectory(dirname(options.output), "output parent");
  if (existsSync(options.output)) fail("output must not already exist");
  const aggregate = aggregatePair(options.armA, options.armB);
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({ applied: false, ...aggregate })}\n`);
    return 0;
  }
  safeWriteExclusive(
    options.output,
    Buffer.from(`${JSON.stringify(aggregate, null, 2)}\n`),
  );
  process.stdout.write(`${options.output}\n`);
  return 0;
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(
      `v5-synthetic-eval-pair: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 2;
  }
}
