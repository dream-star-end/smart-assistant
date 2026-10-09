/**
 * Intelligent UI(OCV5-361)纯逻辑:解析、半截补全、schema、公式、转 Markdown。
 */
import { describe, expect, it } from "vitest";
import { computeOutputs, evaluate, FormulaError, parseFormula, substitute } from "./formula";
import { completePartialJson, IUI_MAX_BLOCK_BYTES, parseUiBlock, sliceFirstObject } from "./parse";
import { LIMITS, resolveType, validateSpec } from "./schema";
import { niceTicks } from "./ChartBlock";
import { formatNumber, specToMarkdown, uiCodeToMarkdown, uiFencesToMarkdown, withUnit } from "./toMarkdown";

describe("parseUiBlock", () => {
  it("parses a complete object and ignores trailing prose after it", () => {
    const r = parseUiBlock('{"type":"callout","body":"x"}\n多余的说明', false);
    expect(r).toEqual({ ok: true, value: { type: "callout", body: "x" }, complete: true });
  });

  it("repairs trailing commas", () => {
    const r = parseUiBlock('{"type":"suggestions","items":["a","b",],}', false);
    expect(r.ok && r.value.items).toEqual(["a", "b"]);
  });

  it("repairs a missing final brace once the message is finished", () => {
    const r = parseUiBlock('{"type":"suggestions","items":["a","b"]', false);
    expect(r.ok && r.complete).toBe(true);
  });

  it.each([
    ["empty", "   ", "empty"],
    ["array", '["a"]', "not_object"],
    ["prose", "这不是 JSON", "not_object"],
    ["broken", '{"type": "table", "rows": [[1, 2], [3 4]]}', "invalid"],
  ])("rejects %s", (_n, src, reason) => {
    const r = parseUiBlock(src, false);
    expect(r).toEqual({ ok: false, reason });
  });

  it("rejects blocks over the size limit", () => {
    const big = `{"type":"callout","body":"${"x".repeat(IUI_MAX_BLOCK_BYTES)}"}`;
    expect(parseUiBlock(big, false)).toEqual({ ok: false, reason: "too_large" });
  });

  it("returns partial objects while streaming", () => {
    const r = parseUiBlock('{"type":"table","columns":["a","b"],"rows":[[1,2],[3,', true);
    expect(r).toEqual({ ok: true, value: { type: "table", columns: ["a", "b"], rows: [[1, 2], [3]] }, complete: false });
  });
});

describe("completePartialJson", () => {
  it.each([
    ['{"a":1,"b":[1,2', '{"a":1,"b":[1]}'],
    ['{"a":"hel', '{"a":"hel"}'],
    ['{"a":"x\\', '{"a":"x"}'],
    ['{"a":"\\u00', '{"a":""}'],
    ['{"a":tr', "{}"],
    ['{"ke', "{}"],
    ['{"a":{"b":[{"c":"d"},{"c":', '{"a":{"b":[{"c":"d"},{}]}}'],
  ])("%s → %s", (src, expected) => {
    const out = completePartialJson(src);
    expect(out).toBe(expected);
    expect(() => JSON.parse(out!)).not.toThrow();
  });

  it("returns the full object unchanged when complete", () => {
    expect(completePartialJson('{"a":[1,{"b":"}"}]} tail')).toBe('{"a":[1,{"b":"}"}]}');
  });

  it("does not treat braces inside strings as structure", () => {
    expect(sliceFirstObject('{"a":"{[","b":2}')).toBe('{"a":"{[","b":2}');
  });
});

