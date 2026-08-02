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
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, posix, resolve } from "node:path";
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
const CASE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MODEL_ID_RE = /^[A-Za-z0-9._-]{1,80}$/;
const PEER_ID_RE = /^[A-Za-z0-9_-]{8,160}$/;
const CLIENT_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_TIMEOUT_SECONDS = 900;
const MAX_TIMEOUT_SECONDS = 1_050;
const HELPER_TIMEOUT_MS = 180_000;
// The turn timeout starts only after relay readiness. The helper also needs
// 120s for readiness, 60s for post-final billing persistence, 10s for the
// clean WebSocket close, plus 20s of process-boundary margin.
const TURN_HELPER_FIXED_OVERHEAD_MS = 210_000;
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const overlayDriver = resolve(here, "v5-synthetic-eval-overlay.mjs");

export function turnHelperTimeoutMs(turnTimeoutSeconds) {
  return turnTimeoutSeconds * 1_000 + TURN_HELPER_FIXED_OVERHEAD_MS;
}

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
    else if (option === "--model") options.model = value;
    else if (option === "--case-pack") options.casePack = value;
    else if (option === "--case-pack-sha") options.casePackSha = value;
    else if (option === "--case-id") options.caseId = value;
    else if (option === "--pair-id") options.pairId = value;
    else if (option === "--order") options.order = value;
    else if (option === "--expected-prompt-delta-sha") {
      options.expectedPromptDeltaSha = value;
    }
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
    || !MODEL_ID_RE.test(options.model ?? "")
    || !CASE_ID_RE.test(options.caseId ?? "")
    || !CASE_ID_RE.test(options.pairId ?? "")
    || !["A_FIRST", "B_FIRST"].includes(options.order)
    || !SHA256_RE.test(options.casePackSha ?? "")
    || !SHA256_RE.test(options.expectedPromptDeltaSha ?? "")
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
    ["case pack", options.casePack],
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

export function verifyCasePack(path, expectedSha, caseId, engine, model) {
  assertRootOwnedSafe(path, "file", 0o600);
  const real = realpathSync(path);
  if (real !== path) fail(`case pack path must already be canonical: ${path}`);
  if (
    real === repoRoot
    || real.startsWith(`${repoRoot}/`)
    || real.startsWith("/opt/openclaude/")
    || real.startsWith("/var/lib/openclaude-v5/")
  ) {
    fail("real held-out case pack must stay outside the repository/release tree");
  }
  const bytes = readFileSync(real);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== expectedSha) fail("case pack SHA mismatch");
  const pack = JSON.parse(bytes);
  const entry = pack?.schemaVersion === 1 && pack.cases
    && typeof pack.cases === "object"
    ? pack.cases[caseId]
    : null;
  if (
    !entry
    || typeof entry !== "object"
    || entry.id !== caseId
    || typeof entry.category !== "string"
    || entry.category.length === 0
    || typeof entry.prompt !== "string"
    || entry.prompt.trim().length === 0
    || entry.prompt.includes("\0")
    || !entry.models
    || entry.models[engine] !== model
    || !["none", "temporary"].includes(entry.workspace)
  ) {
    fail("case pack entry or engine/model binding is invalid");
  }
  const temporaryWorkspace = `/tmp/oc-synthetic-eval-${caseId}`;
  if (
    entry.workspace === "temporary"
    && !entry.prompt.includes("{{EVAL_WORKSPACE}}")
  ) {
    fail("temporary-workspace case must name its deterministic workspace");
  }
  if (
    entry.workspace === "none"
    && entry.prompt.includes("{{EVAL_WORKSPACE}}")
  ) {
    fail("non-workspace case contains an unexpected workspace placeholder");
  }
  const prompt = entry.prompt.replaceAll(
    "{{EVAL_WORKSPACE}}",
    temporaryWorkspace,
  );
  return {
    path: real,
    sha256: actualSha,
    id: caseId,
    category: entry.category,
    workspace: entry.workspace,
    temporaryWorkspace:
      entry.workspace === "temporary" ? temporaryWorkspace : null,
    prompt,
    promptSha256: createHash("sha256").update(prompt).digest("hex"),
    model,
  };
}

