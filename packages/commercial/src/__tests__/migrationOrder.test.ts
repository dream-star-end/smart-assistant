/**
 * 迁移顺序依赖声明的解析/校验单测(无 DB)。
 *
 * 跑法: npx tsx --test packages/commercial/src/__tests__/migrationOrder.test.ts
 *
 * 真实 apply 行为(fail-closed 时机)由 migrate.integ.test.ts 覆盖。
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  OrderDependencySyntaxError,
  parseOrderDependency,
  verifyOrderDependencies,
} from "../db/migrationOrder.js";

describe("parseOrderDependency", () => {
  test("无声明 → declared=false(存量迁移全部走这条路径,行为不变)", () => {
    const d = parseOrderDependency("-- 0220 something\nCREATE TABLE t();\n");
    assert.equal(d.declared, false);
    assert.deepEqual(d.dependsOn, []);
  });

  test("声明具体依赖", () => {
    const d = parseOrderDependency(
      "-- 0220_x\n-- order-dependency: 0219_deepseek_v4_pro_transition\nCREATE TABLE t();\n",
    );
    assert.equal(d.declared, true);
    assert.deepEqual(d.dependsOn, ["0219_deepseek_v4_pro_transition"]);
    assert.deepEqual(d.lines, [2]);
  });

  test("声明 none + 自由文本理由", () => {
    const d = parseOrderDependency(
      "-- order-dependency: none  (0219 由 feat/x 保留,已放弃)\nSELECT 1;\n",
    );
    assert.equal(d.declared, true);
    assert.deepEqual(d.dependsOn, []);
  });

  test("多条依赖累加;大小写与空白不敏感", () => {
    const d = parseOrderDependency(
      "--   Order-Dependency:   0218_a\n--order-dependency:0219_b\nSELECT 1;\n",
    );
    assert.deepEqual(d.dependsOn, ["0218_a", "0219_b"]);
  });

  test("空行不终止头部块", () => {
    const d = parseOrderDependency("-- 标题\n\n-- order-dependency: 0218_a\nSELECT 1;\n");
    assert.deepEqual(d.dependsOn, ["0218_a"]);
  });

  test("SQL 中段的同名注释不生效(声明必须在头部块,否则易被后续编辑连带删掉)", () => {
    const d = parseOrderDependency("SELECT 1;\n-- order-dependency: 0218_a\nSELECT 2;\n");
    assert.equal(d.declared, false);
    assert.deepEqual(d.dependsOn, []);
  });

  test("空值 → 语法错", () => {
    assert.throws(
      () => parseOrderDependency("-- order-dependency:\nSELECT 1;\n"),
      OrderDependencySyntaxError,
    );
  });

  test("非法 version → 语法错", () => {
    assert.throws(
      () => parseOrderDependency("-- order-dependency: 218-x\nSELECT 1;\n"),
      OrderDependencySyntaxError,
    );
  });

  test("none 与具体依赖混写 → 语法错", () => {
    assert.throws(
      () => parseOrderDependency("-- order-dependency: none\n-- order-dependency: 0218_a\nS;\n"),
      OrderDependencySyntaxError,
    );
  });
});

describe("verifyOrderDependencies", () => {
  const known = new Set(["0217_stage", "0218_a"]);

  test("依赖已在 known(applied 或同批目录内)→ 通过", () => {
    const v = verifyOrderDependencies(
      [{ version: "0219_b", sql: "-- order-dependency: 0218_a\nSELECT 1;\n" }],
      known,
    );
    assert.deepEqual(v, []);
  });

  test("依赖缺失 → 违规,且指名要先合并哪一支", () => {
    const v = verifyOrderDependencies(
      [{ version: "0220_c", sql: "-- order-dependency: 0219_b\nSELECT 1;\n" }],
      known,
    );
    assert.equal(v.length, 1);
    assert.match(v[0]!, /0220_c/);
    assert.match(v[0]!, /0219_b/);
  });

  test("依赖编号不小于自身 → 违规(顺序门只保证小号先落)", () => {
    const v = verifyOrderDependencies(
      [{ version: "0218_a", sql: "-- order-dependency: 0219_b\nSELECT 1;\n" }],
      new Set([...known, "0219_b"]),
    );
    assert.equal(v.length, 1);
    assert.match(v[0]!, /更小的编号/);
  });

  test("无声明 → 通过(存量迁移零行为变化)", () => {
    const v = verifyOrderDependencies([{ version: "0219_b", sql: "CREATE TABLE t();\n" }], known);
    assert.deepEqual(v, []);
  });

  test("声明 none → 通过", () => {
    const v = verifyOrderDependencies(
      [{ version: "0219_b", sql: "-- order-dependency: none (0218 已放弃)\nSELECT 1;\n" }],
      new Set<string>(),
    );
    assert.deepEqual(v, []);
  });

  test("语法错以违规形式返回,不抛(apply 前统一 fail-closed,不区分错误种类)", () => {
    const v = verifyOrderDependencies(
      [{ version: "0219_b", sql: "-- order-dependency: nope!\nSELECT 1;\n" }],
      known,
    );
    assert.equal(v.length, 1);
    assert.match(v[0]!, /0219_b/);
  });

  test("空 pending → 空违规", () => {
    assert.deepEqual(verifyOrderDependencies([], known), []);
  });
});
