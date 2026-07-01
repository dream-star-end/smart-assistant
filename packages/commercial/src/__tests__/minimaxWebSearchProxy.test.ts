import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { __internal_minimaxSearch } from "../minimax/webSearchProxy.js";

const { trimOrganic, baseRespOk } = __internal_minimaxSearch;

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

  it("caps at 10 results", () => {
    const organic = Array.from({ length: 25 }, (_v, i) => ({
      title: `t${i}`,
      link: `https://x.com/${i}`,
      snippet: "s",
    }));
    assert.equal(trimOrganic({ organic }).length, 10);
  });

  it("tolerates missing/garbage organic", () => {
    assert.deepEqual(trimOrganic({}), []);
    assert.deepEqual(trimOrganic({ organic: "nope" }), []);
    assert.deepEqual(trimOrganic(null), []);
  });

  it("baseRespOk: status_code 0/absent ok, non-zero not ok", () => {
    assert.equal(baseRespOk({ base_resp: { status_code: 0 } }), true);
    assert.equal(baseRespOk({ organic: [] }), true);
    assert.equal(baseRespOk({ base_resp: { status_code: 2013 } }), false);
  });
});