function helperEnvironment(options, phase, evaluationCase, outputs) {
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
    OC_SYNTHETIC_EVAL_MODEL: options.model,
    OC_SYNTHETIC_EVAL_CASE_ID: evaluationCase.id,
    OC_SYNTHETIC_EVAL_PAIR_ID: options.pairId,
    OC_SYNTHETIC_EVAL_ORDER: options.order,
    OC_SYNTHETIC_EVAL_CASE_PACK_SHA: evaluationCase.sha256,
    OC_SYNTHETIC_EVAL_PROMPT_SHA: evaluationCase.promptSha256,
    OC_SYNTHETIC_EVAL_PROMPT: evaluationCase.prompt,
    OC_SYNTHETIC_EVAL_TURN_PATH: outputs.turn,
    OC_SYNTHETIC_EVAL_FRAMES_PATH: outputs.frames,
    OC_SYNTHETIC_EVAL_TIMEOUT_SECONDS: String(options.timeoutSeconds),
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

function readEvidenceFile(path, label) {
  assertRootOwnedSafe(path, "file", 0o600);
  if (realpathSync(path) !== path) fail(`${label} path must already be canonical`);
  const bytes = readFileSync(path);
  return {
    value: JSON.parse(bytes),
    source: {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    },
  };
}

export function parseTurnResult(stdout, resultPath, framesPath, identity) {
  const lastLine = stdout.split("\n").filter(Boolean).at(-1) ?? "";
  if (lastLine !== resultPath) {
    fail("turn helper did not return the runner-assigned result path");
  }
  const parsed = readEvidenceFile(resultPath, "turn result");
  const frames = readEvidenceFile(framesPath, "turn frames");
  const value = parsed.value;
  if (
    !value
    || typeof value !== "object"
    || value.schema_version !== 2
    || typeof value.peer_id !== "string"
    || !PEER_ID_RE.test(value.peer_id)
    || !CLIENT_MESSAGE_ID_RE.test(value.client_message_id ?? "")
    || value.case_id !== identity.caseId
    || value.case_pack_sha !== identity.casePackSha
    || value.pair_id !== identity.pairId
    || value.order !== identity.order
    || value.prompt_sha !== identity.promptSha
    || value.model !== identity.model
    || value.uid !== identity.uid
    || value.engine !== identity.engine
    || value.agent_id !== identity.agentId
    || value.frames_path !== framesPath
    || value.frames_sha256 !== frames.source.sha256
    || value.frames_bytes !== frames.source.bytes
    || !Number.isSafeInteger(value.frame_count)
    || value.frame_count < 1
    || !Number.isFinite(value.wall_ms)
    || value.wall_ms < 0
    || typeof value.billing_evidence_at !== "string"
    || !Number.isFinite(Date.parse(value.billing_evidence_at))
    || !Number.isFinite(value.billing_evidence_wait_ms)
    || value.billing_evidence_wait_ms < 0
    || value.billing_evidence_wait_ms > 66_000
    || Date.parse(value.finished_at) - Date.parse(value.started_at)
      !== value.wall_ms
    || Date.parse(value.billing_evidence_at) - Date.parse(value.finished_at)
      !== value.billing_evidence_wait_ms
    || (
      value.ttft_ms !== null
      && (!Number.isFinite(value.ttft_ms) || value.ttft_ms < 0)
    )
    || typeof value.final_text !== "string"
    || value.billing_binding?.mode !== (
      identity.engine === "ccb"
        ? "ccb_authority_dispatch_attempt"
        : "codex_server_trace"
    )
    || (
      identity.engine === "ccb"
      && (
        value.billing_binding.finalTraceId !== value.trace_id
        || typeof value.billing_binding.dispatchBillingRequestId !== "string"
        || value.billing_binding.dispatchBillingRequestId.length === 0
        || !/^[0-9a-f]{32}$/.test(value.billing_binding.authorityTurnId ?? "")
        || typeof value.billing_binding.dispatchId !== "string"
        || !Number.isSafeInteger(value.billing_binding.attemptNo)
        || value.billing_binding.attemptNo < 1
        || !Array.isArray(value.billing_binding.requestIds)
        || value.billing_binding.requestIds.length < 1
        || !Array.isArray(value.billing_binding.rootRequestIds)
        || value.billing_binding.rootRequestIds.length < 1
        || !Array.isArray(value.billing_binding.usageIds)
        || value.billing_binding.usageIds.length < 1
        || !Array.isArray(value.billing_binding.ledgerIds)
        || value.billing_binding.ledgerIds.length < 1
      )
    )
    || (
      identity.engine === "codex"
      && value.billing_binding.traceId !== value.trace_id
    )
  ) {
    fail("turn helper result identity/evidence is invalid");
  }
  const frameValue = frames.value;
  if (
    !frameValue
    || frameValue.schema_version !== 2
    || frameValue.peer_id !== value.peer_id
    || frameValue.client_message_id !== value.client_message_id
    || frameValue.case_id !== identity.caseId
    || frameValue.case_pack_sha !== identity.casePackSha
    || frameValue.pair_id !== identity.pairId
    || frameValue.order !== identity.order
    || frameValue.prompt_sha !== identity.promptSha
    || frameValue.uid !== identity.uid
    || frameValue.engine !== identity.engine
    || frameValue.agent_id !== identity.agentId
    || frameValue.model !== identity.model
    || !Array.isArray(frameValue.frames)
    || frameValue.connection?.opens !== 1
    || frameValue.connection?.closes !== 1
    || frameValue.connection?.reconnects !== 0
    || frameValue.runtime?.login_requests !== 1
    || frameValue.runtime?.session_puts !== 1
    || frameValue.runtime?.websocket_instances !== 1
    || frameValue.runtime?.inbound_messages !== 1
    || frameValue.runtime?.finals !== 1
    || !Number.isSafeInteger(frameValue.runtime?.binding_queries)
    || frameValue.runtime.binding_queries < 0
    || (identity.engine === "ccb" && frameValue.runtime.binding_queries < 1)
    || (identity.engine === "codex" && frameValue.runtime.binding_queries !== 0)
    || !Number.isSafeInteger(frameValue.runtime?.matching_costs)
    || frameValue.runtime.matching_costs < 1
    || JSON.stringify(value.connection) !== JSON.stringify(frameValue.connection)
    || JSON.stringify(value.runtime) !== JSON.stringify(frameValue.runtime)
    || JSON.stringify(value.billing_binding)
      !== JSON.stringify(frameValue.billing_binding)
  ) {
    fail("raw turn frame evidence does not prove one WebSocket connection");
  }
  const parsedFrames = frameValue.frames.map((frame, index) => {
    if (
      frame?.seq !== index
      || !["sent", "received"].includes(frame.direction)
      || typeof frame.at !== "string"
      || !Number.isFinite(Date.parse(frame.at))
      || !Number.isSafeInteger(frame.bytes)
      || frame.bytes < 0
      || typeof frame.text !== "string"
      || Buffer.byteLength(frame.text) !== frame.bytes
    ) {
      fail("raw turn frames are incomplete or out of order");
    }
    let payload;
    try {
      payload = JSON.parse(frame.text);
    } catch {
      fail("raw turn frame is not exact JSON protocol text");
    }
    return { ...frame, payload };
  });
  const sentInbound = parsedFrames.filter(
    (frame) =>
      frame?.direction === "sent"
      && frame?.payload?.type === "inbound.message",
  );
  if (sentInbound.length !== 1) {
    fail("raw turn frames do not prove exactly one inbound.message send");
  }
  const sent = sentInbound[0].payload;
  const sentText = sent?.content?.text;
  if (
    sent?.peer?.id !== value.peer_id
    || sent?.clientMessageId !== value.client_message_id
    || sent?.agentId !== identity.agentId
    || sent?.model !== identity.model
    || typeof sentText !== "string"
    || createHash("sha256").update(sentText).digest("hex")
      !== identity.promptSha
  ) {
    fail("actual sent prompt/routing differs from the frozen case identity");
  }
  const received = parsedFrames.filter(
    (frame) => frame?.direction === "received",
  );
  const finalFrames = received.filter(
    (frame) =>
      frame?.payload?.type === "outbound.message"
      && frame?.payload?.peer?.id === value.peer_id
      && frame?.payload?.isFinal === true,
  );
  const costFrames = received.filter(
    (frame) => frame?.payload?.type === "outbound.cost_charged",
  );
  const errorFrames = received.filter(
    (frame) =>
      ["outbound.error", "outbound.turn_error", "error"].includes(
        frame?.payload?.type,
      ),
  );
  if (finalFrames.length !== 1 || costFrames.length < 1 || errorFrames.length) {
    fail("raw turn frames do not prove a clean final plus authoritative cost");
  }
  const exactCostFrames = costFrames.filter((frame) =>
    identity.engine === "ccb"
      ? value.billing_binding.requestIds.includes(frame.payload.requestId)
      : frame.payload.traceId === value.trace_id
        || frame.payload.requestId === value.trace_id
  );
  if (
    exactCostFrames.length !== frameValue.runtime.matching_costs
    || (identity.engine === "ccb" && exactCostFrames.length !== costFrames.length)
  ) {
    fail("raw cost frames differ from the engine-specific billing binding");
  }
  const final = finalFrames[0].payload;
  const finalTrace = final.traceId ?? final.requestId;
  const reconstructedText = received
    .filter(
      (frame) =>
        frame.payload?.type === "outbound.message"
        && frame.payload?.peer?.id === value.peer_id,
    )
    .flatMap((frame) => frame.payload.blocks ?? [])
    .filter(
      (block) => block?.kind === "text" && typeof block.text === "string",
    )
    .map((block) => block.text)
    .join("")
    .trim();
  if (
    value.frame_count !== parsedFrames.length
    || !/^[0-9a-f]{32}$/.test(value.trace_id ?? "")
    || finalTrace !== value.trace_id
    || reconstructedText !== value.final_text
  ) {
    fail("turn result is not an exact projection of the raw protocol frames");
  }
  return {
    ...parsed,
    peerId: value.peer_id,
    frames: frames.source,
    parsedFrames,
    sent,
    costFrames: costFrames.map((frame) => frame.payload),
  };
}

function safeArtifactRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !value.includes("\0")
    && !value.startsWith("/")
    && posix.normalize(value) === value
    && value !== "."
    && value !== ".."
    && !value.startsWith("../");
}

