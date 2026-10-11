/**
 * Intelligent UI(OCV5-361)—— 组件 schema 校验与规范化。
 *
 * 手写校验(web-react 不引 zod)。原则:能修就修(截断超限项、丢非法行、数字字符串转数字),
 * 修过的在 `notes` 里留一句,组件底部显示「部分内容已省略」;修不了才返回 ok:false 降级。
 * `partial` = 流式半截:必填数组允许为空,只要 type 已知就先渲染已有部分。
 * 这里的上限是渲染护栏(防止超大块拖垮页面),不约束模型使用组件的意愿。
 */

import { needsSignedSrc } from "../../lib/chat/media";

export type Cell = string | number | null;

/** 标题下的一行说明;所有带标题的组件都可写。 */
type Sub = { subtitle?: string };

export type TableSpec = Sub & {
  type: "table";
  title?: string;
  columns: { label: string; unit?: string; align: "left" | "right"; bar: boolean }[];
  rows: Cell[][];
  /** 强调行(0 起,按原始顺序)。 */
  highlight?: number;
  source?: string;
  note?: string;
};

export type ChartKind = "bar" | "line" | "area" | "pie";
export type ChartSpec = Sub & {
  type: "chart";
  kind: ChartKind;
  title?: string;
  labels: string[];
  series: { name: string; values: (number | null)[] }[];
  unit?: string;
  xLabel?: string;
  yLabel?: string;
  stacked: boolean;
  source?: string;
  note?: string;
};

export type StatTone = "up" | "down" | "neutral";
export type StatsSpec = Sub & {
  type: "stats";
  title?: string;
  items: { label: string; value: string | number; unit?: string; delta?: string; tone?: StatTone; basis?: string; trend?: number[] }[];
  source?: string;
};

export type StepsSpec = Sub & {
  type: "steps";
  title?: string;
  checkable: boolean;
  items: { title: string; detail?: string; done: boolean }[];
};

export type CompareSpec = Sub & {
  type: "compare";
  title?: string;
  items: {
    name: string;
    tag?: string;
    price?: string;
    image?: string;
    summary?: string;
    points: string[];
    pros: string[];
    cons: string[];
    recommended: boolean;
  }[];
  verdict?: string;
};

export type ChoiceSpec = {
  type: "choice";
  question?: string;
  multi: boolean;
  options: { label: string; desc?: string }[];
};

export type CalcInput = {
  id: string;
  label: string;
  kind: "number" | "slider" | "select" | "toggle";
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options: { label: string; value: number }[];
};
export type CalcFormat = "number" | "integer" | "currency" | "percent";
export type CalcOutput = {
  id: string;
  label: string;
  formula: string;
  unit?: string;
  format: CalcFormat;
  decimals?: number;
  primary: boolean;
  tone?: "up" | "down";
};
/** 按某个输入扫描画曲线:x 从 from 到 to(数字或输入 id),每个点重算 series 里的输出。 */
export type CalcChart = { kind: "area" | "line" | "bar"; x: string; from: number; to: number | string; points: number; series: string[]; xLabel?: string };
export type CalculatorSpec = Sub & {
  type: "calculator";
  title?: string;
  inputs: CalcInput[];
  outputs: CalcOutput[];
  /** 占比条:这些输出按数值比例并排。 */
  breakdown: string[];
  chart?: CalcChart;
  assumptions: string[];
  note?: string;
};

export type CalloutTone = "info" | "tip" | "warning" | "danger" | "success";
export type CalloutSpec = { type: "callout"; tone: CalloutTone; title?: string; body: string };

/** 分段里可以放一个完整组件(不能再嵌 tabs)。 */
export type TabsSpec = Sub & { type: "tabs"; title?: string; tabs: { label: string; body: string; block?: Exclude<IuiSpec, TabsSpec> }[] };

export type TimelineSpec = Sub & {
  type: "timeline";
  title?: string;
  items: { time: string; title: string; detail?: string }[];
};

export type SuggestionsSpec = { type: "suggestions"; items: string[] };

export type CardItem = { title: string; subtitle?: string; body?: string; image?: string; icon?: string; tags: string[]; meta?: string; url?: string };
export type CardsSpec = Sub & { type: "cards"; title?: string; layout: "list" | "grid"; items: CardItem[] };

export type GallerySpec = Sub & { type: "gallery"; title?: string; images: { src: string; caption?: string }[]; caption?: string };

export type SwatchesSpec = Sub & { type: "swatches"; title?: string; colors: { hex: string; name?: string }[] };

export const TILE_TONES = ["green", "amber", "sky", "rose", "violet", "slate"] as const;
export type TileTone = (typeof TILE_TONES)[number];
export type TilesSpec = Sub & {
  type: "tiles";
  title?: string;
  columns: number;
  items: { title: string; subtitle?: string; icon?: string; tone: TileTone; span: number }[];
  caption?: string;
};

export type RecipeSpec = Sub & {
  type: "recipe";
  title?: string;
  servings: number;
  unit: string;
  ingredients: { name: string; amount?: number; unit?: string; note?: string }[];
  steps: string[];
  meta: { label: string; value: string }[];
};

export type QuizSpec = Sub & {
  type: "quiz";
  title?: string;
  questions: { question: string; options: string[]; answer: number; explain?: string }[];
};

export type ProgressTone = "default" | "good" | "warn" | "bad";
export type ProgressSpec = Sub & {
  type: "progress";
  title?: string;
  items: { label: string; value: number; max: number; unit?: string; tone: ProgressTone; note?: string }[];
  source?: string;
};

export type KvSpec = Sub & { type: "kv"; title?: string; items: { label: string; value: string }[]; source?: string };

