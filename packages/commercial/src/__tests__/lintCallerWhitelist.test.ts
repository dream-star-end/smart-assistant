/**
 * Phase 1.B — lint caller-whitelist 升级 TDD placeholder (INV-1)。
 *
 * 现状:`lintAgentContainersSql.ts:5-9` 自承"R6.11 (b)(c)(d) 严格模式推迟到 P1
 * 一并落地"。现有 lint 只校验"agent_containers 5 行内出现 state 字符串"
 * (`lintAgentContainersSql.test.ts:99` 锁常量 STATE_WINDOW_LINES=5),不够
 * R6.11 FAIL2 的"caller-whitelist + open-migration predicate"语义级要求。
 *
 * 本文件锁 R6.11 FAIL2 完整不变量:
 *   - INV-1 strict: agent_containers 上的 reader SQL 调用栈要么调
 *     `supervisor.ensureRunning(uid)`(函数级 `// @oc-reader-entry` 标注白名单),
 *     要么 SQL 必须含 `NOT EXISTS (... agent_migrations ... phase NOT IN ('committed','rolled_back'))`
 *     predicate;
 *   - RECONCILER_WHITELIST file-path 校验:reconciler 内的 docker-start 入口允许
 *     绕开 ensureRunning(reconciler 是单点权威),其他文件不允许;
 *   - lint fixture 三 case:漏 predicate fail / 加 predicate pass / 白名单 pass。
 *
 * **Phase 2 完工硬门**:本文件不允许 ship 时仍含 `test.todo`(同 v3MigrationLedger.test.ts)。
 *
 * 与现有 `lintAgentContainersSql.test.ts:99`(锁常量 STATE_WINDOW_LINES=5)的关系:
 *   后者锁的是"lint 实现细节",Phase 2 升级 lint 到语义级时一并删;本文件锁的是
 *   "lint 必须 enforce 的语义",二者方向相反,不应混在一个文件里。
 */

import { describe, test } from "node:test";

describe("lint caller-whitelist — R6.11 FAIL2 strict mode — Phase 2 TDD placeholder", () => {
  test.todo(
    "fixture 1 (fail): 一段 SELECT … FROM agent_containers WHERE state='active' 但没 NOT EXISTS open-migration predicate、且 caller file 不在 RECONCILER_WHITELIST → lint 必须报错并指出 caller path",
  );

  test.todo(
    "fixture 2 (pass): 同样的 SELECT 但加上 NOT EXISTS (SELECT 1 FROM agent_migrations m WHERE m.agent_container_id = c.id AND m.phase NOT IN ('committed','rolled_back')) → lint 通过",
  );

  test.todo(
    "fixture 3 (pass via whitelist): 调用文件在 RECONCILER_WHITELIST(例如 v3migrationReconciler.ts)裸 SELECT(无 `// @oc-reader-entry` 标注 + 无 NOT EXISTS predicate)→ lint 仍通过(reconciler 是 docker start 单点权威,自己持有 ledger 写权,白名单文件整文件豁免 reader 闸门;**不**额外要求 annotation,annotation 只锁非白名单 reader 路径上的 ensureRunning 入口 — 见 02-DEVELOPMENT-PLAN.md:2258 三 fixture 权威定义)",
  );
});