export function verifyWorkspaceArtifactDocument(
  document,
  remote,
  expected,
) {
  if (
    !document
    || typeof document !== "object"
    || Array.isArray(document)
    || document.schemaVersion !== 1
    || document.uid !== expected.uid
    || document.engine !== expected.engine
    || document.agentId !== expected.agentId
    || document.caseId !== expected.caseId
    || document.workspaceMode !== expected.workspaceMode
    || document.containerId !== expected.containerId
    || document.manifestSha !== expected.manifestSha
    || JSON.stringify(document.identity) !== JSON.stringify(expected.identity)
    || JSON.stringify(document.identity) !== JSON.stringify(remote.identity)
    || !Array.isArray(document.entries)
    || document.entries.length !== remote.entryCount
    || document.identity?.state !== remote.state
  ) {
    fail("workspace artifact document identity is invalid");
  }
  if (
    document.identity.state === "absent"
    && document.entries.length !== 0
  ) {
    fail("absent workspace artifact document contains entries");
  }
  const seen = new Set();
  const hash = createHash("sha256");
  let files = 0;
  let directories = 0;
  let completeBytes = 0;
  for (const entry of document.entries) {
    if (
      !entry
      || typeof entry !== "object"
      || Array.isArray(entry)
      || !safeArtifactRelativePath(entry.path)
      || seen.has(entry.path)
      || !Number.isSafeInteger(entry.mode)
      || entry.mode < 0
      || entry.mode > 0o777
    ) {
      fail("workspace artifact entry identity is invalid");
    }
    seen.add(entry.path);
    if (entry.type === "directory") {
      if (
        Object.keys(entry).sort().join(",") !== "mode,path,type"
      ) {
        fail("workspace artifact directory has unexpected fields");
      }
      directories += 1;
      hash.update(`D  ${entry.path}\n`);
      continue;
    }
    if (
      entry.type !== "file"
      || Object.keys(entry).sort().join(",")
        !== "bytes,contentBase64,mode,path,sha256,type"
      || !Number.isSafeInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.contentBase64 !== "string"
      || !SHA256_RE.test(entry.sha256 ?? "")
    ) {
      fail("workspace artifact file entry is invalid");
    }
    const bytes = Buffer.from(entry.contentBase64, "base64");
    if (
      bytes.toString("base64") !== entry.contentBase64
      || bytes.length !== entry.bytes
      || createHash("sha256").update(bytes).digest("hex") !== entry.sha256
    ) {
      fail("workspace artifact file bytes are incomplete or corrupted");
    }
    files += 1;
    completeBytes += bytes.length;
    hash.update(`F  ${entry.sha256}  ${entry.path}\n`);
  }
  const identity = document.identity;
  if (identity.state === "tree") {
    if (
      identity.files !== files
      || identity.directories !== directories
      || identity.sha256 !== hash.digest("hex")
    ) {
      fail("workspace artifact tree identity differs from complete entries");
    }
  } else if (
    identity.state !== "absent"
    || files !== 0
    || directories !== 0
  ) {
    fail("workspace artifact state is invalid");
  }
  return { files, directories, completeBytes };
}

