#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { analyzeFrames } from "./frame-analysis.mjs";

const POSITIVE_SCENARIOS = new Set(["document_batch", "code_batch"]);
const NEGATIVE_SCENARIOS = new Set(["simple", "dependent"]);
const FATAL_FAILURE =
  /oom|queue[_ -]?(?:timeout|full)|resource gate timeout|abnormal retry|container identity|cgroup cpu counter reset|pids max|too many concurrent delegations|delegate resource pressure|排队.*(?:超时|已满)|已等待.*资源仍紧张|delegate run.*(?:failed|incomplete)|usage ledger.*failed/i;

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sameJson(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

export function parseAnswer(text) {
  const trimmed = String(text ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {}
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1].trim());
    } catch {}
  }
  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("answer has no JSON object");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < trimmed.length; i++) {
    const char = trimmed[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      return JSON.parse(trimmed.slice(start, i + 1));
    }
  }
  throw new Error("answer JSON object is incomplete");
}

export function parseCodeAnswer(text) {
  try {
    const answer = parseAnswer(text);
    if (answer?.functions && typeof answer.functions === "object") return answer;
  } catch {}

  const expected = ["parse_csv", "apply_patch", "dependency_batches"];
  const normalized = String(text ?? "").trim().replace(/\r\n/g, "\n");
  const functions = {};
  let cursor = 0;
  for (const name of expected) {
    const header = `FUNCTION ${name}\n`;
    if (!normalized.startsWith(header, cursor)) {
      throw new Error(`code answer must contain ${header.trim()} in the required order`);
    }
    cursor += header.length;
    const end = normalized.indexOf("\nEND FUNCTION", cursor);
    if (end < 0) throw new Error(`code answer is missing END FUNCTION for ${name}`);
    const source = normalized.slice(cursor, end).trim();
    if (!source) throw new Error(`code answer has empty function source: ${name}`);
    functions[name] = source;
    cursor = end + "\nEND FUNCTION".length;
    if (cursor < normalized.length) {
      if (normalized[cursor] !== "\n") {
        throw new Error(`code answer has invalid separator after ${name}`);
      }
      cursor++;
    }
  }
  if (normalized.slice(cursor).trim()) throw new Error("code answer has unexpected trailing content");
  return { functions };
}

function normalizeFormula(value) {
  return typeof value === "string" ? value.trim().replace(/^=/, "") : value;
}

