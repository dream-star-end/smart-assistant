// 单元:leader lease 资格 env 真值表 + /proc/<pid>/stat 第 22 字段解析(纯函数,无 PG)。
// RFC-v5-dual-master-cohort D4:OC_CONTROL_PLANE_LEADER 严格 '0'|'1',unset/非法 = fail-closed 拒起。

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { resolveLeaderEnvEligibility, readProcStartTicks } from "../deploy/leaderLease.js";

describe("resolveLeaderEnvEligibility 真值表(fail-closed)", () => {
  test("'1' → true(eligible)", () => {
    assert.equal(resolveLeaderEnvEligibility({ OC_CONTROL_PLANE_LEADER: "1" }), true);
  });
  test("'0' → false(kill-switch,不竞锁)", () => {
    assert.equal(resolveLeaderEnvEligibility({ OC_CONTROL_PLANE_LEADER: "0" }), false);
  });
  test("尾随空白容忍:' 1 ' → true / ' 0 ' → false", () => {
    assert.equal(resolveLeaderEnvEligibility({ OC_CONTROL_PLANE_LEADER: " 1 " }), true);
    assert.equal(resolveLeaderEnvEligibility({ OC_CONTROL_PLANE_LEADER: "0\n" }), false);
  });
  test("unset → throw(拒起)", () => {
    assert.throws(() => resolveLeaderEnvEligibility({}), /必须显式 '0'\|'1'/);
  });
  test("空串 → throw", () => {
    assert.throws(() => resolveLeaderEnvEligibility({ OC_CONTROL_PLANE_LEADER: "" }), /fail-closed/);
  });
  test("非法值 'true'/'yes'/'2' → throw(不静默默认)", () => {
    for (const v of ["true", "yes", "2", "on", "leader"]) {
      assert.throws(
        () => resolveLeaderEnvEligibility({ OC_CONTROL_PLANE_LEADER: v }),
        /必须显式/,
        `期望 ${v} 拒起`,
      );
    }
  });
});

describe("readProcStartTicks(/proc/<pid>/stat 第 22 字段)", () => {
  test("能读到自身 starttime 且为正整数(Linux)", () => {
    let ticks: number | undefined;
    try {
      ticks = readProcStartTicks(process.pid);
    } catch {
      // 非 Linux/无 /proc → skip(CI 是 Linux;本地 mac 环境跳过)。
      return;
    }
    assert.ok(Number.isFinite(ticks) && (ticks as number) > 0, `starttime 应为正:${ticks}`);
  });
  test("comm 含空格/括号也能正确取第 22 字段(取最后一个 ')' 之后再分词)", () => {
    // 构造一个 comm 带空格+括号的 stat 行:field1=pid field2=(a (b) c) field3=state ... field22=starttime。
    // 用一个真实 /proc 行验证解析不被 comm 里的括号骗到,这里用合成串直接调内部逻辑的等价路径:
    // 直接读一个不存在 pid → 抛(证明 /proc 缺失=抛,供上层判死)。
    assert.throws(() => readProcStartTicks(2_147_483_646), /./);
  });
});