function fetchWorkspaceArtifact(remote, outputPath, expected) {
  const host = process.env.KL_HOST || "kl-mirror";
  if (!/^[A-Za-z0-9_.@-]+$/.test(host)) fail(`unsafe KL_HOST: ${host}`);
  if (
    !remote
    || typeof remote !== "object"
    || !["absent", "tree"].includes(remote.state)
    || !remote.identity
    || !Number.isSafeInteger(remote.entryCount)
    || remote.entryCount < 0
    || typeof remote.remotePath !== "string"
    || !/^\/var\/lib\/openclaude-v5\/synthetic-eval-overlay\/[0-9a-f]{64}\/evidence\/[0-9a-f]{32}-[A-Za-z0-9_-]{1,80}\.workspace\.json$/.test(
      remote.remotePath,
    )
    || !Number.isSafeInteger(remote.bytes)
    || remote.bytes < 1
    || !SHA256_RE.test(remote.sha256 ?? "")
  ) {
    fail("remote workspace artifact evidence is invalid");
  }
  if (existsSync(outputPath)) fail("workspace artifact output already exists");
  const copied = spawnSync(
    "scp",
    ["-q", `${host}:${remote.remotePath}`, outputPath],
    { encoding: "utf8" },
  );
  if (copied.error) throw copied.error;
  if (copied.status !== 0) {
    fail(`workspace artifact copy failed: ${copied.stderr || copied.stdout}`);
  }
  chmodSync(outputPath, 0o600);
  assertRootOwnedSafe(outputPath, "file", 0o600);
  if (realpathSync(outputPath) !== outputPath) {
    fail("workspace artifact output path is not canonical");
  }
  const bytes = readFileSync(outputPath);
  if (
    bytes.length !== remote.bytes
    || createHash("sha256").update(bytes).digest("hex") !== remote.sha256
  ) {
    fail("copied workspace artifact bytes differ from remote evidence");
  }
  const document = JSON.parse(bytes.toString("utf8"));
  const complete = verifyWorkspaceArtifactDocument(document, remote, expected);
  durablyPersistWorkspaceArtifact(outputPath);
  return {
    state: remote.state,
    identity: remote.identity,
    entryCount: remote.entryCount,
    capturedPath: outputPath,
    bytes: bytes.length,
    sha256: remote.sha256,
    ...complete,
  };
}

