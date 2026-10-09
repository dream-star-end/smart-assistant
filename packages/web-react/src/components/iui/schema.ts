/**
 * Intelligent UI(OCV5-361)—— 组件 schema 校验与规范化。
 *
 * 手写校验(web-react 不引 zod)。原则:能修就修(截断超限项、丢非法行、数字字符串转数字),
 * 修过的在 `notes` 里留一句,组件底部显示「部分内容已省略」;修不了才返回 ok:false 降级。
 * `partial` = 流式半截:必填数组允许为空,只要 type 已知就先渲染已有部分。
 * 这里的上限是渲染护栏(防止超大块拖垮页面),不约束模型使用组件的意愿。
 */

export type Cell = string | number | null;

export type TableSpec = {
  type: "table";
  title?: string;
  columns: { label: string; unit?: string; align: "left" | "right" }[];
  rows: Cell[][];
  source?: string;
  note?: string;
};

export type ChartKind = "bar" | "line" | "area" | "pie";
export type ChartSpec = {
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
export type StatsSpec = {
  type: "stats";
  title?: string;
  items: { label: string; value: string | number; unit?: string; delta?: string; tone?: StatTone; basis?: string }[];
  source?: string;
};

export type StepsSpec = {
  type: "steps";
  title?: string;
  checkable: boolean;
  items: { title: string; detail?: string; done: boolean }[];
};

export type CompareSpec = {
  type: "compare";
  title?: string;
  items: {
    name: string;
    tag?: string;
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
};
export type CalculatorSpec = {
  type: "calculator";
  title?: string;
  inputs: CalcInput[];
  outputs: CalcOutput[];
  assumptions: string[];
  note?: string;
};

export type CalloutTone = "info" | "tip" | "warning" | "danger" | "success";
export type CalloutSpec = { type: "callout"; tone: CalloutTone; title?: string; body: string };

export type TabsSpec = { type: "tabs"; title?: string; tabs: { label: string; body: string }[] };

export type TimelineSpec = {
  type: "timeline";
  title?: string;
  items: { time: string; title: string; detail?: string }[];
};

export type SuggestionsSpec = { type: "suggestions"; items: string[] };

export type IuiSpec =
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
  | SuggestionsSpec;

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

// ── 各类型 ─────────────────────────────────────────────────────────────

function table(raw: Record<string, unknown>, ctx: Ctx): TableSpec | null {
  const columns: TableSpec["columns"] = [];
  for (const c of arr(raw.columns)) {
    if (typeof c === "string" || typeof c === "number") {
      const label = str(c);
      if (label) columns.push({ label, align: "left" });
    } else if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      const label = str(o.label ?? o.name ?? o.title);
      if (!label) continue;
      columns.push({ label, ...optional("unit", str(o.unit, 24)), align: o.align === "right" ? "right" : "left" });
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
    for (let i = 0; i < width; i++) cols.push({ label: `列 ${i + 1}`, align: "left" });
  }
  if (cols.length === 0 && !ctx.partial) return null;
  // 全数字列自动右对齐(未显式指定时)。
  cols.forEach((c, i) => {
    if (c.align === "left" && rows.length > 0 && rows.every((r) => r[i] == null || typeof r[i] === "number")) {
      if (rows.some((r) => typeof r[i] === "number")) c.align = "right";
    }
  });
  return {
    type: "table",
    ...optional("title", str(raw.title)),
    columns: cols,
    rows: cap(rows, LIMITS.tableRows, ctx, "行"),
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
    });
  }
  if ((inputs.length === 0 || outputs.length === 0) && !ctx.partial) return null;
  return {
    type: "calculator",
    ...optional("title", str(raw.title)),
    inputs: cap(inputs, LIMITS.calcInputs, ctx, "输入"),
    outputs: cap(outputs, LIMITS.calcOutputs, ctx, "结果"),
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
    out.push({ label, body: str(o.body ?? o.content, LIMITS.text) ?? "" });
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
};

/** 常见别名(模型偶尔写成其它名字)。 */
const TYPE_ALIASES: Record<string, IuiType> = {
  checklist: "steps",
  metrics: "stats",
  metric: "stats",
  cards: "compare",
  comparison: "compare",
  options: "choice",
  form: "calculator",
  calc: "calculator",
  alert: "callout",
  note: "callout",
  segmented: "tabs",
  followups: "suggestions",
  follow_up: "suggestions",
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
    const spec = VALIDATORS[type](raw, ctx);
    if (!spec) return { ok: false, reason: `invalid_${type}` };
    if (type === "steps" && raw.type === "checklist") (spec as StepsSpec).checkable = raw.checkable !== false;
    return { ok: true, spec, notes: ctx.notes };
  } catch {
    return { ok: false, reason: `invalid_${type}` };
  }
}