export type FormField = {
  id: string;
  label: string;
  kind: "text" | "number" | "select" | "chips" | "date";
  options: string[];
  multi: boolean;
  placeholder?: string;
  unit?: string;
  required: boolean;
  value?: string;
};
export type FormSpec = Sub & { type: "form"; title?: string; fields: FormField[]; submit: string };

export type RouteSpec = Sub & {
  type: "route";
  title?: string;
  stops: { name: string; detail?: string; note?: string; highlight: boolean }[];
  legs: { distance?: string; duration?: string; mode?: string }[];
};

/** 回答里用到的来源。正文用 [1] [2] 引用;链接只认 http(s)。 */
export type SourceItem = { title: string; url?: string; site?: string; date?: string; note?: string };
export type SourcesSpec = Sub & { type: "sources"; title?: string; items: SourceItem[] };

/** 大纲 / 思维导图:最多 4 层的树。 */
export type OutlineNode = { title: string; detail?: string; children: OutlineNode[] };
export type OutlineSpec = Sub & { type: "outline"; title?: string; view: "tree" | "map"; items: OutlineNode[] };

/** 成稿:可直接发出去的文字,1–3 个版本;original = 改写前的原文(显示修改对比)。 */
export const DRAFT_KINDS = ["email", "message", "post", "doc"] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];
export type DraftSpec = Sub & {
  type: "draft";
  title?: string;
  kind?: DraftKind;
  variants: { label: string; subject?: string; text: string }[];
  original?: string;
  note?: string;
};

export type IuiSpec =
  | SourcesSpec
  | OutlineSpec
  | DraftSpec
  | TableSpec
  | ChartSpec
  | StatsSpec
  | StepsSpec
  | CompareSpec
  | ChoiceSpec
  | CalculatorSpec
  | CalloutSpec
  | TabsSpec
  | TimelineSpec
  | SuggestionsSpec
  | CardsSpec
  | GallerySpec
  | SwatchesSpec
  | TilesSpec
  | RecipeSpec
  | QuizSpec
  | ProgressSpec
  | KvSpec
  | FormSpec
  | RouteSpec;

export type IuiType = IuiSpec["type"];

export const IUI_TYPES: readonly IuiType[] = [
  "table",
  "chart",
  "stats",
  "steps",
  "compare",
  "choice",
  "calculator",
  "callout",
  "tabs",
  "timeline",
  "suggestions",
  "cards",
  "gallery",
  "swatches",
  "tiles",
  "recipe",
  "quiz",
  "progress",
  "kv",
  "form",
  "route",
  "sources",
  "outline",
  "draft",
];

export type ValidateResult =
  | { ok: true; spec: IuiSpec; notes: string[] }
  | { ok: false; reason: string };

export const LIMITS = {
  text: 4000,
  short: 300,
  tableCols: 12,
  tableRows: 200,
  chartLabels: 60,
  chartSeries: 6,
  statsItems: 8,
  listItems: 30,
  compareItems: 6,
  compareList: 12,
  choiceOptions: 12,
  calcInputs: 12,
  calcOutputs: 12,
  tabs: 8,
  suggestions: 6,
  cards: 12,
  images: 12,
  swatches: 12,
  tiles: 16,
  ingredients: 40,
  quiz: 10,
  quizOptions: 6,
  progress: 12,
  kv: 30,
  formFields: 10,
  stops: 12,
  trend: 60,
  sources: 12,
  outlineDepth: 4,
  outlineNodes: 80,
  outlineChildren: 20,
  draftVariants: 3,
} as const;

type Ctx = { notes: string[]; partial: boolean };

function str(v: unknown, max: number = LIMITS.short): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/[,\s_]/g, "");
    if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(cleaned)) {
      const n = Number(cleaned);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function cap<T>(items: T[], max: number, ctx: Ctx, what: string): T[] {
  if (items.length <= max) return items;
  ctx.notes.push(`${what}超过 ${max} 项,已省略其余`);
  return items.slice(0, max);
}

function strList(v: unknown, max: number, ctx: Ctx, what: string, len: number = LIMITS.short): string[] {
  const out: string[] = [];
  for (const item of arr(v)) {
    const s = str(item, len);
    if (s) out.push(s);
  }
  return cap(out, max, ctx, what);
}

function pickOne<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function numList(v: unknown, max: number): number[] | undefined {
  const out = arr(v)
    .map((x) => num(x))
    .filter((x): x is number => x !== undefined)
    .slice(0, max);
  return out.length >= 2 ? out : undefined;
}

/** 图片只认 https 外链与容器内文件路径(走现有签名管线);http / data / 其它一律不加载。 */
export function imageSrc(v: unknown): string | undefined {
  const s = str(v, 2000);
  if (!s) return undefined;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s)) return s;
  if (!s.includes("..") && needsSignedSrc(s)) return s;
  return undefined;
}

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function calcChart(v: unknown, inputs: CalcInput[], outIds: Set<string>): CalcChart | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  const x = typeof o.x === "string" ? o.x : "";
  if (!inputs.some((i) => i.id === x)) return undefined;
  const series = arr(o.series)
    .filter((id): id is string => typeof id === "string" && outIds.has(id))
    .slice(0, 4);
  if (series.length === 0) return undefined;
  const from = num(o.from) ?? 0;
  const toRaw = o.to;
  const to = typeof toRaw === "string" && inputs.some((i) => i.id === toRaw) ? toRaw : num(toRaw);
  if (to === undefined) return undefined;
  const points = Math.round(num(o.points) ?? 0);
  return {
    kind: pickOne<CalcChart["kind"]>(o.kind, ["area", "line", "bar"], "area"),
    x,
    from,
    to,
    points: points >= 2 && points <= 120 ? points : 0,
    series,
    ...optional("xLabel", str(o.x_label ?? o.xLabel, 40)),
  };
}

