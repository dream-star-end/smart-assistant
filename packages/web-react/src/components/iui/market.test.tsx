/**
 * 行情类智能 UI 组件（OCV5-383）：schema / 渲染 / Markdown，以及同花顺插件 `ths --ui` 的真实产出。
 *
 * __fixtures__/ths/*.json 是 2026-10-12 13:06 CST 在 v5-dev 上用上游 ths CLI 真实拉到的 JSON 输出
 * （600519 等）；indicators / events / doctor / commands / kline-adj / quote-index / kline-sector / f10-deep 是
 * 同日 17:1x 用上游 v1.3.0（ca5b125）拉的。「ths --ui 产出能被前端 schema 接受」这条用 python3 直接调用插件里的 ui_fences()
 * 转换同一份夹具，不走网络 —— Python 端与前端端的字段约定改了任何一边，这里都会红。
 */
import "@testing-library/jest-dom/vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { IuiBlock } from "./IuiBlock";
import { cnAmount, direction, movingAverage, pctText, priceText } from "./marketSchema";
import { parseUiBlock } from "./parse";
import { validateSpec } from "./schema";
import { specToMarkdown, uiFencesToMarkdown } from "./toMarkdown";

afterEach(cleanup);

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "__fixtures__", "ths");
const THS = resolve(here, "../../../../commercial/agent-sandbox/ccb-baseline/skills/ths/scripts");
const fixture = (name: string) => readFileSync(join(FIX, `${name}.json`), "utf8");

