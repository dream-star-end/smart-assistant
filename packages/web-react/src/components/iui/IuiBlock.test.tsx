import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIntelligentUiForTests, applyIntelligentUiSnapshot, setIntelligentUiPref } from "../../lib/intelligentUi";
import { exportSessionMarkdown } from "../../lib/chat/exportMarkdown";
import type { ChatMessage } from "../../lib/chat/model";
import MarkdownImpl from "../MarkdownImpl";
import { ChatInteractionContext } from "../tool/context";
import { BlockBoundary, IuiBlock } from "./IuiBlock";

const j = (v: unknown) => JSON.stringify(v);

beforeEach(() => {
  __resetIntelligentUiForTests();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(cleanup);

describe("table", () => {
  const code = j({
    type: "table",
    title: "三款对比",
    columns: ["型号", { label: "重量", unit: "kg" }, "价格"],
    rows: [
      ["B", 1.4, "¥7,999"],
      ["A", 1.2, "¥12,999"],
      ["C", null, "¥5,499"],
    ],
    source: "厂商官网",
  });

  it("renders title, unit, source and sorts by numeric value with aria-sort", () => {
    render(<IuiBlock code={code} />);
    expect(screen.getByText("三款对比")).toBeInTheDocument();
    expect(screen.getByText("(kg)")).toBeInTheDocument();
    expect(screen.getByText(/来源:/)).toHaveTextContent("来源:厂商官网");
    const firstCol = () => screen.getAllByRole("rowheader").map((c) => c.textContent);
    expect(firstCol()).toEqual(["B", "A", "C"]);
    fireEvent.click(screen.getByRole("button", { name: "按「价格」排序" }));
    expect(firstCol()).toEqual(["C", "B", "A"]);
    expect(screen.getAllByRole("columnheader")[2]).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(screen.getByRole("button", { name: "按「价格」排序" }));
    expect(firstCol()).toEqual(["A", "B", "C"]);
    // 空值永远在最后
    fireEvent.click(screen.getByRole("button", { name: "按「重量」排序" }));
    expect(firstCol()).toEqual(["A", "B", "C"]);
    fireEvent.click(screen.getByRole("button", { name: "按「重量」排序" }));
    expect(firstCol()).toEqual(["B", "A", "C"]);
  });

  it("copies the component as Markdown", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<IuiBlock code={code} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "复制(Markdown)" }));
    });
    expect(writeText.mock.calls[0]![0]).toContain("| 型号 | 重量(kg) | 价格 |");
  });
});

describe("chart", () => {
  it("renders an accessible chart and a data table toggle", () => {
    render(
      <IuiBlock
        code={j({ type: "chart", kind: "bar", title: "季度收入", labels: ["Q1", "Q2"], series: [{ name: "收入", values: [10, 20] }], unit: "万元" })}
      />,
    );
    const img = screen.getByRole("img");
    expect(img.getAttribute("aria-label")).toMatch(/季度收入:柱状图,2 个数据点/);
    expect(img.querySelectorAll("rect[rx]").length).toBe(2);
    fireEvent.keyDown(img, { key: "ArrowRight" });
    // 读数行显示当前点(与 x 轴刻度的 Q1 区分开)
    expect(document.querySelector(".oc-iui-readout")).toHaveTextContent("Q110万元");
    fireEvent.click(screen.getByRole("button", { name: "数据" }));
    const table = screen.getByRole("table");
    expect(within(table).getByText("20")).toBeInTheDocument();
  });

  it("renders line/area paths with gaps for null values", () => {
    const { container } = render(
      <IuiBlock code={j({ type: "chart", kind: "area", labels: ["a", "b", "c", "d"], series: [{ name: "s", values: [1, null, 3, 4] }] })} />,
    );
    // 一段单点 + 一段两点:两条折线、两块面积
    expect(container.querySelectorAll('path[fill="none"]').length).toBe(2);
  });

  it("renders a pie with a percentage legend", () => {
    render(<IuiBlock code={j({ type: "chart", kind: "pie", labels: ["房租", "餐饮"], series: [{ name: "支出", values: [3, 1] }] })} />);
    expect(screen.getByRole("button", { name: /房租.*75\.0%/ })).toBeInTheDocument();
  });
});