// ── 各类型 ─────────────────────────────────────────────────────────────

function table(raw: Record<string, unknown>, ctx: Ctx): TableSpec | null {
  const columns: TableSpec["columns"] = [];
  for (const c of arr(raw.columns)) {
    if (typeof c === "string" || typeof c === "number") {
      const label = str(c);
      if (label) columns.push({ label, align: "left", bar: false });
    } else if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const label = str(o.label ?? o.name ?? o.title);
      if (!label) continue;
      columns.push({ label, ...optional("unit", str(o.unit, 24)), align: o.align === "right" ? "right" : "left", bar: o.bar === true });
    }
  }
  const cols = cap(columns, LIMITS.tableCols, ctx, "列");
  const rows: Cell[][] = [];
  for (const r of arr(raw.rows)) {
    let cells: unknown[];
    if (Array.isArray(r)) cells = r;
    else if (r && typeof r === "object") {
      // 对象行:按列名取值(模型常写 [{"型号":"A","重量":1.2}])。
      const o = r as Record<string, unknown>;
      cells = cols.length ? cols.map((c) => o[c.label]) : Object.values(o);
    } else continue;
    const row = cells.slice(0, cols.length || LIMITS.tableCols).map((x): Cell => {
      if (x === null || x === undefined) return null;
      if (typeof x === "number") return Number.isFinite(x) ? x : null;
      if (typeof x === "boolean") return x ? "是" : "否";
      return str(x, 1000) ?? "";
    });
    rows.push(row);
  }
  // 没给列名但有行:用「列 1、列 2…」补齐。
  if (cols.length === 0 && rows.length > 0) {
    const width = Math.min(Math.max(...rows.map((r) => r.length)), LIMITS.tableCols);
    for (let i = 0; i < width; i++) cols.push({ label: `列 ${i + 1}`, align: "left", bar: false });
  }
  if (cols.length === 0 && !ctx.partial) return null;
  // 全数字列自动右对齐(未显式指定时)。
  cols.forEach((c, i) => {
    if (c.align === "left" && rows.length > 0 && rows.every((r) => r[i] == null || typeof r[i] === "number")) {
      if (rows.some((r) => typeof r[i] === "number")) c.align = "right";
    }
  });
  // 数据条只对数字列有意义。
  cols.forEach((c, i) => {
    if (c.bar && !rows.some((r) => typeof r[i] === "number")) c.bar = false;
  });
  const hl = num(raw.highlight);
  const capped = cap(rows, LIMITS.tableRows, ctx, "行");
  return {
    type: "table",
    ...optional("title", str(raw.title)),
    columns: cols,
    rows: capped,
    ...optional("highlight", hl !== undefined && Number.isInteger(hl) && hl >= 0 && hl < capped.length ? hl : undefined),
    ...optional("source", str(raw.source, 600)),
    ...optional("note", str(raw.note, 600)),
  };
}

function chart(raw: Record<string, unknown>, ctx: Ctx): ChartSpec | null {
  const kindRaw = raw.kind ?? raw.chart ?? raw.variant;
  const kind = pickOne<ChartKind>(kindRaw === "donut" || kindRaw === "doughnut" ? "pie" : kindRaw, ["bar", "line", "area", "pie"], "bar");
  let labels = strList(raw.labels ?? raw.categories ?? raw.x, LIMITS.chartLabels, ctx, "数据点", 80);
  const series: ChartSpec["series"] = [];
  const rawSeries = Array.isArray(raw.series)
    ? raw.series
    : Array.isArray(raw.values) || Array.isArray(raw.data)
      ? [{ name: str(raw.title) ?? "数值", values: raw.values ?? raw.data }]
      : [];
  for (const s of rawSeries) {
    if (!s || typeof s !== "object") continue;
    const o = s as Record<string, unknown>;
    const values = arr(o.values ?? o.data).map((v) => num(v) ?? null);
    series.push({ name: str(o.name ?? o.label) ?? `系列 ${series.length + 1}`, values });
  }
  let picked = cap(series, LIMITS.chartSeries, ctx, "数据系列");
  if (kind === "pie" && picked.length > 1) {
    ctx.notes.push("饼图只显示第一个数据系列");
    picked = picked.slice(0, 1);
  }
  // labels 缺失时按最长序列补序号。
  const longest = Math.max(0, ...picked.map((s) => s.values.length));
  if (labels.length === 0 && longest > 0) labels = Array.from({ length: Math.min(longest, LIMITS.chartLabels) }, (_, i) => String(i + 1));
  for (const s of picked) {
    if (s.values.length > labels.length) s.values = s.values.slice(0, labels.length);
    while (s.values.length < labels.length) s.values.push(null);
  }
  if (kind === "pie") {
    const s = picked[0];
    if (s?.values.some((v) => v !== null && v < 0)) {
      if (ctx.partial) return null;
      ctx.notes.push("饼图忽略了负值");
      s.values = s.values.map((v) => (v !== null && v < 0 ? null : v));
    }
  }
  const hasData = picked.some((s) => s.values.some((v) => v !== null));
  if (!hasData && !ctx.partial) return null;
  return {
    type: "chart",
    kind,
    ...optional("title", str(raw.title)),
    labels,
    series: picked,
    ...optional("unit", str(raw.unit, 24)),
    ...optional("xLabel", str(raw.x_label ?? raw.xLabel, 60)),
    ...optional("yLabel", str(raw.y_label ?? raw.yLabel, 60)),
    stacked: raw.stacked === true,
    ...optional("source", str(raw.source, 600)),
    ...optional("note", str(raw.note, 600)),
  };
}

