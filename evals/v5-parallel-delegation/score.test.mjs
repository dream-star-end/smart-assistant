import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCodeAnswer, runHiddenTest, scoreRuns } from "./score.mjs";

const gold = {
  pages: [
    { page: 1, orientation: 0, blank: false, marker: "P1", watermark: "W1", table_rows: [] },
    { page: 2, orientation: 90, blank: false, marker: "P2", watermark: "W2", table_rows: ["R2"] },
  ],
  workbook: {
    sheets: ["摘要", "数据"],
    merges: { 摘要: ["A1:C1"], 数据: [] },
    cells: {
      摘要: {
        A1: { value: "季度汇总", bold: true, fill: "FFD9EAF7" },
        C2: { formula: "B2*1.13" },
      },
    },
  },
  code_hidden_tests: {
    normalize_slug: [{ args: [" Hi, WORLD "], expected: "hi-world" }],
    stable_dedupe: [{ args: [[3, 1, 3]], expected: [3, 1] }],
    group_totals: [{
      args: [[{ group: "a", amount: 2 }, { group: "a", amount: 3 }]],
      expected: { a: 5 },
    }],
  },
  simple: { answer: 703 },
  dependent: { trace: [3, 8, 16, 12, 144, 8, 19] },
};
const goldRev = createHash("sha256").update(JSON.stringify(gold)).digest("hex");
Object.defineProperty(gold, "_sha256", { value: goldRev });

const answers = {
  document_batch: JSON.stringify({ pages: gold.pages, workbook: gold.workbook }),
  code_batch: JSON.stringify({
    functions: {
      normalize_slug: "(value) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')",
      stable_dedupe: "(values) => [...new Set(values)]",
      group_totals: "(rows) => rows.reduce((out, row) => ({...out, [row.group]: (out[row.group] || 0) + row.amount}), {})",
    },
  }),
  simple: JSON.stringify(gold.simple),
  dependent: JSON.stringify(gold.dependent),
};

describe("code answer parser", () => {
  it("accepts exact marker blocks without JSON escaping function source", () => {
    const answer = parseCodeAnswer([
      "FUNCTION parse_csv",
      "(text) => text.includes('\"') ? [['quoted']] : []",
      "END FUNCTION",
      "FUNCTION apply_patch",
      "(document) => ({...document})",
      "END FUNCTION",
      "FUNCTION dependency_batches",
      "(tasks) => [tasks.map((task) => task.id)]",
      "END FUNCTION",
    ].join("\n"));
    assert.equal(answer.functions.parse_csv, "(text) => text.includes('\"') ? [['quoted']] : []");
    assert.equal(Object.keys(answer.functions).length, 3);
  });

  it("does not expose host constructors or require to hidden-test code", () => {
    assert.throws(
      () => runHiddenTest(
        "(value) => value.constructor.constructor('return process.env.HOME')()",
        [{}],
      ),
      /Command failed/,
    );
  });

  it("runs hidden code without host globals and contains a memory bomb", () => {
    assert.deepEqual(
      runHiddenTest(
        "() => ({ process: typeof process, require: typeof require, fetch: typeof fetch })",
        [],
      ).result,
      { process: "undefined", require: "undefined", fetch: "undefined" },
    );
    const started = Date.now();
    assert.throws(() =>
      runHiddenTest("() => new ArrayBuffer(2 * 1024 * 1024 * 1024)", []),
    );
    assert.ok(Date.now() - started < 5_000, "memory bomb must fail promptly inside the sandbox");
    assert.deepEqual(
      runHiddenTest("(value) => value + 1", [41]),
      { result: 42, args: [41] },
      "sandbox must remain healthy after containing external-memory allocation",
    );
  });

  it("rejects missing, reordered, or trailing marker blocks", () => {
    assert.throws(
      () => parseCodeAnswer("FUNCTION apply_patch\n(x) => x\nEND FUNCTION"),
      /FUNCTION parse_csv/,
    );
    assert.throws(
      () => parseCodeAnswer([
        "FUNCTION parse_csv",
        "(x) => x",
        "END FUNCTION",
        "FUNCTION apply_patch",
        "(x) => x",
        "END FUNCTION",
        "FUNCTION dependency_batches",
        "(x) => x",
        "END FUNCTION",
        "extra",
      ].join("\n")),
      /unexpected trailing content/,
    );
  });
});

