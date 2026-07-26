/**
 * .github/scripts/diff-known-failures.sh 的红绿对照测试。
 *
 * 这个门是 commercial-unit(4696 个测试点)唯一的判绿依据。2026-07-26 审计发现
 * 它当时只比对 19 个顶层失败名,`# fail 61` / `# cancelled 39` / 半途被 kill
 * 全都能绿着过去。本文件把重写后的每一条判据都钉成用例:**先证明门会红,
 * 再证明修好后会绿** —— 否则下一次有人"顺手放宽"时没有任何东西拦得住。
 *
 * 全程只用临时目录里的合成 TAP,不碰 DB、不碰生产。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATE = join(REPO_ROOT, ".github", "scripts", "diff-known-failures.sh");

interface TapSpec {
  /** 顶层失败名(会写成 `not ok N - <name>`) */
  failing?: string[];
  /** 顶层通过的测试点数量 */
  passingPoints?: number;
  /** 省略 plan 行(模拟 OOM / 看门狗 kill 后的截断) */
  omitPlan?: boolean;
  /** 让 plan 行的 N 与实际测试点数不符 */
  planOverride?: number;
  /** 不写这些汇总键 */
  omitSummary?: string[];
  fail?: number;
  cancelled?: number;
  skipped?: number;
}

function buildTap(spec: TapSpec): string {
  const failing = spec.failing ?? [];
  const passing = spec.passingPoints ?? 5;
  const lines: string[] = ["TAP version 13"];
  let n = 0;
  for (const name of failing) {
    n += 1;
    lines.push(`not ok ${n} - ${name}`, "  ---", "  duration_ms: 1", "  ...");
  }
  for (let i = 0; i < passing; i++) {
    n += 1;
    lines.push(`ok ${n} - passing suite ${i}`, "  ---", "  duration_ms: 1", "  ...");
  }
  if (!spec.omitPlan) lines.push(`1..${spec.planOverride ?? n}`);
  const fail = spec.fail ?? failing.length;
  const cancelled = spec.cancelled ?? 0;
  const skipped = spec.skipped ?? 0;
  // tests 必须容得下 fail+cancelled+skipped,否则 pass 会算成负数、汇总行不合法。
  const tests = Math.max(n * 10, fail + cancelled + skipped + n);
  const summary: Record<string, number> = {
    tests,
    suites: n,
    pass: tests - fail - cancelled - skipped,
    fail,
    cancelled,
    skipped,
    todo: 0,
  };
  for (const [k, v] of Object.entries(summary)) {
    if (spec.omitSummary?.includes(k)) continue;
    lines.push(`# ${k} ${v}`);
  }
  return `${lines.join("\n")}\n`;
}

interface RunSpec {
  tap: TapSpec;
  baseline: string[];
  /** counts 基线内容;传 null 表示不创建该文件 */
  counts?: { fail_max: number; cancelled_max: number } | null;
  core?: string[];
  upstreamExit?: string;
  strict?: boolean;
}

function runGate(spec: RunSpec): { code: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "kf-gate-"));
  try {
    const tapPath = join(dir, "run.tap");
    const knownPath = join(dir, "commercial-unit.txt");
    const countsPath = join(dir, "commercial-unit.counts");
    const corePath = join(dir, "core-contract-suites.txt");
    writeFileSync(tapPath, buildTap(spec.tap));
    writeFileSync(knownPath, `# baseline\n${spec.baseline.join("\n")}\n`);
    if (spec.counts !== null) {
      const c = spec.counts ?? { fail_max: 999, cancelled_max: 999 };
      writeFileSync(countsPath, `# counts\nfail_max = ${c.fail_max}\ncancelled_max = ${c.cancelled_max}\n`);
    }
    writeFileSync(corePath, `# core\n${(spec.core ?? []).join("\n")}\n`);
    const r = spawnSync(
      "bash",
      [GATE, tapPath, knownPath, spec.upstreamExit ?? "0"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CI: spec.strict === false ? "" : "true",
          KNOWN_FAILURES_STRICT: spec.strict === undefined ? "" : spec.strict ? "1" : "0",
          CORE_CONTRACT_SUITES: corePath,
        },
      },
    );
    return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 一份"正常的、只有已登记存量失败"的运行。 */
const GREEN: RunSpec = {
  tap: { failing: ["known suite A", "known suite B"], passingPoints: 8, fail: 61, cancelled: 39 },
  baseline: ["known suite A", "known suite B"],
  counts: { fail_max: 61, cancelled_max: 39 },
  upstreamExit: "1",
};

describe("known-failures gate — 基准绿", () => {
  test("顶层失败集 ⊆ 基线 + TAP 完整 + 计数未超 → PASS(哪怕 runner 非零退出)", () => {
    const r = runGate(GREEN);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASS: no new failures beyond baseline/);
  });
});

describe("known-failures gate — 判据 A:TAP 完整性(堵'跑了一半也算绿')", () => {
  test("缺顶层 plan 行(OOM / 看门狗 kill 截断)→ 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, omitPlan: true } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /缺顶层 plan 行/);
  });

  test("plan 行 N 与实际测试点数不符(输出被截断/写串)→ 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, planOverride: 999 } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /plan 与实际测试点数不符/);
  });

  test("缺 `# tests` 汇总行 → 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, omitSummary: ["tests"] } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /缺汇总行/);
  });

  test("一个测试点都没有 → 红", () => {
    const r = runGate({ ...GREEN, tap: { failing: [], passingPoints: 0, fail: 0, cancelled: 0 } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no TAP test points found/);
  });
});

