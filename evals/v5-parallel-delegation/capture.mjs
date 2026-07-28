#!/usr/bin/env node
/**
 * Capture one synthetic V5 true turn plus tool/resource evidence.
 *
 * This deliberately does not decide PASS/FAIL. score.mjs owns the frozen gate.
 * Run only against a dedicated eval account/container with no other traffic.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBrowserExecutable } from "../../scripts/lib/resolve-browser.mjs";
import { analyzeFrames } from "./frame-analysis.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(join(HERE, "..", "..", "package.json"));
const { chromium } = require_("playwright-core");

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env ${name}`);
  return value;
};

const BASE = required("V5_EVAL_BASE").replace(/\/$/, "");
const EMAIL = required("V5_EVAL_EMAIL");
const PASSWORD_FILE = required("V5_EVAL_PASSWORD_FILE");
const FIXTURES = resolve(required("V5_EVAL_FIXTURES"));
const SCENARIO = required("V5_EVAL_SCENARIO");
const ARM = required("V5_EVAL_ARM");
const PAIR_ID = required("V5_EVAL_PAIR_ID");
const ORDER = required("V5_EVAL_ORDER");
const ENGINE = required("V5_EVAL_ENGINE");
const MODEL = required("V5_EVAL_MODEL");
const EXPECTED_EFFORT = process.env.V5_EVAL_EFFORT?.trim() || null;
const OUTPUT = resolve(required("V5_EVAL_OUTPUT"));
const MANIFEST_PATH = resolve(required("V5_EVAL_MANIFEST"));
const CONTAINER = required("V5_EVAL_CONTAINER");
const SSH_HOST = process.env.V5_EVAL_SSH_HOST?.trim() || "kl-mirror";
const PROBE_PATH = required("V5_EVAL_PROBE_PATH");
const PROMPT_REV = required("V5_EVAL_PROMPT_REV");
const PERSONA_PATH = required("V5_EVAL_PERSONA_PATH");
const PERSONA_REV = required("V5_EVAL_PERSONA_REV");
const PERSONA_BASE_REV = required("V5_EVAL_PERSONA_BASE_REV");
const RULE_INJECTION = required("V5_EVAL_RULE_INJECTION");
const RULE_REV = process.env.V5_EVAL_RULE_REV?.trim() || null;
const PAIR_EXECUTION_ID = required("V5_EVAL_PAIR_EXECUTION_ID");
const PAIR_STEP = Number(required("V5_EVAL_PAIR_STEP"));
const TIMEOUT_MS = Number(process.env.V5_EVAL_TIMEOUT_MS ?? 900_000);
const SAMPLE_MS = Number(process.env.V5_EVAL_SAMPLE_MS ?? 500);

if (!["A", "B"].includes(ARM)) throw new Error("V5_EVAL_ARM must be A or B");
if (!["A_FIRST", "B_FIRST"].includes(ORDER)) throw new Error("V5_EVAL_ORDER must be A_FIRST or B_FIRST");
if (!["ccb", "codex"].includes(ENGINE)) throw new Error("V5_EVAL_ENGINE must be ccb or codex");
if (!["none", "persona-system-slot", "platform-bundle"].includes(RULE_INJECTION)) {
  throw new Error("V5_EVAL_RULE_INJECTION must be none, persona-system-slot, or platform-bundle");
}
if (ARM === "A" && (RULE_INJECTION !== "none" || RULE_REV !== null)) {
  throw new Error("A arm must not inject the candidate rule");
}
if (ARM === "B" && (RULE_INJECTION === "none" || RULE_REV === null)) {
  throw new Error("B arm must record the candidate rule injection and SHA");
}
if (![1, 2].includes(PAIR_STEP)) throw new Error("V5_EVAL_PAIR_STEP must be 1 or 2");

const scenariosBytes = readFileSync(join(FIXTURES, "scenarios.json"));
const scenarios = JSON.parse(scenariosBytes);
const scenario = scenarios[SCENARIO];
if (!scenario) throw new Error(`unknown scenario ${SCENARIO}`);
const manifestBytes = readFileSync(MANIFEST_PATH);
const manifest = JSON.parse(manifestBytes);
const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
if (
  manifest.fixture_revs?.scenarios_rev !==
    createHash("sha256").update(scenariosBytes).digest("hex") ||
  manifest.fixture_revs?.generator_rev !==
    createHash("sha256").update(readFileSync(join(HERE, "generate-fixtures.py"))).digest("hex")
) {
  throw new Error("fixture scenarios/generator revision differs from manifest");
}
const expectedEngine = manifest.engines?.[ENGINE];
const expectedTarget = manifest.targets?.[ENGINE];
const expectedPair = manifest.pairs?.find((pair) => pair.pair_id === PAIR_ID);
if (!expectedEngine) throw new Error(`engine ${ENGINE} is not preregistered`);
if (!expectedTarget) throw new Error(`eval target ${ENGINE} is not preregistered`);
if (expectedTarget.container !== CONTAINER) throw new Error("container differs from manifest target");
if (!manifest.scenarios?.includes(SCENARIO)) throw new Error(`scenario ${SCENARIO} is not preregistered`);
if (!expectedPair || expectedPair.order !== ORDER) throw new Error("pair id/order differs from manifest");
if (!manifest.arms?.includes(ARM)) throw new Error(`arm ${ARM} is not preregistered`);
if (expectedEngine.model !== MODEL || (expectedEngine.effort ?? null) !== EXPECTED_EFFORT) {
  throw new Error("model/effort differs from manifest");
}
if (!manifest.policy) throw new Error("manifest policy is not cryptographically bound");
if (
  !Number.isFinite(manifest.max_container_age_before_pair_ms) ||
  manifest.max_container_age_before_pair_ms <= 0
) {
  throw new Error("manifest fresh-container age gate is invalid");
}
for (const field of [
  "rule_rev",
  "baseline_prompt_rev",
  "candidate_prompt_rev",
  "probe_rev",
]) {
  if (!/^[0-9a-f]{64}$/.test(manifest.policy[field] ?? "")) {
    throw new Error(`manifest policy ${field} is not a SHA-256`);
  }
}
const expectedPersonaPolicy = manifest.policy.personas?.[ENGINE];
for (const field of ["base_persona_rev", "candidate_persona_rev"]) {
  if (!/^[0-9a-f]{64}$/.test(expectedPersonaPolicy?.[field] ?? "")) {
    throw new Error(`manifest policy personas.${ENGINE}.${field} is not a SHA-256`);
  }
}
const expectedStep = RULE_INJECTION === "platform-bundle"
  ? 1
  : ORDER === "A_FIRST"
    ? (ARM === "A" ? 1 : 2)
    : (ARM === "B" ? 1 : 2);
if (PAIR_STEP !== expectedStep) throw new Error(`pair step ${PAIR_STEP} differs from expected ${expectedStep}`);
if (PERSONA_BASE_REV !== expectedPersonaPolicy.base_persona_rev) {
  throw new Error("persona base revision differs from manifest policy");
}
if (Number(scenario.absolute_wall_ms) !== manifest.absolute_wall_ms?.[SCENARIO]) {
  throw new Error("scenario absolute wall gate differs from manifest");
}
mkdirSync(dirname(OUTPUT), { recursive: true });
const rawFramesPath = OUTPUT.replace(/\.json$/i, ".frames.json");
const failurePath = OUTPUT.replace(/\.json$/i, `.${Date.now()}.failed.json`);
if (existsSync(OUTPUT) || existsSync(rawFramesPath)) {
  throw new Error("refusing to overwrite an existing run or transcript");
}

const execFileAsync = promisify(execFile);

async function remote(command) {
  const { stdout } = await execFileAsync("ssh", [SSH_HOST, command], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

async function dockerExec(command) {
  return remote(`docker exec ${shellQuote(CONTAINER)} sh -lc ${shellQuote(command)}`);
}

function parseMax(raw) {
  const value = String(raw).trim();
  return value === "max" ? Number.POSITIVE_INFINITY : Number(value);
}

async function readActivity() {
  const parsed = JSON.parse(await remote(
    `${shellQuote(PROBE_PATH)} activity ${shellQuote(expectedTarget.user_id)}`,
  ));
  if (
    parsed.user_id !== expectedTarget.user_id ||
    !Number.isInteger(parsed.parents) ||
    parsed.parents < 0
  ) {
    throw new Error("activity probe must return non-negative integer parents");
  }
  return parsed;
}

async function readUsage(peerId) {
  const parsed = JSON.parse(await remote(
    `${shellQuote(PROBE_PATH)} usage ${shellQuote(expectedTarget.user_id)} ${shellQuote(peerId)}`,
  ));
  for (const field of ["tokens", "cost_credits", "rows", "child_rows", "failed_rows", "pending_rows"]) {
    if (!Number.isFinite(parsed[field]) || parsed[field] < 0) {
      throw new Error(`usage probe must return finite non-negative ${field}`);
    }
  }
  for (const field of ["tokens", "rows", "child_rows", "failed_rows", "pending_rows"]) {
    if (!Number.isInteger(parsed[field])) throw new Error(`usage probe ${field} must be an integer`);
  }
  if (
    parsed.user_id !== expectedTarget.user_id ||
    parsed.peer_id !== peerId ||
    !Array.isArray(parsed.receipts) ||
    parsed.receipts.length !== parsed.rows
  ) {
    throw new Error("usage probe identity/receipt evidence is inconsistent");
  }
  return parsed;
}

async function readBinding(peerId) {
  const parsed = JSON.parse(await remote(
    `${shellQuote(PROBE_PATH)} binding ${shellQuote(expectedTarget.user_id)} ` +
    `${shellQuote(peerId)} ${shellQuote(CONTAINER)}`,
  ));
  if (
    parsed.user_id !== expectedTarget.user_id ||
    parsed.dispatch_user_id !== expectedTarget.user_id ||
    parsed.peer_id !== peerId ||
    parsed.dispatch_session_id !== peerId ||
    parsed.docker_name !== CONTAINER ||
    !/^[0-9a-f]{64}$/.test(parsed.docker_id ?? "") ||
    parsed.container_internal_id !== parsed.docker_id ||
    typeof parsed.dispatch_id !== "string" ||
    !parsed.dispatch_id
  ) {
    throw new Error("dispatch/container binding evidence is inconsistent");
  }
  return parsed;
}

async function readLane() {
  return JSON.parse(await remote(
    `${shellQuote(PROBE_PATH)} lane ${shellQuote(expectedTarget.user_id)}`,
  ));
}

async function readFreshness(containerStartedAt) {
  const parsed = JSON.parse(await remote(
    `${shellQuote(PROBE_PATH)} freshness ${shellQuote(expectedTarget.user_id)} ` +
    `${shellQuote(containerStartedAt)}`,
  ));
  if (
    parsed.user_id !== expectedTarget.user_id ||
    parsed.container_started_at !== containerStartedAt ||
    !Number.isInteger(parsed.dispatches) ||
    parsed.dispatches < 0 ||
    !Number.isInteger(parsed.usage_rows) ||
    parsed.usage_rows < 0
  ) {
    throw new Error("container freshness evidence is inconsistent");
  }
  return parsed;
}

function laneIdentity(lane) {
  return {
    phase: lane.phase,
    generation: String(lane.generation),
    active_slot: lane.active_slot,
    active_release: lane.active_release,
    candidate_slot: lane.candidate_slot,
    candidate_release: lane.candidate_release,
    cohort_percent: Number(lane.cohort_percent),
  };
}

async function readSample() {
  const parsed = JSON.parse(await remote(
    `${shellQuote(PROBE_PATH)} sample ${shellQuote(expectedTarget.user_id)} ${shellQuote(CONTAINER)}`,
  ));
  const resource = {
    cpu_usec: Number(parsed.cpu_usec),
    memory_current: Number(parsed.memory_current),
    memory_max: parseMax(parsed.memory_max),
    memory_peak: Number(parsed.memory_peak),
    pids_current: Number(parsed.pids_current),
    pids_max: parseMax(parsed.pids_max),
    pids_peak: Number(parsed.pids_peak),
    memory_oom: Number(parsed.memory_oom),
    memory_oom_kill: Number(parsed.memory_oom_kill),
    pids_max_events: Number(parsed.pids_max_events),
  };
  if (
    parsed.activity?.user_id !== expectedTarget.user_id ||
    !Number.isInteger(parsed.activity?.parents) ||
    Object.values(resource).some((value) => typeof value !== "number" || Number.isNaN(value))
  ) {
    throw new Error("sample probe evidence is inconsistent");
  }
  return { resource, activity: parsed.activity };
}

async function readContainerMeta() {
  const inspect = JSON.parse(await remote(`docker inspect ${shellQuote(CONTAINER)}`))[0];
  const labels = inspect.Config?.Labels ?? {};
  const env = Object.fromEntries(
    (inspect.Config?.Env ?? []).map((entry) => {
      const index = entry.indexOf("=");
      return index < 0 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
    }),
  );
  return {
    id: inspect.Id,
    created_at: inspect.Created,
    started_at: inspect.State?.StartedAt,
    restart_count: inspect.RestartCount,
    oom_killed: Boolean(inspect.State?.OOMKilled),
    runtime_tuple: {
      image: env.OC_RUNTIME_IMAGE ?? inspect.Config?.Image ?? null,
      image_id: env.OC_RUNTIME_IMAGE_ID ?? labels["com.openclaude.runtime.image_id"] ?? inspect.Image ?? null,
      runtime_release: env.OC_RUNTIME_RELEASE ?? labels["com.openclaude.runtime.release"] ?? null,
      platform_bundle: env.OC_PLATFORM_BUNDLE ?? labels["com.openclaude.runtime.bundle_rev"] ?? null,
    },
  };
}

async function readFileRev(path) {
  const output = await dockerExec(
    `sha256sum ${shellQuote(path)}`,
  );
  return output.split(/\s+/, 1)[0];
}

async function readPromptRev() {
  const output = await dockerExec(
    'test -n "$OPENCLAUDE_PLATFORM_PROMPTS_DIR" && sha256sum "$OPENCLAUDE_PLATFORM_PROMPTS_DIR/platform-capabilities.md"',
  );
  return output.split(/\s+/, 1)[0];
}

let cleanupBrowser = null;
let cleanupSampler = null;
let stopSampling = null;
const attemptStartedAt = Date.now();
try {
const actualProbeRev = (await remote(`sha256sum ${shellQuote(PROBE_PATH)}`)).split(/\s+/, 1)[0];
if (actualProbeRev !== manifest.policy.probe_rev) {
  throw new Error(`remote probe rev ${actualProbeRev} differs from manifest ${manifest.policy.probe_rev}`);
}
const beforeLane = await readLane();
const expectedLane = RULE_INJECTION === "platform-bundle"
  ? manifest.production?.lane
  : manifest.baseline_lane;
if (!expectedLane || JSON.stringify(laneIdentity(beforeLane)) !== JSON.stringify(expectedLane)) {
  throw new Error(`deployment lane differs from manifest: ${JSON.stringify(laneIdentity(beforeLane))}`);
}
const beforeActivity = await readActivity();
if (beforeActivity.parents !== 0) {
  throw new Error(`eval container is not idle before run: ${JSON.stringify(beforeActivity)}`);
}
const containerMeta = await readContainerMeta();
for (const [field, value] of Object.entries(containerMeta.runtime_tuple)) {
  if (typeof value !== "string" || !value) throw new Error(`runtime tuple missing ${field}`);
}
if (
  RULE_INJECTION !== "platform-bundle" &&
  JSON.stringify(containerMeta.runtime_tuple) !== JSON.stringify(manifest.baseline_runtime_tuple)
) {
  throw new Error("isolated A/B runtime tuple differs from frozen baseline manifest");
}
const actualPromptRev = await readPromptRev();
const freshnessBefore = await readFreshness(containerMeta.started_at);
if (PAIR_STEP === 1) {
  const containerAge = Date.now() - Date.parse(containerMeta.started_at);
  if (
    containerMeta.restart_count !== 0 ||
    freshnessBefore.dispatches !== 0 ||
    freshnessBefore.usage_rows !== 0 ||
    !Number.isFinite(containerAge) ||
    containerAge < 0 ||
    containerAge > manifest.max_container_age_before_pair_ms
  ) {
    throw new Error("first pair arm requires a newly reprovisioned turn-clean container");
  }
}
if (actualPromptRev !== PROMPT_REV) {
  throw new Error(`container prompt rev ${actualPromptRev} differs from required ${PROMPT_REV}`);
}
const actualPersonaRev = await readFileRev(PERSONA_PATH);
if (actualPersonaRev !== PERSONA_REV) {
  throw new Error(`container persona rev ${actualPersonaRev} differs from required ${PERSONA_REV}`);
}
if (RULE_INJECTION === "none") {
  if (
    ARM !== "A" ||
    PROMPT_REV !== manifest.policy.baseline_prompt_rev ||
    PERSONA_REV !== expectedPersonaPolicy.base_persona_rev
  ) {
    throw new Error("baseline arm does not match frozen prompt/persona policy");
  }
} else if (RULE_INJECTION === "persona-system-slot") {
  if (
    ARM !== "B" ||
    PROMPT_REV !== manifest.policy.baseline_prompt_rev ||
    PERSONA_REV !== expectedPersonaPolicy.candidate_persona_rev ||
    RULE_REV !== manifest.policy.rule_rev
  ) {
    throw new Error("persona candidate arm does not match frozen policy");
  }
} else {
  const production = manifest.production;
  if (
    ARM !== "B" ||
    !production ||
    PROMPT_REV !== manifest.policy.candidate_prompt_rev ||
    PERSONA_REV !== expectedPersonaPolicy.base_persona_rev ||
    RULE_REV !== manifest.policy.rule_rev
  ) {
    throw new Error("platform-bundle candidate arm does not match frozen policy");
  }
  for (const field of [
    "isolated_manifest_sha256",
    "isolated_report_sha256",
    "baseline_run_set_sha256",
    "isolated_run_set_sha256",
  ]) {
    if (!/^[0-9a-f]{64}$/.test(production[field] ?? "")) {
      throw new Error(`production manifest ${field} is not frozen`);
    }
  }
  const expectedTuple = {
    image: production.candidate_image,
    image_id: production.candidate_image_id,
    runtime_release: production.candidate_runtime_release,
    platform_bundle: production.candidate_bundle_rev,
  };
  if (JSON.stringify(containerMeta.runtime_tuple) !== JSON.stringify(expectedTuple)) {
    throw new Error("platform-bundle runtime tuple differs from production manifest");
  }
}
const beforeSample = await readSample();
const beforeResource = beforeSample.resource;

const password = readFileSync(PASSWORD_FILE, "utf8").trim();
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password, turnstile_token: "x" }),
});
if (!login.ok) throw new Error(`login failed ${login.status}: ${(await login.text()).slice(0, 300)}`);
const loginBody = await login.json();
const token = loginBody.access_token;
const setCookies = login.headers.getSetCookie?.() ?? [login.headers.get("set-cookie")].filter(Boolean);
const refresh = setCookies.map((cookie) => /(?:^|;\s*)oc_rt=([^;]+)/.exec(cookie)?.[1]).find(Boolean);
if (!token || !refresh) throw new Error("login response missing access token or refresh cookie");

const peerId = `eval${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const put = await fetch(`${BASE}/api/sessions/${peerId}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    agentId: "main",
    title: `parallel eval ${SCENARIO} ${ARM}`,
    modelId: MODEL,
    messages: [],
  }),
});
if (!put.ok) throw new Error(`session PUT failed ${put.status}: ${(await put.text()).slice(0, 300)}`);

const browser = await chromium.launch({
  executablePath: resolveBrowserExecutable(),
  headless: true,
});
cleanupBrowser = browser;
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await context.addCookies([{
  name: "oc_rt",
  value: refresh,
  domain: new URL(BASE).hostname,
  path: "/api/auth",
  httpOnly: true,
  secure: BASE.startsWith("https:"),
  sameSite: "Lax",
}]);
const page = await context.newPage();
const frames = [];
let turnText = "";
let sawTurnFinal = false;
let sawTurnFinalAt = null;
let turnError = null;
page.on("websocket", (socket) => {
  socket.on("framesent", ({ payload }) => {
    try {
      frames.push({ at: Date.now(), direction: "sent", payload: JSON.parse(String(payload)) });
    } catch {}
  });
  socket.on("framereceived", ({ payload }) => {
    try {
      const parsed = JSON.parse(String(payload));
      frames.push({ at: Date.now(), direction: "received", payload: parsed });
      if (parsed?.peer?.id === peerId && parsed.type === "outbound.message") {
        for (const block of parsed.blocks ?? []) {
          if (block?.kind === "text" && typeof block.text === "string") turnText += block.text;
        }
        if (parsed.isFinal === true) {
          sawTurnFinal = true;
          sawTurnFinalAt ??= Date.now();
        }
        if (parsed.error) turnError = JSON.stringify(parsed.error);
      }
      if (
        parsed?.peer?.id === peerId &&
        ["outbound.error", "outbound.turn_error", "error"].includes(parsed.type)
      ) {
        turnError = JSON.stringify(parsed);
      }
    } catch {}
  });
});

await page.goto(`${BASE}/s/${peerId}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.getByText("新建会话", { exact: true }).first().waitFor({ state: "visible", timeout: 60_000 });
await page.locator("textarea").first().waitFor({ state: "visible", timeout: 30_000 });
for (const attachment of scenario.attachments) {
  await page.getByRole("button", { name: "更多选项" }).click();
  const item = page.getByText("添加附件");
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 30_000 }),
    item.click(),
  ]);
  await chooser.setFiles(join(FIXTURES, "input", attachment));
  await page.getByRole("button", { name: `移除 ${basename(attachment)}` }).waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

let peakRss = beforeResource.memory_current;
let peakPids = Math.max(beforeResource.pids_current, beforeResource.pids_peak);
let exclusiveTurn = true;
const samples = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    try {
      const { resource, activity } = await readSample();
      peakRss = Math.max(peakRss, resource.memory_current);
      peakPids = Math.max(peakPids, resource.pids_current, resource.pids_peak);
      if (activity.parents > 1) exclusiveTurn = false;
      samples.push({ at: Date.now(), resource, activity });
    } catch (error) {
      exclusiveTurn = false;
      samples.push({ at: Date.now(), error: error.message });
    }
    await new Promise((done) => setTimeout(done, SAMPLE_MS));
  }
})();
cleanupSampler = sampler;
stopSampling = () => {
  sampling = false;
};

const assistantBefore = await page.getByTestId("assistant-row").count();
const input = page.locator("textarea").first();
await input.fill(scenario.prompt);
const send = page.getByRole("button", { name: "发送", exact: true });
const sendDeadline = Date.now() + 60_000;
while (await send.isDisabled()) {
  if (Date.now() >= sendDeadline) throw new Error("send button remained disabled");
  await new Promise((done) => setTimeout(done, 250));
}
const startedAt = Date.now();
await send.click();
let answerText = "";
const deadline = startedAt + TIMEOUT_MS;
for (;;) {
  if (turnError) throw new Error(`turn failed: ${turnError.slice(0, 500)}`);
  if (sawTurnFinal) {
    answerText = turnText.trim();
    // cost/token sideband normally follows the final frame.
    await new Promise((done) => setTimeout(done, 1_000));
    break;
  }
  const rows = page.getByTestId("assistant-row");
  if ((await rows.count()) > assistantBefore) {
    const newest = rows.last();
    const complete =
      (await newest.locator(".caret-blink").count()) === 0 &&
      (await page.getByRole("button", { name: "发送", exact: true }).count()) > 0;
    if (complete) {
      if ((await newest.locator('[role="alert"]').count()) > 0) throw new Error("assistant ended with an error alert");
      answerText = (await newest.locator(".prose").last().textContent())?.trim() ?? "";
      break;
    }
  }
  if (Date.now() >= deadline) throw new Error(`turn did not complete within ${TIMEOUT_MS}ms`);
  await new Promise((done) => setTimeout(done, 500));
}
if (turnText.trim()) answerText = turnText.trim();
const finishedAt = sawTurnFinalAt ?? Date.now();
stopSampling();
await sampler;
const analysis = analyzeFrames(frames, peerId);
function analysisResourceFailure(message) {
  analysis.resourceFailures.push(message);
}
const afterSample = await readSample();
const afterResource = afterSample.resource;
const afterActivity = await readActivity();
const afterLane = await readLane();
const binding = await readBinding(peerId);
const afterContainerMeta = await readContainerMeta();
if (
  afterContainerMeta.id !== containerMeta.id ||
  JSON.stringify(afterContainerMeta.runtime_tuple) !== JSON.stringify(containerMeta.runtime_tuple)
) {
  exclusiveTurn = false;
  analysisResourceFailure("container identity or runtime tuple changed during run");
}
if (binding.docker_id !== containerMeta.id) {
  exclusiveTurn = false;
  analysisResourceFailure("dispatch binding Docker identity differs from sampled container");
}
if (JSON.stringify(laneIdentity(afterLane)) !== JSON.stringify(laneIdentity(beforeLane))) {
  exclusiveTurn = false;
  analysisResourceFailure("deployment lane changed during run");
}
if (afterActivity.parents !== 0) exclusiveTurn = false;
await browser.close();

if (afterResource.cpu_usec < beforeResource.cpu_usec) {
  analysisResourceFailure("container restarted or cgroup CPU counter reset during run");
}
if (afterResource.memory_oom > beforeResource.memory_oom) analysisResourceFailure("cgroup memory oom event");
if (afterResource.memory_oom_kill > beforeResource.memory_oom_kill) analysisResourceFailure("cgroup memory oom_kill event");
if (afterResource.pids_max_events > beforeResource.pids_max_events) analysisResourceFailure("cgroup pids max event");
if (afterContainerMeta.restart_count !== containerMeta.restart_count || afterContainerMeta.oom_killed) {
  analysisResourceFailure("container restart or OOMKilled state changed during run");
}
if (analysis.retries > 0) analysisResourceFailure(`abnormal retry count ${analysis.retries}`);
if (analysis.behavior.delegate_runs_errors > 0) {
  analysisResourceFailure(`${analysis.behavior.delegate_runs_errors} delegate run(s) ended in error`);
}
if (analysis.behavior.delegate_runs_incomplete > 0) {
  analysisResourceFailure(`${analysis.behavior.delegate_runs_incomplete} delegate run(s) incomplete`);
}
if (analysis.sentRouting?.model !== MODEL) {
  throw new Error(`observed model ${analysis.sentRouting?.model ?? "<missing>"} differs from ${MODEL}`);
}
const observedEffort = analysis.sentRouting?.effortLevel ?? null;
if (EXPECTED_EFFORT !== null && observedEffort !== EXPECTED_EFFORT) {
  throw new Error(`observed effort ${observedEffort ?? "<null>"} differs from ${EXPECTED_EFFORT}`);
}
let usage = null;
const usageDeadline = Date.now() + 30_000;
for (;;) {
  usage = await readUsage(peerId);
  if (usage.rows > 0 && usage.pending_rows === 0) break;
  if (Date.now() >= usageDeadline) {
    throw new Error(`usage rows did not settle: ${JSON.stringify(usage)}`);
  }
  await new Promise((done) => setTimeout(done, 500));
}
if (usage.failed_rows > 0) {
  analysisResourceFailure(`usage ledger contains ${usage.failed_rows} failed row(s)`);
}
const rootReceipts = usage.receipts.filter((receipt) => receipt.mode === "chat");
if (
  rootReceipts.length < 1 ||
  rootReceipts.some(
    (receipt) =>
      receipt.model !== MODEL ||
      receipt.authority_kind !== "bridge_signed" ||
      receipt.dispatch_id !== binding.dispatch_id,
  )
) {
  throw new Error(
    `usage ledger root model authority differs from ${MODEL}: ${JSON.stringify(rootReceipts)}`,
  );
}
const delegateReceipts = usage.receipts.filter((receipt) => receipt.mode === "delegate");
if (
  delegateReceipts.some(
    (receipt) =>
      typeof receipt.model !== "string" ||
      !receipt.model ||
      receipt.parent_session_id !== peerId ||
      typeof receipt.delegate_agent_id !== "string" ||
      !receipt.delegate_agent_id,
  )
) {
  throw new Error("usage ledger delegate attribution/model evidence is incomplete");
}
const freshnessAfter = await readFreshness(containerMeta.started_at);
if (
  freshnessAfter.dispatches !== freshnessBefore.dispatches + 1 ||
  freshnessAfter.usage_rows !== freshnessBefore.usage_rows + usage.rows
) {
  throw new Error("unrelated agent dispatch or usage appeared during the run");
}
const rawFramesJson = `${JSON.stringify({
  peer_id: peerId,
  probe_rev: actualProbeRev,
  started_at_ms: startedAt,
  finished_at_ms: finishedAt,
  before_sample: beforeSample,
  after_sample: afterSample,
  before_activity: beforeActivity,
  after_activity: afterActivity,
  before_lane: laneIdentity(beforeLane),
  after_lane: laneIdentity(afterLane),
  binding,
  usage,
  freshness_before: freshnessBefore,
  freshness_after: freshnessAfter,
  container_before: containerMeta,
  container_after: afterContainerMeta,
  frames,
  samples,
}, null, 2)}\n`;
writeFileSync(rawFramesPath, rawFramesJson, { flag: "wx" });
const inputHash = createHash("sha256")
  .update(JSON.stringify({
    scenario: SCENARIO,
    prompt: scenario.prompt,
    attachments: scenario.attachments.map((name) => [
      name,
      createHash("sha256").update(readFileSync(join(FIXTURES, "input", name))).digest("hex"),
    ]),
  }))
  .digest("hex");

const run = {
  schema_version: 1,
  run_id: `${ENGINE}-${SCENARIO}-${PAIR_ID}-${ARM}`,
  pair_id: PAIR_ID,
  pair_execution_id: PAIR_EXECUTION_ID,
  pair_step: PAIR_STEP,
  order: ORDER,
  arm: ARM,
  engine: ENGINE,
  model: MODEL,
  effort: observedEffort,
  scenario: SCENARIO,
  peer_id: peerId,
  manifest_sha256: manifestSha256,
  probe_rev: actualProbeRev,
  input_hash: inputHash,
  prompt_rev: PROMPT_REV,
  persona: {
    path: PERSONA_PATH,
    rev: PERSONA_REV,
    base_rev: PERSONA_BASE_REV,
    rule_injection: RULE_INJECTION,
    rule_rev: RULE_REV,
  },
  started_at: new Date(startedAt).toISOString(),
  finished_at: new Date(finishedAt).toISOString(),
  wall_ms: finishedAt - startedAt,
  answer_text: answerText,
  transcript_path: rawFramesPath,
  transcript_sha256: createHash("sha256").update(rawFramesJson).digest("hex"),
  behavior: analysis.behavior,
  resources: {
    cpu_seconds: afterResource.cpu_usec >= beforeResource.cpu_usec
      ? (afterResource.cpu_usec - beforeResource.cpu_usec) / 1_000_000
      : null,
    peak_rss_bytes: Math.max(peakRss, afterResource.memory_peak),
    sampled_peak_rss_bytes: peakRss,
    lifetime_peak_rss_bytes: afterResource.memory_peak,
    peak_pids: peakPids,
    lifetime_peak_pids: afterResource.pids_peak,
    tokens: usage.tokens,
    cost_credits: usage.cost_credits,
    frame_tokens: analysis.tokens,
    reported_cost_usd: analysis.costUsd,
    usage,
    sample_ms: SAMPLE_MS,
    failures: analysis.resourceFailures,
  },
  gates: { absolute_wall_ms: Number(scenario.absolute_wall_ms) },
  container: {
    ...containerMeta,
    freshness_before: freshnessBefore,
    freshness_after: freshnessAfter,
    binding,
    lane: { before: laneIdentity(beforeLane), after: laneIdentity(afterLane) },
    prompt_rev: PROMPT_REV,
    limits: { memory_bytes: beforeResource.memory_max, pids: beforeResource.pids_max },
    activity: { before: beforeActivity, after: afterActivity },
    observed_parent_active: samples.some((sample) => sample.activity?.parents === 1),
    exclusive_turn: exclusiveTurn,
  },
};
writeFileSync(OUTPUT, `${JSON.stringify(run, null, 2)}\n`, { flag: "wx" });
console.log(OUTPUT);
} catch (error) {
  stopSampling?.();
  try {
    await cleanupSampler;
  } catch {}
  try {
    await cleanupBrowser?.close();
  } catch {}
  writeFileSync(failurePath, `${JSON.stringify({
    schema_version: 1,
    status: "failed",
    run_id: `${ENGINE}-${SCENARIO}-${PAIR_ID}-${ARM}`,
    pair_id: PAIR_ID,
    pair_execution_id: PAIR_EXECUTION_ID,
    pair_step: PAIR_STEP,
    order: ORDER,
    arm: ARM,
    engine: ENGINE,
    model: MODEL,
    scenario: SCENARIO,
    manifest_sha256: manifestSha256,
    attempted_at: new Date(attemptStartedAt).toISOString(),
    failed_at: new Date().toISOString(),
    error: error instanceof Error ? error.message : String(error),
  }, null, 2)}\n`, { flag: "wx" });
  throw error;
}
