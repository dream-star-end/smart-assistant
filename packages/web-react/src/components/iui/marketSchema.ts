/**
 * Intelligent UI —— 行情类组件的 schema（OCV5-383）：quote 行情卡、kline K 线、intraday 分时、stocklist 股票列表。
 *
 * 字段名直接沿用同花顺插件（ths CLI）的 JSON 输出（price / change_pct / prev_close / order_book …），
 * 插件的 `ths … --ui` 原样产出这些块，模型只需原样转贴，不用转写数字。K 线 / 分时的行也接受紧凑数组
 * （[日期, 开, 高, 低, 收, 量]、[时间, 价, 均价, 量]），省 token。
 *
 * 与 schema.ts 同一套原则：能修就修（丢非法行、数字字符串转数字），修过的记进 notes；修不了才降级。
 * 组件不做任何推算以外的「补数据」：缺的字段就不显示。
 */

type Ctx = { notes: string[]; partial: boolean };
type Sub = { subtitle?: string };

export const MARKET_LIMITS = {
  quoteItems: 12,
  klineRows: 250,
  intradayPoints: 300,
  stockItems: 100,
  maPeriods: 3,
} as const;

export type QuoteItem = {
  code: string;
  name?: string;
  market?: string;
  price: number | null;
  change?: number;
  changePct?: number;
  prevClose?: number;
  open?: number;
  high?: number;
  low?: number;
  /** 成交量（股）。 */
  volume?: number;
  /** 成交额（元）。 */
  amount?: number;
  turnoverPct?: number;
  amplitudePct?: number;
  limitUp?: number;
  limitDown?: number;
  marketCap?: number;
  floatMarketCap?: number;
  bid?: { price: number; volume?: number };
  ask?: { price: number; volume?: number };
  /** 委比（%）。 */
  imbalancePct?: number;
  status?: string;
  time?: string;
};
export type QuoteSpec = Sub & { type: "quote"; title?: string; items: QuoteItem[]; source?: string; note?: string };

export type KlineRow = { date: string; open: number; high: number; low: number; close: number; volume?: number };
export type KlineSpec = Sub & {
  type: "kline";
  title?: string;
  code?: string;
  name?: string;
  period?: string;
  rows: KlineRow[];
  /** 均线周期（按收盘价在前端计算）；默认 [5, 10]，[] 表示不画。 */
  ma: number[];
  source?: string;
  note?: string;
};

export type IntradayPoint = { time: string; price: number; avg?: number; volume?: number };
export type IntradaySpec = Sub & {
  type: "intraday";
  title?: string;
  code?: string;
  name?: string;
  date?: string;
  prevClose?: number;
  points: IntradayPoint[];
  source?: string;
  note?: string;
};

export type StockRow = {
  code: string;
  name?: string;
  price?: number;
  changePct?: number;
  amount?: number;
  turnoverPct?: number;
  /** 行尾的一小段补充（如「涨停」「问财第 3」）。 */
  tag?: string;
};
export type StockListSpec = Sub & {
  type: "stocklist";
  title?: string;
  items: StockRow[];
  /** 来源里的总数（列表只截了一部分时显示「共 N 只」）。 */
  total?: number;
  source?: string;
  note?: string;
};

export type MarketSpec = QuoteSpec | KlineSpec | IntradaySpec | StockListSpec;

// ── 小工具（与 schema.ts 的同名私有函数同语义；这里自带一份，避免互相引用私有实现） ──

function s(v: unknown, max = 300): string | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 数字；接受数字字符串（含千分位、「%」、全角负号）。null / "" / "--" → undefined。 */
function n(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string") return undefined;
  const t = v.trim().replace(/,/g, "").replace(/%$/, "").replace(/^−/, "-");
  if (!t || t === "--" || t === "-") return undefined;
  const x = Number(t);
  return Number.isFinite(x) ? x : undefined;
}

function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function capList<T>(items: T[], max: number, ctx: Ctx, what: string): T[] {
  if (items.length <= max) return items;
  ctx.notes.push(`只显示前 ${max} ${what}`);
  return items.slice(0, max);
}

function code(v: unknown): string | undefined {
  const t = s(v, 24);
  return t && /^[A-Za-z0-9._-]{1,24}$/.test(t) ? t : undefined;
}

function common(raw: Record<string, unknown>) {
  return {
    ...opt("title", s(raw.title)),
    ...opt("source", s(raw.source, 600)),
    ...opt("note", s(raw.note, 600)),
  };
}

// ── quote ─────────────────────────────────────────────────────────────