const manifest = {
  schema_version: 1,
  _sha256: "f".repeat(64),
  fixture_revs: {
    generator_rev: "6".repeat(64),
    scenarios_rev: "7".repeat(64),
    gold_rev: goldRev,
  },
  engines: {
    ccb: { model: "ccb-test", effort: "high" },
    codex: { model: "gpt-test", effort: "high" },
  },
  scenarios: ["document_batch", "code_batch", "simple", "dependent"],
  absolute_wall_ms: {
    document_batch: 2000,
    code_batch: 2000,
    simple: 2000,
    dependent: 2000,
  },
  input_hashes: {
    document_batch: "input-document_batch",
    code_batch: "input-code_batch",
    simple: "input-simple",
    dependent: "input-dependent",
  },
  pairs: [
    { pair_id: "01", order: "A_FIRST" },
    { pair_id: "02", order: "B_FIRST" },
    { pair_id: "03", order: "A_FIRST" },
    { pair_id: "04", order: "B_FIRST" },
  ],
  max_pair_gap_ms: 120000,
  max_container_age_before_pair_ms: 300000,
  arms: ["A", "B"],
  policy: {
    rule_rev: "c".repeat(64),
    baseline_prompt_rev: "d".repeat(64),
    candidate_prompt_rev: "e".repeat(64),
    probe_rev: "9".repeat(64),
    personas: {
      ccb: {
        base_persona_rev: "a".repeat(64),
        candidate_persona_rev: "b".repeat(64),
      },
      codex: {
        base_persona_rev: "1".repeat(64),
        candidate_persona_rev: "2".repeat(64),
      },
    },
  },
  targets: {
    ccb: { user_id: 1, container: "oc-v5-u1" },
    codex: { user_id: 2, container: "oc-v5-u2" },
  },
  baseline_lane: {
    phase: "stable",
    generation: "70",
    active_slot: "A",
    active_release: "baseline-release",
    candidate_slot: null,
    candidate_release: null,
    cohort_percent: 0,
  },
  baseline_runtime_tuple: {
    image: "image",
    image_id: "image-id",
    runtime_release: "release",
    platform_bundle: "bundle",
  },
  production: {
    candidate_image: "image",
    candidate_image_id: "image-id",
    candidate_runtime_release: "release",
    candidate_bundle_rev: "bundle",
    isolated_manifest_sha256: "1".repeat(64),
    isolated_report_sha256: "2".repeat(64),
    baseline_run_set_sha256: "3".repeat(64),
    isolated_run_set_sha256: "4".repeat(64),
    replicate_report_sha256: "5".repeat(64),
    replicate_run_set_sha256: "6".repeat(64),
    lane: {
      phase: "stable",
      generation: "71",
      active_slot: "B",
      active_release: "candidate-release",
      candidate_slot: null,
      candidate_release: null,
      cohort_percent: 0,
    },
    smoke_scenarios: ["code_batch", "dependent"],
    smoke_pair_id: "01",
    max_wall_ms: {
      ccb: { code_batch: 850 },
      codex: { code_batch: 850 },
    },
  },
};

