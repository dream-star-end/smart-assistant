/**
 * Intelligent UI —— 行情类组件（OCV5-383）：行情卡、K 线、分时、股票列表。
 *
 * - 数据全部来自块里的字段（同花顺插件 `ths … --ui` 原样产出）；组件只做两样推算并在界面上写明：
 *   K 线均线（按收盘价）、缺 change_pct 时按昨收推算涨跌幅。
 * - A 股配色：红涨绿跌（--mkt-up / --mkt-down，取主题里的 danger / success，明暗主题都过对比度）。
 * - 手机优先：390px 宽下行情卡两列网格、图表全宽、触摸即读数；桌面放宽到四列。
 */
import { type PointerEvent, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import {
  type IntradaySpec,
  type KlineSpec,
  type QuoteItem,
  type QuoteSpec,
  type StockListSpec,
  type StockRow,
  cnAmount,
  direction,
  movingAverage,
  pctText,
  priceText,
  quoteChangePct,
} from "./marketSchema";
import { Frame, Segmented } from "./shell";
import { useWidth } from "./ChartBlock";
import { specToMarkdown } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; nested?: boolean };

const PERIOD_LABEL: Record<string, string> = {
  day: "日K",
  week: "周K",
  month: "月K",
  "60m": "60分钟",
  "30m": "30分钟",
  "15m": "15分钟",
  "5m": "5分钟",
  "1m": "1分钟",
};

function Pct({ value, className }: { value: number | undefined; className?: string }) {
  const dir = direction(value);
  return <span className={cn("oc-mkt-pct", `is-${dir}`, className)}>{pctText(value)}</span>;
}

function StatusLine({ status, time }: { status?: string; time?: string }) {
  if (!status && !time) return null;
  const live = status ? /竞价|交易/.test(status) : false;
  return (
    <span className="oc-mkt-status">
      {status && status !== "--" && <span className={cn("oc-mkt-status-dot", live && "is-live")} aria-hidden />}
      {[status && status !== "--" ? status : null, time].filter(Boolean).join(" · ")}
    </span>
  );
}

// ── 行情卡 ────────────────────────────────────────────────────────────

/** 跌停—涨停区间里：今日最低—最高的一段 + 现价位置。 */
function LimitBar({ q }: { q: QuoteItem }) {
  if (q.limitUp === undefined || q.limitDown === undefined || q.limitUp <= q.limitDown || q.price === null) return null;
  const span = q.limitUp - q.limitDown;
  const at = (v: number) => `${Math.min(100, Math.max(0, ((v - q.limitDown!) / span) * 100)).toFixed(2)}%`;
  const lo = q.low ?? q.price;
  const hi = q.high ?? q.price;
  return (
    <div className="oc-mkt-limit" role="img" aria-label={`跌停 ${priceText(q.limitDown)}，涨停 ${priceText(q.limitUp)}，现价 ${priceText(q.price)}`}>
      <div className="oc-mkt-limit-track">
        {q.prevClose !== undefined && <span className="oc-mkt-limit-mid" style={{ left: at(q.prevClose) }} />}
        <span className="oc-mkt-limit-range" style={{ left: at(lo), width: `calc(${at(hi)} - ${at(lo)})` }} />
        <span className={cn("oc-mkt-limit-dot", `is-${direction(quoteChangePct(q))}`)} style={{ left: at(q.price) }} />
      </div>
      <div className="oc-mkt-limit-labels">
        <span>跌停 {priceText(q.limitDown)}</span>
        <span>涨停 {priceText(q.limitUp)}</span>
      </div>
    </div>
  );
}

