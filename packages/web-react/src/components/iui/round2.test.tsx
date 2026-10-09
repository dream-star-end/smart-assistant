import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIntelligentUiForTests } from "../../lib/intelligentUi";
import { ChatInteractionContext } from "../tool/context";
import { composeFormMessage, scaleAmount } from "./InteractiveBlocks";
import { IuiBlock } from "./IuiBlock";
import { imageSrc, validateSpec } from "./schema";
import { kitchenRound, specToMarkdown, uiFencesToMarkdown } from "./toMarkdown";

const j = (v: unknown) => JSON.stringify(v);
const ok = (raw: Record<string, unknown>) => {
  const v = validateSpec(raw, false);
  if (!v.ok) throw new Error(`expected ok, got ${v.reason}`);
  return v.spec;
};

const setMotion = (reduce: boolean) =>
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: reduce && q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }),
  });

beforeEach(() => {
  setMotion(true);
  __resetIntelligentUiForTests();
  try {
    localStorage.clear();
  } catch {
    /* jsdom */
  }
});
afterEach(cleanup);

describe("schema · new components", () => {
  it("image sources: only https and container files, never http/data/traversal", () => {
    expect(imageSrc("https://images.example.com/a.jpg")).toBe("https://images.example.com/a.jpg");
    expect(imageSrc("/home/agent/.openclaude/workspace/out/menu.png")).toBe("/home/agent/.openclaude/workspace/out/menu.png");
    expect(imageSrc("/api/media/abc123")).toBe("/api/media/abc123");
    expect(imageSrc("http://example.com/a.jpg")).toBeUndefined();
    expect(imageSrc("data:image/png;base64,AAAA")).toBeUndefined();
    expect(imageSrc("/home/agent/../../etc/passwd")).toBeUndefined();
    expect(imageSrc("javascript:alert(1)")).toBeUndefined();
    expect(imageSrc('https://x.example/a.png" onerror="x')).toBeUndefined();
  });

  it("cards keep valid items, drop unsafe images and non-http links, cap tags", () => {
    const s = ok({
      type: "menu",
      items: [
        { title: "烤羊腿", image: "https://img.example/lamb.jpg", tags: ["主菜", "迷迭香", "a", "b", "c"], url: "javascript:x" },
        { name: "土豆", image: "http://img.example/p.jpg", icon: "carrot", price: "¥12" },
        { body: "没有标题的会被丢掉" },
      ],
    });
    if (s.type !== "cards") throw new Error("cards");
    expect(s.items).toHaveLength(2);
    expect(s.items[0]!.image).toBe("https://img.example/lamb.jpg");
    expect(s.items[0]!.url).toBeUndefined();
    expect(s.items[0]!.tags).toHaveLength(4);
    expect(s.items[1]!.image).toBeUndefined();
    expect(s.items[1]!.meta).toBe("¥12");
    expect(s.layout).toBe("list");
  });

  it("gallery, swatches and tiles normalize their input", () => {
    expect(validateSpec({ type: "gallery", images: ["http://x/a.jpg"] }, false).ok).toBe(false);
    const sw = ok({ type: "palette", colors: [{ hex: "#F5EFE6", name: "奶油白" }, "#7b4a2d", "red", { hex: "#12345" }] });
    if (sw.type !== "swatches") throw new Error("swatches");
    expect(sw.colors.map((c) => c.hex)).toEqual(["#f5efe6", "#7b4a2d"]);
    const t = ok({ type: "tiles", columns: 9, items: [{ title: "生菜", tone: "green", span: 5 }, { title: "香草", tone: "neon" }] });
    if (t.type !== "tiles") throw new Error("tiles");
    expect(t.columns).toBe(4);
    expect(t.items[0]!.span).toBe(1);
    expect(t.items[1]!.tone).toBe("amber");
  });

  it("recipe, quiz, progress, kv, form and route validate", () => {
    const r = ok({ type: "recipe", servings: "4", ingredients: [{ name: "羊腿", amount: 1.6, unit: "kg" }, "盐"], steps: ["腌制", "烤"] });
    if (r.type !== "recipe") throw new Error("recipe");
    expect(r.servings).toBe(4);
    expect(r.ingredients[1]).toEqual({ name: "盐" });
    expect(validateSpec({ type: "recipe", ingredients: ["盐"] }, false).ok).toBe(false);

    const q = ok({
      type: "quiz",
      questions: [
        { question: "越位要在对方半场吗?", options: ["要", "不要"], answer: "要" },
        { question: "坏题", options: ["a", "b"], answer: 5 },
      ],
    });
    if (q.type !== "quiz") throw new Error("quiz");
    expect(q.questions).toHaveLength(1);
    expect(q.questions[0]!.answer).toBe(0);

    const p = ok({ type: "bars", items: [{ label: "蛋白质", value: 62 }, { label: "预算", value: 9000, max: 8000, unit: "元", tone: "warn" }] });
    if (p.type !== "progress") throw new Error("progress");
    expect(p.items[0]!.max).toBe(100);
    expect(p.items[1]!.tone).toBe("warn");

    const kv = ok({ type: "specs", items: { 重量: "1.24 kg", 屏幕: "13.6 英寸" } });
    if (kv.type !== "kv") throw new Error("kv");
    expect(kv.items).toEqual([
      { label: "重量", value: "1.24 kg" },
      { label: "屏幕", value: "13.6 英寸" },
    ]);

    const f = ok({
      type: "form",
      fields: [
        { id: "who", label: "几个人", kind: "number", unit: "人", required: true },
        { label: "口味", kind: "chips", options: ["清淡", "重口"], multi: true },
        { label: "没有选项的 chips 变文本", kind: "chips" },
        { id: "who", label: "重复 id 换一个" },
      ],
    });
    if (f.type !== "form") throw new Error("form");
    expect(f.fields.map((x) => x.kind)).toEqual(["number", "chips", "text", "text"]);
    expect(new Set(f.fields.map((x) => x.id)).size).toBe(4);
    expect(f.submit).toBe("发送");

    const rt = ok({ type: "itinerary", stops: ["旧金山", { name: "大苏尔", note: "值得绕路", highlight: true }, "洛杉矶"], legs: [{ distance: "240 km" }, {}, { distance: "多余的一段" }] });
    if (rt.type !== "route") throw new Error("route");
    expect(rt.legs).toHaveLength(2);
    expect(validateSpec({ type: "route", stops: ["只有一站"] }, false).ok).toBe(false);
  });

  it("tabs can hold one nested component, never nested tabs", () => {
    const s = ok({
      type: "tabs",
      tabs: [
        { label: "投资", block: { type: "stats", items: [{ label: "终值", value: 300851 }] } },
        { label: "套娃", block: { type: "tabs", tabs: [{ label: "x", body: "y" }] } },
        { label: "空的" },
      ],
    });
    if (s.type !== "tabs") throw new Error("tabs");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0]!.block?.type).toBe("stats");
    expect(specToMarkdown(s)).toContain("**终值**:300,851");
  });

  it("calculator chart and breakdown only reference real ids", () => {
    const base = {
      type: "calculator",
      inputs: [
        { id: "monthly", label: "每月投入", value: 1000 },
        { id: "years", label: "年数", value: 20 },
      ],
      outputs: [
        { id: "value", label: "终值", formula: "monthly*12*years*1.5", primary: true },
        { id: "invested", label: "投入", formula: "monthly*12*years" },
        { id: "growth", label: "增长", formula: "value-invested", tone: "up" },
      ],
    };
    const s = ok({ ...base, breakdown: ["invested", "growth", "nope"], chart: { x: "years", from: 0, to: "years", series: ["value", "invested", "ghost"] } });
    if (s.type !== "calculator") throw new Error("calc");
    expect(s.breakdown).toEqual(["invested", "growth"]);
    expect(s.chart).toEqual({ kind: "area", x: "years", from: 0, to: "years", points: 0, series: ["value", "invested"] });
    expect(s.outputs[2]!.tone).toBe("up");
    const bad = ok({ ...base, breakdown: ["invested"], chart: { x: "ghost", from: 0, to: 10, series: ["value"] } });
    if (bad.type !== "calculator") throw new Error("calc");
    expect(bad.breakdown).toEqual([]);
    expect(bad.chart).toBeUndefined();
    expect(specToMarkdown(s)).toContain("曲线(年数 从 0 到 20)");
  });

  it("the example in the master prompt passes this validator unchanged", () => {
    const src = readFileSync(resolve(__dirname, "../../../../commercial/src/intelligentUi/index.ts"), "utf8");
    const line = /'(\{"type":"tabs".*\})',\n\s*F,/.exec(src)?.[1];
    expect(line).toBeTruthy();
    const v = validateSpec(JSON.parse(line!) as Record<string, unknown>, false);
    expect(v.ok && v.notes).toEqual([]);
    if (!v.ok || v.spec.type !== "tabs") throw new Error("tabs");
    const calc = v.spec.tabs[0]!.block;
    expect(calc?.type === "calculator" && calc.chart && calc.breakdown.length).toBe(2);
  });

  it("subtitle is accepted on titled components", () => {
    const s = ok({ type: "kv", title: "规格", subtitle: "官方数据", items: [{ label: "a", value: "b" }] });
    expect(s.type === "kv" && s.subtitle).toBe("官方数据");
    const c = ok({ type: "callout", body: "x", subtitle: "不支持" });
    expect("subtitle" in c).toBe(false);
  });

  it("kitchen rounding and recipe scaling", () => {
    expect(kitchenRound(1503)).toBe(1505);
    expect(kitchenRound(37.6)).toBe(38);
    expect(kitchenRound(2.44)).toBe(2.4);
    expect(scaleAmount(1500, 5, 8)).toBe(2400);
    expect(scaleAmount(2, 5, 8)).toBe(3.2);
  });

  it("every new component converts to readable Markdown (off mode, copy, export)", () => {
    const blocks = [
      { type: "cards", title: "菜单", items: [{ title: "烤羊腿", body: "迷迭香", url: "https://example.com/r" }] },
      { type: "gallery", images: [{ src: "https://img.example/1.jpg", caption: "奶油白针织" }] },
      { type: "swatches", colors: [{ hex: "#7b4a2d", name: "巧克力" }] },
      { type: "tiles", title: "菜园", items: [{ title: "生菜", subtitle: "24 寸盆" }], caption: "示意" },
      { type: "recipe", servings: 5, ingredients: [{ name: "羊腿", amount: 2, unit: "kg" }], steps: ["烤"] },
      { type: "quiz", questions: [{ question: "Q?", options: ["a", "b"], answer: 1, explain: "因为" }] },
      { type: "progress", items: [{ label: "预算", value: 50, max: 200, unit: "元" }] },
      { type: "kv", items: [{ label: "重量", value: "1 kg" }] },
      { type: "form", fields: [{ label: "人数" }] },
      { type: "route", stops: ["A", "B"], legs: [{ distance: "10 km", duration: "15 分钟" }] },
    ];
    const text = blocks.map((b) => `\`\`\`ui\n${j(b)}\n\`\`\``).join("\n\n");
    const md = uiFencesToMarkdown(text);
    expect(md).not.toContain("```");
    for (const needle of ["[烤羊腿](https://example.com/r)", "奶油白针织", "`#7b4a2d`", "**生菜**", "羊腿:2 kg", "答案:B", "预算", "| 重量 | 1 kg |", "人数", "↓ 10 km · 15 分钟"]) {
      expect(md).toContain(needle);
    }
    // 食谱按份数换算
    const r = ok({ type: "recipe", servings: 5, ingredients: [{ name: "土豆", amount: 1500, unit: "g" }] });
    expect(specToMarkdown(r, { servings: 8 })).toContain("土豆:2,400 g");
  });
});