/** 用插件自己的 ui_fences() 把夹具转成 ```ui 块（不联网）。 */
function thsUi(name: string, cmd: string, extra: Record<string, unknown> = {}): string[] {
  const py = [
    "import sys, json, argparse",
    `sys.path.insert(0, ${JSON.stringify(THS)})`,
    "import ths",
    "data = json.load(sys.stdin)",
    `args = argparse.Namespace(cmd=${JSON.stringify(cmd)}, **json.loads(${JSON.stringify(JSON.stringify(extra))}))`,
    "print(ths.ui_fences(data, args))",
  ].join("\n");
  const out = execFileSync("python3", ["-I", "-c", py], { input: fixture(name), encoding: "utf8" });
  return [...out.matchAll(/```ui\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

function valid(code: string) {
  const parsed = parseUiBlock(code, false);
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) throw new Error("parse");
  const v = validateSpec(parsed.value as Record<string, unknown>, false);
  expect(v.ok).toBe(true);
  if (!v.ok) throw new Error(v.reason);
  return v;
}

describe("ths --ui → 前端 schema（真实夹具）", () => {
  const cases: [string, string, Record<string, unknown>, string][] = [
    ["quote1", "quote", {}, "quote"],
    ["quote3", "quote", {}, "quote"],
    ["kline", "kline", {}, "kline"],
    ["intraday", "intraday", {}, "intraday"],
    ["rank", "rank", {}, "stocklist"],
    ["search", "search", {}, "stocklist"],
    ["sectors", "sector", { action: "stocks" }, "stocklist"],
    ["sectorq", "sector", { action: "quote" }, "quote"],
    ["news", "news", {}, "sources"],
    ["f10", "f10", {}, "kv"],
    ["login", "login", { login_action: "status" }, "callout"],
    // 上游 v1.3.0（ca5b125）
    ["indicators", "indicators", {}, "stats"],
    ["events", "events", {}, "timeline"],
    ["doctor", "doctor", {}, "callout"],
    ["commands", "commands", {}, "table"],
    ["kline-adj", "kline", {}, "kline"],
    ["quote-index", "quote", {}, "quote"],
    ["kline-sector", "kline", {}, "kline"],
    ["f10-deep", "f10", {}, "kv"],
  ];
  test.each(cases)("%s（ths %s）产出的块全部通过校验，首块类型 %s", (name, cmd, extra, firstType) => {
    const blocks = thsUi(name, cmd, extra);
    expect(blocks.length).toBeGreaterThan(0);
    const specs = blocks.map((b) => valid(b));
    expect(specs[0].spec.type).toBe(firstType);
    // 不能有「修过」的痕迹：插件产出应当一次过，不靠前端截断。
    for (const s of specs) expect(s.notes).toEqual([]);
  });

  test("技术指标（v1.3.0）：指标卡取 latest 原值，四张折线图逐点等于 series", () => {
    const raw = JSON.parse(fixture("indicators"));
    const [stats, price, boll, macd, osc] = thsUi("indicators", "indicators").map((b) => valid(b).spec) as Record<string, any>[];
    expect(stats.title).toContain("前复权");
    const byLabel = new Map(stats.items.map((i: { label: string; value: unknown }) => [i.label, i.value]));
    expect(byLabel.get("收盘")).toBe(raw.latest.close);
    expect(byLabel.get("MA5 / 10 / 20 / 60")).toBe(`${raw.latest.ma5} / ${raw.latest.ma10} / ${raw.latest.ma20} / ${raw.latest.ma60}`);
    expect(byLabel.get("RSI14")).toBe(raw.latest.rsi14);
    expect(byLabel.get("MACD（DIF / DEA / 柱）")).toBe(`${raw.latest.dif} / ${raw.latest.dea} / ${raw.latest.macd_hist}`);
    expect(price.labels).toEqual(raw.series.map((r: { date: string }) => r.date));
    expect(price.series[0].values).toEqual(raw.series.map((r: { close: number }) => r.close));
    expect(boll.series.map((x: { name: string }) => x.name)).toEqual(["收盘", "BOLL 上轨", "BOLL 中轨", "BOLL 下轨"]);
    expect(macd.series.map((x: { name: string }) => x.name)).toEqual(["DIF", "DEA", "MACD 柱"]);
    expect(osc.series[0].values).toEqual(raw.series.map((r: { rsi14: number | null }) => r.rsi14));
  });

  test("技术指标：CLI 输出的每个数值字段都进了某个块（不丢字段）", () => {
    const raw = JSON.parse(fixture("indicators"));
    const blocks = thsUi("indicators", "indicators").map((b) => valid(b).spec) as Record<string, any>[];
    const statsText = JSON.stringify(blocks[0].items);
    for (const [k, v] of Object.entries(raw.latest)) if (k !== "date" && v !== null) expect(statsText).toContain(String(v));
    const plotted = blocks.slice(1).flatMap((c) => c.series.map((s: { values: unknown[] }) => JSON.stringify(s.values)));
    for (const k of Object.keys(raw.series[0]).filter((x) => x !== "date"))
      expect(plotted).toContain(JSON.stringify(raw.series.map((r: Record<string, unknown>) => r[k])));
  });

  test("公司大事（v1.3.0）：时间线条数、日期、类别、正文与 CLI 一致", () => {
    const raw = JSON.parse(fixture("events"));
    const [tl] = thsUi("events", "events").map((b) => valid(b).spec) as Record<string, any>[];
    expect(tl.items).toEqual(raw.events.map((e: { date: string; category: string; text: string }) => ({ time: e.date, title: e.category, detail: e.text })));
  });

  test("通道自检（v1.3.0）：每项检查一行，结论与 ok 一致", () => {
    const raw = JSON.parse(fixture("doctor"));
    const [callout, table] = thsUi("doctor", "doctor").map((b) => valid(b).spec) as Record<string, any>[];
    expect(callout.tone).toBe(raw.ok ? "success" : "warning");
    expect(table.rows.map((r: unknown[]) => r[0])).toEqual(raw.checks.map((c: { name: string }) => c.name));
  });

  test("前复权 K 线（v1.3.0）：块里注明前复权，行数与收盘价逐行一致", () => {
    const raw = JSON.parse(fixture("kline-adj"));
    expect(raw.adjust).toBe("forward");
    const [k] = thsUi("kline-adj", "kline").map((b) => valid(b).spec) as Record<string, any>[];
    expect(k.note).toBe("前复权");
    expect(k.rows.map((r: { close: number }) => r.close)).toEqual(raw.rows.map((r: { close: number }) => r.close));
  });

  test("数值原样：行情卡的现价 / 涨跌幅 / 盘口与 CLI JSON 一致", () => {
    const raw = JSON.parse(fixture("quote1"));
    const v = valid(thsUi("quote1", "quote")[0]);
    if (v.spec.type !== "quote") throw new Error("type");
    const q = v.spec.items[0];
    expect(q.price).toBe(raw.price);
    expect(q.changePct).toBe(raw.change_pct);
    expect(q.bid?.price).toBe(raw.order_book.bid1_price);
    expect(q.imbalancePct).toBe(raw.order_book.imbalance_pct);
  });

  test("K 线行数与收盘价逐行一致", () => {
    const raw = JSON.parse(fixture("kline"));
    const v = valid(thsUi("kline", "kline")[0]);
    if (v.spec.type !== "kline") throw new Error("type");
    expect(v.spec.rows.map((r) => r.close)).toEqual(raw.rows.map((r: { close: number }) => r.close));
  });

  test("分时按 2 分钟取样：点数约减半，最后一个点就是 CLI 最后一分钟，成交量是两分钟合计", () => {
    const raw = JSON.parse(fixture("intraday"));
    const v = valid(thsUi("intraday", "intraday")[0]);
    if (v.spec.type !== "intraday") throw new Error("type");
    expect(v.spec.points.length).toBe(Math.ceil(raw.points.length / 2));
    const last = raw.points[raw.points.length - 1];
    expect(v.spec.points.at(-1)?.price).toBe(last.price);
    const total = raw.points.reduce((s: number, p: { volume: number }) => s + p.volume, 0);
    expect(v.spec.points.reduce((s, p) => s + (p.volume ?? 0), 0)).toBeCloseTo(total, 3);
    expect(v.spec.note).toMatch(/2 分钟/);
  });
});

describe("schema：宽容但不编数据", () => {
  test("单只行情可以直接写在顶层；数字字符串转数字；缺字段就不显示", () => {
    const v = validateSpec({ type: "quote", code: "600519", name: "贵州茅台", price: "1,281.37", change_pct: "1.45%" }, false);
    expect(v.ok).toBe(true);
    if (!v.ok || v.spec.type !== "quote") return;
    expect(v.spec.items[0]).toMatchObject({ code: "600519", price: 1281.37, changePct: 1.45 });
    expect(v.spec.items[0].open).toBeUndefined();
  });

  test("K 线：高低价包不住开收价的坏行被丢弃并注明，不去「修」", () => {
    const v = validateSpec(
      {
        type: "kline",
        rows: [
          ["20261009", 10, 11, 9, 10.5, 100],
          ["20261010", 10, 10.2, 9.5, 10.8, 100],
        ],
      },
      false,
    );
    expect(v.ok).toBe(true);
    if (!v.ok || v.spec.type !== "kline") return;
    expect(v.spec.rows).toHaveLength(1);
    expect(v.notes.join()).toMatch(/跳过 1 行/);
    expect(v.spec.ma).toEqual([5, 10]);
  });

  test("别名：candlestick → kline，watchlist → stocklist", () => {
    expect(validateSpec({ type: "candlestick", rows: [["d", 1, 2, 1, 2]] }, false).ok).toBe(true);
    const w = validateSpec({ type: "watchlist", items: [{ code: "600519" }] }, false);
    expect(w.ok && w.spec.type).toBe("stocklist");
  });

  test("没有任何有效数据时降级（不渲染空组件）", () => {
    expect(validateSpec({ type: "quote", items: [{ name: "无代码" }] }, false).ok).toBe(false);
    expect(validateSpec({ type: "intraday", points: [] }, false).ok).toBe(false);
  });
});

describe("推算与格式", () => {
  test("均线：不足周期的位置为空", () => {
    expect(movingAverage([1, 2, 3, 4], 3)).toEqual([null, null, 2, 3]);
  });
  test("红涨绿跌方向、中文量级、价格与百分比", () => {
    expect(direction(1.2)).toBe("up");
    expect(direction(-0.1)).toBe("down");
    expect(direction(0)).toBe("flat");
    expect(cnAmount(2463946400)).toBe("24.64亿");
    expect(cnAmount(1602867100000)).toBe("1.60万亿");
    expect(priceText(1282.21)).toBe("1282.21");
    expect(priceText(22.12)).toBe("22.12");
    expect(pctText(1.52)).toBe("+1.52%");
    expect(pctText(-2.07)).toBe("-2.07%");
  });
});

describe("渲染", () => {
  const block = (code: string) => render(<IuiBlock code={code} />);

  test("单只行情卡：名称、现价、涨跌幅（红色 = 上涨）、盘口委比、涨跌停区间", () => {
    block(thsUi("quote1", "quote")[0]);
    const raw = JSON.parse(fixture("quote1"));
    expect(screen.getByText("贵州茅台")).toBeInTheDocument();
    expect(screen.getByText(priceText(raw.price))).toBeInTheDocument();
    const pct = screen.getAllByText(pctText(raw.change_pct))[0];
    expect(pct).toHaveClass("is-up");
    expect(screen.getByText(/委比/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /跌停 .*涨停 .*现价/ })).toBeInTheDocument();
    expect(screen.getByText(/来源/)).toHaveTextContent("同花顺");
  });

  test("多只行情：紧凑列表，每行有涨跌幅药丸", () => {
    const { container } = block(thsUi("quote3", "quote")[0]);
    expect(container.querySelectorAll(".oc-mkt-row")).toHaveLength(3);
    expect(container.querySelectorAll(".oc-mkt-pct.is-pill")).toHaveLength(3);
  });

  test("K 线：有图（无障碍摘要）、均线图例写明按收盘价计算、可切换数据表", () => {
    block(thsUi("kline", "kline")[0]);
    expect(screen.getByRole("img", { name: /日K：60 根/ })).toBeInTheDocument();
    expect(screen.getByText("均线按收盘价计算")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "数据" }));
    const table = screen.getByRole("region", { name: "K线数据" });
    expect(within(table).getAllByRole("row")).toHaveLength(61);
  });

  test("分时：价格线 + 均价 + 昨收基线图例；数据来源注明取样", () => {
    block(thsUi("intraday", "intraday")[0]);
    expect(screen.getByRole("img", { name: /分时：/ })).toBeInTheDocument();
    expect(screen.getByText("均价")).toBeInTheDocument();
    expect(screen.getByText("昨收")).toBeInTheDocument();
    expect(screen.getByText(/每 2 分钟一个点/)).toBeInTheDocument();
  });

  test("股票列表：默认保持来源顺序；超过 10 只折叠；可按成交额重排", () => {
    const { container } = block(thsUi("rank", "rank")[0]);
    const names = () => [...container.querySelectorAll(".oc-mkt-row .oc-mkt-name")].map((n) => n.textContent);
    const raw = JSON.parse(fixture("rank"));
    expect(names()[0]).toBe(raw.results[0].name);
    fireEvent.click(screen.getByRole("radio", { name: "成交额" }));
    const byAmount = [...raw.results].sort((a: { amount: number }, b: { amount: number }) => b.amount - a.amount);
    expect(names()[0]).toBe(byAmount[0].name);
  });
});

describe("Markdown 降级（关闭智能 UI / 复制 / 导出）", () => {
  test("四种行情块都转成真正的 Markdown 表格，不留 JSON", () => {
    for (const [name, cmd] of [
      ["quote1", "quote"],
      ["kline", "kline"],
      ["intraday", "intraday"],
      ["rank", "rank"],
    ] as const) {
      const code = thsUi(name, cmd)[0];
      const md = uiFencesToMarkdown(`看这里：\n\n\`\`\`ui\n${code}\n\`\`\`\n`);
      expect(md).not.toContain("```ui");
      expect(md).toMatch(/\| --- \|/);
      expect(md).toContain("来源");
    }
  });
  test("分时按半小时取点，并写明取样方式", () => {
    const v = valid(thsUi("intraday", "intraday")[0]);
    expect(specToMarkdown(v.spec)).toMatch(/每半小时取一个点/);
  });
});