function stats(raw: Record<string, unknown>, ctx: Ctx): StatsSpec | null {
  const items: StatsSpec["items"] = [];
  for (const it of arr(raw.items ?? raw.stats)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const label = str(o.label ?? o.name);
    const value = typeof o.value === "number" && Number.isFinite(o.value) ? o.value : str(o.value, 60);
    if (!label || value === undefined) continue;
    items.push({
      label,
      value,
      ...optional("unit", str(o.unit, 24)),
      ...optional("delta", str(o.delta ?? o.change, 40)),
      ...optional("tone", typeof o.tone === "string" ? pickOne<StatTone>(o.tone, ["up", "down", "neutral"], "neutral") : undefined),
      ...optional("basis", str(o.basis ?? o.note, 300)),
      ...optional("trend", numList(o.trend ?? o.sparkline, LIMITS.trend)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return {
    type: "stats",
    ...optional("title", str(raw.title)),
    items: cap(items, LIMITS.statsItems, ctx, "指标"),
    ...optional("source", str(raw.source, 600)),
  };
}

function steps(raw: Record<string, unknown>, ctx: Ctx): StepsSpec | null {
  const items: StepsSpec["items"] = [];
  for (const it of arr(raw.items ?? raw.steps)) {
    if (typeof it === "string") {
      const title = str(it, 600);
      if (title) items.push({ title, done: false });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = str(o.title ?? o.label ?? o.text, 600);
    if (!title) continue;
    items.push({ title, ...optional("detail", str(o.detail ?? o.description, 2000)), done: o.done === true });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return {
    type: "steps",
    ...optional("title", str(raw.title)),
    checkable: raw.checkable === true,
    items: cap(items, LIMITS.listItems, ctx, "步骤"),
  };
}

function compare(raw: Record<string, unknown>, ctx: Ctx): CompareSpec | null {
  const items: CompareSpec["items"] = [];
  for (const it of arr(raw.items ?? raw.options)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = str(o.name ?? o.title ?? o.label);
    if (!name) continue;
    items.push({
      name,
      ...optional("tag", str(o.tag ?? o.badge, 40)),
      ...optional("price", str(o.price, 40)),
      ...optional("image", imageSrc(o.image)),
      ...optional("summary", str(o.summary ?? o.description, 1000)),
      points: strList(o.points ?? o.features, LIMITS.compareList, ctx, "要点"),
      pros: strList(o.pros, LIMITS.compareList, ctx, "优点"),
      cons: strList(o.cons, LIMITS.compareList, ctx, "缺点"),
      recommended: o.recommended === true,
    });
  }
  if (items.length < (ctx.partial ? 0 : 1)) return null;
  return {
    type: "compare",
    ...optional("title", str(raw.title)),
    items: cap(items, LIMITS.compareItems, ctx, "对比项"),
    ...optional("verdict", str(raw.verdict ?? raw.conclusion, 1000)),
  };
}

function choice(raw: Record<string, unknown>, ctx: Ctx): ChoiceSpec | null {
  const options: ChoiceSpec["options"] = [];
  for (const it of arr(raw.options ?? raw.choices)) {
    if (typeof it === "string") {
      const label = str(it);
      if (label) options.push({ label });
    } else if (it && typeof it === "object") {
      const o = it as Record<string, unknown>;
      const label = str(o.label ?? o.title);
      if (label) options.push({ label, ...optional("desc", str(o.desc ?? o.description, 1000)) });
    }
  }
  if (options.length === 0 && !ctx.partial) return null;
  return {
    type: "choice",
    ...optional("question", str(raw.question ?? raw.title, 2000)),
    multi: raw.multi === true || raw.multiple === true,
    options: cap(options, LIMITS.choiceOptions, ctx, "选项"),
  };
}

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;

function calculator(raw: Record<string, unknown>, ctx: Ctx): CalculatorSpec | null {
  const seen = new Set<string>();
  const inputs: CalcInput[] = [];
  for (const it of arr(raw.inputs)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!ID_RE.test(id) || seen.has(id)) continue;
    const label = str(o.label) ?? id;
    const kind = pickOne<CalcInput["kind"]>(o.kind ?? o.type, ["number", "slider", "select", "toggle"], "number");
    const options: CalcInput["options"] = [];
    for (const op of arr(o.options)) {
      if (!op || typeof op !== "object") continue;
      const oo = op as Record<string, unknown>;
      const v = num(oo.value);
      const l = str(oo.label);
      if (v !== undefined && l) options.push({ label: l, value: v });
    }
    if (kind === "select" && options.length === 0) continue;
    let value: number | undefined =
      typeof o.value === "boolean" ? (o.value ? 1 : 0) : num(o.value ?? o.default);
    if (value === undefined) value = kind === "select" ? options[0]!.value : 0;
    const min = num(o.min);
    const max = num(o.max);
    const step = num(o.step);
    seen.add(id);
    inputs.push({
      id,
      label,
      kind: kind === "slider" && (min === undefined || max === undefined) ? "number" : kind,
      value,
      ...optional("min", min),
      ...optional("max", max),
      ...optional("step", step !== undefined && step > 0 ? step : undefined),
      ...optional("unit", str(o.unit, 24)),
      options: cap(options, 20, ctx, "下拉选项"),
    });
  }
  const outputs: CalcOutput[] = [];
  for (const it of arr(raw.outputs)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : `out${outputs.length + 1}`;
    const formula = typeof o.formula === "string" ? o.formula.trim() : "";
    if (!ID_RE.test(id) || seen.has(id) || !formula) continue;
    seen.add(id);
    const decimals = num(o.decimals);
    outputs.push({
      id,
      label: str(o.label) ?? id,
      formula: formula.slice(0, 500),
      ...optional("unit", str(o.unit, 24)),
      format: pickOne<CalcFormat>(o.format, ["number", "integer", "currency", "percent"], "number"),
      ...optional("decimals", decimals !== undefined ? Math.max(0, Math.min(8, Math.round(decimals))) : undefined),
      primary: o.primary === true,
      ...optional<"tone", "up" | "down">("tone", o.tone === "up" || o.tone === "down" ? (o.tone as "up" | "down") : undefined),
    });
  }
  if ((inputs.length === 0 || outputs.length === 0) && !ctx.partial) return null;
  const ins = cap(inputs, LIMITS.calcInputs, ctx, "输入");
  const outs = cap(outputs, LIMITS.calcOutputs, ctx, "结果");
  const outIds = new Set(outs.map((o) => o.id));
  const breakdown = arr(raw.breakdown)
    .filter((x): x is string => typeof x === "string" && outIds.has(x))
    .slice(0, 6);
  return {
    type: "calculator",
    ...optional("title", str(raw.title)),
    inputs: ins,
    outputs: outs,
    breakdown: breakdown.length >= 2 ? breakdown : [],
    ...optional("chart", calcChart(raw.chart, ins, outIds)),
    assumptions: strList(raw.assumptions, 12, ctx, "假设", 600),
    ...optional("note", str(raw.note, 600)),
  };
}

function callout(raw: Record<string, unknown>, ctx: Ctx): CalloutSpec | null {
  const body = str(raw.body ?? raw.text ?? raw.content, LIMITS.text);
  if (!body && !ctx.partial) return null;
  const toneRaw = raw.tone ?? raw.level ?? raw.kind;
  const tone = pickOne<CalloutTone>(
    toneRaw === "note" ? "info" : toneRaw === "error" ? "danger" : toneRaw === "caution" ? "warning" : toneRaw,
    ["info", "tip", "warning", "danger", "success"],
    "info",
  );
  return { type: "callout", tone, ...optional("title", str(raw.title)), body: body ?? "" };
}

function tabs(raw: Record<string, unknown>, ctx: Ctx): TabsSpec | null {
  const out: TabsSpec["tabs"] = [];
  for (const it of arr(raw.tabs ?? raw.items)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const label = str(o.label ?? o.title, 40);
    if (!label) continue;
    let block: TabsSpec["tabs"][number]["block"];
    const b = o.block ?? o.ui;
    if (b && typeof b === "object" && !Array.isArray(b)) {
      const t = resolveType((b as Record<string, unknown>).type);
      if (t && t !== "tabs") {
        const sub: Ctx = { notes: ctx.notes, partial: ctx.partial };
        const spec = VALIDATORS[t](b as Record<string, unknown>, sub);
        if (spec && spec.type !== "tabs") block = withSubtitle(spec, b as Record<string, unknown>) as typeof block;
      }
    }
    const body = str(o.body ?? o.content, LIMITS.text) ?? "";
    if (!body && !block && !ctx.partial) continue;
    out.push({ label, body, ...optional("block", block) });
  }
  if (out.length === 0 && !ctx.partial) return null;
  return { type: "tabs", ...optional("title", str(raw.title)), tabs: cap(out, LIMITS.tabs, ctx, "标签") };
}

function timeline(raw: Record<string, unknown>, ctx: Ctx): TimelineSpec | null {
  const items: TimelineSpec["items"] = [];
  for (const it of arr(raw.items ?? raw.events)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = str(o.title ?? o.label ?? o.event, 600);
    if (!title) continue;
    items.push({ time: str(o.time ?? o.date ?? o.when, 60) ?? "", title, ...optional("detail", str(o.detail ?? o.description, 2000)) });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "timeline", ...optional("title", str(raw.title)), items: cap(items, LIMITS.listItems, ctx, "事件") };
}

function suggestions(raw: Record<string, unknown>, ctx: Ctx): SuggestionsSpec | null {
  const items = strList(raw.items ?? raw.suggestions, LIMITS.suggestions, ctx, "建议", 200);
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "suggestions", items };
}

function cards(raw: Record<string, unknown>, ctx: Ctx): CardsSpec | null {
  const items: CardItem[] = [];
  for (const it of arr(raw.items ?? raw.cards)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = str(o.title ?? o.name ?? o.label);
    if (!title) continue;
    const url = str(o.url ?? o.link, 2000);
    items.push({
      title,
      ...optional("subtitle", str(o.subtitle, 200)),
      ...optional("body", str(o.body ?? o.description ?? o.desc, 1000)),
      ...optional("image", imageSrc(o.image ?? o.img)),
      ...optional("icon", str(o.icon, 40)),
      tags: strList(o.tags, 4, ctx, "标签", 24),
      ...optional("meta", str(o.meta ?? o.price, 60)),
      ...optional("url", url && /^https?:\/\//i.test(url) ? url : undefined),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return {
    type: "cards",
    ...optional("title", str(raw.title)),
    layout: raw.layout === "grid" ? "grid" : "list",
    items: cap(items, LIMITS.cards, ctx, "卡片"),
  };
}

function gallery(raw: Record<string, unknown>, ctx: Ctx): GallerySpec | null {
  const images: GallerySpec["images"] = [];
  for (const it of arr(raw.images ?? raw.items)) {
    const o = typeof it === "string" ? { src: it } : it && typeof it === "object" ? (it as Record<string, unknown>) : null;
    if (!o) continue;
    const src = imageSrc(o.src ?? o.url ?? o.image);
    if (src) images.push({ src, ...optional("caption", str(o.caption ?? o.alt, 200)) });
  }
  if (images.length === 0 && !ctx.partial) return null;
  return {
    type: "gallery",
    ...optional("title", str(raw.title)),
    images: cap(images, LIMITS.images, ctx, "图片"),
    ...optional("caption", str(raw.caption, 600)),
  };
}

function swatches(raw: Record<string, unknown>, ctx: Ctx): SwatchesSpec | null {
  const colors: SwatchesSpec["colors"] = [];
  for (const it of arr(raw.colors ?? raw.items)) {
    const o = typeof it === "string" ? { hex: it } : it && typeof it === "object" ? (it as Record<string, unknown>) : null;
    if (!o) continue;
    const hex = typeof o.hex === "string" ? o.hex.trim() : typeof o.color === "string" ? o.color.trim() : "";
    if (!HEX_RE.test(hex)) continue;
    colors.push({ hex: hex.toLowerCase(), ...optional("name", str(o.name ?? o.label, 40)) });
  }
  if (colors.length === 0 && !ctx.partial) return null;
  return { type: "swatches", ...optional("title", str(raw.title)), colors: cap(colors, LIMITS.swatches, ctx, "颜色") };
}

function tiles(raw: Record<string, unknown>, ctx: Ctx): TilesSpec | null {
  const items: TilesSpec["items"] = [];
  const columns = Math.max(2, Math.min(4, Math.round(num(raw.columns) ?? 2)));
  for (const it of arr(raw.items ?? raw.tiles)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const title = str(o.title ?? o.label ?? o.name, 80);
    if (!title) continue;
    const span = Math.round(num(o.span) ?? 1);
    items.push({
      title,
      ...optional("subtitle", str(o.subtitle ?? o.detail, 120)),
      ...optional("icon", str(o.icon, 40)),
      tone: pickOne<TileTone>(o.tone ?? o.color, TILE_TONES, TILE_TONES[items.length % TILE_TONES.length]!),
      span: span >= 1 && span <= columns ? span : 1,
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return {
    type: "tiles",
    ...optional("title", str(raw.title)),
    columns,
    items: cap(items, LIMITS.tiles, ctx, "方块"),
    ...optional("caption", str(raw.caption ?? raw.note, 300)),
  };
}

function recipe(raw: Record<string, unknown>, ctx: Ctx): RecipeSpec | null {
  const ingredients: RecipeSpec["ingredients"] = [];
  for (const it of arr(raw.ingredients ?? raw.items)) {
    if (typeof it === "string") {
      const name = str(it, 120);
      if (name) ingredients.push({ name });
      continue;
    }
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const name = str(o.name ?? o.label, 120);
    if (!name) continue;
    const amount = num(o.amount ?? o.qty);
    ingredients.push({
      name,
      ...optional("amount", amount !== undefined && amount >= 0 ? amount : undefined),
      ...optional("unit", str(o.unit, 16)),
      ...optional("note", str(o.note, 120)),
    });
  }
  const servings = num(raw.servings ?? raw.serves);
  if ((ingredients.length === 0 || servings === undefined) && !ctx.partial) return null;
  const meta: RecipeSpec["meta"] = [];
  for (const it of arr(raw.meta)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const label = str(o.label, 20);
    const value = str(o.value, 40);
    if (label && value) meta.push({ label, value });
  }
  return {
    type: "recipe",
    ...optional("title", str(raw.title)),
    servings: servings !== undefined && servings > 0 && servings <= 1000 ? servings : 1,
    unit: str(raw.unit, 8) ?? "人",
    ingredients: cap(ingredients, LIMITS.ingredients, ctx, "用料"),
    steps: strList(raw.steps, LIMITS.listItems, ctx, "步骤", 600),
    meta: meta.slice(0, 4),
  };
}

function quiz(raw: Record<string, unknown>, ctx: Ctx): QuizSpec | null {
  const questions: QuizSpec["questions"] = [];
  const list = Array.isArray(raw.questions) ? raw.questions : raw.question ? [raw] : [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const question = str(o.question ?? o.q, 600);
    const options = strList(o.options ?? o.choices, LIMITS.quizOptions, ctx, "选项", 200);
    let answer = num(o.answer);
    if (answer === undefined && typeof o.answer === "string") answer = options.indexOf(o.answer.trim());
    if (!question || options.length < 2 || answer === undefined || !Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
    questions.push({ question, options, answer, ...optional("explain", str(o.explain ?? o.explanation, 1000)) });
  }
  if (questions.length === 0 && !ctx.partial) return null;
  return { type: "quiz", ...optional("title", str(raw.title)), questions: cap(questions, LIMITS.quiz, ctx, "题目") };
}

function progress(raw: Record<string, unknown>, ctx: Ctx): ProgressSpec | null {
  const items: ProgressSpec["items"] = [];
  for (const it of arr(raw.items ?? raw.bars)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const label = str(o.label ?? o.name, 80);
    const value = num(o.value);
    if (!label || value === undefined) continue;
    const max = num(o.max ?? o.target ?? o.total);
    items.push({
      label,
      value,
      max: max !== undefined && max > 0 ? max : 100,
      ...optional("unit", str(o.unit, 16)),
      tone: pickOne<ProgressTone>(o.tone, ["default", "good", "warn", "bad"], "default"),
      ...optional("note", str(o.note ?? o.detail, 200)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return {
    type: "progress",
    ...optional("title", str(raw.title)),
    items: cap(items, LIMITS.progress, ctx, "条目"),
    ...optional("source", str(raw.source, 600)),
  };
}

function kv(raw: Record<string, unknown>, ctx: Ctx): KvSpec | null {
  const items: KvSpec["items"] = [];
  const src = raw.items ?? raw.pairs;
  if (Array.isArray(src)) {
    for (const it of src) {
      if (!it || typeof it !== "object") continue;
      const o = it as Record<string, unknown>;
      const label = str(o.label ?? o.key ?? o.name, 80);
      const value = str(o.value, 600);
      if (label && value) items.push({ label, value });
    }
  } else if (src && typeof src === "object") {
    for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
      const label = str(k, 80);
      const value = str(v, 600);
      if (label && value) items.push({ label, value });
    }
  }
  if (items.length === 0 && !ctx.partial) return null;
  return {
    type: "kv",
    ...optional("title", str(raw.title)),
    items: cap(items, LIMITS.kv, ctx, "条目"),
    ...optional("source", str(raw.source, 600)),
  };
}

function form(raw: Record<string, unknown>, ctx: Ctx): FormSpec | null {
  const fields: FormField[] = [];
  const seen = new Set<string>();
  for (const it of arr(raw.fields)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const label = str(o.label ?? o.name, 60);
    if (!label) continue;
    let id = typeof o.id === "string" && ID_RE.test(o.id.trim()) ? o.id.trim() : "";
    // 缺 id / 重复 id:生成一个没被占用的(自动生成的也可能撞上后面字段写明的 id)。
    if (!id || seen.has(id)) {
      let n = fields.length + 1;
      while (seen.has(`f${n}`)) n += 1;
      id = `f${n}`;
    }
    seen.add(id);
    const options = strList(o.options, 12, ctx, "选项", 60);
    let kind = pickOne<FormField["kind"]>(o.kind ?? o.type, ["text", "number", "select", "chips", "date"], options.length ? "chips" : "text");
    if ((kind === "select" || kind === "chips") && options.length === 0) kind = "text";
    const value = str(o.value ?? o.default, 200);
    fields.push({
      id,
      label,
      kind,
      options,
      multi: o.multi === true,
      ...optional("placeholder", str(o.placeholder, 80)),
      ...optional("unit", str(o.unit, 16)),
      required: o.required === true,
      ...optional("value", value),
    });
  }
  if (fields.length === 0 && !ctx.partial) return null;
  return {
    type: "form",
    ...optional("title", str(raw.title)),
    fields: cap(fields, LIMITS.formFields, ctx, "字段"),
    submit: str(raw.submit ?? raw.button, 20) ?? "发送",
  };
}

function route(raw: Record<string, unknown>, ctx: Ctx): RouteSpec | null {
  const stops: RouteSpec["stops"] = [];
  for (const it of arr(raw.stops ?? raw.items)) {
    const o = typeof it === "string" ? { name: it } : it && typeof it === "object" ? (it as Record<string, unknown>) : null;
    if (!o) continue;
    const name = str(o.name ?? o.title, 80);
    if (!name) continue;
    stops.push({
      name,
      ...optional("detail", str(o.detail ?? o.description, 600)),
      ...optional("note", str(o.note, 60)),
      highlight: o.highlight === true,
    });
  }
  const capped = cap(stops, LIMITS.stops, ctx, "站点");
  const legs: RouteSpec["legs"] = [];
  for (const it of arr(raw.legs).slice(0, Math.max(0, capped.length - 1))) {
    const o = it && typeof it === "object" ? (it as Record<string, unknown>) : {};
    legs.push({
      ...optional("distance", str(o.distance, 24)),
      ...optional("duration", str(o.duration ?? o.time, 24)),
      ...optional("mode", str(o.mode, 16)),
    });
  }
  if (capped.length < (ctx.partial ? 1 : 2)) return null;
  return { type: "route", ...optional("title", str(raw.title)), stops: capped, legs };
}

/** 只认 http(s) 链接(来源是给人点开的链接,不加载任何资源)。 */
function httpUrl(v: unknown): string | undefined {
  const s = str(v, 2000);
  return s && /^https?:\/\/[^\s"'<>]+$/i.test(s) ? s : undefined;
}

/** 链接的站点名:去掉 www.;解析不了就不写。 */
export function siteOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./i, "") || undefined;
  } catch {
    return undefined;
  }
}

function sources(raw: Record<string, unknown>, ctx: Ctx): SourcesSpec | null {
  const items: SourceItem[] = [];
  for (const it of arr(raw.items ?? raw.sources ?? raw.links)) {
    const o = typeof it === "string" ? { url: it } : it && typeof it === "object" ? (it as Record<string, unknown>) : null;
    if (!o) continue;
    const url = httpUrl(o.url ?? o.link ?? o.href);
    const site = str(o.site ?? o.source ?? o.publisher, 60) ?? (url ? siteOf(url) : undefined);
    const title = str(o.title ?? o.name ?? o.label, 200) ?? site;
    if (!title) continue;
    items.push({
      title,
      ...optional("url", url),
      ...optional("site", site),
      ...optional("date", str(o.date ?? o.published ?? o.time, 30)),
      ...optional("note", str(o.note ?? o.summary ?? o.snippet ?? o.description, 300)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "sources", ...optional("title", str(raw.title)), items: cap(items, LIMITS.sources, ctx, "来源") };
}

function outline(raw: Record<string, unknown>, ctx: Ctx): OutlineSpec | null {
  let count = 0;
  let trimmed = false;
  const walk = (list: unknown, depth: number): OutlineNode[] => {
    const out: OutlineNode[] = [];
    for (const it of arr(list)) {
      if (count >= LIMITS.outlineNodes || out.length >= LIMITS.outlineChildren) {
        trimmed = true;
        break;
      }
      const o = typeof it === "string" ? { title: it } : it && typeof it === "object" ? (it as Record<string, unknown>) : null;
      if (!o) continue;
      const title = str(o.title ?? o.label ?? o.name ?? o.text, 200);
      if (!title) continue;
      count += 1;
      const kids = o.children ?? o.items ?? o.nodes;
      let children: OutlineNode[] = [];
      if (arr(kids).length > 0) {
        if (depth < LIMITS.outlineDepth) children = walk(kids, depth + 1);
        else trimmed = true;
      }
      out.push({ title, ...optional("detail", str(o.detail ?? o.description ?? o.note, 600)), children });
    }
    return out;
  };
  const items = walk(raw.items ?? raw.children ?? raw.nodes, 1);
  if (trimmed) ctx.notes.push(`大纲最多 ${LIMITS.outlineDepth} 层、${LIMITS.outlineNodes} 个节点,已省略其余`);
  if (items.length === 0 && !ctx.partial) return null;
  const viewRaw = typeof raw.view === "string" ? raw.view.toLowerCase().replace(/[\s_-]/g, "") : "";
  return {
    type: "outline",
    ...optional("title", str(raw.title)),
    view: viewRaw === "map" || viewRaw === "mindmap" ? "map" : "tree",
    items,
  };
}

const DRAFT_KIND_ALIASES: Record<string, DraftKind> = {
  mail: "email",
  letter: "email",
  wechat: "message",
  im: "message",
  sms: "message",
  chat: "message",
  social: "post",
  article: "doc",
  document: "doc",
};

/** 成稿是要原样拿走的交付物:不截断(整块已受 IUI_MAX_BLOCK_BYTES 限制),只统一换行、去掉首尾空行。 */
function draftText(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
  return t || undefined;
}

function draft(raw: Record<string, unknown>, ctx: Ctx): DraftSpec | null {
  const variants: DraftSpec["variants"] = [];
  const list = Array.isArray(raw.variants) ? raw.variants : Array.isArray(raw.versions) ? raw.versions : null;
  if (list) {
    for (const it of list) {
      const o = typeof it === "string" ? { text: it } : it && typeof it === "object" ? (it as Record<string, unknown>) : null;
      if (!o) continue;
      const text = draftText(o.text ?? o.body ?? o.content);
      if (!text) continue;
      variants.push({
        label: str(o.label ?? o.name ?? o.title, 20) ?? `版本 ${variants.length + 1}`,
        ...optional("subject", str(o.subject, 200) ?? str(raw.subject, 200)),
        text,
      });
    }
  } else {
    const text = draftText(raw.text ?? raw.body ?? raw.content);
    if (text) variants.push({ label: "版本 1", ...optional("subject", str(raw.subject, 200)), text });
  }
  if (variants.length === 0 && !ctx.partial) return null;
  const kindRaw = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  const kind = (DRAFT_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as DraftKind) : DRAFT_KIND_ALIASES[kindRaw];
  return {
    type: "draft",
    ...optional("title", str(raw.title)),
    ...optional("kind", kind),
    variants: cap(variants, LIMITS.draftVariants, ctx, "版本"),
    ...optional("original", draftText(raw.original ?? raw.before)),
    ...optional("note", str(raw.note, 600)),
  };
}

const NO_SUBTITLE = new Set<IuiType>(["callout", "choice", "suggestions"]);

/** 通用的 `subtitle`(标题下一行说明)。cards 的 description 是卡片自己的字段,这里只认 subtitle。 */
function withSubtitle<S extends IuiSpec>(spec: S, raw: Record<string, unknown>): S {
  if (NO_SUBTITLE.has(spec.type)) return spec;
  const sub = str(raw.subtitle, 300);
  return sub ? { ...spec, subtitle: sub } : spec;
}

const VALIDATORS: Record<IuiType, (raw: Record<string, unknown>, ctx: Ctx) => IuiSpec | null> = {
  table,
  chart,
  stats,
  steps,
  compare,
  choice,
  calculator,
  callout,
  tabs,
  timeline,
  suggestions,
  cards,
  gallery,
  swatches,
  tiles,
  recipe,
  quiz,
  progress,
  kv,
  form,
  route,
  sources,
  outline,
  draft,
};

/** 常见别名(模型偶尔写成其它名字)。 */
const TYPE_ALIASES: Record<string, IuiType> = {
  checklist: "steps",
  metrics: "stats",
  metric: "stats",
  cards: "compare",
  comparison: "compare",
  options: "choice",
  calc: "calculator",
  menu: "cards",
  list: "cards",
  images: "gallery",
  photos: "gallery",
  collage: "gallery",
  palette: "swatches",
  colors: "swatches",
  grid: "tiles",
  ingredients: "recipe",
  test: "quiz",
  bars: "progress",
  meter: "progress",
  specs: "kv",
  keyvalue: "kv",
  facts: "kv",
  details: "kv",
  itinerary: "route",
  trip: "route",
  alert: "callout",
  note: "callout",
  segmented: "tabs",
  followups: "suggestions",
  follow_up: "suggestions",
  references: "sources",
  citations: "sources",
  refs: "sources",
  links: "sources",
  tree: "outline",
  mindmap: "outline",
  mind_map: "outline",
  email: "draft",
  copy: "draft",
};

export function resolveType(raw: unknown): IuiType | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  if ((IUI_TYPES as readonly string[]).includes(t)) return t as IuiType;
  return TYPE_ALIASES[t] ?? null;
}

export function validateSpec(raw: Record<string, unknown>, partial: boolean): ValidateResult {
  const type = resolveType(raw.type);
  if (!type) return { ok: false, reason: typeof raw.type === "string" ? `unknown_type:${raw.type.slice(0, 40)}` : "missing_type" };
  const ctx: Ctx = { notes: [], partial };
  try {
    const validated = VALIDATORS[type](raw, ctx);
    if (!validated) return { ok: false, reason: `invalid_${type}` };
    const spec = withSubtitle(validated, raw);
    if (type === "steps" && raw.type === "checklist") (spec as StepsSpec).checkable = raw.checkable !== false;
    return { ok: true, spec, notes: ctx.notes };
  } catch {
    return { ok: false, reason: `invalid_${type}` };
  }
}