describe("render · new components", () => {
  it("cards render images without referrer, fall back to an icon tile, open links in a new tab", () => {
    const { container } = render(
      <IuiBlock
        code={j({
          type: "cards",
          title: "周日菜单",
          subtitle: "按 5 人准备",
          items: [
            { title: "迷迭香烤羊腿", body: "柠檬、蒜、迷迭香", image: "https://img.example/lamb.jpg", url: "https://example.com/lamb" },
            { title: "脆皮土豆", icon: "carrot", tags: ["配菜"] },
          ],
        })}
      />,
    );
    expect(screen.getByText("按 5 人准备")).toBeInTheDocument();
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(img).toHaveAttribute("loading", "lazy");
    const link = screen.getByRole("link", { name: /迷迭香烤羊腿/ });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(container.querySelectorAll(".oc-iui-media-fallback")).toHaveLength(1);
    // 图片加载失败 → 色块,不留破图
    fireEvent.error(img);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByRole("img", { name: /图片无法加载/ })).toBeInTheDocument();
  });

  it("gallery shows at most three images and a +N badge", () => {
    const { container } = render(
      <IuiBlock code={j({ type: "gallery", images: ["https://i.example/1.jpg", "https://i.example/2.jpg", "https://i.example/3.jpg", "https://i.example/4.jpg"] })} />,
    );
    expect(container.querySelectorAll("img")).toHaveLength(3);
    expect(screen.getByText("+1")).toBeInTheDocument();
  });

  it("swatches copy the hex value", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<IuiBlock code={j({ type: "swatches", colors: [{ hex: "#7b4a2d", name: "巧克力" }] })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /巧克力/ }));
    });
    expect(writeText).toHaveBeenCalledWith("#7b4a2d");
  });

  it("tiles lay out in the requested columns with tone classes", () => {
    const { container } = render(<IuiBlock code={j({ type: "tiles", columns: 2, items: [{ title: "生菜", tone: "green", icon: "leaf" }, { title: "香草", tone: "amber" }] })} />);
    expect(container.querySelector(".oc-iui-tiles")).toHaveStyle({ gridTemplateColumns: "repeat(2, minmax(0, 1fr))" });
    expect(container.querySelector(".oc-iui-tile.is-green")).toHaveTextContent("生菜");
    expect(container.querySelector(".oc-iui-tile.is-amber svg")).toBeNull();
  });

  it("recipe rescales every amount when servings change", () => {
    render(<IuiBlock code={j({ type: "recipe", title: "烤羊腿", servings: 5, ingredients: [{ name: "羊腿", amount: 2, unit: "kg" }, { name: "土豆", amount: 1500, unit: "g" }, { name: "盐" }] })} />);
    const list = screen.getByRole("list", { name: "用料" });
    expect(list).toHaveTextContent("2 kg");
    expect(list).toHaveTextContent("1,500 g");
    expect(list).toHaveTextContent("适量");
    for (let i = 0; i < 3; i++) fireEvent.click(screen.getByRole("button", { name: "增加份量" }));
    expect(screen.getByText("8 人")).toBeInTheDocument();
    expect(list).toHaveTextContent("3.2 kg");
    expect(list).toHaveTextContent("2,400 g");
  });

  it("quiz scores locally and explains the answer", () => {
    render(
      <IuiBlock
        code={j({
          type: "quiz",
          title: "越位小测",
          questions: [
            { question: "在本方半场能越位吗?", options: ["能", "不能"], answer: 1, explain: "越位只在对方半场成立。" },
            { question: "手算越位位置吗?", options: ["算", "不算"], answer: 1 },
          ],
        })}
      />,
    );
    expect(screen.getByText("第 1 题 · 共 2 题")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "能" }));
    expect(screen.getByText("正确答案是 B")).toBeInTheDocument();
    expect(screen.getByText("越位只在对方半场成立。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /不能/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /下一题/ }));
    fireEvent.click(screen.getByRole("button", { name: /不算/ }));
    expect(screen.getByText("答对了")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /看结果/ }));
    expect(screen.getByText("1")).toHaveTextContent("1 / 2");
    fireEvent.click(screen.getByRole("button", { name: /再做一次/ }));
    expect(screen.getByText("第 1 题 · 共 2 题")).toBeInTheDocument();
  });

  it("form requires required fields, sends one composed message and locks", () => {
    const sendUserText = vi.fn();
    const spec = {
      type: "form",
      title: "帮你规划",
      fields: [
        { id: "days", label: "玩几天", kind: "number", unit: "天", required: true },
        { id: "style", label: "偏好", kind: "chips", options: ["自然", "城市", "美食"], multi: true },
        { id: "budget", label: "预算", kind: "select", options: ["5 千内", "1 万内"] },
      ],
      submit: "开始规划",
    };
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock code={j(spec)} />
      </ChatInteractionContext.Provider>,
    );
    const send = screen.getByRole("button", { name: "开始规划" });
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/玩几天/), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "自然" }));
    fireEvent.click(screen.getByRole("button", { name: "美食" }));
    expect(screen.getByRole("button", { name: "美食" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(send);
    fireEvent.click(send);
    expect(sendUserText).toHaveBeenCalledTimes(1);
    expect(sendUserText).toHaveBeenCalledWith("帮你规划:\n- 玩几天:5 天\n- 偏好:自然、美食\n- 预算:5 千内");
    expect(screen.getByText("已发送")).toBeInTheDocument();
    const v = validateSpec(spec, false);
    if (!v.ok || v.spec.type !== "form") throw new Error("form");
    expect(composeFormMessage(v.spec, { days: "", style: [], budget: "1 万内" })).toBe("帮你规划:\n- 预算:1 万内");
    cleanup();
    render(
      <ChatInteractionContext.Provider value={{ sendUserText }}>
        <IuiBlock code={j(spec)} readOnly />
      </ChatInteractionContext.Provider>,
    );
    expect(screen.getByLabelText(/玩几天/)).toBeDisabled();
  });

  it("progress, kv and route render their data accessibly", () => {
    render(
      <>
        <IuiBlock code={j({ type: "progress", title: "今日营养", items: [{ label: "蛋白质", value: 62, max: 90, unit: "g" }, { label: "钠", value: 2600, max: 2000, unit: "mg" }] })} />
        <IuiBlock code={j({ type: "kv", title: "规格", items: [{ label: "重量", value: "1.24 kg" }] })} />
        <IuiBlock code={j({ type: "route", title: "一号公路", stops: ["旧金山", { name: "大苏尔", note: "值得绕路", highlight: true }, "洛杉矶"], legs: [{ mode: "自驾", distance: "240 km", duration: "3 小时" }] })} />
      </>,
    );
    const bars = screen.getAllByRole("progressbar");
    expect(bars[0]).toHaveAttribute("aria-valuenow", "62");
    expect(bars[1]!.closest("li")).toHaveClass("is-over");
    expect(screen.getByText("1.24 kg")).toBeInTheDocument();
    expect(screen.getByText("值得绕路")).toBeInTheDocument();
    expect(screen.getByText("自驾 · 240 km · 3 小时")).toBeInTheDocument();
  });

  it("table draws data bars, highlights a row and turns ✓/✗ into labelled icons", () => {
    const { container } = render(
      <IuiBlock
        code={j({ type: "table", columns: ["机型", { label: "续航", unit: "小时", bar: true }, "雷电口"], rows: [["A", 18, "✓"], ["B", 9, "✗"]], highlight: 0 })}
      />,
    );
    expect(container.querySelectorAll(".oc-iui-cellbar")).toHaveLength(2);
    expect(container.querySelector("tr.is-highlight")).toHaveTextContent("A");
    expect(screen.getByRole("img", { name: "是" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "否" })).toBeInTheDocument();
    // 排序后高亮跟着原来那一行走
    fireEvent.click(screen.getByRole("button", { name: "按「续航」排序" }));
    expect(container.querySelector("tr.is-highlight")).toHaveTextContent("A");
  });

  it("stats draw a sparkline for trends", () => {
    const { container } = render(<IuiBlock code={j({ type: "stats", items: [{ label: "体重", value: 68.2, unit: "kg", delta: "-1.4", trend: [70, 69.6, 69.1, 68.8, 68.2] }] })} />);
    expect(container.querySelector(".oc-iui-spark")).toBeTruthy();
  });

  it("calculator shows the primary result, a coloured delta, a breakdown and a swept curve", () => {
    const { container } = render(
      <IuiBlock
        code={j({
          type: "calculator",
          title: "定投",
          inputs: [
            { id: "monthly", label: "每月投入", value: 1000, step: 100, unit: "元" },
            { id: "years", label: "年数", kind: "slider", value: 10, min: 1, max: 40, step: 1, unit: "年" },
          ],
          outputs: [
            { id: "value", label: "终值", formula: "monthly*12*years*1.5", unit: "元", format: "integer", primary: true },
            { id: "invested", label: "累计投入", formula: "monthly*12*years", unit: "元", format: "integer" },
            { id: "growth", label: "收益", formula: "value-invested", unit: "元", format: "integer", tone: "up" },
          ],
          breakdown: ["invested", "growth"],
          chart: { x: "years", from: 0, to: "years", series: ["value", "invested"], kind: "area" },
        })}
      />,
    );
    expect(container.querySelector(".oc-iui-calc-primary-value")).toHaveTextContent("180,000元");
    expect(container.querySelector(".oc-iui-calc-delta.is-up")).toHaveTextContent("60,000元收益");
    expect(container.querySelector(".oc-iui-breakdown-bar")?.children).toHaveLength(2);
    const readout = container.querySelector(".oc-iui-calc-chart .oc-iui-readout")!;
    expect(readout).toHaveTextContent("10年");
    expect(readout).toHaveTextContent("180,000元");
    fireEvent.change(screen.getByLabelText("年数"), { target: { value: "20" } });
    expect(readout).toHaveTextContent("20年");
    expect(container.querySelector(".oc-iui-range")).toHaveStyle({ "--pct": `${(19 / 39) * 100}%` });
  });

  it("the primary result eases to a new value when motion is allowed, and lands exactly on it", async () => {
    setMotion(false);
    const { container } = render(
      <IuiBlock
        code={j({
          type: "calculator",
          inputs: [{ id: "a", label: "数量", value: 10 }],
          outputs: [{ id: "b", label: "十倍", formula: "a*10", format: "integer", primary: true }],
        })}
      />,
    );
    const value = () => container.querySelector(".oc-iui-calc-primary-value")!.textContent;
    expect(value()).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: "增加数量" }));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(value()).toBe("110");
  });

  it("tabs render a nested calculator inside the panel without a second card", () => {
    const { container } = render(
      <IuiBlock
        code={j({
          type: "tabs",
          title: "理财计算器",
          tabs: [
            { label: "投资", block: { type: "calculator", inputs: [{ id: "a", label: "本金", value: 100 }], outputs: [{ id: "b", label: "两倍", formula: "a*2", primary: true }] } },
            { label: "说明", body: "只是示例" },
          ],
        })}
      />,
    );
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText("两倍")).toBeInTheDocument();
    expect(container.querySelectorAll(".oc-iui-card")).toHaveLength(1);
    expect(panel.querySelector(".oc-iui-nested")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "说明" }));
    expect(screen.getByRole("tabpanel")).toHaveTextContent("只是示例");
  });

  it("interactive new components wait for the complete block while streaming", () => {
    for (const partial of [
      '{"type":"quiz","questions":[{"question":"Q","options":["a","b"],"answer":1}',
      '{"type":"form","fields":[{"label":"人数"}',
      '{"type":"recipe","servings":5,"ingredients":[{"name":"羊腿"}',
      '{"type":"tabs","tabs":[{"label":"x","block":{"type":"stats","items":[{"label":"a","value":1}]}}',
    ]) {
      const { container, unmount } = render(<IuiBlock code={partial} live />);
      expect(container.querySelector("[data-iui-skeleton]")).toBeTruthy();
      unmount();
    }
    const { container } = render(<IuiBlock code={'{"type":"cards","items":[{"title":"烤羊腿"}'} live />);
    expect(container.querySelector("[data-iui=cards]")).toHaveTextContent("烤羊腿");
  });
});
