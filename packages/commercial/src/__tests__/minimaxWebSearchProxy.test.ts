import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __internal_minimaxSearch } from "../minimax/webSearchProxy.js";

const { trimOrganic, baseRespOk, recencyBonus, rerankByRecency, dedupeByHost } =
  __internal_minimaxSearch;

// 固定 now 供确定性时效重排测试(2026-07-06)。
const NOW = Date.parse("2026-07-06T00:00:00Z");

describe("minimax webSearchProxy trimOrganic", () => {
  it("maps organic link→url + title/snippet/date, drops entries with no link", () => {
    const out = trimOrganic({
      organic: [
        { title: "抖音起号技巧", link: "https://www.toutiao.com/a/1", snippet: "1.定位...", date: "2026-01-01" },
        { title: "no link entry", snippet: "dropped" },
        { title: "算法解析", link: "https://blog.csdn.net/x", snippet: "" },
      ],
      base_resp: { status_code: 0 },
    });
    assert.deepEqual(out, [
      { title: "抖音起号技巧", url: "https://www.toutiao.com/a/1", snippet: "1.定位...", date: "2026-01-01" },
      { title: "算法解析", url: "https://blog.csdn.net/x", snippet: "" },
    ]);
  });

  it("caps at 10 results (distinct hosts → dedup no-op)", () => {
    const organic = Array.from({ length: 25 }, (_v, i) => ({
      title: `t${i}`,
      link: `https://x${i}.com/`,
      snippet: "s",
    }));
    assert.equal(trimOrganic({ organic }, NOW).length, 10);
  });

  it("tolerates missing/garbage organic", () => {
    assert.deepEqual(trimOrganic({}), []);
    assert.deepEqual(trimOrganic({ organic: "nope" }), []);
    assert.deepEqual(trimOrganic(null), []);
  });
});

describe("minimax webSearchProxy 时效加权重排", () => {
  it("recencyBonus:越新分越大;无 date/一年以上/非法 date → 0(不惩罚)", () => {
    assert.equal(recencyBonus("2026-07-01", NOW), 3); // 5 天内
    assert.equal(recencyBonus("2026-06-20", NOW), 2); // 一月内
    assert.equal(recencyBonus("2026-03-01", NOW), 1); // 半年内
    assert.equal(recencyBonus("2025-10-01", NOW), 0.5); // 一年内
    assert.equal(recencyBonus("2020-01-01", NOW), 0); // 更旧不惩罚
    assert.equal(recencyBonus(undefined, NOW), 0); // 无 date 不惩罚
    assert.equal(recencyBonus("garbage", NOW), 0); // 非法不惩罚
    assert.equal(recencyBonus("2099-01-01", NOW), 3); // 未来按最新档
  });

  it("新结果适度前移,但至多 3 位(不颠覆相关性)", () => {
    // 位置 4 的新结果(bonus 3)eff=1,超过位置 0/1(无 date,eff=0/1)但打平位置 1,tie 用原名次。
    const items = Array.from({ length: 6 }, (_v, i) => ({
      title: `t${i}`,
      url: `https://s${i}.com/`,
      snippet: "s",
    })) as Array<{ title: string; url: string; snippet: string; date?: string }>;
    items[4].date = "2026-07-05"; // 最新
    const out = rerankByRecency(items, NOW);
    // t4 从第 5 位前移到第 2 位(eff=4-3=1),不能越过 t0(eff=0)。
    assert.deepEqual(out.map((r) => r.title), ["t0", "t1", "t4", "t2", "t3", "t5"]);
  });

  it("无 date 结果不被下压(纯相关性顺序保持)", () => {
    const items = [
      { title: "a", url: "https://a.com/", snippet: "s" },
      { title: "b", url: "https://b.com/", snippet: "s" },
      { title: "c", url: "https://c.com/", snippet: "s" },
    ];
    assert.deepEqual(
      rerankByRecency(items, NOW).map((r) => r.title),
      ["a", "b", "c"],
    );
  });

  it("同 host 超 3 条折叠(保序保前 3)", () => {
    const items = [
      { title: "1", url: "https://csdn.net/1", snippet: "s" },
      { title: "2", url: "https://csdn.net/2", snippet: "s" },
      { title: "3", url: "https://csdn.net/3", snippet: "s" },
      { title: "4", url: "https://csdn.net/4", snippet: "s" }, // 折叠丢弃
      { title: "5", url: "https://zhihu.com/5", snippet: "s" },
    ];
    assert.deepEqual(
      dedupeByHost(items, 3).map((r) => r.title),
      ["1", "2", "3", "5"],
    );
  });

  it("trimOrganic 端到端:同域折叠 + 字段透传 date", () => {
    const out = trimOrganic(
      {
        organic: [
          { title: "a1", link: "https://csdn.net/1", snippet: "s", date: "2026-07-05" },
          { title: "a2", link: "https://csdn.net/2", snippet: "s" },
          { title: "a3", link: "https://csdn.net/3", snippet: "s" },
          { title: "a4", link: "https://csdn.net/4", snippet: "s" },
          { title: "b1", link: "https://zhihu.com/1", snippet: "s" },
        ],
      },
      NOW,
    );
    assert.equal(out.length, 4); // csdn 折叠到 3 + zhihu 1
    assert.equal(out[0].date, "2026-07-05"); // 最新的 csdn 前移到首位 + date 透传
    assert.deepEqual(out.map((r) => r.title).sort(), ["a1", "a2", "a3", "b1"]);
  });

  it("baseRespOk: status_code 0/absent ok, non-zero not ok", () => {
    assert.equal(baseRespOk({ base_resp: { status_code: 0 } }), true);
    assert.equal(baseRespOk({ organic: [] }), true);
    assert.equal(baseRespOk({ base_resp: { status_code: 2013 } }), false);
  });
});
