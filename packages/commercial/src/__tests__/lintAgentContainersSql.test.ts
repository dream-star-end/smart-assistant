/**
 * V3 Phase 3M — lint-agent-containers-sql 单元测试。
 *
 * 验证 R6.7 (a) "5 行内显式 state filter" 硬规则在四种关键路径上的行为:
 *   - 漏 state filter → fail(违规计数 1)
 *   - 同行 state filter → pass
 *   - 多行 SQL,5 行窗口内 state → pass
 *   - 多行 SQL,5 行窗口外 state → fail(防窗口被偷偷拉宽)
 *   - LEFT JOIN agent_containers 等价 → fail/pass 同 FROM
 *   - LEGACY_V2_FILES 中的文件 → 始终 pass(豁免)
 *
 * 见 packages/commercial/scripts/lint-agent-containers-sql.ts。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  lintFile,
  lintFileDetailed,
  LEGACY_V2_FILES,
  STATE_WINDOW_LINES,
  WAIVER_LOOKBEHIND_LINES,
  WAIVER_MARKER,
} from "../../scripts/lint-agent-containers-sql.js";

describe("lint-agent-containers-sql (3M, R6.7 (a))", () => {
  test("FROM agent_containers without state filter → 1 violation", () => {
    const src = `const r = await query(\`SELECT id FROM agent_containers WHERE user_id = $1\`, [u]);`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.line, 1);
    assert.match(v[0]!.match, /FROM agent_containers/);
  });

  test("FROM agent_containers with state on same line → pass", () => {
    const src = `const r = await query(\`SELECT id FROM agent_containers WHERE state = 'active'\`, []);`;
    assert.deepEqual(lintFile("agent-sandbox/v3foo.ts", src), []);
  });

  test("multi-line SQL with state within 5-line window → pass", () => {
    const src = `await pool.query(
  \`SELECT id, container_internal_id
     FROM agent_containers
    WHERE state = 'active'
      AND last_ws_activity < NOW() - INTERVAL '30 minutes'\`,
);`;
    assert.deepEqual(lintFile("agent-sandbox/v3foo.ts", src), []);
  });

  test("multi-line SQL with state OUTSIDE 5-line window → fail", () => {
    // 关键 line: FROM 在 line 1。state 在 line 6 — 窗口 [1..5],漏。
    const src = `FROM agent_containers
WHERE id = $1
  AND user_id IS NOT NULL
  AND created_at > NOW() - INTERVAL '1 day'
  AND something = 'irrelevant'
  AND state = 'active'`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.line, 1);
  });

  test("LEFT JOIN agent_containers without state filter → 1 violation", () => {
    const src = `SELECT * FROM users u LEFT JOIN agent_containers c ON c.user_id = u.id`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1);
  });

  test("INNER JOIN agent_containers WITH state on next line → pass", () => {
    const src = `SELECT * FROM users u INNER JOIN agent_containers c
  ON c.user_id = u.id AND c.state = 'active'`;
    assert.deepEqual(lintFile("agent-sandbox/v3foo.ts", src), []);
  });

  test("multiple FROM agent_containers in one file — independent verdicts", () => {
    const src = `const a = \`SELECT id FROM agent_containers WHERE state = 'active'\`;
const b = \`SELECT id FROM agent_containers WHERE user_id = $1\`;`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1, "second SELECT lacks state filter");
    assert.equal(v[0]!.line, 2);
  });

  test("legacy v2 file — bypassed even with no state filter", () => {
    const legacyPath = [...LEGACY_V2_FILES][0]!;
    const src = `const r = query(\`SELECT id FROM agent_containers WHERE user_id = $1\`, [u]);`;
    assert.deepEqual(lintFile(legacyPath, src), []);
  });

  test("all hard-coded LEGACY_V2_FILES are valid relative paths", () => {
    for (const p of LEGACY_V2_FILES) {
      assert.ok(!p.startsWith("/"), `legacy path must be relative: ${p}`);
      assert.ok(!p.includes("\\"), `legacy path must use / separator: ${p}`);
      assert.ok(p.endsWith(".ts"), `legacy path must be .ts: ${p}`);
    }
  });

  test("FROM agent_containers in a code comment is also flagged (lint is keyword-level)", () => {
    // 设计取舍:lint 不去剥离注释 — 文档里写一条 SQL 范例若漏 state filter,
    // 与真实 SQL 写法一致、容易被复制到生产代码;flag 它促使作者要么补 state、
    // 要么把范例改成不出现 `FROM agent_containers` 字样。
    const src = `// example: SELECT FROM agent_containers WHERE x=1`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1, "even comment FROM gets flagged (safer)");
  });

  test("STATE_WINDOW_LINES is 5 (sanity)", () => {
    assert.equal(STATE_WINDOW_LINES, 5);
  });
});

/**
 * 2026-07-26 门禁审计:原规则只向下看 5 行,而 SQL 最常见写法是
 * `SELECT ac.state ... FROM agent_containers ac` —— state 在 FROM **上方**。
 * 实测 7 处"违规"里 3 处属这类系统性误报,不修就只能靠白名单堆,门名存实亡。
 */