function makeRun({
  engine,
  scenario,
  pair,
  arm,
  order,
  wall = arm === "A" ? 1000 : 800,
}) {
  const aFirst = order === "A_FIRST";
  const armFirst = (arm === "A") === aFirst;
  const started = Date.parse("2026-07-28T00:00:00.000Z") + (armFirst ? 0 : 20_000);
  const positiveCandidate = arm === "B" && ["document_batch", "code_batch"].includes(scenario);
  const positiveScenario = ["document_batch", "code_batch"].includes(scenario);
  const userId = engine === "ccb" ? 1 : 2;
  const personaPolicy = manifest.policy.personas[engine];
  const containerName = `oc-v5-u${userId}`;
  const tokens = arm === "A" ? 1000 : 1050;
  const costCredits = arm === "A" ? 1 : 1.05;
  const receipts = positiveCandidate
    ? [
        {
          id: `${engine}-${scenario}-${pair}-${arm}-root`,
          request_id: "root-request",
          turn_key: "turn",
          parent_turn_key: null,
          parent_session_id: null,
          delegate_agent_id: null,
          dispatch_id: `${engine}-${scenario}-${pair}-${arm}-dispatch`,
          mode: "chat",
          model: engine === "codex" ? "gpt-test" : "ccb-test",
          authority_kind: "bridge_signed",
          status: "success",
          tokens: tokens - 3,
          cost_credits: costCredits,
        },
        ...[1, 2, 3].map((index) => ({
          id: `${engine}-${scenario}-${pair}-${arm}-child-${index}`,
          request_id: `child-request-${index}`,
          turn_key: `child-turn-${index}`,
          parent_turn_key: "turn",
          parent_session_id: `${engine}-${scenario}-${pair}-${arm}-peer`,
          delegate_agent_id: `delegate-${index}`,
          dispatch_id: null,
          mode: "delegate",
          model: `specialist-${index}`,
          authority_kind: "local_catalog",
          status: "success",
          tokens: 1,
          cost_credits: 0,
        })),
      ]
    : [{
        id: `${engine}-${scenario}-${pair}-${arm}-root`,
        request_id: "root-request",
        turn_key: "turn",
        parent_turn_key: null,
        parent_session_id: null,
        delegate_agent_id: null,
        dispatch_id: `${engine}-${scenario}-${pair}-${arm}-dispatch`,
        mode: "chat",
        model: engine === "codex" ? "gpt-test" : "ccb-test",
        authority_kind: "bridge_signed",
        status: "success",
        tokens,
        cost_credits: costCredits,
      }];
  return {
    schema_version: 1,
    run_id: `${engine}-${scenario}-${pair}-${arm}`,
    pair_id: pair,
    pair_execution_id: `${engine}-${scenario}-${pair}-execution`,
    pair_step: armFirst ? 1 : 2,
    order,
    arm,
    engine,
    model: engine === "codex" ? "gpt-test" : "ccb-test",
    effort: "high",
    scenario,
    peer_id: `${engine}-${scenario}-${pair}-${arm}-peer`,
    manifest_sha256: manifest._sha256,
    probe_rev: manifest.policy.probe_rev,
    input_hash: `input-${scenario}`,
    prompt_rev: manifest.policy.baseline_prompt_rev,
    started_at: new Date(started).toISOString(),
    finished_at: new Date(started + wall).toISOString(),
    wall_ms: wall,
    transcript_path: "/unused/unit-test.frames.json",
    transcript_sha256: "a".repeat(64),
    answer_text: answers[scenario],
    behavior: {
      delegate_tasks_calls: positiveCandidate ? 1 : 0,
      delegate_task_calls: 0,
      delegate_tasks_errors: 0,
      max_shards: positiveCandidate ? 3 : 0,
      max_concurrent_delegates: positiveCandidate ? 3 : 0,
      delegate_runs_started: positiveCandidate ? 3 : 0,
      delegate_runs_queued: 0,
      delegate_runs_completed: positiveCandidate ? 3 : 0,
      delegate_runs_errors: 0,
      delegate_runs_incomplete: 0,
      nested_delegate_calls: 0,
      background_bash_fanout: 0,
      native_agent_calls: 0,
    },
    resources: {
      cpu_seconds: arm === "A" ? 100 : 105,
      peak_rss_bytes: 400,
      peak_pids: 40,
      tokens,
      cost_credits: costCredits,
      frame_tokens: tokens,
      reported_cost_usd: costCredits,
      sampled_peak_rss_bytes: 400,
      lifetime_peak_rss_bytes: 400,
      lifetime_peak_pids: 40,
      sample_ms: 500,
      usage: {
        user_id: userId,
        peer_id: `${engine}-${scenario}-${pair}-${arm}-peer`,
        tokens,
        cost_credits: costCredits,
        rows: positiveCandidate ? 4 : 1,
        child_rows: positiveCandidate ? 3 : 0,
        failed_rows: 0,
        pending_rows: 0,
        receipts,
      },
      failures: [],
    },
    gates: { absolute_wall_ms: 2000 },
    container: {
      id: `${engine}-${scenario}-${pair}-container`,
      created_at: new Date(Date.parse("2026-07-27T23:58:00.000Z")).toISOString(),
      started_at: new Date(Date.parse("2026-07-27T23:59:00.000Z")).toISOString(),
      restart_count: 0,
      oom_killed: false,
      freshness_before: {
        user_id: userId,
        container_started_at: new Date(Date.parse("2026-07-27T23:59:00.000Z")).toISOString(),
        dispatches: armFirst ? 0 : 1,
        usage_rows: armFirst ? 0 : (positiveScenario && !aFirst ? 4 : 1),
      },
      freshness_after: {
        user_id: userId,
        container_started_at: new Date(Date.parse("2026-07-27T23:59:00.000Z")).toISOString(),
        dispatches: (armFirst ? 0 : 1) + 1,
        usage_rows:
          (armFirst ? 0 : (positiveScenario && !aFirst ? 4 : 1)) +
          (positiveCandidate ? 4 : 1),
      },
      runtime_tuple: {
        image: "image",
        image_id: "image-id",
        runtime_release: "release",
        platform_bundle: "bundle",
      },
      prompt_rev: manifest.policy.baseline_prompt_rev,
      limits: { memory_bytes: 1000, pids: 100 },
      activity: {
        before: { parents: 0, delegates: 0, queued: 0 },
        after: { parents: 0, delegates: 0, queued: 0 },
      },
      binding: {
        user_id: userId,
        peer_id: `${engine}-${scenario}-${pair}-${arm}-peer`,
        dispatch_id: `${engine}-${scenario}-${pair}-${arm}-dispatch`,
        dispatch_user_id: userId,
        dispatch_session_id: `${engine}-${scenario}-${pair}-${arm}-peer`,
        agent_container_id: "row",
        container_internal_id: `${engine}-${scenario}-${pair}-container`,
        docker_id: `${engine}-${scenario}-${pair}-container`,
        docker_name: containerName,
      },
      lane: { before: structuredClone(manifest.baseline_lane), after: structuredClone(manifest.baseline_lane) },
      observed_parent_active: true,
      exclusive_turn: true,
    },
    persona: {
      path: "/persona",
      rev: arm === "A" ? personaPolicy.base_persona_rev : personaPolicy.candidate_persona_rev,
      base_rev: personaPolicy.base_persona_rev,
      rule_injection: arm === "A" ? "none" : "persona-system-slot",
      rule_rev: arm === "A" ? null : manifest.policy.rule_rev,
    },
  };
}