function quoteItem(o: Record<string, unknown>): QuoteItem | null {
  const c = code(o.code ?? o.symbol);
  if (!c) return null;
  const book = o.order_book && typeof o.order_book === "object" ? (o.order_book as Record<string, unknown>) : {};
  const bidPrice = n(book.bid1_price ?? o.bid1_price ?? o.bid);
  const askPrice = n(book.ask1_price ?? o.ask1_price ?? o.ask);
  const bidVol = n(book.bid1_volume ?? o.bid1_volume);
  const askVol = n(book.ask1_volume ?? o.ask1_volume);
  return {
    code: c,
    ...opt("name", s(o.name, 40)),
    ...opt("market", s(o.market, 12)),
    price: n(o.price ?? o.last ?? o.close) ?? null,
    ...opt("change", n(o.change)),
    ...opt("changePct", n(o.change_pct ?? o.changePct ?? o.pct)),
    ...opt("prevClose", n(o.prev_close ?? o.prevClose)),
    ...opt("open", n(o.open)),
    ...opt("high", n(o.high)),
    ...opt("low", n(o.low)),
    ...opt("volume", n(o.volume)),
    ...opt("amount", n(o.amount)),
    ...opt("turnoverPct", n(o.turnover_pct ?? o.turnoverPct)),
    ...opt("amplitudePct", n(o.amplitude_pct ?? o.amplitudePct)),
    ...opt("limitUp", n(o.limit_up ?? o.limitUp)),
    ...opt("limitDown", n(o.limit_down ?? o.limitDown)),
    ...opt("marketCap", n(o.market_cap ?? o.marketCap)),
    ...opt("floatMarketCap", n(o.float_market_cap ?? o.floatMarketCap)),
    ...opt("bid", bidPrice !== undefined ? { price: bidPrice, ...opt("volume", bidVol) } : undefined),
    ...opt("ask", askPrice !== undefined ? { price: askPrice, ...opt("volume", askVol) } : undefined),
    ...opt("imbalancePct", n(book.imbalance_pct ?? o.imbalance_pct)),
    ...opt("status", s(o.status, 20)),
    ...opt("time", s(o.update_time ?? o.time, 30)),
  };
}

export function quote(raw: Record<string, unknown>, ctx: Ctx): QuoteSpec | null {
  // 单只行情可以直接把字段写在块顶层（与 `ths quote 600519` 单只输出同形）。
  const src = Array.isArray(raw.items) ? raw.items : Array.isArray(raw.quotes) ? raw.quotes : raw.code ? [raw] : [];
  const items: QuoteItem[] = [];
  for (const it of src) {
    if (!it || typeof it !== "object") continue;
    const q = quoteItem(it as Record<string, unknown>);
    if (q) items.push(q);
  }
  if (items.length === 0 && !ctx.partial) return null;
  return { type: "quote", ...common(raw), items: capList(items, MARKET_LIMITS.quoteItems, ctx, "只") };
}

// ── kline ─────────────────────────────────────────────────────────────

function klineRow(r: unknown): KlineRow | null {
  let date: unknown;
  let o: unknown;
  let h: unknown;
  let l: unknown;
  let c: unknown;
  let v: unknown;
  if (Array.isArray(r)) [date, o, h, l, c, v] = r;
  else if (r && typeof r === "object") {
    const x = r as Record<string, unknown>;
    [date, o, h, l, c, v] = [x.date ?? x.time ?? x.t, x.open, x.high, x.low, x.close, x.volume];
  } else return null;
  const row = { date: s(date, 20), open: n(o), high: n(h), low: n(l), close: n(c) };
  if (!row.date || row.open === undefined || row.high === undefined || row.low === undefined || row.close === undefined) return null;
  // 高低价必须包住开收价；不包住的是坏行（不去「修」它，修了就是编数据）。
  if (row.high < Math.max(row.open, row.close) || row.low > Math.min(row.open, row.close)) return null;
  return { date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, ...opt("volume", n(v)) };
}

export function kline(raw: Record<string, unknown>, ctx: Ctx): KlineSpec | null {
  const rows: KlineRow[] = [];
  let bad = 0;
  for (const r of list(raw.rows ?? raw.data ?? raw.candles)) {
    const k = klineRow(r);
    if (k) rows.push(k);
    else bad += 1;
  }
  if (bad > 0) ctx.notes.push(`跳过 ${bad} 行无效数据`);
  if (rows.length === 0 && !ctx.partial) return null;
  // 只保留最后 N 根（最新的最有用）。
  const kept = rows.length > MARKET_LIMITS.klineRows ? rows.slice(-MARKET_LIMITS.klineRows) : rows;
  if (kept.length < rows.length) ctx.notes.push(`只显示最近 ${MARKET_LIMITS.klineRows} 根`);
  const maRaw = raw.ma === undefined ? [5, 10] : list(raw.ma);
  const ma = [...new Set(maRaw.map(n).filter((x): x is number => x !== undefined && Number.isInteger(x) && x >= 2 && x <= 120))].slice(
    0,
    MARKET_LIMITS.maPeriods,
  );
  return {
    type: "kline",
    ...common(raw),
    ...opt("code", code(raw.code)),
    ...opt("name", s(raw.name, 40)),
    ...opt("period", s(raw.period, 12)),
    rows: kept,
    ma,
  };
}

// ── intraday ──────────────────────────────────────────────────────────