describe("validateSpec", () => {
  it("normalizes table columns, object rows, numeric strings and right-aligns numeric columns", () => {
    const v = validateSpec(
      { type: "table", columns: ["型号", { label: "重量", unit: "kg" }], rows: [{ 型号: "A", 重量: 1.2 }, ["B", 1.4], "junk"] },
      false,
    );
    expect(v.ok).toBe(true);
    if (!v.ok || v.spec.type !== "table") throw new Error("expected table");
    expect(v.spec.rows).toEqual([
      ["A", 1.2],
      ["B", 1.4],
    ]);
    expect(v.spec.columns[1]).toEqual({ label: "重量", unit: "kg", align: "right", bar: false });
  });

  it("caps oversized content and records a note instead of failing", () => {
    const rows = Array.from({ length: LIMITS.tableRows + 5 }, (_, i) => [String(i)]);
    const v = validateSpec({ type: "table", columns: ["n"], rows }, false);
    expect(v.ok && v.spec.type === "table" && v.spec.rows.length).toBe(LIMITS.tableRows);
    expect(v.ok && v.notes[0]).toMatch(/行超过/);
  });

  it("pads chart series to the labels and coerces numeric strings", () => {
    const v = validateSpec({ type: "chart", kind: "line", labels: ["1月", "2月", "3月"], series: [{ name: "收入", values: ["1,200", 3] }] }, false);
    expect(v.ok && v.spec.type === "chart" && v.spec.series[0]!.values).toEqual([1200, 3, null]);
  });

  it("accepts donut as pie and keeps only the first series", () => {
    const v = validateSpec({ type: "chart", kind: "donut", labels: ["a", "b"], series: [{ name: "x", values: [1, 2] }, { name: "y", values: [3, 4] }] }, false);
    expect(v.ok && v.spec.type === "chart" && v.spec.kind).toBe("pie");
    expect(v.ok && v.spec.type === "chart" && v.spec.series.length).toBe(1);
  });

  it("rejects a chart with no data once complete, but allows it while streaming", () => {
    expect(validateSpec({ type: "chart", labels: ["a"] }, false).ok).toBe(false);
    expect(validateSpec({ type: "chart", labels: ["a"] }, true).ok).toBe(true);
  });

  it("drops calculator inputs with invalid or duplicate ids and outputs without formulas", () => {
    const v = validateSpec(
      {
        type: "calculator",
        inputs: [
          { id: "a", label: "A", value: 2 },
          { id: "a", label: "dup", value: 3 },
          { id: "1bad", value: 1 },
          { id: "s", kind: "slider", value: 1 },
        ],
        outputs: [{ id: "o", label: "O", formula: "a*2" }, { id: "p", label: "P" }],
      },
      false,
    );
    if (!v.ok || v.spec.type !== "calculator") throw new Error("expected calculator");
    expect(v.spec.inputs.map((i) => i.id)).toEqual(["a", "s"]);
    // slider 没给 min/max 退化为数字输入
    expect(v.spec.inputs[1]!.kind).toBe("number");
    expect(v.spec.outputs.map((o) => o.id)).toEqual(["o"]);
  });

  it("maps aliases and makes checklist checkable", () => {
    expect(resolveType("checklist")).toBe("steps");
    const v = validateSpec({ type: "checklist", items: ["a", { title: "b", done: true }] }, false);
    expect(v.ok && v.spec.type === "steps" && v.spec.checkable).toBe(true);
  });

  it.each([
    [{ type: "nope" }, "unknown_type:nope"],
    [{}, "missing_type"],
    [{ type: "table" }, "invalid_table"],
    [{ type: "compare", items: [] }, "invalid_compare"],
    [{ type: "suggestions", items: [] }, "invalid_suggestions"],
    [{ type: "callout" }, "invalid_callout"],
  ])("rejects %j", (raw, reason) => {
    expect(validateSpec(raw as Record<string, unknown>, false)).toEqual({ ok: false, reason });
  });
});