function passingRuns() {
  const runs = [];
  for (const engine of ["ccb", "codex"]) {
    for (const scenario of ["document_batch", "code_batch", "simple", "dependent"]) {
      for (let pair = 1; pair <= 4; pair++) {
        const order = pair % 2 ? "A_FIRST" : "B_FIRST";
        const pairId = String(pair).padStart(2, "0");
        runs.push(makeRun({ engine, scenario, pair: pairId, arm: "A", order }));
        runs.push(makeRun({ engine, scenario, pair: pairId, arm: "B", order }));
      }
    }
  }
  return runs;
}

function productionRuns() {
  return passingRuns().filter(
    (run) =>
      run.arm === "B" &&
      run.pair_id === manifest.production.smoke_pair_id &&
      manifest.production.smoke_scenarios.includes(run.scenario),
  ).map((run) => ({
    ...run,
    pair_step: 1,
    container: {
      ...run.container,
      freshness_before: {
        ...run.container.freshness_before,
        dispatches: 0,
        usage_rows: 0,
      },
      freshness_after: {
        ...run.container.freshness_after,
        dispatches: 1,
        usage_rows: run.resources.usage.rows,
      },
    },
  }));
}

describe("v5 parallel delegation release scorer", () => {
  it("passes interleaved dual-engine runs with exact quality and bounded resources", () => {
    const report = scoreRuns(passingRuns(), gold, { manifest });
    assert.equal(report.passed, true, report.findings.join("\n"));
  });

  it("fails a candidate with missing document pages even when it is faster", () => {
    const runs = passingRuns();
    const run = runs.find((item) => item.arm === "B" && item.scenario === "document_batch");
    run.answer_text = JSON.stringify({ pages: gold.pages.slice(0, 1), workbook: gold.workbook });
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("missing, duplicated, or out of order")));
  });

  it("fails code that returns the expected value by mutating its input", () => {
    const runs = passingRuns();
    const candidate = runs.find(
      (run) => run.engine === "ccb" && run.scenario === "code_batch" && run.arm === "B",
    );
    const answer = JSON.parse(candidate.answer_text);
    answer.functions.stable_dedupe =
      "(values) => { values.splice(0, values.length, ...new Set(values)); return values; }";
    candidate.answer_text = JSON.stringify(answer);
    const result = scoreRuns(runs, gold, { manifest });
    assert.equal(result.passed, false);
    assert.ok(result.findings.some((finding) => finding.includes("mutated its input arguments")));
  });

  it("fails mechanical fan-out on a simple task and recursive delegation", () => {
    const runs = passingRuns();
    const run = runs.find((item) => item.arm === "B" && item.scenario === "simple");
    run.behavior.delegate_tasks_calls = 1;
    run.behavior.nested_delegate_calls = 1;
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("negative scenario used delegate_tasks")));
    assert.ok(report.findings.some((finding) => finding.includes("recursive delegation")));
  });

  it("fails a candidate that is not at least 15% faster", () => {
    const runs = passingRuns();
    for (const run of runs) {
      if (run.arm === "B" && ["document_batch", "code_batch"].includes(run.scenario)) run.wall_ms = 900;
    }
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("wall median ratio")));
  });

  it("fails latency regression on a task that should remain single-agent", () => {
    const runs = passingRuns();
    runs.find(
      (run) =>
        run.engine === "ccb" &&
        run.scenario === "simple" &&
        run.pair_id === "01" &&
        run.arm === "B",
    ).wall_ms = 1500;
    const changed = runs.find(
      (run) =>
        run.engine === "ccb" &&
        run.scenario === "simple" &&
        run.pair_id === "01" &&
        run.arm === "B",
    );
    changed.finished_at = new Date(Date.parse(changed.started_at) + changed.wall_ms).toISOString();
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("wall non-regression ratio")));
  });

  it("rejects pure second-arm warmup as parallel speedup", () => {
    const runs = passingRuns();
    for (const run of runs) {
      const second =
        (run.order === "A_FIRST" && run.arm === "B") ||
        (run.order === "B_FIRST" && run.arm === "A");
      run.wall_ms = second ? 800 : 1000;
      run.finished_at = new Date(Date.parse(run.started_at) + run.wall_ms).toISOString();
    }
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("B_FIRST") && finding.includes("wall")));
  });

  it("rejects mixed pair regressions hidden by medians in positive and negative scenarios", () => {
    const runs = passingRuns();
    for (const run of runs) {
      if (run.engine !== "ccb" || run.arm !== "B") continue;
      if (!["code_batch", "simple"].includes(run.scenario)) continue;
      const fastPair = ["01", "03"].includes(run.pair_id);
      run.wall_ms = run.scenario === "code_batch"
        ? (fastPair ? 300 : 1400)
        : (fastPair ? 800 : 1400);
      run.finished_at = new Date(Date.parse(run.started_at) + run.wall_ms).toISOString();
    }
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("ccb/code_batch") && finding.includes("jointly be <=1.1"),
      ),
    );
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("ccb/simple") && finding.includes("jointly be <=1.1"),
      ),
    );
  });

  it("requires three pairs to jointly pass every quantitative metric", () => {
    const runs = passingRuns();
    const fields = [
      ["01", "wall_ms"],
      ["02", "cpu_seconds"],
      ["03", "tokens"],
      ["04", "cost_credits"],
    ];
    for (const [pairId, field] of fields) {
      const run = runs.find(
        (item) =>
          item.engine === "ccb" &&
          item.scenario === "simple" &&
          item.pair_id === pairId &&
          item.arm === "B",
      );
      if (field === "wall_ms") {
        run.wall_ms = 1200;
        run.finished_at = new Date(Date.parse(run.started_at) + run.wall_ms).toISOString();
      } else if (field === "cpu_seconds") {
        run.resources.cpu_seconds = 120;
      } else if (field === "tokens") {
        run.resources.tokens = 1200;
        run.resources.usage.tokens = 1200;
        run.resources.usage.receipts[0].tokens += 150;
      } else {
        run.resources.cost_credits = 1.2;
        run.resources.usage.cost_credits = 1.2;
        run.resources.usage.receipts[0].cost_credits += 0.15;
      }
    }
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("ccb/simple") && finding.includes("jointly be <=1.1"),
      ),
    );
  });

  it("requires the speedup threshold in at least three of four positive pairs", () => {
    const runs = passingRuns();
    for (const run of runs) {
      if (run.engine !== "codex" || run.scenario !== "document_batch" || run.arm !== "B") continue;
      run.wall_ms = ["01", "03"].includes(run.pair_id) ? 600 : 1000;
      run.finished_at = new Date(Date.parse(run.started_at) + run.wall_ms).toISOString();
    }
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("wall improvement must reach <=0.85 in at least 3/4 pairs"),
      ),
    );
  });

  it("rejects an unrelated main turn or usage row between pair arms", () => {
    const runs = passingRuns();
    const second = runs.find(
      (run) =>
        run.engine === "codex" &&
        run.scenario === "code_batch" &&
        run.pair_id === "01" &&
        run.arm === "B",
    );
    second.container.freshness_before.dispatches = 2;
    second.container.freshness_before.usage_rows += 1;
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("unrelated turn or usage appeared between pair arms"),
      ),
    );
  });

  it("fails contaminated containers and fatal resource outcomes", () => {
    const runs = passingRuns();
    const run = runs.find((item) => item.arm === "B" && item.scenario === "code_batch");
    run.container.activity.before.parents = 1;
    run.resources.failures.push("delegate queue_timeout");
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("not idle")));
    assert.ok(report.findings.some((finding) => finding.includes("fatal resource failure")));
  });

  it("rejects a pair-consistent runtime tuple that differs from the frozen baseline", () => {
    const runs = passingRuns();
    for (const run of runs.filter(
      (item) => item.engine === "ccb" && item.scenario === "code_batch" && item.pair_id === "01",
    )) {
      run.container.runtime_tuple = {
        image: "other-image",
        image_id: "other-image-id",
        runtime_release: "other-release",
        platform_bundle: "other-bundle",
      };
    }
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("runtime tuple differs from frozen baseline manifest"),
      ),
    );
  });

  it("rejects requested-model evidence when the actual root receipt model or dispatch differs", () => {
    const runs = passingRuns();
    const run = runs.find(
      (item) => item.engine === "codex" && item.scenario === "simple" && item.arm === "A",
    );
    const root = run.resources.usage.receipts.find((receipt) => receipt.mode === "chat");
    root.model = "fallback-model";
    root.dispatch_id = "another-dispatch";
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("root actual model/authority differs from requested engine model"),
      ),
    );
  });

  it("allows specialist child models but rejects missing delegate attribution", () => {
    const passing = scoreRuns(passingRuns(), gold, { manifest });
    assert.equal(passing.passed, true, passing.findings.join("\n"));

    const runs = passingRuns();
    const run = runs.find(
      (item) => item.engine === "ccb" && item.scenario === "code_batch" && item.arm === "B",
    );
    const child = run.resources.usage.receipts.find((receipt) => receipt.mode === "delegate");
    child.delegate_agent_id = null;
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("delegate attribution/model evidence is incomplete"),
      ),
    );
  });

  it("rejects an unrelated all-agent dispatch that completes during one arm", () => {
    const runs = passingRuns();
    const run = runs.find(
      (item) => item.engine === "ccb" && item.scenario === "simple" && item.arm === "B",
    );
    run.container.freshness_after.dispatches += 1;
    run.container.freshness_after.usage_rows += 1;
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(
      report.findings.some((finding) =>
        finding.includes("unrelated agent dispatch or usage appeared during the run"),
      ),
    );
  });

  it("production smoke uses the exact stable bundle lane and reduced smoke matrix", () => {
    const runs = productionRuns();
    for (const run of runs) {
      run.persona.rule_injection = "platform-bundle";
      run.persona.rev = manifest.policy.personas[run.engine].base_persona_rev;
      run.prompt_rev = manifest.policy.candidate_prompt_rev;
      run.container.prompt_rev = manifest.policy.candidate_prompt_rev;
      run.container.lane = {
        before: structuredClone(manifest.production.lane),
        after: structuredClone(manifest.production.lane),
      };
    }
    const report = scoreRuns(runs, gold, { mode: "production-smoke", manifest });
    assert.equal(report.passed, true, report.findings.join("\n"));
  });

  it("fails a formal production smoke slower than the frozen baseline-derived wall gate", () => {
    const runs = productionRuns();
    for (const run of runs) {
      run.persona.rule_injection = "platform-bundle";
      run.persona.rev = manifest.policy.personas[run.engine].base_persona_rev;
      run.prompt_rev = manifest.policy.candidate_prompt_rev;
      run.container.prompt_rev = manifest.policy.candidate_prompt_rev;
      run.container.lane = {
        before: structuredClone(manifest.production.lane),
        after: structuredClone(manifest.production.lane),
      };
      if (run.engine === "codex" && run.scenario === "code_batch") {
        run.wall_ms = 900;
        run.finished_at = new Date(Date.parse(run.started_at) + 900).toISOString();
      }
    }
    const report = scoreRuns(runs, gold, { mode: "production-smoke", manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("exceeds frozen")));
  });

  it("fails policy, child-ledger, and pair-execution evidence tampering", () => {
    const runs = passingRuns();
    const target = runs.find((run) => run.engine === "ccb" && run.scenario === "code_batch" && run.arm === "B");
    target.persona.rev = manifest.policy.personas[target.engine].base_persona_rev;
    target.resources.usage.child_rows = 1;
    target.pair_execution_id = "not-the-same-pair";
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("frozen persona system-slot policy")));
    assert.ok(report.findings.some((finding) => finding.includes("every delegated child")));
    assert.ok(report.findings.some((finding) => finding.includes("pair_execution_id")));
  });

  it("normalizes semantically equivalent document formulas, colors, merges, and rows", () => {
    const runs = passingRuns();
    const run = runs.find((item) => item.arm === "B" && item.scenario === "document_batch");
    const answer = JSON.parse(run.answer_text);
    answer.pages[1].table_rows = [["R2"]];
    answer.workbook.merges = { 摘要: ["A1:C1"] };
    answer.workbook.cells.摘要.A1.fill = "#D9EAF7";
    answer.workbook.cells.摘要.C2.formula = "=B2*1.13";
    run.answer_text = JSON.stringify(answer);
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, true, report.findings.join("\n"));
  });

  it("fails missing preregistered groups, duplicate runs, and fake B_FIRST ordering", () => {
    const runs = passingRuns();
    runs.push(structuredClone(runs[0]));
    runs.splice(runs.findIndex((run) => run.engine === "codex" && run.scenario === "dependent"), 1);
    const fakeOrder = runs.find((run) => run.order === "B_FIRST" && run.arm === "A");
    fakeOrder.started_at = "2026-07-28T00:00:00.000Z";
    fakeOrder.finished_at = "2026-07-28T00:00:10.000Z";
    const report = scoreRuns(runs, gold, { manifest });
    assert.equal(report.passed, false);
    assert.ok(report.findings.some((finding) => finding.includes("duplicate run")));
    assert.ok(report.findings.some((finding) => finding.includes("missing preregistered run")));
    assert.ok(report.findings.some((finding) => finding.includes("declared B_FIRST was not executed in order")));
  });

  it("rejects reusing a warm container across different isolated pairs", () => {
    const runs = passingRuns();
    const first = runs.find((run) => run.engine === "ccb" && run.scenario === "code_batch" && run.pair_id === "01");
    for (const run of runs.filter(
      (item) => item.engine === "ccb" && item.scenario === "code_batch" && item.pair_id === "02",
    )) {
      run.container.id = first.container.id;
      run.container.binding.docker_id = first.container.id;
      run.container.binding.container_internal_id = first.container.id;
    }
    const result = scoreRuns(runs, gold, { manifest });
    assert.equal(result.passed, false);
    assert.ok(result.findings.some((finding) => finding.includes("container id reused by another pair")));
  });

  it("CLI ignores frame sidecars and verifies their SHA-256", () => {
    const dir = mkdtempSync(join(tmpdir(), "v5-parallel-score-"));
    const runsDir = join(dir, "runs");
    execFileSync("mkdir", ["-p", runsDir]);
    const { _sha256: ignored, ...manifestOnDisk } = manifest;
    const manifestSerialized = JSON.stringify(manifestOnDisk);
    const manifestSha = createHash("sha256").update(manifestSerialized).digest("hex");
    for (const run of passingRuns()) {
      const userId = manifest.targets[run.engine].user_id;
      const positive = run.behavior.delegate_tasks_calls === 1;
      const frames = [
        {
          at: 1,
          direction: "sent",
          payload: {
            type: "inbound.message",
            peer: { id: run.peer_id },
            model: run.model,
            effortLevel: run.effort,
          },
        },
        {
          at: 2,
          direction: "received",
          payload: {
            type: "outbound.turn_usage",
            peer: { id: run.peer_id },
            usage: { totalTokens: run.resources.frame_tokens },
          },
        },
        {
          at: 3,
          direction: "received",
          payload: {
            type: "outbound.message",
            peer: { id: run.peer_id },
            blocks: positive ? [{
              kind: "tool_use",
              blockId: "batch",
              toolName: "delegate_tasks",
              inputJson: { tasks: [{ goal: "a" }, { goal: "b" }, { goal: "c" }] },
              partial: false,
            }] : [],
          },
        },
        ...(positive ? [
          ...["a", "b", "c"].map((id, index) => ({
            at: 4 + index,
            direction: "received",
            payload: {
              type: "outbound.message",
              peer: { id: run.peer_id },
              blocks: [{ kind: "delegate_progress", runId: id, phase: "start" }],
            },
          })),
          ...["a", "b", "c"].map((id, index) => ({
            at: 7 + index,
            direction: "received",
            payload: {
              type: "outbound.message",
              peer: { id: run.peer_id },
              blocks: [{ kind: "delegate_progress", runId: id, phase: "done" }],
            },
          })),
          {
            at: 10,
            direction: "received",
            payload: {
              type: "outbound.message",
              peer: { id: run.peer_id },
              blocks: [{
                kind: "tool_result",
                toolUseBlockId: "batch",
                blockId: "batch:result",
                isError: false,
              }],
            },
          },
        ] : []),
        {
          at: 11,
          direction: "received",
          payload: {
            type: "outbound.message",
            peer: { id: run.peer_id },
            isFinal: true,
            meta: { totalCost: run.resources.reported_cost_usd },
            blocks: [{ kind: "text", text: run.answer_text }],
          },
        },
      ];
      const beforeResource = {
        cpu_usec: 1_000_000,
        memory_current: 400,
        memory_max: 1000,
        memory_peak: 400,
        pids_current: 40,
        pids_max: 100,
        pids_peak: 40,
        memory_oom: 0,
        memory_oom_kill: 0,
        pids_max_events: 0,
      };
      const afterResource = {
        ...beforeResource,
        cpu_usec: beforeResource.cpu_usec + run.resources.cpu_seconds * 1_000_000,
      };
      const containerInspect = {
        id: run.container.id,
        created_at: run.container.created_at,
        started_at: run.container.started_at,
        restart_count: run.container.restart_count,
        oom_killed: run.container.oom_killed,
        runtime_tuple: run.container.runtime_tuple,
      };
      const transcript = `${JSON.stringify({
        peer_id: run.peer_id,
        probe_rev: run.probe_rev,
        started_at_ms: Date.parse(run.started_at),
        finished_at_ms: Date.parse(run.finished_at),
        before_sample: { resource: beforeResource, activity: { user_id: userId, parents: 0 } },
        after_sample: { resource: afterResource, activity: { user_id: userId, parents: 0 } },
        before_activity: run.container.activity.before,
        after_activity: run.container.activity.after,
        before_lane: run.container.lane.before,
        after_lane: run.container.lane.after,
        binding: run.container.binding,
        usage: run.resources.usage,
        freshness_before: run.container.freshness_before,
        freshness_after: run.container.freshness_after,
        container_before: containerInspect,
        container_after: containerInspect,
        frames,
        samples: [{
          at: Date.parse(run.started_at) + 5,
          resource: beforeResource,
          activity: { user_id: userId, parents: 1 },
        }],
      })}\n`;
      const transcriptPath = join(dir, `${run.run_id}.frames.json`);
      writeFileSync(transcriptPath, transcript);
      run.transcript_path = transcriptPath;
      run.transcript_sha256 = createHash("sha256").update(transcript).digest("hex");
      run.manifest_sha256 = manifestSha;
      writeFileSync(join(runsDir, `${run.run_id}.json`), JSON.stringify(run));
    }
    writeFileSync(join(runsDir, "unrelated.frames.json"), JSON.stringify({ frames: [{ not: "a run" }] }));
    const goldPath = join(dir, "gold.json");
    const manifestPath = join(dir, "manifest.json");
    writeFileSync(goldPath, JSON.stringify(gold));
    writeFileSync(manifestPath, manifestSerialized);
    const output = execFileSync(process.execPath, [
      new URL("./score.mjs", import.meta.url).pathname,
      "--runs", runsDir,
      "--gold", goldPath,
      "--manifest", manifestPath,
      "--mode", "isolated-ab",
    ], { encoding: "utf8", timeout: 10_000 });
    assert.equal(JSON.parse(output).passed, true);

    const firstRunPath = join(
      runsDir,
      readdirSync(runsDir).find((name) => name.endsWith(".json") && !name.endsWith(".frames.json")),
    );
    const originalRunBytes = readFileSync(firstRunPath);
    const tamperedRun = JSON.parse(originalRunBytes);
    tamperedRun.answer_text += " tampered";
    writeFileSync(firstRunPath, JSON.stringify(tamperedRun));
    assert.throws(() => execFileSync(process.execPath, [
      new URL("./score.mjs", import.meta.url).pathname,
      "--runs", runsDir,
      "--gold", goldPath,
      "--manifest", manifestPath,
      "--mode", "isolated-ab",
    ], { encoding: "utf8", timeout: 10_000 }), /Command failed/);
    writeFileSync(firstRunPath, originalRunBytes);

    writeFileSync(goldPath, JSON.stringify({ ...gold, simple: { answer: 704 } }));
    assert.throws(() => execFileSync(process.execPath, [
      new URL("./score.mjs", import.meta.url).pathname,
      "--runs", runsDir,
      "--gold", goldPath,
      "--manifest", manifestPath,
      "--mode", "isolated-ab",
    ], { encoding: "utf8", timeout: 10_000 }), /Command failed/);
    writeFileSync(goldPath, JSON.stringify(gold));

    writeFileSync(join(runsDir, "invalid-extra.json"), JSON.stringify({ schema_version: 99 }));
    assert.throws(() => execFileSync(process.execPath, [
      new URL("./score.mjs", import.meta.url).pathname,
      "--runs", runsDir,
      "--gold", goldPath,
      "--manifest", manifestPath,
      "--mode", "isolated-ab",
    ], { encoding: "utf8", timeout: 10_000 }), /Command failed/);
  });
});