function intradayPoint(p: unknown): IntradayPoint | null {
  let t: unknown;
  let price: unknown;
  let avg: unknown;
  let vol: unknown;
  if (Array.isArray(p)) [t, price, avg, vol] = p;
  else if (p && typeof p === "object") {
    const x = p as Record<string, unknown>;
    [t, price, avg, vol] = [x.time ?? x.t, x.price ?? x.close, x.avg, x.volume];
  } else return null;
  const time = s(t, 8);
  const pr = n(price);
  if (!time || pr === undefined) return null;
  return { time: normalizeHm(time), price: pr, ...opt("avg", n(avg)), ...opt("volume", n(vol)) };
}

/** "0930" → "09:30"；已带冒号的原样。 */
export function normalizeHm(t: string): string {
  return /^\d{4}$/.test(t) ? `${t.slice(0, 2)}:${t.slice(2)}` : t;
}

export function intraday(raw: Record<string, unknown>, ctx: Ctx): IntradaySpec | null {
  const points: IntradayPoint[] = [];
  for (const p of list(raw.points ?? raw.data)) {
    const x = intradayPoint(p);
    if (x) points.push(x);
  }
  if (points.length === 0 && !ctx.partial) return null;
  return {
    type: "intraday",
    ...common(raw),
    ...opt("code", code(raw.code)),
    ...opt("name", s(raw.name, 40)),
    ...opt("date", s(raw.date, 20)),
    ...opt("prevClose", n(raw.prev_close ?? raw.prevClose)),
    points: capList(points, MARKET_LIMITS.intradayPoints, ctx, "个点"),
  };
}

// ── stocklist ─────────────────────────────────────────────────────────

export function stocklist(raw: Record<string, unknown>, ctx: Ctx): StockListSpec | null {
  const items: StockRow[] = [];
  for (const it of list(raw.items ?? raw.results ?? raw.stocks ?? raw.watchlist)) {
    if (!it || typeof it !== "object") continue;
    const o = it as Record<string, unknown>;
    const c = code(o.code);
    if (!c) continue;
    items.push({
      code: c,
      ...opt("name", s(o.name, 40)),
      ...opt("price", n(o.price)),
      ...opt("changePct", n(o.change_pct ?? o.changePct)),
      ...opt("amount", n(o.amount)),
      ...opt("turnoverPct", n(o.turnover_pct ?? o.turnoverPct)),
      ...opt("tag", s(o.tag ?? o.error, 40)),
    });
  }
  if (items.length === 0 && !ctx.partial) return null;
  const total = n(raw.total ?? raw.total_from_nlp);
  return {
    type: "stocklist",
    ...common(raw),
    items: capList(items, MARKET_LIMITS.stockItems, ctx, "只"),
    ...opt("total", total !== undefined && Number.isInteger(total) && total > items.length ? total : undefined),
  };
}

export const MARKET_VALIDATORS = { quote, kline, intraday, stocklist } as const;

export const MARKET_ALIASES: Record<string, keyof typeof MARKET_VALIDATORS> = {
  stock: "quote",
  quotes: "quote",
  ticker: "quote",
  candlestick: "kline",
  candles: "kline",
  ohlc: "kline",
  timeshare: "intraday",
  minute: "intraday",
  stocks: "stocklist",
  watchlist: "stocklist",
  ranking: "stocklist",
};

// ── 派生计算（前端只做这几样推算，都标在界面上） ──────────────────────────────

/** 简单移动平均；不足 period 根的位置为 null。 */
export function movingAverage(closes: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = [];
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    out.push(i >= period - 1 ? sum / period : null);
  }
  return out;
}

/** 涨跌方向：A 股习惯红涨绿跌；平盘 / 未知为 flat。 */
export function direction(changePct: number | undefined | null): "up" | "down" | "flat" {
  if (changePct === undefined || changePct === null || !Number.isFinite(changePct) || changePct === 0) return "flat";
  return changePct > 0 ? "up" : "down";
}

/** 有 prevClose 时由现价推算涨跌幅（行情卡缺 change_pct 时用；推算值与接口值同口径）。 */
export function quoteChangePct(q: Pick<QuoteItem, "changePct" | "price" | "prevClose">): number | undefined {
  if (q.changePct !== undefined) return q.changePct;
  if (q.price === null || q.prevClose === undefined || q.prevClose === 0) return undefined;
  return ((q.price - q.prevClose) / q.prevClose) * 100;
}

/** 中文量级：1.23万 / 4.56亿 / 1.6万亿。 */
export function cnAmount(v: number | undefined, digits = 2): string {
  if (v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(digits)}万亿`;
  if (a >= 1e8) return `${(v / 1e8).toFixed(digits)}亿`;
  if (a >= 1e4) return `${(v / 1e4).toFixed(digits)}万`;
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

/** 价格：≥1000 两位小数，其余按数据精度（最多 3 位）。 */
export function priceText(v: number | undefined | null): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  const d = Math.abs(v) >= 1000 ? 2 : Number.isInteger(v * 100) ? 2 : 3;
  return v.toFixed(d);
}

export function pctText(v: number | undefined | null, signed = true): string {
  if (v === undefined || v === null || !Number.isFinite(v)) return "—";
  const t = `${Math.abs(v).toFixed(2)}%`;
  if (!signed || v === 0) return v < 0 ? `-${t}` : t;
  return v > 0 ? `+${t}` : `-${t}`;
}