export function durablyPersistWorkspaceArtifact(path, sync = fsyncSync) {
  for (const target of [path, dirname(path)]) {
    const fd = openSync(target, "r");
    try {
      sync(fd);
    } finally {
      closeSync(fd);
    }
  }
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

export function assertDynamicInputsStable(before, after, workspaceMode) {
  const beforeInputs = before?.inputs;
  const afterInputs = after?.inputs;
  if (!beforeInputs || !afterInputs) fail("dynamic input evidence is missing");
  for (const name of [
    "agentClaude",
    "agentMemoryIndex",
    "agentMemoryTree",
    "userSoul",
    "userProfile",
    "userSkills",
    "workspace",
  ]) {
    if (
      JSON.stringify(beforeInputs[name])
      !== JSON.stringify(afterInputs[name])
    ) {
      fail(`dynamic input changed during exact arm: ${name}`);
    }
  }
  if (beforeInputs.temporaryWorkspace?.state !== "absent") {
    fail("temporary evaluation workspace was not clean before the turn");
  }
  if (
    workspaceMode === "none"
    && afterInputs.temporaryWorkspace?.state !== "absent"
  ) {
    fail("non-workspace case created the reserved temporary workspace");
  }
}

export function assertTurnUsageMatchesFrames(turn, evidence) {
  const usage = [...evidence.rootUsage, ...evidence.delegateUsage];
  const newIds = new Set(evidence.newUsage.map((row) => row.id));
  if (
    newIds.size !== usage.length
    || usage.some((row) => !newIds.has(row.id))
  ) {
    fail("new usage rows are not exactly the evaluated root/delegate usage");
  }
  const byRequest = new Map();
  for (const row of usage) {
    if (
      typeof row.request_id !== "string"
      || row.request_id.length === 0
      || byRequest.has(row.request_id)
    ) {
      fail("authoritative usage request identities are missing or duplicated");
    }
    byRequest.set(row.request_id, row);
  }
  const seen = new Set();
  for (const frame of turn.costFrames) {
    const row = byRequest.get(frame.requestId);
    if (
      typeof frame.requestId !== "string"
      || seen.has(frame.requestId)
      || !row
      || (
        frame.model !== undefined
        && frame.model !== row.model
      )
      || String(frame.costCredits) !== String(row.cost_credits)
    ) {
      fail("cost frame is not uniquely bound to exact authoritative usage");
    }
    seen.add(frame.requestId);
  }
  for (const row of usage) {
    if (BigInt(row.cost_credits) > 0n && !seen.has(row.request_id)) {
      fail("positive authoritative usage has no exact cost frame");
    }
  }
  if (turn.value.billing_binding?.mode !== evidence.billingBindingMode) {
    fail("turn helper and durable evidence use different billing bindings");
  }
  if (evidence.billingBindingMode === "ccb_authority_dispatch_attempt") {
    const positiveRequests = usage
      .filter((row) => BigInt(row.cost_credits) > 0n)
      .map((row) => row.request_id)
      .sort();
    const positiveRootRequests = evidence.rootUsage
      .filter((row) => BigInt(row.cost_credits) > 0n)
      .map((row) => row.request_id)
      .sort();
    const binding = turn.value.billing_binding;
    const authority = evidence.authorityBindings?.[0];
    if (
      !authority
      || binding.finalTraceId !== turn.value.trace_id
      || binding.dispatchBillingRequestId
        !== evidence.dispatch.billing_request_id
      || binding.authorityTurnId !== authority.authority_turn_id
      || binding.dispatchId !== evidence.dispatch.dispatch_id
      || binding.attemptNo !== evidence.dispatch.attempt_no
      || JSON.stringify(binding.requestIds) !== JSON.stringify(positiveRequests)
      || JSON.stringify(binding.rootRequestIds)
        !== JSON.stringify(positiveRootRequests)
      || JSON.stringify(binding.usageIds) !== JSON.stringify(
        usage.map((row) => String(row.id)).sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
        ),
      )
      || JSON.stringify(binding.ledgerIds) !== JSON.stringify(
        evidence.ledger.map((row) => row.id).sort((left, right) =>
          BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0
        ),
      )
    ) {
      fail("CCB helper binding differs from exact authority/usage/ledger evidence");
    }
  } else if (
    evidence.billingBindingMode === "codex_server_trace"
  ) {
    const binding = turn.value.billing_binding;
    const dispatchRequestId = evidence.dispatch?.billing_request_id;
    const rootUsage = evidence.rootUsage.find((row) =>
      row.request_id === dispatchRequestId && BigInt(row.cost_credits) > 0n
    );
    const rootCostFrame = turn.costFrames.find((frame) =>
      frame.requestId === dispatchRequestId
    );
    if (
      binding?.traceId !== turn.value.trace_id
      || typeof dispatchRequestId !== "string"
      || dispatchRequestId.length === 0
      || !binding.requestIds?.includes(dispatchRequestId)
      || !rootUsage
      || !rootCostFrame
      || (
        rootCostFrame.traceId !== turn.value.trace_id
        && rootCostFrame.requestId !== turn.value.trace_id
      )
    ) {
      fail("Codex helper binding differs from the exact root dispatch trace");
    }
  } else {
    fail("turn evidence uses an unsupported billing binding");
  }
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
  ).join(",")}}`;
}

function walkJson(value, visit, nested = false) {
  if (value === null || typeof value !== "object") return;
  const childNested = nested || value.kind === "delegate_progress";
  visit(value, childNested);
  if (Array.isArray(value)) {
    for (const child of value) walkJson(child, visit, childNested);
  } else {
    for (const child of Object.values(value)) {
      walkJson(child, visit, childNested);
    }
  }
}

function normalizedTool(node) {
  const rawName = node.toolName ?? node.name;
  if (typeof rawName !== "string" || rawName.length === 0) return null;
  let name = rawName;
  let input = node.inputJson ?? node.input ?? node.args ?? {};
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      input = { raw: input };
    }
  }
  if (/^codex:mcpToolCall$/i.test(name)) {
    name = `${input?.server ?? ""}:${input?.tool ?? input?.name ?? ""}`;
    let args = input?.arguments ?? {};
    if (typeof args === "string") {
      try {
        args = JSON.parse(args);
      } catch {
        args = { raw: args };
      }
    }
    input = args;
  } else if (/^ExecuteExtraTool$/i.test(name)) {
    name = input?.tool_name ?? name;
    let params = input?.params ?? {};
    if (typeof params === "string") {
      try {
        params = JSON.parse(params);
      } catch {
        params = { raw: params };
      }
    }
    input = params;
  }
  return {
    name: String(name),
    input,
    signature: `${String(name)}\0${canonicalJson(input)}`,
  };
}

function sumUsage(records, field) {
  return records.reduce(
    (total, row) => total + BigInt(row[field] ?? 0),
    0n,
  ).toString();
}

export function analyzeEfficiency(turn, turnEvidence) {
  const toolCalls = new Map();
  const toolResults = new Set();
  const signatures = new Map();
  let topLevelToolCalls = 0;
  let nestedToolCalls = 0;
  let delegationCalls = 0;
  let parallelToolCallFrames = 0;
  let maxToolCallsInFrame = 0;
  let modelToolBoundaries = 0;
  let lastStage = null;
  const markStage = (stage) => {
    if (lastStage !== null && lastStage !== stage) modelToolBoundaries += 1;
    lastStage = stage;
  };

  for (const frame of turn.parsedFrames) {
    if (frame.direction !== "received") continue;
    let newToolCalls = 0;
    walkJson(frame.payload, (node, nested) => {
      if (
        node.kind === "text"
        && typeof node.text === "string"
        && node.text.length > 0
      ) {
        markStage("model");
      }
      if (node.kind === "tool_use" && node.partial !== true) {
        const tool = normalizedTool(node);
        if (!tool) return;
        const id =
          node.blockId
          ?? node.toolUseId
          ?? tool.signature;
        if (toolCalls.has(id)) return;
        toolCalls.set(id, tool);
        markStage("tool");
        signatures.set(
          tool.signature,
          (signatures.get(tool.signature) ?? 0) + 1,
        );
        newToolCalls += 1;
        if (nested || node.parentToolUseId) nestedToolCalls += 1;
        else topLevelToolCalls += 1;
        if (/(^|[:_.])(?:delegate_tasks?|spawn_agent)$/i.test(tool.name)) {
          delegationCalls += 1;
        }
      }
      if (node.kind === "tool_result") {
        const id =
          node.toolUseBlockId
          ?? node.toolUseId
          ?? node.blockId?.replace(/:result$/, "");
        if (typeof id === "string" && !toolResults.has(id)) {
          toolResults.add(id);
          markStage("tool");
        }
      }
    });
    if (newToolCalls > 1) parallelToolCallFrames += 1;
    maxToolCallsInFrame = Math.max(maxToolCallsInFrame, newToolCalls);
  }

  const usage = [...turnEvidence.rootUsage, ...turnEvidence.delegateUsage];
  return {
    wallMs: turn.value.wall_ms,
    ttftMs: turn.value.ttft_ms,
    receivedFrameCount: turn.parsedFrames.filter(
      (frame) => frame.direction === "received",
    ).length,
    totalFrameBytes: turn.parsedFrames.reduce(
      (total, frame) => total + frame.bytes,
      0,
    ),
    finalTextBytes: Buffer.byteLength(turn.value.final_text),
    modelToolBoundaries,
    toolCallCount: toolCalls.size,
    toolResultCount: toolResults.size,
    topLevelToolCalls,
    nestedToolCalls,
    parallelToolCallFrames,
    maxToolCallsInFrame,
    duplicateExactToolCallCount: [...signatures.values()].reduce(
      (total, count) => total + Math.max(0, count - 1),
      0,
    ),
    delegationCalls,
    usageRecordCount: usage.length,
    rootUsageRecordCount: turnEvidence.rootUsage.length,
    delegateUsageRecordCount: turnEvidence.delegateUsage.length,
    inputTokens: sumUsage(usage, "input_tokens"),
    outputTokens: sumUsage(usage, "output_tokens"),
    cacheReadTokens: sumUsage(usage, "cache_read_tokens"),
    cacheWriteTokens: sumUsage(usage, "cache_write_tokens"),
    costCredits: sumUsage(usage, "cost_credits"),
  };
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
    --arm A|B --uid 247|626 --engine ccb|codex --agent-id <id> --model <id> \\
    --case-pack </absolute/root-owned-0600.json> --case-pack-sha <64hex> \\
    --case-id <id> --pair-id <id> --order A_FIRST|B_FIRST \\
    --expected-prompt-delta-sha <64hex> \\
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
  const evaluationCase = verifyCasePack(
    options.casePack,
    options.casePackSha,
    options.caseId,
    options.engine,
    options.model,
  );
  const evidenceParent = dirname(options.evidenceFile);
  assertRootOwnedSafe(evidenceParent, "dir", 0o700);
  const evidenceStem = options.evidenceFile.slice(0, -".json".length);
  const outputPaths = {
    turn: `${evidenceStem}.turn.json`,
    frames: `${evidenceStem}.frames.json`,
    extraPrompt: `${evidenceStem}.extra-prompt.md`,
    workspaceArtifact: `${evidenceStem}.workspace.json`,
  };
  for (const path of [
    options.evidenceFile,
    outputPaths.turn,
    outputPaths.frames,
    outputPaths.extraPrompt,
    outputPaths.workspaceArtifact,
  ]) {
    if (existsSync(path)) fail(`evaluation evidence path already exists: ${path}`);
  }
  if (!options.apply) {
    process.stdout.write(`${JSON.stringify({
      applied: false,
      arm: options.arm,
      uid: options.uid,
      engine: options.engine,
      model: options.model,
      pairId: options.pairId,
      order: options.order,
      expectedPromptDeltaSha: options.expectedPromptDeltaSha,
      evaluationCase: {
        id: evaluationCase.id,
        category: evaluationCase.category,
        workspace: evaluationCase.workspace,
        casePackSha256: evaluationCase.sha256,
        promptSha256: evaluationCase.promptSha256,
      },
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
  let dynamicInputsPre = null;
  let dynamicInputsPost = null;
  let turn = null;
  let turnEvidence = null;
  let efficiency = null;
  let workspaceArtifact = null;
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
      helperEnvironment(options, "overlay", evaluationCase, outputPaths),
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
    dynamicInputsPre = runRemote("dynamic-input-evidence", {
      ...remoteCommon(lease),
      uid: options.uid,
      expectedBase: options.baseCommit,
      candidateCommit: options.candidateCommit,
      manifestSha: prepared.manifestSha,
      recordNonce: prepared.nonce,
      containerId: overlayContainer.containerId,
      agentId: options.agentId,
      caseId: evaluationCase.id,
      phase: "pre",
    });

    const turnOutput = runNodeHelper(
      options.turnHelper,
      helperEnvironment(options, "turn", evaluationCase, outputPaths),
      turnHelperTimeoutMs(options.timeoutSeconds),
    );
    turn = parseTurnResult(
      turnOutput,
      outputPaths.turn,
      outputPaths.frames,
      {
        caseId: evaluationCase.id,
        casePackSha: evaluationCase.sha256,
        pairId: options.pairId,
        order: options.order,
        promptSha: evaluationCase.promptSha256,
        model: options.model,
        uid: options.uid,
        engine: options.engine,
        agentId: options.agentId,
      },
    );
    assertHelperTreesUnchanged(helpers);
    const caseAfterTurn = verifyCasePack(
      options.casePack,
      options.casePackSha,
      options.caseId,
      options.engine,
      options.model,
    );
    if (
      caseAfterTurn.promptSha256 !== evaluationCase.promptSha256
      || caseAfterTurn.category !== evaluationCase.category
      || caseAfterTurn.workspace !== evaluationCase.workspace
    ) {
      fail("held-out case identity changed during the exact arm");
    }
    if (
      turn.value.container?.id !== undefined
      && turn.value.container.id !== overlayContainer.containerId
    ) {
      fail("turn result is bound to a different Docker container");
    }
    turnEvidence = runRemote("turn-evidence", {
      ...remoteCommon(lease),
      uid: options.uid,
      expectedBase: options.baseCommit,
      peerId: turn.peerId,
      clientMessageId: turn.value.client_message_id,
      agentId: options.agentId,
      model: options.model,
      engine: options.engine,
      traceId: turn.value.trace_id,
      usageFloor: pre.usageMaxId,
    });
    assertTurnUsageMatchesFrames(turn, turnEvidence);
    efficiency = analyzeEfficiency(turn, turnEvidence);
    dynamicInputsPost = runRemote("dynamic-input-evidence", {
      ...remoteCommon(lease),
      uid: options.uid,
      expectedBase: options.baseCommit,
      candidateCommit: options.candidateCommit,
      manifestSha: prepared.manifestSha,
      recordNonce: prepared.nonce,
      containerId: overlayContainer.containerId,
      agentId: options.agentId,
      caseId: evaluationCase.id,
      phase: "post",
    });
    assertDynamicInputsStable(
      dynamicInputsPre,
      dynamicInputsPost,
      evaluationCase.workspace,
    );
    const remoteWorkspaceArtifact = runRemote("workspace-artifact-evidence", {
      ...remoteCommon(lease),
      uid: options.uid,
      expectedBase: options.baseCommit,
      candidateCommit: options.candidateCommit,
      manifestSha: prepared.manifestSha,
      recordNonce: prepared.nonce,
      containerId: overlayContainer.containerId,
      engine: options.engine,
      agentId: options.agentId,
      caseId: evaluationCase.id,
      workspaceMode: evaluationCase.workspace,
      expectedIdentity: dynamicInputsPost.inputs.temporaryWorkspace,
    });
    workspaceArtifact = fetchWorkspaceArtifact(
      remoteWorkspaceArtifact,
      outputPaths.workspaceArtifact,
      {
        uid: options.uid,
        engine: options.engine,
        agentId: options.agentId,
        caseId: evaluationCase.id,
        workspaceMode: evaluationCase.workspace,
        containerId: overlayContainer.containerId,
        manifestSha: prepared.manifestSha,
        identity: dynamicInputsPost.inputs.temporaryWorkspace,
      },
    );
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
    if (post.usageCount !== pre.usageCount + turnEvidence.newUsage.length) {
      fail("post snapshot usage count differs from exact bound turn evidence");
    }
    const expectedUsageMaxId = Math.max(
      pre.usageMaxId,
      ...turnEvidence.newUsage.map((row) => row.id),
    );
    if (post.usageMaxId !== expectedUsageMaxId) {
      fail("post snapshot usage high-water mark differs from exact turn evidence");
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
          helperEnvironment(options, "restore", evaluationCase, outputPaths),
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

  const extraPromptPath = outputPaths.extraPrompt;
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
    schemaVersion: 3,
    status: primaryError || cleanupError ? "failed" : "completed",
    arm: options.arm,
    uid: options.uid,
    engine: options.engine,
    agentId: options.agentId,
    model: options.model,
    pairId: options.pairId,
    order: options.order,
    expectedPromptDeltaSha: options.expectedPromptDeltaSha,
    evaluationCase: {
      id: evaluationCase.id,
      category: evaluationCase.category,
      workspace: evaluationCase.workspace,
      casePackSha256: evaluationCase.sha256,
      promptSha256: evaluationCase.promptSha256,
    },
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
    dynamicInputs: dynamicInputsPre && dynamicInputsPost
      ? { pre: dynamicInputsPre, post: dynamicInputsPost }
      : null,
    turn: turn && {
      peerId: turn.peerId,
      source: turn.source,
      frames: turn.frames,
      resultSha256: turn.source.sha256,
      wallMs: turn.value.wall_ms,
      ttftMs: turn.value.ttft_ms,
      finalTextSha256: createHash("sha256")
        .update(turn.value.final_text)
        .digest("hex"),
    },
    turnEvidence,
    efficiency,
    workspaceArtifact,
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