function normalizeFill(value) {
  if (typeof value !== "string") return value;
  const normalized = value.trim().replace(/^#/, "").toUpperCase();
  return /^[0-9A-F]{6}$/.test(normalized) ? `FF${normalized}` : normalized;
}

function normalizeTableRow(row) {
  if (typeof row === "string") return row;
  if (Array.isArray(row)) return row.map(String).join("|");
  if (row && typeof row === "object") {
    const id = row.id ?? row.row_id ?? row.marker;
    const name = row.item ?? row.name ?? row.label;
    const quantity = row.qty ?? row.quantity ?? row.amount;
    if (id !== undefined && name !== undefined && quantity !== undefined) {
      return [id, name, quantity].map(String).join("|");
    }
  }
  return JSON.stringify(row);
}

function checkDocument(answer, gold) {
  const failures = [];
  const pages = Array.isArray(answer.pages) ? answer.pages : [];
  if (pages.length !== gold.pages.length) failures.push(`pages: expected ${gold.pages.length}, got ${pages.length}`);
  const pageNumbers = pages.map((page) => page?.page);
  if (!sameJson(pageNumbers, gold.pages.map((page) => page.page))) {
    failures.push("pages: missing, duplicated, or out of order");
  }
  for (const expected of gold.pages) {
    const actual = pages.find((page) => page?.page === expected.page);
    if (!actual) continue;
    for (const field of ["orientation", "blank", "marker", "watermark"]) {
      const value = actual[field] ?? (field === "marker" ? "" : undefined);
      if (value !== expected[field]) {
        failures.push(`page ${expected.page} ${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(value)}`);
      }
    }
    const rows = Array.isArray(actual.table_rows) ? actual.table_rows.map(normalizeTableRow) : [];
    if (!sameJson(rows, expected.table_rows)) failures.push(`page ${expected.page} table_rows mismatch`);
  }
  const workbook = answer.workbook ?? {};
  if (!sameJson(workbook.sheets, gold.workbook.sheets)) failures.push("workbook sheet order mismatch");
  for (const sheet of gold.workbook.sheets) {
    if (!sameJson(workbook.merges?.[sheet] ?? [], gold.workbook.merges[sheet] ?? [])) {
      failures.push(`workbook ${sheet} merges mismatch`);
    }
  }
  for (const [sheet, cells] of Object.entries(gold.workbook.cells)) {
    for (const [ref, expected] of Object.entries(cells)) {
      const actual = workbook.cells?.[sheet]?.[ref];
      if (!actual) {
        failures.push(`workbook missing ${sheet}!${ref}`);
        continue;
      }
      for (const [field, value] of Object.entries(expected)) {
        const normalizedActual =
          field === "formula" ? normalizeFormula(actual[field])
            : field === "fill" ? normalizeFill(actual[field])
              : actual[field];
        const normalizedExpected =
          field === "formula" ? normalizeFormula(value)
            : field === "fill" ? normalizeFill(value)
              : value;
        if (!sameJson(normalizedActual, normalizedExpected)) {
          failures.push(
            `workbook ${sheet}!${ref}.${field}: expected ${JSON.stringify(normalizedExpected)}, got ${JSON.stringify(normalizedActual)}`,
          );
        }
      }
    }
  }
  return failures;
}

const CHILD_RUNNER = `
const fs = require("node:fs");
const vm = require("node:vm");
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const expression =
  "(() => { const args = " + JSON.stringify(payload.args) + ";" +
  "const result = (" + payload.source + ")(...args);" +
  "return { result, args }; })()";
const value = vm.runInNewContext(expression, Object.create(null), {
  timeout: 200,
  contextCodeGeneration: { strings: false, wasm: false },
});
process.stdout.write(JSON.stringify(value));
`;
const hiddenTestCache = new Map();
const SANDBOX = Object.freeze({
  prlimit: "/usr/bin/prlimit",
  bwrap: "/usr/bin/bwrap",
  node: realpathSync(process.execPath),
  addressSpaceBytes: 1024 * 1024 * 1024,
  heapMegabytes: 64,
});

export function runHiddenTest(source, args) {
  const cacheKey = JSON.stringify([source, args]);
  if (hiddenTestCache.has(cacheKey)) return structuredClone(hiddenTestCache.get(cacheKey));
  for (const [name, path] of Object.entries({
    prlimit: SANDBOX.prlimit,
    bwrap: SANDBOX.bwrap,
    node: SANDBOX.node,
  })) {
    if (!existsSync(path)) throw new Error(`hidden-code sandbox requires ${name} at ${path}`);
  }
  if (!SANDBOX.node.startsWith("/usr/")) {
    throw new Error(`hidden-code sandbox refuses Node outside the read-only /usr mount: ${SANDBOX.node}`);
  }
  const output = execFileSync(
    SANDBOX.prlimit,
    [
      `--as=${SANDBOX.addressSpaceBytes}:${SANDBOX.addressSpaceBytes}`,
      `--data=${SANDBOX.addressSpaceBytes}:${SANDBOX.addressSpaceBytes}`,
      "--nproc=16:16",
      "--nofile=32:32",
      "--fsize=1048576:1048576",
      "--stack=8388608:8388608",
      "--cpu=1:1",
      "--core=0:0",
      "--",
      SANDBOX.bwrap,
      "--unshare-user",
      "--disable-userns",
      "--unshare-ipc",
      "--unshare-pid",
      "--unshare-net",
      "--unshare-uts",
      "--unshare-cgroup",
      "--die-with-parent",
      "--new-session",
      "--cap-drop", "ALL",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--dev", "/dev",
      "--proc", "/proc",
      "--size", "16777216",
      "--tmpfs", "/tmp",
      "--clearenv",
      "--gid", "65534",
      "--uid", "65534",
      "--chdir", "/tmp",
      SANDBOX.node,
      "--no-warnings",
      "--experimental-permission",
      `--max-old-space-size=${SANDBOX.heapMegabytes}`,
      "--max-semi-space-size=4",
      "-e",
      CHILD_RUNNER,
    ],
    {
      input: JSON.stringify({ source, args }),
      encoding: "utf8",
      env: {},
      timeout: 1_000,
      killSignal: "SIGKILL",
      maxBuffer: 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const result = JSON.parse(output);
  hiddenTestCache.set(cacheKey, result);
  return structuredClone(result);
}

function checkCode(answer, gold) {
  const failures = [];
  for (const [name, tests] of Object.entries(gold.code_hidden_tests)) {
    const source = answer.functions?.[name];
    if (typeof source !== "string") {
      failures.push(`missing function source: ${name}`);
      continue;
    }
    for (const test of tests) {
      try {
        const actual = runHiddenTest(source, structuredClone(test.args));
        if (!sameJson(actual.result, test.expected)) {
          failures.push(
            `${name} hidden test failed: expected ${JSON.stringify(test.expected)}, ` +
            `got ${JSON.stringify(actual.result)}`,
          );
        }
        if (!sameJson(actual.args, test.args)) {
          failures.push(`${name} mutated its input arguments`);
        }
      } catch (error) {
        failures.push(`${name} hidden test failed or timed out: ${error.message}`);
      }
    }
  }
  return failures;
}

export function qualityFailures(run, gold) {
  let answer;
  try {
    answer = run.scenario === "code_batch"
      ? parseCodeAnswer(run.answer_text)
      : parseAnswer(run.answer_text);
  } catch (error) {
    return [error.message];
  }
  if (run.scenario === "document_batch") return checkDocument(answer, gold);
  if (run.scenario === "code_batch") return checkCode(answer, gold);
  if (run.scenario === "simple") {
    return answer.answer === gold.simple.answer ? [] : ["simple answer mismatch"];
  }
  if (run.scenario === "dependent") {
    return sameJson(answer.trace, gold.dependent.trace) ? [] : ["dependent trace mismatch"];
  }
  return [`unknown scenario: ${run.scenario}`];
}

function schemaFailures(run, manifest) {
  const failures = [];
  const finite = (value) => typeof value === "number" && Number.isFinite(value);
  if (run.schema_version !== 1) failures.push("unsupported or missing schema_version");
  if (!["A", "B"].includes(run.arm)) failures.push("invalid arm");
  for (const field of [
    "run_id", "pair_id", "pair_execution_id", "order", "engine", "model", "scenario",
    "input_hash", "prompt_rev", "peer_id", "manifest_sha256",
  ]) {
    if (typeof run[field] !== "string" || !run[field]) failures.push(`missing string field ${field}`);
  }
  if (![1, 2].includes(run.pair_step)) failures.push("pair_step must be 1 or 2");
  if (run.manifest_sha256 !== manifest._sha256) failures.push("run manifest SHA-256 differs from scored manifest");
  if (run.probe_rev !== manifest.policy.probe_rev) failures.push("run probe revision differs from manifest");
  if (!finite(run.wall_ms) || run.wall_ms <= 0) failures.push("wall_ms must be finite and positive");
  for (const field of ["cpu_seconds", "tokens", "peak_rss_bytes", "peak_pids"]) {
    if (!finite(run.resources?.[field]) || run.resources[field] <= 0) {
      failures.push(`resources.${field} must be finite and positive`);
    }
  }
  if (!finite(run.resources?.cost_credits) || run.resources.cost_credits < 0) {
    failures.push("resources.cost_credits must be finite and non-negative");
  }
  if (!finite(run.resources?.frame_tokens) || run.resources.frame_tokens < 0) {
    failures.push("resources.frame_tokens must be finite and non-negative");
  }
  if (!Array.isArray(run.resources?.failures)) failures.push("resources.failures must be an array");
  if (!finite(run.resources?.reported_cost_usd) || run.resources.reported_cost_usd < 0) {
    failures.push("resources.reported_cost_usd must be finite and non-negative");
  }
  for (const field of ["memory_bytes", "pids"]) {
    if (!finite(run.container?.limits?.[field]) || run.container.limits[field] <= 0) {
      failures.push(`container limit ${field} must be finite and positive`);
    }
  }
  for (const field of ["peak_rss_bytes", "peak_pids"]) {
    if (!finite(run.resources?.[field])) failures.push(`missing finite ${field}`);
  }
  if (!Number.isFinite(Date.parse(run.started_at)) || !Number.isFinite(Date.parse(run.finished_at))) {
    failures.push("started_at and finished_at must be valid timestamps");
  } else if (Date.parse(run.finished_at) - Date.parse(run.started_at) !== run.wall_ms) {
    failures.push("wall_ms differs from timestamps");
  }
  if (
    !Number.isFinite(Date.parse(run.container?.created_at)) ||
    !Number.isFinite(Date.parse(run.container?.started_at))
  ) {
    failures.push("container created_at and started_at must be valid timestamps");
  }
  if (!Number.isInteger(run.container?.restart_count) || run.container.restart_count < 0) {
    failures.push("container restart_count must be a non-negative integer");
  }
  for (const phase of ["freshness_before", "freshness_after"]) {
    for (const field of ["dispatches", "usage_rows"]) {
      if (!Number.isInteger(run.container?.[phase]?.[field]) || run.container[phase][field] < 0) {
        failures.push(`container ${phase} ${field} must be a non-negative integer`);
      }
    }
  }
  if (run.prompt_rev !== run.container?.prompt_rev) failures.push("run and container prompt rev differ");
  if (run.persona?.rev == null || run.persona?.base_rev == null) failures.push("missing persona revision evidence");
  if (typeof run.transcript_path !== "string" || !run.transcript_path) failures.push("missing transcript path");
  if (!/^[0-9a-f]{64}$/.test(run.transcript_sha256 ?? "")) failures.push("missing transcript SHA-256");
  for (const field of ["image", "image_id", "runtime_release", "platform_bundle"]) {
    if (typeof run.container?.runtime_tuple?.[field] !== "string" || !run.container.runtime_tuple[field]) {
      failures.push(`runtime tuple missing ${field}`);
    }
  }
  for (const field of ["tokens", "cost_credits", "rows", "child_rows", "failed_rows", "pending_rows"]) {
    if (!finite(run.resources?.usage?.[field]) || run.resources.usage[field] < 0) {
      failures.push(`resources.usage.${field} must be finite and non-negative`);
    }
  }
  const receipts = run.resources?.usage?.receipts;
  if (!Array.isArray(receipts) || receipts.length !== run.resources?.usage?.rows) {
    failures.push("usage receipt count differs from rows");
  } else {
    const ids = new Set();
    let tokens = 0;
    let costCredits = 0;
    let childRows = 0;
    let failedRows = 0;
    let pendingRows = 0;
    for (const receipt of receipts) {
      if (typeof receipt?.id !== "string" || !receipt.id || ids.has(receipt.id)) {
        failures.push("usage receipts contain missing or duplicate id");
      }
      ids.add(receipt?.id);
      if (typeof receipt?.request_id !== "string" || !receipt.request_id) {
        failures.push("usage receipt missing request_id");
      }
      if (typeof receipt?.turn_key !== "string" || !receipt.turn_key) {
        failures.push("usage receipt missing turn_key");
      }
      if (typeof receipt?.model !== "string" || !receipt.model) {
        failures.push("usage receipt missing actual model");
      }
      if (typeof receipt?.authority_kind !== "string" || !receipt.authority_kind) {
        failures.push("usage receipt missing model authority kind");
      }
      if (!finite(receipt?.tokens) || receipt.tokens < 0) failures.push("usage receipt tokens invalid");
      if (!finite(receipt?.cost_credits) || receipt.cost_credits < 0) {
        failures.push("usage receipt cost invalid");
      }
      tokens += Number(receipt?.tokens ?? 0);
      costCredits += Number(receipt?.cost_credits ?? 0);
      if (receipt?.mode === "delegate") childRows++;
      if (receipt?.status === "error") failedRows++;
      else if (receipt?.status !== "success") pendingRows++;
    }
    if (tokens !== run.resources?.usage?.tokens) failures.push("usage receipt token sum mismatch");
    if (costCredits !== run.resources?.usage?.cost_credits) failures.push("usage receipt cost sum mismatch");
    if (childRows !== run.resources?.usage?.child_rows) failures.push("usage receipt child count mismatch");
    if (failedRows !== run.resources?.usage?.failed_rows) failures.push("usage receipt failure count mismatch");
    if (pendingRows !== run.resources?.usage?.pending_rows) failures.push("usage receipt pending count mismatch");
    const roots = receipts.filter((receipt) => receipt?.mode === "chat");
    if (
      roots.length < 1 ||
      roots.some(
        (receipt) =>
          receipt?.model !== run.model ||
          receipt?.authority_kind !== "bridge_signed" ||
          receipt?.dispatch_id !== run.container?.binding?.dispatch_id,
      )
    ) {
      failures.push("usage ledger root actual model/authority differs from requested engine model");
    }
    const delegates = receipts.filter((receipt) => receipt?.mode === "delegate");
    if (
      delegates.some(
        (receipt) =>
          receipt?.parent_session_id !== run.peer_id ||
          typeof receipt?.delegate_agent_id !== "string" ||
          !receipt.delegate_agent_id,
      )
    ) {
      failures.push("usage ledger delegate attribution/model evidence is incomplete");
    }
  }
  if (run.resources?.usage?.user_id !== manifest.targets?.[run.engine]?.user_id) {
    failures.push("usage evidence user differs from manifest target");
  }
  if (run.resources?.usage?.peer_id !== run.peer_id) failures.push("usage evidence peer differs from run");
  if (run.resources?.tokens !== run.resources?.usage?.tokens) failures.push("tokens differ from usage ledger evidence");
  if (run.resources?.cost_credits !== run.resources?.usage?.cost_credits) {
    failures.push("cost credits differ from usage ledger evidence");
  }
  if ((run.resources?.usage?.failed_rows ?? 1) !== 0) failures.push("usage ledger contains failed rows");
  if ((run.resources?.usage?.pending_rows ?? 1) !== 0) failures.push("usage ledger contains pending rows");
  if (!finite(run.resources?.sampled_peak_rss_bytes) || run.resources.sampled_peak_rss_bytes <= 0) {
    failures.push("sampled peak RSS must be finite and positive");
  }
  if (!finite(run.resources?.lifetime_peak_rss_bytes) || run.resources.lifetime_peak_rss_bytes <= 0) {
    failures.push("lifetime peak RSS must be finite and positive");
  }
  if (!finite(run.resources?.lifetime_peak_pids) || run.resources.lifetime_peak_pids <= 0) {
    failures.push("lifetime peak PIDs must be finite and positive");
  }
  if (!finite(run.resources?.sample_ms) || run.resources.sample_ms <= 0) {
    failures.push("sample_ms must be finite and positive");
  }
  return failures;
}

function absoluteResourceFailures(run) {
  const failures = [];
  const resource = run.resources ?? {};
  const limits = run.container?.limits ?? {};
  if (Number.isFinite(limits.memory_bytes) && resource.peak_rss_bytes >= limits.memory_bytes * 0.9) {
    failures.push("peak RSS reached 90% of memory limit");
  }
  if (Number.isFinite(limits.pids) && resource.peak_pids >= limits.pids * 0.9) {
    failures.push("peak PIDs reached 90% of PID limit");
  }
  for (const failure of resource.failures ?? []) {
    if (FATAL_FAILURE.test(String(failure))) failures.push(`fatal resource failure: ${failure}`);
  }
  const absoluteWallMs = run.gates?.absolute_wall_ms;
  if (Number.isFinite(absoluteWallMs) && run.wall_ms > absoluteWallMs) {
    failures.push(`wall time ${run.wall_ms}ms exceeds ${absoluteWallMs}ms`);
  }
  return failures;
}

function behaviorFailures(run) {
  const behavior = run.behavior ?? {};
  const failures = [];
  if (POSITIVE_SCENARIOS.has(run.scenario) && run.arm === "B") {
    if (behavior.delegate_tasks_calls !== 1) {
      failures.push(`candidate must use exactly one delegate_tasks call, got ${behavior.delegate_tasks_calls ?? 0}`);
    }
    if ((behavior.delegate_tasks_errors ?? 0) !== 0) failures.push("candidate delegate_tasks call failed");
    if ((behavior.max_shards ?? 0) < 2 || behavior.max_shards > 4) {
      failures.push(`candidate shard count outside 2-4: ${behavior.max_shards ?? 0}`);
    }
    if ((behavior.max_concurrent_delegates ?? 0) < 2) {
      failures.push("candidate did not prove at least two overlapping delegate runs");
    }
    if (behavior.delegate_runs_started !== behavior.max_shards) {
      failures.push(
        `candidate started ${behavior.delegate_runs_started ?? 0}/${behavior.max_shards ?? 0} delegate runs`,
      );
    }
    if (behavior.delegate_runs_completed !== behavior.max_shards) {
      failures.push(
        `candidate completed ${behavior.delegate_runs_completed ?? 0}/${behavior.max_shards ?? 0} delegate runs`,
      );
    }
    if ((behavior.delegate_runs_errors ?? 0) !== 0 || (behavior.delegate_runs_incomplete ?? 0) !== 0) {
      failures.push("candidate has failed or incomplete delegate runs");
    }
    if ((run.resources?.usage?.child_rows ?? 0) < behavior.max_shards) {
      failures.push("usage ledger does not contain every delegated child");
    }
  }
  if (NEGATIVE_SCENARIOS.has(run.scenario)) {
    if ((behavior.delegate_tasks_calls ?? 0) > 0) failures.push("negative scenario used delegate_tasks fan-out");
    if ((behavior.delegate_task_calls ?? 0) > 1) failures.push("negative scenario used more than one specialist delegation");
  }
  if ((behavior.nested_delegate_calls ?? 0) > 0) failures.push("recursive delegation observed");
  if ((behavior.native_agent_calls ?? 0) > 0) failures.push("native multi-agent tool observed");
  if ((behavior.delegate_tasks_calls ?? 0) > 0 && (behavior.background_bash_fanout ?? 0) > 0) {
    failures.push("delegate_tasks was stacked with background Bash fan-out");
  }
  return failures;
}

function contaminationFailures(run) {
  const failures = [];
  for (const phase of ["before", "after"]) {
    const activity = run.container?.activity?.[phase];
    if (!activity) failures.push(`missing ${phase} activity probe`);
    else if (activity.parents !== 0) failures.push(`${phase} activity probe was not idle`);
  }
  if (run.container?.exclusive_turn !== true) failures.push("container turn exclusivity not proven");
  if (run.container?.observed_parent_active !== true) failures.push("target parent activity was never observed");
  for (const field of ["id", "runtime_tuple", "prompt_rev", "limits"]) {
    if (run.container?.[field] == null) failures.push(`missing container metadata: ${field}`);
  }
  const target = run._expected_target;
  const binding = run.container?.binding;
  if (
    run.container?.freshness_before?.user_id !== target?.user_id ||
    run.container?.freshness_before?.container_started_at !== run.container?.started_at ||
    run.container?.freshness_after?.user_id !== target?.user_id ||
    run.container?.freshness_after?.container_started_at !== run.container?.started_at
  ) {
    failures.push("container freshness identity differs from target container");
  }
  if (
    run.container?.freshness_after?.dispatches !==
      run.container?.freshness_before?.dispatches + 1 ||
    run.container?.freshness_after?.usage_rows !==
      run.container?.freshness_before?.usage_rows + run.resources?.usage?.rows
  ) {
    failures.push("unrelated agent dispatch or usage appeared during the run");
  }
  if (!target || target.container !== run.container?.binding?.docker_name) {
    failures.push("container binding name differs from manifest target");
  }
  if (
    binding?.user_id !== target?.user_id ||
    binding?.dispatch_user_id !== target?.user_id ||
    binding?.peer_id !== run.peer_id ||
    binding?.dispatch_session_id !== run.peer_id ||
    binding?.docker_id !== run.container?.id ||
    binding?.container_internal_id !== run.container?.id ||
    typeof binding?.dispatch_id !== "string" ||
    !binding.dispatch_id
  ) {
    failures.push("peer/dispatch/container binding is not authoritative");
  }
  return failures;
}

function ratio(candidate, baseline) {
  if (baseline === 0) return candidate === 0 ? 1 : Number.POSITIVE_INFINITY;
  return candidate / baseline;
}

function expectedKeys(manifest, mode) {
  const arms = mode === "isolated-ab" ? manifest.arms : ["B"];
  const scenarios = mode === "isolated-ab" ? manifest.scenarios : manifest.production.smoke_scenarios;
  const pairs = mode === "isolated-ab"
    ? manifest.pairs
    : manifest.pairs.filter((pair) => pair.pair_id === manifest.production.smoke_pair_id);
  const keys = new Map();
  for (const [engine, config] of Object.entries(manifest.engines)) {
    for (const scenario of scenarios) {
      for (const pair of pairs) {
        for (const arm of arms) {
          const key = `${engine}/${scenario}/${pair.pair_id}/${arm}`;
          keys.set(key, { engine, config, scenario, pair, arm });
        }
      }
    }
  }
  return keys;
}

function runKey(run) {
  return `${run.engine}/${run.scenario}/${run.pair_id}/${run.arm}`;
}

function validateManifest(manifest, gold, mode) {
  const shaFields = [
    "rule_rev",
    "baseline_prompt_rev",
    "candidate_prompt_rev",
    "probe_rev",
    "reprovision_rev",
  ];
  if (!/^[0-9a-f]{64}$/.test(manifest._sha256 ?? "")) {
    throw new Error("scoreRuns requires manifest._sha256");
  }
  if (!manifest.policy) throw new Error("scoreRuns requires a bound manifest policy");
  if (
    !sameJson(Object.keys(manifest.engines ?? {}), ["ccb", "codex"]) ||
    !sameJson(
      manifest.scenarios,
      ["document_batch", "code_batch", "simple", "dependent"],
    ) ||
    !sameJson(manifest.arms, ["A", "B"]) ||
    !sameJson(manifest.pairs, [
      { pair_id: "01", order: "A_FIRST" },
      { pair_id: "02", order: "B_FIRST" },
      { pair_id: "03", order: "A_FIRST" },
      { pair_id: "04", order: "B_FIRST" },
    ])
  ) {
    throw new Error("manifest does not match the frozen 64-run engine/scenario/pair matrix");
  }
  for (const field of ["generator_rev", "scenarios_rev", "gold_rev"]) {
    if (!/^[0-9a-f]{64}$/.test(manifest.fixture_revs?.[field] ?? "")) {
      throw new Error(`manifest fixture ${field} is not a SHA-256`);
    }
  }
  if (gold?._sha256 !== manifest.fixture_revs.gold_rev) {
    throw new Error("gold revision differs from manifest fixture");
  }
  for (const field of shaFields) {
    if (!/^[0-9a-f]{64}$/.test(manifest.policy[field] ?? "")) {
      throw new Error(`manifest policy ${field} is not a SHA-256`);
    }
  }
  if (!Number.isFinite(manifest.max_pair_gap_ms) || manifest.max_pair_gap_ms <= 0) {
    throw new Error("manifest max_pair_gap_ms must be finite and positive");
  }
  if (
    !Number.isFinite(manifest.max_container_age_before_pair_ms) ||
    manifest.max_container_age_before_pair_ms <= 0
  ) {
    throw new Error("manifest max_container_age_before_pair_ms must be finite and positive");
  }
  const orders = (manifest.pairs ?? []).map((pair) => pair.order);
  if (
    orders.length < 4 ||
    orders.filter((order) => order === "A_FIRST").length !==
      orders.filter((order) => order === "B_FIRST").length
  ) {
    throw new Error("manifest pairs must counterbalance A_FIRST and B_FIRST");
  }
  for (const engine of Object.keys(manifest.engines ?? {})) {
    const target = manifest.targets?.[engine];
    if (
      !Number.isSafeInteger(target?.user_id) ||
      target.user_id <= 0 ||
      !/^oc-v5-u[1-9][0-9]*$/.test(target?.container ?? "")
    ) {
      throw new Error(`manifest target missing for ${engine}`);
    }
    for (const field of ["base_persona_rev", "candidate_persona_rev"]) {
      if (!/^[0-9a-f]{64}$/.test(manifest.policy.personas?.[engine]?.[field] ?? "")) {
        throw new Error(`manifest policy personas.${engine}.${field} is not a SHA-256`);
      }
    }
  }
  if (
    manifest.baseline_lane?.phase !== "stable" ||
    !["A", "B"].includes(manifest.baseline_lane?.active_slot) ||
    manifest.baseline_lane?.candidate_slot !== null ||
    manifest.baseline_lane?.candidate_release !== null ||
    manifest.baseline_lane?.cohort_percent !== 0
  ) {
    throw new Error("manifest baseline lane is not a frozen stable release");
  }
  for (const field of ["image", "image_id", "runtime_release", "platform_bundle"]) {
    if (
      typeof manifest.baseline_runtime_tuple?.[field] !== "string" ||
      !manifest.baseline_runtime_tuple[field]
    ) {
      throw new Error(`manifest baseline runtime tuple missing ${field}`);
    }
  }
  for (const scenario of manifest.scenarios ?? []) {
    if (!Number.isFinite(manifest.absolute_wall_ms?.[scenario]) || manifest.absolute_wall_ms[scenario] <= 0) {
      throw new Error(`manifest absolute wall gate missing for ${scenario}`);
    }
  }
  if (mode === "production-smoke") {
    for (const field of [
      "isolated_manifest_sha256",
      "isolated_report_sha256",
      "baseline_run_set_sha256",
      "isolated_run_set_sha256",
      "replicate_report_sha256",
      "replicate_run_set_sha256",
    ]) {
      if (!/^[0-9a-f]{64}$/.test(manifest.production?.[field] ?? "")) {
        throw new Error(`production manifest ${field} is not frozen`);
      }
    }
    if (
      !sameJson(manifest.production?.smoke_scenarios, ["code_batch", "dependent"]) ||
      typeof manifest.production?.smoke_pair_id !== "string" ||
      manifest.production?.lane?.phase !== "stable" ||
      manifest.production?.lane?.candidate_slot !== null ||
      manifest.production?.lane?.candidate_release !== null ||
      manifest.production?.lane?.cohort_percent !== 0
    ) {
      throw new Error("production smoke manifest is not a frozen post-activation stable lane");
    }
  }
}

export function scoreRuns(runs, gold, { mode = "isolated-ab", manifest } = {}) {
  if (!manifest) throw new Error("scoreRuns requires a preregistered manifest");
  validateManifest(manifest, gold, mode);
  const findings = [];
  const perRun = [];
  const expected = expectedKeys(manifest, mode);
  const actual = new Map();
  const peers = new Map();
  const containerRuns = new Map();
  for (const run of runs) {
    const key = runKey(run);
    if (actual.has(key)) findings.push(`${key}: duplicate run`);
    actual.set(key, run);
    if (!expected.has(key)) findings.push(`${key}: unexpected run`);
    if (typeof run.peer_id === "string") {
      const prior = peers.get(run.peer_id);
      if (prior) findings.push(`${key}: peer_id reused by ${prior}`);
      peers.set(run.peer_id, key);
    }
    if (mode === "isolated-ab" && typeof run.container?.id === "string" && run.container.id) {
      const previous = containerRuns.get(run.container.id);
      if (previous) {
        findings.push(`${key}: container id reused by ${previous}`);
      } else {
        containerRuns.set(run.container.id, key);
      }
    }
  }
  for (const key of expected.keys()) {
    if (!actual.has(key)) findings.push(`${key}: missing preregistered run`);
  }

  for (const [key, run] of actual) {
    const expectedRun = expected.get(key);
    const schema = schemaFailures(run, manifest);
    const quality = qualityFailures(run, gold);
    const behavior = behaviorFailures(run);
    const resources = absoluteResourceFailures(run);
    Object.defineProperty(run, "_expected_target", {
      value: manifest.targets?.[run.engine],
      configurable: true,
    });
    const contamination = contaminationFailures(run);
    const failures = [...schema, ...quality, ...behavior, ...resources, ...contamination];
    if (expectedRun) {
      if (run.model !== expectedRun.config.model || run.effort !== expectedRun.config.effort) {
        failures.push("model or effort differs from manifest");
      }
      if (run.input_hash !== manifest.input_hashes?.[run.scenario]) {
        failures.push("input hash differs from preregistered manifest");
      }
      if (run.order !== expectedRun.pair.order) failures.push("order differs from manifest");
      if (run.gates?.absolute_wall_ms !== manifest.absolute_wall_ms?.[run.scenario]) {
        failures.push("absolute wall gate differs from preregistered manifest");
      }
      const expectedPersona = manifest.policy.personas?.[run.engine];
      if (run.persona?.base_rev !== expectedPersona?.base_persona_rev) {
        failures.push("persona base revision differs from frozen policy");
      }
      const expectedLane = mode === "production-smoke"
        ? manifest.production?.lane
        : manifest.baseline_lane;
      if (
        !sameJson(run.container?.lane?.before, expectedLane) ||
        !sameJson(run.container?.lane?.after, expectedLane)
      ) {
        failures.push("deployment lane evidence differs from manifest");
      }
      if (run.persona?.rule_rev !== (run.arm === "A" ? null : manifest.policy.rule_rev)) {
        failures.push("rule revision differs from frozen policy");
      }
    }
    if (mode === "isolated-ab") {
      if (!sameJson(run.container?.runtime_tuple, manifest.baseline_runtime_tuple)) {
        failures.push("isolated A/B runtime tuple differs from frozen baseline manifest");
      }
      if (
        run.arm === "A" &&
        (
          run.persona?.rule_injection !== "none" ||
          run.persona?.rev !== manifest.policy.personas?.[run.engine]?.base_persona_rev ||
          run.prompt_rev !== manifest.policy.baseline_prompt_rev
        )
      ) {
        failures.push("baseline does not match frozen prompt/persona policy");
      }
      if (
        run.arm === "B" &&
        (
          run.persona?.rule_injection !== "persona-system-slot" ||
          run.persona?.rev !== manifest.policy.personas?.[run.engine]?.candidate_persona_rev ||
          run.prompt_rev !== manifest.policy.baseline_prompt_rev
        )
      ) {
        failures.push("candidate does not match frozen persona system-slot policy");
      }
    } else if (mode === "production-smoke") {
      if (run.arm !== "B") failures.push("production smoke accepts B runs only");
      if (run.pair_step !== 1) failures.push("production smoke B-only run must use pair_step=1");
      if (
        run.persona?.rule_injection !== "platform-bundle" ||
        run.persona?.rev !== manifest.policy.personas?.[run.engine]?.base_persona_rev ||
        run.prompt_rev !== manifest.policy.candidate_prompt_rev
      ) {
        failures.push("production smoke does not match frozen platform-bundle policy");
      }
      const production = manifest.production;
      if (!production) {
        failures.push("manifest lacks frozen production tuple");
      } else {
        const expectedTuple = {
          image: production.candidate_image,
          image_id: production.candidate_image_id,
          runtime_release: production.candidate_runtime_release,
          platform_bundle: production.candidate_bundle_rev,
        };
        if (!sameJson(run.container?.runtime_tuple, expectedTuple)) {
          failures.push("production smoke runtime tuple differs from manifest");
        }
      }
    } else {
      failures.push(`unknown mode: ${mode}`);
    }
    perRun.push({ run_id: run.run_id, arm: run.arm, engine: run.engine, scenario: run.scenario, failures });
    findings.push(...failures.map((failure) => `${run.run_id}: ${failure}`));
  }

  if (mode === "isolated-ab") {
    const pairExecutions = new Map();
    for (const engine of Object.keys(manifest.engines)) {
      for (const scenario of manifest.scenarios) {
        const positivePairs = [];
        const negativePairs = [];
        for (const pair of manifest.pairs) {
          const A = actual.get(`${engine}/${scenario}/${pair.pair_id}/A`);
          const B = actual.get(`${engine}/${scenario}/${pair.pair_id}/B`);
          if (!A || !B) continue;
          for (const field of ["engine", "model", "effort", "input_hash", "prompt_rev"]) {
            if (!sameJson(A[field], B[field])) findings.push(`${engine}/${scenario}/${pair.pair_id}: ${field} differs between arms`);
          }
          for (const field of ["runtime_tuple", "limits"]) {
            if (!sameJson(A.container?.[field], B.container?.[field])) {
              findings.push(`${engine}/${scenario}/${pair.pair_id}: container ${field} differs between arms`);
            }
          }
          if (A.persona?.base_rev !== B.persona?.base_rev) {
            findings.push(`${engine}/${scenario}/${pair.pair_id}: persona base rev differs between arms`);
          }
          const pairLabel = `${engine}/${scenario}/${pair.pair_id}`;
          if (A.container?.id === B.container?.id) {
            findings.push(`${pairLabel}: A/B arms must use different container ids`);
          }
          if (A.pair_execution_id !== B.pair_execution_id) {
            findings.push(`${pairLabel}: arms do not share pair_execution_id`);
          } else {
            const previous = pairExecutions.get(A.pair_execution_id);
            if (previous && previous !== pairLabel) {
              findings.push(`${pairLabel}: pair_execution_id reused by ${previous}`);
            }
            pairExecutions.set(A.pair_execution_id, pairLabel);
          }
          const first = pair.order === "A_FIRST" ? A : B;
          const second = pair.order === "A_FIRST" ? B : A;
          for (const armRun of [A, B]) {
            const containerAge =
              Date.parse(armRun.started_at) - Date.parse(armRun.container?.started_at);
            if (
              !Number.isFinite(containerAge) ||
              containerAge < 0 ||
              containerAge > manifest.max_container_age_before_pair_ms
            ) {
              findings.push(
                `${pairLabel}/${armRun.arm}: container age ${containerAge}ms exceeds fresh-container gate`,
              );
            }
            if (
              armRun.container?.restart_count !== 0 ||
              armRun.container?.freshness_before?.dispatches !== 0 ||
              armRun.container?.freshness_before?.usage_rows !== 0
            ) {
              findings.push(
                `${pairLabel}/${armRun.arm}: arm did not start from a turn-clean fresh container`,
              );
            }
            if (
              armRun.container?.freshness_after?.dispatches !== 1 ||
              armRun.container?.freshness_after?.usage_rows !== armRun.resources?.usage?.rows
            ) {
              findings.push(
                `${pairLabel}/${armRun.arm}: arm freshness did not increase by exactly its own run`,
              );
            }
          }
          if (first.pair_step !== 1 || second.pair_step !== 2) {
            findings.push(`${pairLabel}: pair steps do not match execution order`);
          }
          const gap = Date.parse(second.started_at) - Date.parse(first.finished_at);
          if (!Number.isFinite(gap) || gap < 0) {
            findings.push(`${pairLabel}: declared ${pair.order} was not executed in order`);
          } else if (gap > manifest.max_pair_gap_ms) {
            findings.push(`${pairLabel}: pair gap ${gap}ms exceeds ${manifest.max_pair_gap_ms}ms`);
          }
          if (POSITIVE_SCENARIOS.has(scenario)) positivePairs.push({ A, B });
          if (NEGATIVE_SCENARIOS.has(scenario)) negativePairs.push({ A, B });
        }
        if (NEGATIVE_SCENARIOS.has(scenario) && negativePairs.length > 0) {
          const metrics = [
            ["wall", (run) => run.wall_ms],
            ["cpu_seconds", (run) => run.resources.cpu_seconds],
            ["tokens", (run) => run.resources.tokens],
            ["cost_credits", (run) => run.resources.cost_credits],
          ];
          const jointlyHealthy = negativePairs.filter(({ A, B }) =>
            metrics.every(([, read]) => {
              const value = ratio(read(B), read(A));
              return value != null && value <= 1.10;
            }),
          ).length;
          if (jointlyHealthy < 3) {
            findings.push(
              `${engine}/${scenario}: all quantitative ratios must jointly be <=1.1 in at least ` +
              `3/4 pairs, got ${jointlyHealthy}/4`,
            );
          }
          for (const [name, read] of metrics) {
            const pairRatios = negativePairs.map(({ A, B }) => ({
              pair: A.pair_id,
              value: ratio(read(B), read(A)),
            }));
            const value = median(pairRatios.map((item) => item.value));
            if (value == null || value > 1.10) {
              findings.push(`${engine}/${scenario}: ${name} non-regression ratio must be <=1.1, got ${value}`);
            }
            for (const order of ["A_FIRST", "B_FIRST"]) {
              const stratum = negativePairs.filter(({ A }) => A.order === order);
              const stratified = median(stratum.map(({ A, B }) => ratio(read(B), read(A))));
              if (stratified == null || stratified > 1.10) {
                findings.push(
                  `${engine}/${scenario}/${order}: ${name} non-regression ratio must be <=1.1, ` +
                  `got ${stratified}`,
                );
              }
            }
          }
        }
        if (!POSITIVE_SCENARIOS.has(scenario) || positivePairs.length === 0) continue;
        const metrics = [
          ["wall", (run) => run.wall_ms, 0.85],
          ["cpu_seconds", (run) => run.resources.cpu_seconds, 1.10],
          ["tokens", (run) => run.resources.tokens, 1.10],
          ["cost_credits", (run) => run.resources.cost_credits, 1.10],
        ];
        const jointlyHealthy = positivePairs.filter(({ A, B }) =>
          metrics.every(([, read]) => {
            const value = ratio(read(B), read(A));
            return value != null && value <= 1.10;
          }),
        ).length;
        if (jointlyHealthy < 3) {
          findings.push(
            `${engine}/${scenario}: all quantitative ratios must jointly be <=1.1 in at least ` +
            `3/4 pairs, got ${jointlyHealthy}/4`,
          );
        }
        for (const [name, read, limit] of metrics) {
          const pairRatios = positivePairs.map(({ A, B }) => ({
            pair: A.pair_id,
            value: ratio(read(B), read(A)),
          }));
          if (name === "wall") {
            const improved = pairRatios.filter((item) => item.value != null && item.value <= limit).length;
            if (improved < 3) {
              findings.push(
                `${engine}/${scenario}: wall improvement must reach <=${limit} in at least ` +
                `3/4 pairs, got ${improved}/4`,
              );
            }
          }
          const value = median(pairRatios.map((item) => item.value));
          if (value == null || value > limit) {
            findings.push(`${engine}/${scenario}: ${name} median ratio must be <=${limit}, got ${value}`);
          }
          for (const order of ["A_FIRST", "B_FIRST"]) {
            const stratum = positivePairs.filter(({ A }) => A.order === order);
            const stratified = median(stratum.map(({ A, B }) => ratio(read(B), read(A))));
            if (stratified == null || stratified > limit) {
              findings.push(
                `${engine}/${scenario}/${order}: ${name} median ratio must be <=${limit}, got ${stratified}`,
              );
            }
          }
        }
      }
    }
  } else if (mode === "production-smoke" && manifest.production) {
    for (const engine of Object.keys(manifest.engines)) {
      for (const scenario of ["code_batch"]) {
        const group = [...actual.values()].filter(
          (run) => run.engine === engine && run.scenario === scenario && run.arm === "B",
        );
        const maximum = manifest.production.max_wall_ms?.[engine]?.[scenario];
        const wall = median(group.map((run) => run.wall_ms));
        if (!Number.isFinite(maximum) || maximum <= 0) {
          findings.push(`${engine}/${scenario}: production manifest lacks frozen smoke wall gate`);
        } else if (wall == null || wall > maximum) {
          findings.push(`${engine}/${scenario}: production wall ${wall}ms exceeds frozen ${maximum}ms`);
        }
      }
    }
  }

  return {
    passed: findings.length === 0,
    mode,
    manifest_sha256: manifest._sha256,
    findings,
    per_run: perRun,
  };
}

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) result[argv[i].replace(/^--/, "")] = argv[i + 1];
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.runs || !args.gold || !args.manifest) {
    console.error(
      "usage: score.mjs --runs <dir> --gold <gold.json> --manifest <manifest.json> " +
      "[--mode isolated-ab|production-smoke] [--out report.json]",
    );
    process.exit(2);
  }
  const runs = readdirSync(args.runs)
    .filter((name) => name.endsWith(".json") && !name.endsWith(".frames.json") && !name.endsWith(".failed.json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(resolve(args.runs, name), "utf8")));
  const failures = readdirSync(args.runs).filter((name) => name.endsWith(".failed.json"));
  const goldBytes = readFileSync(args.gold);
  const gold = JSON.parse(goldBytes);
  Object.defineProperty(gold, "_sha256", {
    value: createHash("sha256").update(goldBytes).digest("hex"),
  });
  const manifestBytes = readFileSync(args.manifest);
  const manifest = JSON.parse(manifestBytes);
  manifest._sha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const report = scoreRuns(runs, gold, { mode: args.mode ?? "isolated-ab", manifest });
  for (const run of runs) {
    try {
      const transcript = readFileSync(run.transcript_path);
      const actual = createHash("sha256").update(transcript).digest("hex");
      if (actual !== run.transcript_sha256) report.findings.push(`${run.run_id}: transcript SHA-256 mismatch`);
      const evidence = JSON.parse(transcript);
      if (evidence.peer_id !== run.peer_id) report.findings.push(`${run.run_id}: transcript peer_id mismatch`);
      if (evidence.probe_rev !== run.probe_rev) report.findings.push(`${run.run_id}: transcript probe revision mismatch`);
      const transcriptWallMs = evidence.finished_at_ms - evidence.started_at_ms;
      if (
        !Number.isFinite(evidence.started_at_ms) ||
        !Number.isFinite(evidence.finished_at_ms) ||
        transcriptWallMs !== run.wall_ms ||
        new Date(evidence.started_at_ms).toISOString() !== run.started_at ||
        new Date(evidence.finished_at_ms).toISOString() !== run.finished_at
      ) {
        report.findings.push(`${run.run_id}: wall time differs from transcript timestamps`);
      }
      for (const [label, actualValue, expectedValue] of [
        ["usage", run.resources?.usage, evidence.usage],
        ["binding", run.container?.binding, evidence.binding],
        ["freshness before", run.container?.freshness_before, evidence.freshness_before],
        ["freshness after", run.container?.freshness_after, evidence.freshness_after],
        ["before activity", run.container?.activity?.before, evidence.before_activity],
        ["after activity", run.container?.activity?.after, evidence.after_activity],
        ["before lane", run.container?.lane?.before, evidence.before_lane],
        ["after lane", run.container?.lane?.after, evidence.after_lane],
      ]) {
        if (!sameJson(actualValue, expectedValue)) {
          report.findings.push(`${run.run_id}: ${label} differs from transcript probe evidence`);
        }
      }
      for (const field of ["id", "created_at", "started_at", "restart_count", "oom_killed", "runtime_tuple"]) {
        if (!sameJson(run.container?.[field], evidence.container_before?.[field])) {
          report.findings.push(`${run.run_id}: container ${field} differs from transcript inspect`);
        }
      }
      if (!Array.isArray(evidence.frames) || !Array.isArray(evidence.samples)) {
        report.findings.push(`${run.run_id}: transcript lacks frames or samples`);
      } else {
        const recomputed = analyzeFrames(evidence.frames, run.peer_id);
        if (!sameJson(recomputed.behavior, run.behavior)) {
          report.findings.push(`${run.run_id}: behavior differs from canonical frame analysis`);
        }
        if (recomputed.answerText !== run.answer_text) {
          report.findings.push(`${run.run_id}: answer text differs from canonical frame transcript`);
        }
        if (recomputed.tokens !== run.resources?.frame_tokens) {
          report.findings.push(`${run.run_id}: frame token evidence differs from canonical frame analysis`);
        }
        if (recomputed.sentRouting?.model !== run.model) {
          report.findings.push(`${run.run_id}: frame routing model differs from run`);
        }
        if ((recomputed.sentRouting?.effortLevel ?? null) !== (run.effort ?? null)) {
          report.findings.push(`${run.run_id}: frame routing effort differs from run`);
        }
        if (recomputed.costUsd !== run.resources?.reported_cost_usd) {
          report.findings.push(`${run.run_id}: reported cost differs from canonical frame analysis`);
        }
        const beforeResource = evidence.before_sample?.resource;
        const afterResource = evidence.after_sample?.resource;
        if (
          !beforeResource ||
          !afterResource ||
          !Number.isFinite(beforeResource.cpu_usec) ||
          !Number.isFinite(afterResource.cpu_usec)
        ) {
          report.findings.push(`${run.run_id}: before/after cgroup counters are incomplete`);
        } else {
          const cpuSeconds = afterResource.cpu_usec >= beforeResource.cpu_usec
            ? (afterResource.cpu_usec - beforeResource.cpu_usec) / 1_000_000
            : null;
          if (cpuSeconds !== run.resources?.cpu_seconds) {
            report.findings.push(`${run.run_id}: CPU seconds differ from transcript counters`);
          }
          if (
            beforeResource.memory_max !== run.container?.limits?.memory_bytes ||
            beforeResource.pids_max !== run.container?.limits?.pids
          ) {
            report.findings.push(`${run.run_id}: container limits differ from transcript cgroup`);
          }
        }
        const allSamples = [
          evidence.before_sample,
          ...evidence.samples.map((sample) => ({
            resource: sample.resource,
            activity: sample.activity,
          })),
          evidence.after_sample,
        ];
        if (
          allSamples.some(
            (sample) =>
              !sample?.resource ||
              !Number.isFinite(sample.resource.memory_current) ||
              !Number.isFinite(sample.resource.pids_current) ||
              !Number.isFinite(sample.resource.pids_peak) ||
              !Number.isInteger(sample.activity?.parents),
          )
        ) {
          report.findings.push(`${run.run_id}: resource sample evidence is incomplete`);
        } else {
          const sampledPeakRss = Math.max(...allSamples.map((sample) => sample.resource.memory_current));
          const peakPids = Math.max(
            ...allSamples.flatMap((sample) => [
              sample.resource.pids_current,
              sample.resource.pids_peak,
            ]),
          );
          if (sampledPeakRss !== run.resources?.sampled_peak_rss_bytes) {
            report.findings.push(`${run.run_id}: sampled RSS peak differs from transcript`);
          }
          const peakRss = Math.max(sampledPeakRss, evidence.after_sample.resource.memory_peak);
          if (
            peakRss !== run.resources?.peak_rss_bytes ||
            evidence.after_sample.resource.memory_peak !== run.resources?.lifetime_peak_rss_bytes
          ) {
            report.findings.push(`${run.run_id}: RSS lifetime peak differs from cgroup transcript`);
          }
          if (peakPids !== run.resources?.peak_pids) {
            report.findings.push(`${run.run_id}: PID peak differs from cgroup transcript`);
          }
          if (evidence.after_sample.resource.pids_peak !== run.resources?.lifetime_peak_pids) {
            report.findings.push(`${run.run_id}: PID lifetime peak differs from cgroup transcript`);
          }
          if (!allSamples.some((sample) => sample.activity.parents === 1)) {
            report.findings.push(`${run.run_id}: samples never observed the target parent active`);
          }
          if (allSamples.some((sample) => sample.activity.parents > 1)) {
            report.findings.push(`${run.run_id}: samples observed competing parent activity`);
          }
        }
        if (evidence.samples.length === 0) {
          report.findings.push(`${run.run_id}: no in-turn resource samples`);
        } else {
          for (let index = 1; index < evidence.samples.length; index++) {
            const gap = evidence.samples[index].at - evidence.samples[index - 1].at;
            if (!Number.isFinite(gap) || gap > Math.max(5_000, run.resources.sample_ms * 8)) {
              report.findings.push(`${run.run_id}: resource sampling gap ${gap}ms is too large`);
              break;
            }
          }
          if (evidence.samples.some((sample) => sample.error)) {
            report.findings.push(`${run.run_id}: resource sampler recorded an error`);
          }
        }
        if (
          evidence.usage &&
          evidence.container_before &&
          evidence.container_after &&
          evidence.before_lane &&
          evidence.after_lane &&
          evidence.binding
        ) {
          const derivedFailures = [...recomputed.resourceFailures];
          if (
            evidence.container_after.id !== evidence.container_before.id ||
            !sameJson(
              evidence.container_after.runtime_tuple,
              evidence.container_before.runtime_tuple,
            )
          ) {
            derivedFailures.push("container identity or runtime tuple changed during run");
          }
          if (evidence.binding.docker_id !== evidence.container_before.id) {
            derivedFailures.push("dispatch binding Docker identity differs from sampled container");
          }
          if (!sameJson(evidence.after_lane, evidence.before_lane)) {
            derivedFailures.push("deployment lane changed during run");
          }
          if (evidence.after_sample.resource.cpu_usec < evidence.before_sample.resource.cpu_usec) {
            derivedFailures.push("container restarted or cgroup CPU counter reset during run");
          }
          if (evidence.after_sample.resource.memory_oom > evidence.before_sample.resource.memory_oom) {
            derivedFailures.push("cgroup memory oom event");
          }
          if (
            evidence.after_sample.resource.memory_oom_kill >
            evidence.before_sample.resource.memory_oom_kill
          ) {
            derivedFailures.push("cgroup memory oom_kill event");
          }
          if (
            evidence.after_sample.resource.pids_max_events >
            evidence.before_sample.resource.pids_max_events
          ) {
            derivedFailures.push("cgroup pids max event");
          }
          if (
            evidence.container_after.restart_count !== evidence.container_before.restart_count ||
            evidence.container_after.oom_killed
          ) {
            derivedFailures.push("container restart or OOMKilled state changed during run");
          }
          if (recomputed.retries > 0) {
            derivedFailures.push(`abnormal retry count ${recomputed.retries}`);
          }
          if (recomputed.behavior.delegate_runs_errors > 0) {
            derivedFailures.push(
              `${recomputed.behavior.delegate_runs_errors} delegate run(s) ended in error`,
            );
          }
          if (recomputed.behavior.delegate_runs_incomplete > 0) {
            derivedFailures.push(
              `${recomputed.behavior.delegate_runs_incomplete} delegate run(s) incomplete`,
            );
          }
          if (evidence.usage.failed_rows > 0) {
            derivedFailures.push(
              `usage ledger contains ${evidence.usage.failed_rows} failed row(s)`,
            );
          }
          if (!sameJson(derivedFailures, run.resources?.failures)) {
            report.findings.push(`${run.run_id}: resource failures differ from transcript evidence`);
          }
        } else {
          report.findings.push(`${run.run_id}: transcript lacks resource derivation evidence`);
        }
      }
    } catch (error) {
      report.findings.push(`${run.run_id}: transcript unreadable: ${error.message}`);
    }
  }
  report.findings.push(...failures.map((name) => `failed attempt evidence present: ${name}`));
  report.passed = report.findings.length === 0;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (args.out) writeFileSync(args.out, serialized);
  process.stdout.write(serialized);
  process.exit(report.passed ? 0 : 1);
}