describe("lint-agent-containers-sql — 语句级作用域(修窗口方向盲区)", () => {
  test("state 在 SELECT 列表里(FROM 上方,同一 SQL 字面量)→ pass", () => {
    const src = `const r = await pool.query(
  \`SELECT ac.id,
          ac.state AS state,
          ac.host_uuid
     FROM agent_containers ac
    WHERE ac.id = $1
      FOR UPDATE OF ac\`,
  [id],
);`;
    assert.deepEqual(lintFile("agent-sandbox/v3foo.ts", src), []);
  });

  test("同一字面量里两处关键词 → 逐腿判定,一腿有 state 不替另一腿背书", () => {
    const src = `const r = await query(
  \`WITH ct_v3 AS (
       SELECT user_id, COUNT(*) AS n
         FROM agent_containers
        WHERE state = 'active'
        GROUP BY user_id
     ), ct_v2 AS (
       SELECT user_id, COUNT(*) AS n
         FROM agent_containers
        WHERE status = 'running'
        GROUP BY user_id
     )
     SELECT 1\`,
);`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1, "ct_v2 腿没有 state,必须单独报出来");
    assert.equal(v[0]!.line, 9, "报的是 ct_v2 那一处 FROM");
  });

  test("语句级作用域不会漫过字面量边界(下一条 SQL 的 state 不算数)", () => {
    const src = `const a = \`SELECT id FROM agent_containers WHERE user_id = $1\`;
const b = \`SELECT id FROM other WHERE state = 'active'\`;`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1);
    assert.equal(v[0]!.line, 1);
  });
});

describe("lint-agent-containers-sql — 行内 waiver", () => {
  /** waiver 注释 + `gap` 个空行 + 一条缺 state filter 的查询(距离 = gap + 1)。 */
  const waived = (reason: string, gap = 0) =>
    `// ${WAIVER_MARKER} — ${reason}\n${"\n".repeat(gap)}const r = await query(\`SELECT id FROM agent_containers WHERE id = $1\`, [id]);`;

  test("带理由的 waiver → 违规被豁免,且不算 stale", () => {
    const res = lintFileDetailed("agent-sandbox/v3foo.ts", waived("回收路径,行只喂 stopAndRemove"));
    assert.deepEqual(res.violations, []);
    assert.deepEqual(res.staleWaivers, []);
  });

  test("waiver 只写 marker 不写理由 → 不豁免,并报「缺理由」", () => {
    const src = `// ${WAIVER_MARKER}\nconst r = await query(\`SELECT id FROM agent_containers WHERE id = $1\`, [id]);`;
    const res = lintFileDetailed("agent-sandbox/v3foo.ts", src);
    assert.equal(res.violations.length, 1, "无理由 waiver 不得豁免");
    assert.equal(res.staleWaivers.length, 1);
    assert.equal(res.staleWaivers[0]!.reason, "");
  });

  test("waiver 超出 lookbehind 窗口 → 不豁免", () => {
    const res = lintFileDetailed(
      "agent-sandbox/v3foo.ts",
      waived("太远了", WAIVER_LOOKBEHIND_LINES + 1),
    );
    assert.equal(res.violations.length, 1);
    assert.equal(res.staleWaivers.length, 1, "没被消费的 waiver 必须报 stale");
  });

  test("代码修好后遗留的 waiver → 报 stale(逼人删行)", () => {
    const src = `// ${WAIVER_MARKER} — 早年的理由\nconst r = await query(\`SELECT id FROM agent_containers WHERE state = 'active'\`, []);`;
    const res = lintFileDetailed("agent-sandbox/v3foo.ts", src);
    assert.deepEqual(res.violations, []);
    assert.equal(res.staleWaivers.length, 1);
    assert.equal(res.staleWaivers[0]!.line, 1);
  });
});

describe("lint-agent-containers-sql — 注释不得充当 state 证据", () => {
  test("代码平面的关键词:上方散文提到 state 不算过", () => {
    // 这条最要命:waiver 的理由里几乎一定会出现 "state" 这个词。
    // 若注释算证据,写 waiver 的动作本身就会把门刷绿 —— 门就废了。
    const src = `// v2 行的 state 列只是 DEFAULT 'active',不承载语义
const r = await query(\`SELECT id FROM agent_containers WHERE status = 'running'\`, []);`;
    const v = lintFile("agent-sandbox/v3foo.ts", src);
    assert.equal(v.length, 1);
  });

  test("SQL 注释行同样不算证据", () => {
    const src = `const r = await query(
  \`SELECT id
     -- 这里本该按 state 过滤
     FROM agent_containers
    WHERE user_id = $1\`,
);`;
    assert.equal(lintFile("agent-sandbox/v3foo.ts", src).length, 1);
  });

  test("关键词本身写在注释里(文档 SQL 范例)→ 同一平面,注释里的 state 算数", () => {
    const src = `/**
 * 设计说明:
 *   SELECT id FROM agent_containers WHERE state='active'
 */`;
    assert.deepEqual(lintFile("agent-sandbox/v3foo.ts", src), []);
  });
});
