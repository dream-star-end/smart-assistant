/**
 * Elo 排名单测(tournament debate 确定性核心):
 *   - 全胜者排第一、全败者垫底;战绩统计;draw;未参赛者保持初始;非法 match 忽略;确定性。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { computeElo, type Match } from "../rank.js";

describe("computeElo", () => {
  it("全胜候选排第一,全败垫底", () => {
    const matches: Match[] = [
      { a: "A", b: "B", winner: "a" },
      { a: "A", b: "C", winner: "a" },
      { a: "B", b: "C", winner: "a" },
    ];
    const r = computeElo(["A", "B", "C"], matches);
    assert.equal(r[0].id, "A"); // A 全胜
    assert.equal(r[2].id, "C"); // C 全败
    assert.ok(r[0].rating > r[1].rating && r[1].rating > r[2].rating);
    assert.equal(r[0].wins, 2);
    assert.equal(r[2].losses, 2);
  });

  it("draw 各加 0.5,战绩记平", () => {
    const r = computeElo(["A", "B"], [{ a: "A", b: "B", winner: "draw" }]);
    assert.equal(r[0].draws, 1);
    assert.equal(r[1].draws, 1);
    // 平局后 rating 基本不变(初始相同)
    assert.ok(Math.abs(r[0].rating - r[1].rating) < 0.01);
  });

  it("未参赛者保持初始分", () => {
    const r = computeElo(["A", "B", "Z"], [{ a: "A", b: "B", winner: "a" }]);
    const z = r.find((x) => x.id === "Z")!;
    assert.equal(z.rating, 1500);
    assert.equal(z.wins, 0);
  });

  it("非法 match(自比/未知 id)忽略", () => {
    const r = computeElo(
      ["A", "B"],
      [
        { a: "A", b: "A", winner: "a" }, // 自比
        { a: "A", b: "X", winner: "a" }, // 未知 id
        { a: "A", b: "B", winner: "a" }, // 合法
      ],
    );
    assert.equal(r.find((x) => x.id === "A")!.wins, 1); // 仅合法那场
  });

  it("确定性:同输入同输出", () => {
    const m: Match[] = [
      { a: "A", b: "B", winner: "a" },
      { a: "B", b: "C", winner: "b" },
    ];
    const r1 = computeElo(["A", "B", "C"], m);
    const r2 = computeElo(["A", "B", "C"], m);
    assert.deepEqual(r1, r2);
  });

  it("单遍不反转明确胜负:c1>c2>c3 全序", () => {
    // c1 胜 c2、c1 胜 c3、c2 胜 c3 → 必须 c1>c2>c3(回归:旧 passes 重放曾反转 c2/c3)
    const r = computeElo(
      ["c1", "c2", "c3"],
      [
        { a: "c1", b: "c2", winner: "a" },
        { a: "c1", b: "c3", winner: "a" },
        { a: "c2", b: "c3", winner: "a" },
      ],
    );
    assert.deepEqual(r.map((x) => x.id), ["c1", "c2", "c3"]);
  });
});