describe("other components", () => {
  it("stats show value, delta and basis", () => {
    render(<IuiBlock code={j({ type: "stats", items: [{ label: "月供", value: 4546.43, unit: "¥", delta: "-120", basis: "30 年等额本息,年利率 3.6%" }] })} />);
    expect(screen.getByText("¥4,546.43")).toBeInTheDocument();
    expect(screen.getByText("-120").className).toMatch(/is-down/);
    expect(screen.getByText("30 年等额本息,年利率 3.6%")).toBeInTheDocument();
  });

  it("checkable steps update progress and remember ticks locally", () => {
    const code = j({ type: "steps", checkable: true, items: ["买菜", { title: "腌肉", detail: "提前一晚" }, "烤"] });
    render(<IuiBlock code={code} />);
    expect(screen.getByText("已完成 0 / 3")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /腌肉/ }));
    expect(screen.getByText("已完成 1 / 3")).toBeInTheDocument();
    cleanup();
    render(<IuiBlock code={code} />);
    expect(screen.getByRole("checkbox", { name: /腌肉/ })).toBeChecked();
  });

  it("compare marks the recommended card", () => {
    render(<IuiBlock code={j({ type: "compare", items: [{ name: "A", recommended: true, pros: ["轻"] }, { name: "B", cons: ["重"] }], verdict: "选 A" })} />);
    expect(screen.getByText("推荐")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "优点" })).toHaveTextContent("轻");
    expect(screen.getByText("选 A")).toBeInTheDocument();
  });

  it("callout renders tone and markdown body without images", () => {
    const { container } = render(<IuiBlock code={j({ type: "callout", tone: "warning", body: "**别**这样 ![x](https://t.example/p.png)" })} />);
    expect(container.querySelector(".oc-iui-callout.is-warning")).toBeTruthy();
    expect(screen.getByText("别").tagName).toBe("STRONG");
    expect(container.querySelector("img")).toBeNull();
  });

  it("tabs switch by click and arrow keys", () => {
    render(<IuiBlock code={j({ type: "tabs", tabs: [{ label: "车架", body: "铝合金" }, { label: "传动", body: "7 速" }] })} />);
    expect(screen.getByRole("tabpanel")).toHaveTextContent("铝合金");
    fireEvent.keyDown(screen.getByRole("tablist"), { key: "ArrowRight" });
    expect(screen.getByRole("tab", { name: "传动" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("7 速");
    fireEvent.click(screen.getByRole("tab", { name: "车架" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("铝合金");
  });

  it("timeline renders items", () => {
    render(<IuiBlock code={j({ type: "timeline", items: [{ time: "2024-01", title: "立项" }, { title: "上线", detail: "灰度" }] })} />);
    expect(screen.getByText("立项")).toBeInTheDocument();
    expect(screen.getByText("灰度")).toBeInTheDocument();
  });

  it("suggestions send once and lock; read-only and missing sender cannot send", () => {
    const sendUserText = vi.fn();
    const code = j({ type: "suggestions", items: ["按 8 人算", "换成素食"] });
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "按 8 人算" }));
    fireEvent.click(screen.getByRole("button", { name: "换成素食" }));
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith("按 8 人算");
    cleanup();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock code={code} readOnly />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "按 8 人算" })).toBeDisabled();
    cleanup();
    render(
      <ChatInteractionContext.Provider value={{ reason: "demo" }}>
        <IuiBlock code={code} />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByText(/演示模式/)).toBeInTheDocument();
  });

  it("choice reuses the options card and sends the pick", () => {
    const sendUserText = vi.fn();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock code={j({ type: "choice", question: "预算?", options: ["5 千内", "1 万内"] })} />
      </ChatInteractionContext.Provider>,
    );
    fireEvent.click(screen.getByText("1 万内"));
    expect(sendUserText).toHaveBeenCalledWith("我选择:1 万内");
  });
});

describe("calculator", () => {
  const code = j({
    type: "calculator",
    title: "烤羊腿用量",
    inputs: [
      { id: "people", label: "人数", value: 5, min: 1, max: 20, step: 1, unit: "人" },
      { id: "doneness", label: "熟度", kind: "select", value: 1, options: [{ label: "五分", value: 1 }, { label: "全熟", value: 1.1 }] },
      { id: "kids", label: "有小孩", kind: "toggle", value: false },
    ],
    outputs: [
      { id: "lamb", label: "羊腿", formula: "people * 0.4 * doneness * (kids ? 0.9 : 1)", unit: "kg", decimals: 1, primary: true },
      { id: "potato", label: "土豆", formula: "people * 300", unit: "g", format: "integer" },
      { id: "per", label: "人均", formula: "lamb / (people - people)", unit: "kg" },
    ],
    assumptions: ["成人食量"],
  });

  it("recomputes on every input change and shows formulas with substituted values", () => {
    render(<IuiBlock code={code} />);
    expect(screen.getByText("2.0 kg")).toBeInTheDocument();
    expect(screen.getByText("1,500 g")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "增加人数" }));
    expect(screen.getByText("2.4 kg")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("熟度"), { target: { value: "1.1" } });
    expect(screen.getByText("2.6 kg")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "有小孩" }));
    expect(screen.getByText("2.4 kg")).toBeInTheDocument();
    // 除零的输出单独报错,其它输出不受影响
    expect(screen.getByText("除数为 0")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "公式与假设" }));
    expect(screen.getByText("people * 300")).toBeInTheDocument();
    expect(screen.getByText("6 * 300")).toBeInTheDocument();
    expect(screen.getByText("成人食量")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "还原" }));
    expect(screen.getByText("2.0 kg")).toBeInTheDocument();
  });

  it("clamps typed values to min/max", () => {
    render(<IuiBlock code={code} />);
    fireEvent.change(screen.getByLabelText("人数"), { target: { value: "99" } });
    expect(screen.getByText("8.0 kg")).toBeInTheDocument();
  });
});

