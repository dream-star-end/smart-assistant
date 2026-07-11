/**
 * v5 自愈体系切片① — incident_policies 匹配裁决纯单元(无 DB)。
 *
 * matchPolicyIn 是对已加载 cache 求值的纯函数,验:exact 优先 / longest-prefix /
 * 同长度 fail-fast / 无命中 null。不碰 DB / HTTP。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchPolicyIn, type IncidentPolicy } from "../selfheal/policy.js";

function pol(matchKind: "exact" | "prefix", matchKey: string): IncidentPolicy {
  return {
    id: 1,
    matchKind,
    matchKey,
    surface: "global",
    audience: "all",
    resolveMode: "probe",
    autoRepair: false,
    severityFloor: "warning",
    userTitle: `t:${matchKey}`,
    userMessage: "m",
    repairHint: null,
    enabled: true,
  };
}

// matchPolicyIn 结构化接受 { exact: Map, prefixes: IncidentPolicy[], loadedAt }。
function state(exact: IncidentPolicy[], prefixes: IncidentPolicy[]) {
  return {
    exact: new Map(exact.map((p) => [p.matchKey, p])),
    prefixes,
    loadedAt: Date.now(),
  };
}

describe("selfheal policy — matchPolicyIn", () => {
  test("exact 命中优先于 prefix", () => {
    const s = state([pol("exact", "ops.monitor:svc_v5")], [pol("prefix", "ops.monitor:")]);
    const m = matchPolicyIn(s, "ops.monitor:svc_v5");
    assert.ok(m);
    assert.equal(m.matchKind, "exact");
  });

  test("longest-prefix 胜出", () => {
    const s = state(
      [],
      [pol("prefix", "ops.monitor:"), pol("prefix", "ops.monitor:svc")],
    );
    const m = matchPolicyIn(s, "ops.monitor:svc_v5");
    assert.ok(m);
    assert.equal(m.matchKey, "ops.monitor:svc");
  });

  test("无命中 → null", () => {
    const s = state([pol("exact", "a.b")], [pol("prefix", "x.")]);
    assert.equal(matchPolicyIn(s, "no.match_here"), null);
  });

  test("同长度且同为前缀(重复 key)→ fail-fast 抛错", () => {
    // 人造两条等长且都命中的 prefix(现实由 DB 唯一键挡;此处验裁决防线)。
    const s = state([], [pol("prefix", "dup.key"), pol("prefix", "dup.key")]);
    assert.throws(() => matchPolicyIn(s, "dup.key.tail"), /同长度/);
  });
});