describe("formula", () => {
  const ev = (src: string, env: Record<string, number> = {}) => evaluate(parseFormula(src), env);

  it("follows precedence, right-assoc power and unary minus", () => {
    expect(ev("1 + 2 * 3")).toBe(7);
    expect(ev("(1 + 2) * 3")).toBe(9);
    expect(ev("2 ^ 3 ^ 2")).toBe(512);
    expect(ev("-2 ^ 2")).toBe(-4);
    expect(ev("10 % 4")).toBe(2);
  });

  it("supports comparisons, ternary and lazy if", () => {
    expect(ev("x > 3 ? 1 : 0", { x: 5 })).toBe(1);
    expect(ev("if(x == 0, 0, 10 / x)", { x: 0 })).toBe(0);
    expect(ev("a && !b", { a: 1, b: 0 })).toBe(1);
  });

  it("supports whitelisted functions incl. pmt", () => {
    expect(ev("round(3.14159, 2)")).toBe(3.14);
    expect(ev("max(1, 7, 3)")).toBe(7);
    expect(ev("clamp(15, 0, 10)")).toBe(10);
    expect(ev("pmt(0, 10, 1000)")).toBe(100);
    // 100 万、30 年、年利率 3.6% 按月:约 4546.43
    expect(ev("pmt(0.036/12, 360, 1000000)")).toBeCloseTo(4546.43, 1);
  });

  it("accepts full-width operators", () => {
    expect(ev("6 × 7 ÷ 2")).toBe(21);
  });

  it.each([
    ["alert(1)", /不支持的函数/],
    ["constructor.constructor", /无法识别的字符/],
    ["a +", /不完整/],
    ["(1 + 2", /缺少/],
    ["1 2", /多余内容/],
    ["x".repeat(501), /过长/],
    [`${"(".repeat(70)}1${")".repeat(70)}`, /嵌套过深/],
    ["1+".repeat(200).concat("1"), /过于复杂/],
  ])("rejects %s", (src, msg) => {
    expect(() => parseFormula(src)).toThrow(msg);
  });

  it("never executes JavaScript", () => {
    expect(() => ev("globalThis")).toThrow(FormulaError);
  });

  it("computes outputs in dependency order and isolates errors", () => {
    const r = computeOutputs({ price: 100, qty: 3 }, [
      { id: "total", formula: "subtotal * 1.1" },
      { id: "subtotal", formula: "price * qty" },
      { id: "bad", formula: "price / 0" },
      { id: "loopA", formula: "loopB + 1" },
      { id: "loopB", formula: "loopA + 1" },
      { id: "unknown", formula: "nope * 2" },
    ]);
    expect(r.subtotal!.value).toBe(300);
    expect(r.total!.value).toBeCloseTo(330);
    expect(r.bad).toMatchObject({ value: null, error: "除数为 0" });
    expect(r.loopA!.value).toBeNull();
    expect(r.loopB!.value).toBeNull();
    expect(r.unknown).toMatchObject({ value: null, error: "未知变量「nope」" });
  });

  it("substitutes current values for display", () => {
    expect(substitute("price * qty", { price: 100, qty: 3 }, String)).toBe("100 * 3");
  });
});

describe("review r1 regressions", () => {
  it("integer format with decimals never throws (was RangeError)", () => {
    expect(formatNumber(4.567, "integer", 2)).toBe("5");
    const md = uiFencesToMarkdown(
      '```ui\n{"type":"calculator","inputs":[{"id":"x","value":2}],"outputs":[{"id":"y","formula":"x*2","format":"integer","decimals":2}]}\n```',
    );
    expect(md).toContain("= 4");
  });

  it("absurd decimals are clamped instead of throwing", () => {
    expect(formatNumber(1.5, "number", 99)).toBe("1.5000000000");
    expect(formatNumber(1.5, "currency", -3)).toBe("2");
  });

  it("niceTicks terminates for huge nearly-equal values (was an infinite loop)", () => {
    const t = niceTicks(10000000000000000, 10000000000000002);
    expect(t.length).toBeLessThanOrEqual(51);
    expect(niceTicks(0, 100)).toEqual([0, 20, 40, 60, 80, 100]);
  });
});