describe("fallbacks never crash the message", () => {
  it.each([
    ["invalid JSON", '{"type":"table", rows: oops}', /无法解析/],
    ["not an object", '["a","b"]', /无法解析/],
    ["unknown type without items", j({ type: "hologram", x: 1 }), /无法显示/],
    ["invalid known type", j({ type: "table" }), /无法显示/],
    ["too large", `{"type":"callout","body":"${"x".repeat(70_000)}"}`, /过大/],
  ])("%s → readable original", (_n, code, msg) => {
    render(<IuiBlock code={code} />);
    expect(screen.getByText(msg)).toBeInTheDocument();
    expect(document.querySelector("pre")).toBeTruthy();
  });

  it("unknown type with title and items becomes a list", () => {
    render(<IuiBlock code={j({ type: "kanban", title: "看板", items: [{ name: "写设计", owner: "我" }, "评审"] })} />);
    expect(screen.getByText("看板")).toBeInTheDocument();
    expect(screen.getByText("写设计 —— 我")).toBeInTheDocument();
    expect(screen.getByText("评审")).toBeInTheDocument();
  });

  it("a component that throws falls back to its Markdown", () => {
    const Boom = () => {
      throw new Error("boom");
    };
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <BlockBoundary resetKey="k" fallback={<p>兜底内容</p>}>
        <Boom />
      </BlockBoundary>,
    );
    err.mockRestore();
    expect(screen.getByText("兜底内容")).toBeInTheDocument();
  });
});

describe("streaming", () => {
  const full = j({ type: "table", columns: ["a", "b"], rows: [[1, 2], [3, 4], [5, 6]] });

  it("shows a type-matched skeleton before anything is known", () => {
    render(<IuiBlock code='{"type":"chart","la' live />);
    expect(document.querySelector('[data-iui-skeleton="chart"]')).toBeTruthy();
  });

  it("grows the same component in place, disables interaction until complete", () => {
    const cut = full.indexOf("[3");
    const { rerender, container } = render(<IuiBlock code={full.slice(0, cut + 4)} live />);
    const figure = container.querySelector("figure");
    expect(figure).toHaveAttribute("data-streaming", "true");
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "按「a」排序" })).toBeDisabled();
    rerender(<IuiBlock code={full} live />);
    // 同一个 DOM 节点:没有重挂载
    expect(container.querySelector("figure")).toBe(figure);
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(figure).not.toHaveAttribute("data-streaming");
    expect(screen.getByRole("button", { name: "按「a」排序" })).not.toBeDisabled();
  });

  it("keeps interactive components as skeletons until complete", () => {
    render(<IuiBlock code='{"type":"calculator","inputs":[{"id":"a","value":1}],"outputs":[{"id":"o","formula":"a' live />);
    expect(document.querySelector('[data-iui-skeleton="calculator"]')).toBeTruthy();
  });

  it("an unfinished block becomes the raw fallback once the message ends", () => {
    const { rerender } = render(<IuiBlock code='{"type":"table","columns":[' live />);
    expect(document.querySelector('[data-iui-skeleton="table"]')).toBeTruthy();
    rerender(<IuiBlock code='{"type":"table","columns":[' />);
    expect(screen.getByText(/无法显示|无法解析/)).toBeInTheDocument();
  });
});

describe("switch on/off through the Markdown renderer", () => {
  const doc = ["对比如下:", "", "```ui", j({ type: "table", columns: ["型号", "价格"], rows: [["A", 100]] }), "```", "", "以上。"].join("\n");

  it("on: renders the native component", () => {
    const { container } = render(<MarkdownImpl>{doc}</MarkdownImpl>);
    expect(container.querySelector('figure[data-iui="table"]')).toBeTruthy();
    expect(container.textContent).not.toContain('"type"');
  });

  it("off: renders plain Markdown (a GFM table), never raw JSON, and switches back instantly", () => {
    setIntelligentUiPref(false);
    const { container } = render(<MarkdownImpl>{doc}</MarkdownImpl>);
    expect(container.querySelector("figure[data-iui]")).toBeNull();
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.textContent).toContain("型号");
    expect(container.textContent).not.toContain('"type"');
    act(() => setIntelligentUiPref(true));
    expect(container.querySelector('figure[data-iui="table"]')).toBeTruthy();
  });

  it("server kill switch acts as off even when the user preference is on", () => {
    applyIntelligentUiSnapshot({ prefs: { intelligent_ui: true }, features: { intelligent_ui: { available: false } } });
    const { container } = render(<MarkdownImpl>{doc}</MarkdownImpl>);
    expect(container.querySelector("figure[data-iui]")).toBeNull();
  });

  it("missing preference and old servers default to on", () => {
    applyIntelligentUiSnapshot({ prefs: {} });
    const { container } = render(<MarkdownImpl>{doc}</MarkdownImpl>);
    expect(container.querySelector('figure[data-iui="table"]')).toBeTruthy();
  });

  it("export writes the Markdown version of components", () => {
    const msgs = [{ role: "assistant", text: doc, ts: Number.NaN } as unknown as ChatMessage];
    const md = exportSessionMarkdown(msgs);
    expect(md).toContain("| 型号 | 价格 |");
    expect(md).not.toContain("```ui");
  });
});