function OrderBook({ q }: { q: QuoteItem }) {
  if (!q.bid && !q.ask) return null;
  const imb = q.imbalancePct;
  const buyShare = imb === undefined ? 50 : Math.min(100, Math.max(0, (imb + 100) / 2));
  return (
    <div className="oc-mkt-book">
      <div className="oc-mkt-book-row">
        <span>
          买一 <b className="tabular-nums">{priceText(q.bid?.price)}</b>
          {q.bid?.volume !== undefined && <span className="oc-mkt-faint"> {cnAmount(q.bid.volume / 100, 0)}手</span>}
        </span>
        <span>
          卖一 <b className="tabular-nums">{priceText(q.ask?.price)}</b>
          {q.ask?.volume !== undefined && <span className="oc-mkt-faint"> {cnAmount(q.ask.volume / 100, 0)}手</span>}
        </span>
      </div>
      {imb !== undefined && (
        <div className="oc-mkt-book-bar" role="img" aria-label={`委比 ${pctText(imb)}`}>
          <span className="is-buy" style={{ width: `${buyShare}%` }} />
          <span className="is-sell" />
          <em>委比 {pctText(imb)}</em>
        </div>
      )}
    </div>
  );
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="oc-mkt-cell">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function QuoteHero({ q }: { q: QuoteItem }) {
  const pct = quoteChangePct(q);
  const dir = direction(pct);
  const cells: [string, string][] = [];
  const push = (label: string, v: string | undefined) => v && v !== "—" && cells.push([label, v]);
  push("今开", q.open !== undefined ? priceText(q.open) : undefined);
  push("最高", q.high !== undefined ? priceText(q.high) : undefined);
  push("最低", q.low !== undefined ? priceText(q.low) : undefined);
  push("昨收", q.prevClose !== undefined ? priceText(q.prevClose) : undefined);
  push("成交量", q.volume !== undefined ? `${cnAmount(q.volume / 100)}手` : undefined);
  push("成交额", q.amount !== undefined ? `${cnAmount(q.amount)}元` : undefined);
  push("换手率", q.turnoverPct !== undefined ? pctText(q.turnoverPct, false) : undefined);
  push("振幅", q.amplitudePct !== undefined ? pctText(q.amplitudePct, false) : undefined);
  push("总市值", q.marketCap !== undefined ? `${cnAmount(q.marketCap)}元` : undefined);
  push("流通市值", q.floatMarketCap !== undefined ? `${cnAmount(q.floatMarketCap)}元` : undefined);
  return (
    <div className="oc-mkt-quote">
      <div className="oc-mkt-quote-id">
        <span className="oc-mkt-name">{q.name ?? q.code}</span>
        <span className="oc-mkt-code">{[q.code, q.market].filter(Boolean).join(".")}</span>
        <StatusLine status={q.status} time={q.time} />
      </div>
      <div className={cn("oc-mkt-quote-price", `is-${dir}`)}>
        <span className="oc-mkt-price tabular-nums">{priceText(q.price)}</span>
        <span className="oc-mkt-change tabular-nums">
          {q.change !== undefined && <span>{q.change > 0 ? "+" : ""}{priceText(q.change)}</span>}
          <Pct value={pct} />
        </span>
      </div>
      {q.changePct === undefined && pct !== undefined && <p className="oc-mkt-faint">涨跌幅按昨收推算</p>}
      {cells.length > 0 && (
        <dl className="oc-mkt-grid">
          {cells.map(([l, v]) => (
            <Cell key={l} label={l} value={v} />
          ))}
        </dl>
      )}
      <LimitBar q={q} />
      <OrderBook q={q} />
    </div>
  );
}

function QuoteRow({ q }: { q: QuoteItem }) {
  const pct = quoteChangePct(q);
  return (
    <li className="oc-mkt-row">
      <span className="oc-mkt-row-id">
        <span className="oc-mkt-name">{q.name ?? q.code}</span>
        <span className="oc-mkt-code">{q.code}</span>
      </span>
      <span className="oc-mkt-row-vals">
        <span className="tabular-nums oc-mkt-row-price">{priceText(q.price)}</span>
        <Pct value={pct} className="is-pill" />
      </span>
    </li>
  );
}

export function QuoteBlock({ spec, notes, streaming, nested }: BlockProps<QuoteSpec>) {
  const single = spec.items.length === 1;
  const time = single ? undefined : spec.items.find((q) => q.time)?.time;
  return (
    <Frame
      kind="quote"
      title={spec.title}
      subtitle={spec.subtitle ?? (time ? `更新于 ${time}` : undefined)}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-mkt"
      copyText={() => specToMarkdown(spec)}
    >
      {single ? (
        <QuoteHero q={spec.items[0]} />
      ) : (
        <ul className="oc-mkt-rows">
          {spec.items.map((q) => (
            <QuoteRow key={q.code} q={q} />
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ── 图表公共 ──────────────────────────────────────────────────────────

const PAD = { l: 8, r: 52, t: 10 };

function scale(lo: number, hi: number, top: number, bottom: number) {
  const span = hi - lo || Math.abs(hi) * 0.01 || 1;
  return (v: number) => bottom - ((v - lo) / span) * (bottom - top);
}

/** 指针 → 最近的数据下标（触屏按下 / 拖动、鼠标悬停都走这里）。 */
function useScrub(count: number, x0: number, x1: number) {
  const [active, setActive] = useState<number | null>(null);
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const vbW = e.currentTarget.viewBox.baseVal.width || box.width;
    const x = ((e.clientX - box.left) / box.width) * vbW;
    const i = Math.round(((x - x0) / Math.max(1, x1 - x0)) * (count - 1));
    setActive(Math.min(count - 1, Math.max(0, i)));
  };
  return {
    active,
    handlers: {
      onPointerMove: onMove,
      onPointerDown: onMove,
      onPointerLeave: (e: PointerEvent<SVGSVGElement>) => e.pointerType === "mouse" && setActive(null),
    },
  };
}

// ── K 线 ──────────────────────────────────────────────────────────────

const MA_COLORS = ["var(--iui-c3, #e0a45e)", "var(--iui-c2, #3b82f6)", "var(--iui-c4, #a855f7)"];

function KlineChart({ spec, width }: { spec: KlineSpec; width: number }) {
  const rows = spec.rows;
  const H = 220;
  const volH = rows.some((r) => r.volume !== undefined) ? 52 : 0;
  const priceBottom = H - volH - (volH ? 20 : 18);
  const x0 = PAD.l;
  const x1 = width - PAD.r;
  const step = (x1 - x0) / Math.max(1, rows.length);
  const closes = rows.map((r) => r.close);
  const mas = useMemo(() => spec.ma.map((p) => ({ period: p, values: movingAverage(closes, p) })), [spec.ma, closes]);
  const lo = Math.min(...rows.map((r) => r.low), ...mas.flatMap((m) => m.values.filter((v): v is number => v !== null)));
  const hi = Math.max(...rows.map((r) => r.high), ...mas.flatMap((m) => m.values.filter((v): v is number => v !== null)));
  const y = scale(lo, hi, PAD.t, priceBottom);
  const maxVol = Math.max(1, ...rows.map((r) => r.volume ?? 0));
  const vTop = H - volH;
  const cx = (i: number) => x0 + step * (i + 0.5);
  const { active, handlers } = useScrub(rows.length, cx(0), cx(rows.length - 1));
  const bodyW = Math.max(1, Math.min(10, step * 0.66));
  const ticks = [hi, (hi + lo) / 2, lo];
  const r = active !== null ? rows[active] : rows[rows.length - 1];
  const prev = active !== null ? rows[active - 1] : rows[rows.length - 2];
  const chg = prev ? ((r.close - prev.close) / prev.close) * 100 : undefined;
  return (
    <div className="oc-mkt-chart">
      <div className="oc-mkt-readout" aria-live="polite">
        <span className="font-medium text-fg">{fmtDate(r.date)}</span>
        <span>开 {priceText(r.open)}</span>
        <span>高 {priceText(r.high)}</span>
        <span>低 {priceText(r.low)}</span>
        <span>
          收 <b className={cn("tabular-nums", `is-${direction(chg)}`)}>{priceText(r.close)}</b>
        </span>
        {chg !== undefined && <Pct value={chg} />}
      </div>
      <svg
        viewBox={`0 0 ${width} ${H}`}
        className="oc-mkt-svg"
        role="img"
        aria-label={`${spec.name ?? spec.code ?? ""}${PERIOD_LABEL[spec.period ?? ""] ?? "K线"}：${rows.length} 根，${fmtDate(rows[0].date)} 至 ${fmtDate(rows[rows.length - 1].date)}，最高 ${priceText(hi)}，最低 ${priceText(lo)}。可切换到数据表查看全部数值。`}
        {...handlers}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} className="oc-mkt-grid-line" />
            <text x={x1 + 6} y={y(t) + 4} className="oc-mkt-axis">
              {priceText(t)}
            </text>
          </g>
        ))}
        {rows.map((k, i) => {
          const dir = k.close > k.open ? "up" : k.close < k.open ? "down" : i > 0 && k.close >= rows[i - 1].close ? "up" : "down";
          const top = y(Math.max(k.open, k.close));
          const bot = y(Math.min(k.open, k.close));
          return (
            <g key={`${k.date}:${i}`} className={`oc-mkt-candle is-${dir}`}>
              <line x1={cx(i)} x2={cx(i)} y1={y(k.high)} y2={y(k.low)} />
              <rect x={cx(i) - bodyW / 2} y={top} width={bodyW} height={Math.max(1, bot - top)} rx={0.5} />
              {volH > 0 && k.volume !== undefined && (
                <rect
                  x={cx(i) - bodyW / 2}
                  y={H - (k.volume / maxVol) * (volH - 4)}
                  width={bodyW}
                  height={(k.volume / maxVol) * (volH - 4)}
                  className="oc-mkt-vol"
                />
              )}
            </g>
          );
        })}
        {mas.map((m, mi) => {
          const d = m.values
            .map((v, i) => (v === null ? null : `${cx(i).toFixed(1)},${y(v).toFixed(1)}`))
            .reduce<string>((acc, p) => (p === null ? acc : `${acc}${acc ? "L" : "M"}${p}`), "");
          return d ? <path key={m.period} d={d} fill="none" stroke={MA_COLORS[mi]} strokeWidth={1.25} vectorEffect="non-scaling-stroke" /> : null;
        })}
        {volH > 0 && <line x1={x0} x2={x1} y1={vTop - 6} y2={vTop - 6} className="oc-mkt-grid-line" />}
        <text x={x0} y={priceBottom + 14} className="oc-mkt-axis">
          {fmtDate(rows[0].date)}
        </text>
        <text x={x1} y={priceBottom + 14} className="oc-mkt-axis" textAnchor="end">
          {fmtDate(rows[rows.length - 1].date)}
        </text>
        {active !== null && <line x1={cx(active)} x2={cx(active)} y1={PAD.t} y2={H} className="oc-mkt-cross" />}
      </svg>
      {mas.length > 0 && (
        <div className="oc-mkt-legend">
          {mas.map((m, mi) => (
            <span key={m.period}>
              <i style={{ background: MA_COLORS[mi] }} aria-hidden />
              MA{m.period}
            </span>
          ))}
          <span className="oc-mkt-faint">均线按收盘价计算</span>
        </div>
      )}
    </div>
  );
}

function fmtDate(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
}

function KlineTable({ spec }: { spec: KlineSpec }) {
  return (
    <section
      className="oc-iui-table-region"
      aria-label="K线数据"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向滚动区必须可由键盘聚焦和滚动。
      tabIndex={0}
    >
      <table className="oc-iui-table">
        <thead>
          <tr>
            {["日期", "开", "高", "低", "收", "涨跌幅", "成交量(手)"].map((h, i) => (
              <th key={h} scope="col" className={i ? "is-num" : undefined}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...spec.rows].reverse().map((r, i, all) => {
            const prev = all[i + 1];
            const chg = prev ? ((r.close - prev.close) / prev.close) * 100 : undefined;
            return (
              <tr key={r.date}>
                <th scope="row">{fmtDate(r.date)}</th>
                <td className="is-num">{priceText(r.open)}</td>
                <td className="is-num">{priceText(r.high)}</td>
                <td className="is-num">{priceText(r.low)}</td>
                <td className="is-num">{priceText(r.close)}</td>
                <td className="is-num">
                  <Pct value={chg} />
                </td>
                <td className="is-num">{r.volume === undefined ? "—" : cnAmount(r.volume / 100)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function KlineBlock({ spec, notes, streaming, nested }: BlockProps<KlineSpec>) {
  const [ref, width] = useWidth(560);
  const [view, setView] = useState<"chart" | "data">("chart");
  const label = PERIOD_LABEL[spec.period ?? ""] ?? spec.period ?? "K线";
  const first = spec.rows[0];
  const last = spec.rows[spec.rows.length - 1];
  const rangePct = first && last ? ((last.close - first.close) / first.close) * 100 : undefined;
  return (
    <Frame
      kind="kline"
      title={spec.title ?? [spec.name, spec.code, label].filter(Boolean).join(" · ")}
      subtitle={spec.subtitle ?? (first && last ? `${fmtDate(first.date)} — ${fmtDate(last.date)} · 区间 ${pctText(rangePct)}` : undefined)}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-mkt"
      copyText={() => specToMarkdown(spec)}
      actions={
        <Segmented
          label="K线视图"
          role="radiogroup"
          items={["图", "数据"]}
          value={view === "chart" ? 0 : 1}
          onChange={(i) => setView(i === 1 ? "data" : "chart")}
        />
      }
    >
      <div ref={ref}>{spec.rows.length > 0 && (view === "chart" ? <KlineChart spec={spec} width={width} /> : <KlineTable spec={spec} />)}</div>
    </Frame>
  );
}

// ── 分时 ──────────────────────────────────────────────────────────────

function IntradayChart({ spec, width }: { spec: IntradaySpec; width: number }) {
  const pts = spec.points;
  const H = 200;
  const volH = pts.some((p) => p.volume !== undefined) ? 44 : 0;
  const priceBottom = H - volH - (volH ? 22 : 18);
  const x0 = PAD.l;
  const x1 = width - PAD.r;
  // A 股全天 241 个一分钟点；数据只到上午时横轴仍按全天排，留出下午的空白（看得出「还没走完」）。
  const fullDay = 241;
  const slots = Math.max(pts.length, fullDay);
  const cx = (i: number) => x0 + ((x1 - x0) * i) / (slots - 1);
  const base = spec.prevClose ?? pts[0].price;
  const dev = Math.max(...pts.flatMap((p) => [Math.abs(p.price - base), p.avg !== undefined ? Math.abs(p.avg - base) : 0]), base * 0.005);
  const lo = base - dev * 1.08;
  const hi = base + dev * 1.08;
  const y = scale(lo, hi, PAD.t, priceBottom);
  const line = (vals: (number | undefined)[]) =>
    vals.reduce<string>((acc, v, i) => (v === undefined ? acc : `${acc}${acc ? "L" : "M"}${cx(i).toFixed(1)},${y(v).toFixed(1)}`), "");
  const priceD = line(pts.map((p) => p.price));
  const avgD = line(pts.map((p) => p.avg));
  const maxVol = Math.max(1, ...pts.map((p) => p.volume ?? 0));
  const { active, handlers } = useScrub(pts.length, cx(0), cx(pts.length - 1));
  const p = active !== null ? pts[active] : pts[pts.length - 1];
  const pct = ((p.price - base) / base) * 100;
  const last = pts[pts.length - 1];
  const dir = direction(((last.price - base) / base) * 100);
  return (
    <div className="oc-mkt-chart">
      <div className="oc-mkt-readout" aria-live="polite">
        <span className="font-medium text-fg">{p.time}</span>
        <span>
          价 <b className={cn("tabular-nums", `is-${direction(pct)}`)}>{priceText(p.price)}</b>
        </span>
        <Pct value={pct} />
        {p.avg !== undefined && <span>均 {priceText(p.avg)}</span>}
        {p.volume !== undefined && <span>量 {cnAmount(p.volume / 100)}手</span>}
      </div>
      <svg
        viewBox={`0 0 ${width} ${H}`}
        className="oc-mkt-svg"
        role="img"
        aria-label={`${spec.name ?? spec.code ?? ""}分时：${pts.length} 个点，${pts[0].time} 至 ${last.time}，最新 ${priceText(last.price)}（${pctText(((last.price - base) / base) * 100)}）。`}
        {...handlers}
      >
        {[hi, base, lo].map((t) => (
          <g key={t}>
            <line x1={x0} x2={x1} y1={y(t)} y2={y(t)} className={t === base ? "oc-mkt-base" : "oc-mkt-grid-line"} />
            <text x={x1 + 6} y={y(t) + 4} className={cn("oc-mkt-axis", t > base && "is-up", t < base && "is-down")}>
              {t === base ? priceText(t) : pctText(((t - base) / base) * 100)}
            </text>
          </g>
        ))}
        <path d={`${priceD}L${cx(pts.length - 1).toFixed(1)},${priceBottom}L${cx(0).toFixed(1)},${priceBottom}Z`} className={`oc-mkt-area is-${dir}`} />
        <path d={priceD} fill="none" className="oc-mkt-line" vectorEffect="non-scaling-stroke" />
        {avgD && <path d={avgD} fill="none" className="oc-mkt-avg" vectorEffect="non-scaling-stroke" />}
        {volH > 0 &&
          pts.map((q, i) =>
            q.volume === undefined ? null : (
              <rect
                key={q.time}
                x={cx(i) - 0.6}
                width={Math.max(0.8, (x1 - x0) / slots - 0.4)}
                y={H - (q.volume / maxVol) * (volH - 4)}
                height={(q.volume / maxVol) * (volH - 4)}
                className={cn("oc-mkt-vol", i > 0 && q.price < pts[i - 1].price ? "is-down" : "is-up")}
              />
            ),
          )}
        <text x={x0} y={priceBottom + 14} className="oc-mkt-axis">
          09:30
        </text>
        <text x={(x0 + x1) / 2} y={priceBottom + 14} className="oc-mkt-axis" textAnchor="middle">
          11:30/13:00
        </text>
        <text x={x1} y={priceBottom + 14} className="oc-mkt-axis" textAnchor="end">
          15:00
        </text>
        {active !== null && <line x1={cx(active)} x2={cx(active)} y1={PAD.t} y2={H} className="oc-mkt-cross" />}
      </svg>
      <div className="oc-mkt-legend">
        <span>
          <i className="is-price" aria-hidden />
          价格
        </span>
        {avgD && (
          <span>
            <i className="is-avg" aria-hidden />
            均价
          </span>
        )}
        <span>
          <i className="is-base" aria-hidden />
          {spec.prevClose !== undefined ? "昨收" : "开盘价"}
        </span>
      </div>
    </div>
  );
}

export function IntradayBlock({ spec, notes, streaming, nested }: BlockProps<IntradaySpec>) {
  const [ref, width] = useWidth(560);
  const date = spec.date && /^\d{8}$/.test(spec.date) ? fmtDate(spec.date) : spec.date;
  return (
    <Frame
      kind="intraday"
      title={spec.title ?? [spec.name, spec.code, "分时"].filter(Boolean).join(" · ")}
      subtitle={spec.subtitle ?? date}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-mkt"
      copyText={() => specToMarkdown(spec)}
    >
      <div ref={ref}>{spec.points.length > 0 && <IntradayChart spec={spec} width={width} />}</div>
    </Frame>
  );
}

// ── 股票列表 ──────────────────────────────────────────────────────────

type SortKey = "changePct" | "amount" | "turnoverPct";
const SORT_LABEL: Record<SortKey, string> = { changePct: "涨跌幅", amount: "成交额", turnoverPct: "换手" };
const COLLAPSED = 10;

export function StockListBlock({ spec, notes, streaming, nested }: BlockProps<StockListSpec>) {
  const keys = (Object.keys(SORT_LABEL) as SortKey[]).filter((k) => spec.items.some((r) => r[k] !== undefined));
  // 默认保持来源顺序（排行榜的名次、问财的命中顺序都有含义）；用户点了才重排。
  const [sort, setSort] = useState<SortKey | "source">("source");
  const [expanded, setExpanded] = useState(false);
  const rows = useMemo(() => {
    if (sort === "source") return spec.items;
    return [...spec.items].sort((a, b) => (b[sort] ?? Number.NEGATIVE_INFINITY) - (a[sort] ?? Number.NEGATIVE_INFINITY));
  }, [spec.items, sort]);
  const shown = expanded ? rows : rows.slice(0, COLLAPSED);
  const showAmount = spec.items.some((r) => r.amount !== undefined);
  return (
    <Frame
      kind="stocklist"
      title={spec.title}
      subtitle={spec.subtitle ?? (spec.total ? `共 ${spec.total} 只，列出 ${spec.items.length} 只` : undefined)}
      nested={nested}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      className="oc-mkt"
      copyText={() => specToMarkdown(spec)}
      actions={
        keys.length > 0 && spec.items.length > 1 && !streaming ? (
          <Segmented
            label="排序"
            role="radiogroup"
            items={["默认", ...keys.map((k) => SORT_LABEL[k])]}
            value={sort === "source" ? 0 : keys.indexOf(sort) + 1}
            onChange={(i) => setSort(i === 0 ? "source" : keys[i - 1])}
          />
        ) : undefined
      }
    >
      <ol className="oc-mkt-rows is-list">
        {shown.map((r, i) => (
          <StockLine key={`${r.code}:${i}`} r={r} rank={i + 1} showAmount={showAmount} />
        ))}
      </ol>
      {rows.length > COLLAPSED && (
        <button type="button" className="oc-mkt-more" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          {expanded ? "收起" : `显示全部 ${rows.length} 只`}
        </button>
      )}
    </Frame>
  );
}

function StockLine({ r, rank, showAmount }: { r: StockRow; rank: number; showAmount: boolean }) {
  return (
    <li className="oc-mkt-row">
      <span className="oc-mkt-rank tabular-nums" aria-hidden>
        {rank}
      </span>
      <span className="oc-mkt-row-id">
        <span className="oc-mkt-name">{r.name ?? r.code}</span>
        <span className="oc-mkt-code">
          {r.code}
          {showAmount && r.amount !== undefined && <span> · 额 {cnAmount(r.amount)}</span>}
          {r.turnoverPct !== undefined && <span> · 换手 {pctText(r.turnoverPct, false)}</span>}
          {r.tag && <span> · {r.tag}</span>}
        </span>
      </span>
      <span className="oc-mkt-row-vals">
        {r.price !== undefined && <span className="tabular-nums oc-mkt-row-price">{priceText(r.price)}</span>}
        {r.changePct !== undefined && <Pct value={r.changePct} className="is-pill" />}
      </span>
    </li>
  );
}