describe("toMarkdown", () => {
  it("formats numbers and units", () => {
    expect(formatNumber(1234.5, "currency")).toBe("1,234.50");
    expect(formatNumber(0.256, "percent", 1)).toBe("25.6%");
    expect(withUnit("12", "¥")).toBe("¥12");
    expect(withUnit("12", "元")).toBe("12元");
    expect(withUnit("12", "kg")).toBe("12 kg");
  });

  it("renders a table as GFM with source and escapes pipes", () => {
    const v = validateSpec({ type: "table", title: "T", columns: ["a", "b"], rows: [["x|y", 1]], source: "官网" }, false);
    expect(v.ok && specToMarkdown(v.spec)).toBe("**T**\n\n| a | b |\n| --- | ---: |\n| x\\|y | 1 |\n\n来源:官网");
  });

  it("renders a calculator with formulas, current values and results", () => {
    const v = validateSpec(
      {
        type: "calculator",
        title: "月供",
        inputs: [{ id: "p", label: "本金", value: 1000, unit: "元" }],
        outputs: [{ id: "m", label: "每月", formula: "p / 10", unit: "元", format: "currency" }],
        assumptions: ["不计利息"],
      },
      false,
    );
    if (!v.ok) throw new Error("invalid");
    const md = specToMarkdown(v.spec, { p: 2000 });
    expect(md).toContain("- 本金:2,000元");
    expect(md).toContain("- **每月** = `p / 10` = 200.00元");
    expect(md).toContain("- 不计利息");
  });

  it("keeps unparseable blocks as a json code block, and drops half blocks while streaming", () => {
    expect(uiCodeToMarkdown("{bad")).toBe("```json\n{bad\n```");
    expect(uiCodeToMarkdown('{"type":"table","columns":["a"],"rows":[[1],', true)).toContain("| a |");
    expect(uiCodeToMarkdown("{bad", true)).toBe("");
  });

  it("replaces only ui fences in a document", () => {
    const doc = [
      "前文",
      "```ui",
      '{"type":"suggestions","items":["再算一次"]}',
      "```",
      "```js",
      "```ui is not a fence here",
      "```",
      "后文",
    ].join("\n");
    expect(uiFencesToMarkdown(doc)).toBe(["前文", "你可以接着问:\n- 再算一次", "```js", "```ui is not a fence here", "```", "后文"].join("\n"));
  });

  it("handles an unclosed trailing ui fence (streaming vs finished)", () => {
    const doc = '答案\n```ui\n{"type":"steps","items":["a","b"';
    expect(uiFencesToMarkdown(doc, true)).toBe("答案\n1. a\n2. b");
    expect(uiFencesToMarkdown(doc, false)).toBe("答案\n1. a\n2. b");
  });

  it("is a no-op for text without ui fences", () => {
    const doc = "普通 **markdown**\n```python\nprint(1)\n```";
    expect(uiFencesToMarkdown(doc)).toBe(doc);
  });

  it("covers every component type", () => {
    const samples: Record<string, unknown>[] = [
      { type: "stats", items: [{ label: "营收", value: 12, unit: "亿", delta: "+3%", basis: "2025 年报" }] },
      { type: "compare", items: [{ name: "A", pros: ["快"], cons: ["贵"], recommended: true }], verdict: "选 A" },
      { type: "choice", question: "选哪个?", options: ["A", { label: "B", desc: "便宜" }] },
      { type: "callout", tone: "warning", body: "小心" },
      { type: "tabs", tabs: [{ label: "一", body: "内容" }] },
      { type: "timeline", items: [{ time: "2024", title: "发布" }] },
      { type: "chart", kind: "pie", labels: ["a"], series: [{ name: "s", values: [1] }] },
    ];
    for (const s of samples) {
      const v = validateSpec(s, false);
      expect(v.ok).toBe(true);
      if (v.ok) expect(specToMarkdown(v.spec).length).toBeGreaterThan(0);
    }
  });
});