describe("known-failures gate — 判据 B:skipped 必须为 0", () => {
  test("# skipped 非零(fixture 没起来会整套静默 skip)→ 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, skipped: 3 } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /# skipped 3/);
  });
});

describe("known-failures gate — 判据 C:失败/取消计数基线", () => {
  test("# fail 超基线(顶层名字没变,套件内部多了失败)→ 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, fail: 62 } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /失败测试点数上升/);
  });

  test("# cancelled 超基线(父套件挂得更早,大片用例没执行)→ 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, cancelled: 40 } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /取消.*上升/);
  });

  test("计数低于基线 → 绿 + warning 提示收紧", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, fail: 60 } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning::# fail 60 < 基线 fail_max 61/);
  });

  test("counts 基线文件不存在 → 红(删文件不等于跳过判据)", () => {
    const r = runGate({ ...GREEN, counts: null });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /required gate input not found/);
  });
});

describe("known-failures gate — 判据 D:新增顶层失败", () => {
  test("冒出基线里没有的顶层失败 → 红", () => {
    const r = runGate({ ...GREEN, tap: { ...GREEN.tap, failing: ["known suite A", "brand new regression"] } });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[NEW\] brand new regression/);
  });
});

describe("known-failures gate — 判据 E:核心契约禁豁免", () => {
  test("核心契约套件被写进基线 → 红(整名命中)", () => {
    const r = runGate({
      ...GREEN,
      tap: { ...GREEN.tap, failing: ["known suite A", "known suite B", "routeOwnership"] },
      baseline: ["known suite A", "known suite B", "routeOwnership"],
      core: ["routeOwnership"],
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[FORBIDDEN\] routeOwnership/);
  });

  test("核心契约套件的子用例被写进基线 → 红(前缀命中)", () => {
    const r = runGate({
      ...GREEN,
      tap: { ...GREEN.tap, failing: ["known suite A", "known suite B", "userChatBridge — 某个子用例"] },
      baseline: ["known suite A", "known suite B", "userChatBridge — 某个子用例"],
      core: ["userChatBridge"],
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FORBIDDEN/);
  });

  test("名字只是前缀相同但不是同一个套件 → 不误伤", () => {
    // `userChatBridge` 不得连坐 `userChatBridgeCodexBilling`。
    const r = runGate({
      ...GREEN,
      tap: { ...GREEN.tap, failing: ["userChatBridgeCodexBilling"] },
      baseline: ["userChatBridgeCodexBilling"],
      core: ["userChatBridge"],
    });
    assert.equal(r.code, 0, r.out);
  });
});

describe("known-failures gate — 判据 F:stale 条目", () => {
  test("基线里有本轮没失败的条目 → CI 严格档红", () => {
    const r = runGate({ ...GREEN, baseline: [...GREEN.baseline, "已经修好但没删行的条目"], strict: true });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[STALE\] 已经修好但没删行的条目/);
  });

  test("同一份输入在本地宽松档 → 绿 + warning(基线按 CI 环境校准)", () => {
    const r = runGate({ ...GREEN, baseline: [...GREEN.baseline, "已经修好但没删行的条目"], strict: false });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /::warning::/);
  });
});

describe("known-failures gate — 判据 G:runner 非零退出", () => {
  test("exit != 0 但 TAP 零失败零取消 → 红(非测试失败类崩溃)", () => {
    const r = runGate({
      tap: { failing: [], passingPoints: 8, fail: 0, cancelled: 0 },
      baseline: [],
      counts: { fail_max: 61, cancelled_max: 39 },
      upstreamExit: "134",
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /exited 134/);
  });

  test("exit != 0 且失败都在基线内 → 绿(这正是基线门存在的理由)", () => {
    assert.equal(runGate({ ...GREEN, upstreamExit: "1" }).code, 0);
  });
});

describe("known-failures gate — 仓内真实基线文件自检", () => {
  test("commercial-unit.txt 里没有任何核心契约套件", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        // 用门自身的匹配规则复核一遍仓内实际文件,防止有人绕过 CI 直接改基线。
        `set -euo pipefail
         cd "${REPO_ROOT}"
         known=$(grep -v -e '^[[:space:]]*$' -e '^#' .github/known-failures/commercial-unit.txt || true)
         core=$(grep -v -e '^[[:space:]]*$' -e '^#' .github/known-failures/core-contract-suites.txt || true)
         hit=0
         while IFS= read -r c; do
           [ -z "$c" ] && continue
           while IFS= read -r k; do
             [ -z "$k" ] && continue
             case "$k" in "$c"|"$c "*) echo "FORBIDDEN: $k"; hit=1;; esac
           done <<< "$known"
         done <<< "$core"
         exit $hit`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });

  test("counts 基线存在且给出了两个上界", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `grep -qE '^fail_max = [0-9]+$' "${REPO_ROOT}/.github/known-failures/commercial-unit.counts" &&
         grep -qE '^cancelled_max = [0-9]+$' "${REPO_ROOT}/.github/known-failures/commercial-unit.counts"`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
});
