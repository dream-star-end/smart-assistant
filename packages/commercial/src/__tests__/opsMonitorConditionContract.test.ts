/**
 * bash ⇄ TS 契约测试:scripts/v5-monitor.sh 的检查项全集 ≡
 * packages/commercial/src/selfheal/conditionKeys.ts 的 OPS_MONITOR_CHECKS。
 *
 * 为什么需要机器核对:两个文件的头部都写着"改一侧必同步另一侧",但同步靠的是
 * **注释里的一行名单**。2026-07-26 审计实测它已经漂了 5 个:
 *   - turn_failures / kp_plugin / client_4xx_storm / deploy_state 四个检查项
 *     在 bash 侧跑了很久,TS 侧从未登记;
 *   - http_v3 在 v3 于 2026-07-08 彻底下线后仍留在两侧(默认关、永不执行的死代码)。
 *
 * 漂移的后果不是"注释不好看":自愈体系按 `ops.monitor:<check>` 派单,TS 侧没登记
 * 的 key 等于自愈侧根本不知道这个信号存在,policy seed 也就无从覆盖 —— 探针在响,
 * 没人接。反过来,seed 里写一个 bash 侧不存在的 key,是一条永远不会点亮的策略。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OPS_MONITOR_CHECKS, OPS_MONITOR_PREFIX, opsMonitorKey } from "../selfheal/conditionKeys.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const MONITOR_SH = join(REPO_ROOT, "scripts", "v5-monitor.sh");

/**
 * bash 侧权威 = check_severity() 的 case 分支。
 * 每个检查项都必须有 severity(否则 fanout 时落到 `*)` 兜底),所以这是完备枚举点。
 */
function readBashChecks(source: string): string[] {
  const start = source.indexOf("check_severity() {");
  assert.notEqual(start, -1, "v5-monitor.sh 里找不到 check_severity() —— 契约锚点被改名了");
  const body = source.slice(start, source.indexOf("\n}", start));
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^\s*([a-z0-9_|]+)\)\s*echo\s+(critical|warning|info)\s*;;/.exec(line);
    if (!m) continue;
    for (const name of m[1]!.split("|")) {
      if (name === "*" || name === "") continue;
      names.add(name);
    }
  }
  return [...names].sort();
}

describe("ops.monitor condition key —— bash ⇄ TS 契约", () => {
  const bashChecks = readBashChecks(readFileSync(MONITOR_SH, "utf8"));

  test("check_severity 至少枚举出十几个检查项(锚点没失效)", () => {
    assert.ok(bashChecks.length >= 10, `只解析出 ${bashChecks.length} 个,锚点或格式变了:${bashChecks.join(",")}`);
  });

  test("bash 检查项集合 ≡ OPS_MONITOR_CHECKS(任一侧新增/删除都必须同步)", () => {
    const ts = [...OPS_MONITOR_CHECKS].sort();
    const missingInTs = bashChecks.filter((c) => !ts.includes(c));
    const missingInBash = ts.filter((c) => !bashChecks.includes(c));
    assert.deepEqual(
      { missingInTs, missingInBash },
      { missingInTs: [], missingInBash: [] },
      `monitor.sh 有而 conditionKeys.ts 没登记:[${missingInTs.join(", ")}];` +
        `conditionKeys.ts 有而 monitor.sh 没有:[${missingInBash.join(", ")}]`,
    );
  });

  test("v3 已下线:两侧都不得再出现 http_v3 / V5MON_CHECK_V3", () => {
    // 只看**可执行代码**,整行注释剥掉:门要挡的是"v3 检查项还在跑",不是
    // "有人在注释里解释它为什么被删"。后者是应当鼓励的历史留痕,若一并禁掉,
    // 下一个维护者就只能悄悄删掉说明,反而丢失了上下文。
    const code = readFileSync(MONITOR_SH, "utf8")
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    assert.ok(!code.includes("http_v3"), "v5-monitor.sh 仍残留 http_v3");
    assert.ok(!code.includes("V5MON_CHECK_V3"), "v5-monitor.sh 仍残留 V5MON_CHECK_V3 开关");
    assert.ok(!OPS_MONITOR_CHECKS.includes("http_v3"), "OPS_MONITOR_CHECKS 仍残留 http_v3");
  });

  test("key 构造规则不变(policy seed 的 prefix 行依赖它)", () => {
    assert.equal(OPS_MONITOR_PREFIX, "ops.monitor:");
    assert.equal(opsMonitorKey("svc_v5"), "ops.monitor:svc_v5");
  });

  test("OPS_MONITOR_CHECKS 无重复、无空串", () => {
    assert.equal(new Set(OPS_MONITOR_CHECKS).size, OPS_MONITOR_CHECKS.length);
    for (const c of OPS_MONITOR_CHECKS) assert.match(c, /^[a-z0-9_]+$/);
  });
});
