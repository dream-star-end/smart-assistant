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
import { lintFile, LEGACY_V2_FILES, STATE_WINDOW_LINES } from "../../scripts/lint-agent-containers-sql.js";

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
