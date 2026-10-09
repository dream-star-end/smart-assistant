/**
 * Intelligent UI 图表:原生 SVG(柱 / 折线 / 面积 / 饼)。
 * 宽度随容器测量,文字不随缩放变形;图例行兼作读数行(悬停/触摸/方向键时显示该点各系列数值),
 * 高度固定,不产生跳动。「数据」切换成原始数据表,方便核对与读屏。
 */
import { type KeyboardEvent, type PointerEvent, useEffect, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import type { ChartSpec } from "./schema";
import { Frame } from "./shell";
import { formatNumber, specToMarkdown, withUnit } from "./toMarkdown";

const COLORS = 6;
const color = (i: number) => `var(--iui-c${(i % COLORS) + 1})`;

/** 「好看」的刻度:1/2/2.5/5×10^n 步长,覆盖 [min,max]。 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    if (min === 0) return [0, 1];
    const pad = Math.abs(min) * 0.5;
    min -= pad;
    max += pad;
  }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  // 按序号生成而不是累加:数值极大时 v + step === v(浮点吸收),累加循环永不结束。
  const n = Math.round((hi - lo) / step);
  if (!Number.isFinite(n) || n < 1 || n > 50 || lo + step === lo) return [min, max];
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(lo + i * step);
  return out;
}

/** 单调三次插值(Fritsch–Carlson):曲线平滑且不越过相邻点,不会凭空造出波峰。 */
export function smoothPath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length;
  if (n === 0) return "";
  if (n < 3) return pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  const dx: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const d = pts[i + 1]![0] - pts[i]![0];
    dx.push(d);
    m.push(d === 0 ? 0 : (pts[i + 1]![1] - pts[i]![1]) / d);
  }
  const t: number[] = [m[0]!];
  for (let i = 1; i < n - 1; i++) t.push(m[i - 1]! * m[i]! <= 0 ? 0 : (m[i - 1]! + m[i]!) / 2);
  t.push(m[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) {
      t[i] = 0;
      t[i + 1] = 0;
      continue;
    }
    const a = t[i]! / m[i]!;
    const b = t[i + 1]! / m[i]!;
    const h = a * a + b * b;
    if (h > 9) {
      const k = 3 / Math.sqrt(h);
      t[i] = k * a * m[i]!;
      t[i + 1] = k * b * m[i]!;
    }
  }
  let d = `M${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i]!;
    const [x1, y1] = pts[i + 1]!;
    const h = dx[i]! / 3;
    d += `C${(x0 + h).toFixed(1)},${(y0 + t[i]! * h).toFixed(1)} ${(x1 - h).toFixed(1)},${(y1 - t[i + 1]! * h).toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

/** 只圆顶部两角的柱子(贴着基线的一端保持直角)。 */
function barPath(x: number, yTop: number, w: number, h: number, up: boolean): string {
  const r = Math.max(0, Math.min(5, w / 2, h));
  if (up) {
    const y1 = yTop + h;
    return `M${x},${y1}V${yTop + r}Q${x},${yTop} ${x + r},${yTop}H${x + w - r}Q${x + w},${yTop} ${x + w},${yTop + r}V${y1}Z`;
  }
  const y1 = yTop + h;
  return `M${x},${yTop}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${yTop}Z`;
}

function compact(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e8) return `${formatNumber(v / 1e8, "number", 1)}亿`;
  if (a >= 1e4) return `${formatNumber(v / 1e4, "number", 1)}万`;
  return formatNumber(v, "number", a < 10 && a % 1 !== 0 ? 2 : 0);
}

export function useWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const next = Math.round(el.clientWidth);
      if (next > 0) setW(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function summary(spec: ChartSpec): string {
  const all = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const kind = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图" }[spec.kind];
  const range = all.length ? `,数值范围 ${compact(Math.min(...all))} 到 ${compact(Math.max(...all))}${spec.unit ?? ""}` : "";
  return `${spec.title ? `${spec.title}:` : ""}${kind},${spec.labels.length} 个数据点,系列 ${spec.series.map((s) => s.name).join("、")}${range}。可切换到数据表查看全部数值。`;
}

function DataTable({ spec }: { spec: ChartSpec }) {
  return (
    <section
      className="oc-iui-table-region"
      aria-label="图表数据"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向滚动区必须可由键盘聚焦和滚动。
      tabIndex={0}
    >
      <table className="oc-iui-table">
        <thead>
          <tr>
            <th scope="col">{spec.xLabel ?? ""}</th>
            {spec.series.map((s) => (
              <th key={s.name} scope="col" className="is-num">
                {s.name}
                {spec.unit && <span className="oc-iui-unit">({spec.unit})</span>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.labels.map((l, i) => (
            <tr key={`${i}:${l}`}>
              <th scope="row">{l}</th>
              {spec.series.map((s) => (
                <td key={s.name} className="is-num">
                  {s.values[i] == null ? "—" : formatNumber(s.values[i]!)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Readout({ spec, active }: { spec: ChartSpec; active: number | null }) {
  if (active === null || spec.kind === "pie") {
    if (spec.series.length < 2 && spec.kind !== "pie") {
      return <div className="oc-iui-readout text-faint">{spec.yLabel ?? (spec.unit ? `单位:${spec.unit}` : "悬停或轻触查看数值")}</div>;
    }
    if (spec.kind === "pie") return null;
    return (
      <div className="oc-iui-readout">
        {spec.series.map((s, i) => (
          <span key={s.name} className="oc-iui-legend-item">
            <span className="oc-iui-swatch" style={{ background: color(i) }} aria-hidden />
            {s.name}
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="oc-iui-readout" aria-live="polite">
      <span className="font-medium text-fg">{spec.labels[active]}</span>
      {spec.series.map((s, i) => (
        <span key={s.name} className="oc-iui-legend-item">
          <span className="oc-iui-swatch" style={{ background: color(i) }} aria-hidden />
          {spec.series.length > 1 && `${s.name} `}
          <span className="tabular-nums text-fg">{s.values[active] == null ? "—" : withUnit(formatNumber(s.values[active]!), spec.unit)}</span>
        </span>
      ))}
    </div>
  );
}

export function CartesianChart({
  spec,
  width,
  active,
  setActive,
  height,
}: {
  spec: ChartSpec;
  width: number;
  active: number | null;
  setActive: (i: number | null) => void;
  height?: number;
}) {
  const gid = useId().replace(/:/g, "");
  const H = height ?? (width < 420 ? 220 : 260);
  const n = spec.labels.length;
  const stacked = spec.stacked && spec.kind !== "line";
  const values = spec.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (stacked && n > 0) {
    const sums = spec.labels.map((_, i) => spec.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
    const negs = spec.labels.map((_, i) => spec.series.reduce((a, s) => a + Math.min(0, s.values[i] ?? 0), 0));
    hi = Math.max(hi, ...sums);
    lo = Math.min(lo, ...negs);
  }
  if (spec.kind !== "bar" && values.length) {
    // 折线不强制从 0 起:数据离 0 很远时从 0 起会把起伏压平。
    const vmin = Math.min(...values);
    const vmax = Math.max(...values);
    if (vmin > 0 && vmin > (vmax - vmin) * 2) lo = vmin;
  }
  const ticks = niceTicks(lo, hi, H < 200 ? 3 : width < 420 ? 4 : 5);
  const tMin = ticks[0]!;
  const tMax = ticks[ticks.length - 1]!;
  const labelW = Math.max(...ticks.map((t) => compact(t).length)) * 7 + 10;
  const pad = { l: labelW, r: 10, t: 16, b: 26 };
  const pw = Math.max(40, width - pad.l - pad.r);
  const ph = H - pad.t - pad.b;
  const y = (v: number) => pad.t + ph - ((v - tMin) / (tMax - tMin || 1)) * ph;
  const band = n > 0 ? pw / n : pw;
  const cx = (i: number) => pad.l + band * i + band / 2;
  const every = Math.max(1, Math.ceil((n * 44) / pw));
  // 类目标签按可用宽度截断(按每字约 9px 保守估计)。
  const maxChars = Math.max(4, Math.floor((band * every) / 9));

  const onPointer = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * width - pad.l;
    if (n === 0) return;
    setActive(Math.max(0, Math.min(n - 1, Math.floor(x / band))));
  };

  const bars = () => {
    const inner = band * (spec.series.length > 1 && !stacked ? 0.78 : 0.56);
    const groups = stacked ? 1 : spec.series.length;
    const bw = Math.max(2, Math.min(56, inner / Math.max(1, groups)));
    const used = stacked ? bw : bw * groups;
    // 柱子少时在柱顶标数值(多了会挤,改由悬停读数)。
    const labelBars = !stacked && n * groups <= 12 && bw >= 18;
    return spec.labels.map((_, i) => {
      let posAcc = 0;
      let negAcc = 0;
      return spec.series.map((s, si) => {
        const v = s.values[i];
        if (v == null) return null;
        let y0: number;
        let y1: number;
        if (stacked) {
          const base = v >= 0 ? posAcc : negAcc;
          y0 = y(base);
          y1 = y(base + v);
          if (v >= 0) posAcc += v;
          else negAcc += v;
        } else {
          y0 = y(Math.max(tMin, 0));
          y1 = y(v);
        }
        const x = pad.l + band * i + (band - used) / 2 + (stacked ? 0 : si * bw);
        const w = Math.max(1, bw - (groups > 1 ? 3 : 0));
        const top = Math.min(y0, y1);
        const h = Math.max(0.5, Math.abs(y1 - y0));
        // 堆叠时只给最外一段圆角。
        const outer = !stacked || spec.series.slice(si + 1).every((t) => (t.values[i] ?? 0) === 0 || Math.sign(t.values[i] ?? 0) !== Math.sign(v));
        return (
          <g key={`${i}-${s.name}`} opacity={active === null || active === i ? 1 : 0.4} className="oc-iui-bar">
            {outer ? <path d={barPath(x, top, w, h, v >= 0)} fill={`url(#${gid}-b${si})`} /> : <rect x={x} y={top} width={w} height={h} fill={`url(#${gid}-b${si})`} />}
            {labelBars && (
              <text x={x + w / 2} y={v >= 0 ? top - 5 : top + h + 12} textAnchor="middle" className="oc-iui-bar-label">
                {compact(v)}
              </text>
            )}
          </g>
        );
      });
    });
  };

  const lines = () =>
    spec.series.map((s, si) => {
      const pts = s.values.map((v, i) => (v == null ? null : ([cx(i), y(v)] as const)));
      // 空值断开折线:连续的非空点构成一段。
      const segs: (readonly [number, number])[][] = [];
      let cur: (readonly [number, number])[] = [];
      for (const p of pts) {
        if (p) cur.push(p);
        else if (cur.length) {
          segs.push(cur);
          cur = [];
        }
      }
      if (cur.length) segs.push(cur);
      const base = y(tMin > 0 ? tMin : tMax < 0 ? tMax : 0);
      const lastIdx = pts.reduce((acc, p, i) => (p ? i : acc), -1);
      const showDots = n <= 12 && spec.kind === "line";
      return (
        <g key={s.name}>
          {spec.kind === "area" &&
            segs.map((seg) => (
              <path
                key={`a${seg[0]![0]}`}
                d={`${smoothPath(seg)}L${seg[seg.length - 1]![0].toFixed(1)},${base.toFixed(1)}L${seg[0]![0].toFixed(1)},${base.toFixed(1)}Z`}
                fill={`url(#${gid}-a${si})`}
              />
            ))}
          {segs.map((seg) => (
            <path
              key={`l${seg[0]![0]}`}
              d={smoothPath(seg)}
              fill="none"
              stroke={color(si)}
              strokeWidth={2.25}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={si > 0 && spec.kind === "area" ? "5 4" : undefined}
            />
          ))}
          {pts.map((p, i) =>
            p && (showDots || active === i || i === lastIdx) ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: 点位与类目一一对应
              <g key={i}>
                {(i === lastIdx || active === i) && <circle cx={p[0]} cy={p[1]} r={7} fill={color(si)} opacity={0.18} />}
                <circle cx={p[0]} cy={p[1]} r={active === i || i === lastIdx ? 3.75 : 2.75} fill={color(si)} stroke="var(--surface)" strokeWidth={1.75} />
              </g>
            ) : null,
          )}
        </g>
      );
    });

  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: 装饰性绘制;外层 role=img 带完整 aria-label,数值另有数据表
    <svg
      viewBox={`0 0 ${width} ${H}`}
      width="100%"
      height={H}
      className="oc-iui-svg"
      onPointerMove={onPointer}
      onPointerDown={onPointer}
      onPointerLeave={() => setActive(null)}
      aria-hidden
    >
      <defs>
        {spec.series.map((s, si) => (
          <linearGradient key={`a${s.name}`} id={`${gid}-a${si}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color(si)} stopOpacity={si === 0 ? 0.32 : 0.16} />
            <stop offset="100%" stopColor={color(si)} stopOpacity={0} />
          </linearGradient>
        ))}
        {spec.series.map((s, si) => (
          <linearGradient key={`b${s.name}`} id={`${gid}-b${si}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color(si)} stopOpacity={1} />
            <stop offset="100%" stopColor={color(si)} stopOpacity={0.78} />
          </linearGradient>
        ))}
      </defs>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={width - pad.r} y1={y(t)} y2={y(t)} className={t === 0 ? "oc-iui-axis" : "oc-iui-grid"} />
          <text x={pad.l - 6} y={y(t)} dy="0.32em" textAnchor="end" className="oc-iui-tick">
            {compact(t)}
          </text>
        </g>
      ))}
      {active !== null &&
        (spec.kind === "bar" ? (
          <rect x={pad.l + band * active} y={pad.t} width={band} height={ph} rx={6} className="oc-iui-hover-band" />
        ) : (
          <line x1={cx(active)} x2={cx(active)} y1={pad.t} y2={pad.t + ph} className="oc-iui-hover-line" />
        ))}
      {spec.kind === "bar" ? bars() : lines()}
      {spec.labels.map((l, i) =>
        i % every === 0 ? (
          <text key={`${i}:${l}`} x={cx(i)} y={H - 8} textAnchor="middle" className="oc-iui-tick">
            {l.length > maxChars ? `${l.slice(0, maxChars - 1)}…` : l}
          </text>
        ) : null,
      )}
    </svg>
  );
}

function PieChart({ spec, active, setActive }: { spec: ChartSpec; active: number | null; setActive: (i: number | null) => void }) {
  const s = spec.series[0];
  const vals = (s?.values ?? []).map((v) => (v == null || v < 0 ? 0 : v));
  const total = vals.reduce((a, b) => a + b, 0);
  const R = 76;
  const r = 46;
  let acc = 0;
  const arcs = vals.map((v, i) => {
    const a0 = (acc / (total || 1)) * Math.PI * 2 - Math.PI / 2;
    acc += v;
    const a1 = (acc / (total || 1)) * Math.PI * 2 - Math.PI / 2;
    if (v <= 0) return null;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad: number, ang: number) => `${(90 + rad * Math.cos(ang)).toFixed(2)},${(90 + rad * Math.sin(ang)).toFixed(2)}`;
    // 整圆(只有一项)时 SVG 弧起止点重合画不出来:拆成两半。
    const d =
      v === total
        ? `M${p(R, -Math.PI / 2)}A${R},${R} 0 1 1 ${p(R, Math.PI / 2)}A${R},${R} 0 1 1 ${p(R, -Math.PI / 2)}M${p(r, -Math.PI / 2)}A${r},${r} 0 1 0 ${p(r, Math.PI / 2)}A${r},${r} 0 1 0 ${p(r, -Math.PI / 2)}Z`
        : `M${p(R, a0)}A${R},${R} 0 ${large} 1 ${p(R, a1)}L${p(r, a1)}A${r},${r} 0 ${large} 0 ${p(r, a0)}Z`;
    return (
      <path
        // biome-ignore lint/suspicious/noArrayIndexKey: 扇区与类目一一对应
        key={i}
        d={d}
        fill={color(i)}
        fillRule="evenodd"
        stroke="var(--iui-surface)"
        strokeWidth={2}
        strokeLinejoin="round"
        opacity={active === null || active === i ? 1 : 0.4}
        onPointerEnter={() => setActive(i)}
        onPointerDown={() => setActive(i)}
      />
    );
  });
  const shown = active ?? null;
  return (
    <div className="oc-iui-pie">
      {/* biome-ignore lint/a11y/noSvgWithoutTitle: 装饰性绘制;图例按钮逐项可读 */}
      <svg viewBox="0 0 180 180" width={180} height={180} className="oc-iui-svg shrink-0" aria-hidden onPointerLeave={() => setActive(null)}>
        {arcs}
        <text x={90} y={86} textAnchor="middle" className="oc-iui-pie-center">
          {shown === null ? withUnit(compact(total), spec.unit) : `${total ? formatNumber((vals[shown]! / total) * 100, "number", 1) : 0}%`}
        </text>
        <text x={90} y={104} textAnchor="middle" className="oc-iui-tick">
          {shown === null ? "合计" : (spec.labels[shown] ?? "").slice(0, 8)}
        </text>
      </svg>
      <ul className="oc-iui-pie-legend">
        {spec.labels.map((l, i) => (
          <li key={`${i}:${l}`} className={cn(active === i && "is-active")}>
            <button type="button" onClick={() => setActive(active === i ? null : i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}>
              <span className="oc-iui-swatch" style={{ background: color(i) }} aria-hidden />
              <span className="min-w-0 flex-1 truncate text-left">{l}</span>
              <span className="tabular-nums text-fg">{withUnit(formatNumber(vals[i] ?? 0), spec.unit)}</span>
              <span className="w-12 text-right tabular-nums text-faint">{total ? `${formatNumber(((vals[i] ?? 0) / total) * 100, "number", 1)}%` : "—"}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function ChartBlock({ spec, notes, streaming, nested }: { spec: ChartSpec; notes: string[]; streaming: boolean; nested?: boolean }) {
  const [ref, width] = useWidth();
  const [showData, setShowData] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const label = useMemo(() => summary(spec), [spec]);
  const n = spec.labels.length;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (n === 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      const d = e.key === "ArrowRight" ? 1 : -1;
      setActive((a) => (a === null ? (d === 1 ? 0 : n - 1) : (a + d + n) % n));
    } else if (e.key === "Escape") setActive(null);
  };

  return (
    <Frame
      kind="chart"
      nested={nested}
      title={spec.title}
      subtitle={spec.subtitle}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      copyText={() => specToMarkdown(spec)}
      actions={
        <button type="button" className="oc-iui-text-btn" aria-pressed={showData} onClick={() => setShowData((v) => !v)} disabled={streaming}>
          {showData ? "图表" : "数据"}
        </button>
      }
    >
      {showData ? (
        <DataTable spec={spec} />
      ) : (
        <div ref={ref} className="oc-iui-chart">
          {spec.kind === "pie" ? (
            // 饼图的图例本身就是可聚焦的按钮列表(读屏可逐项读),不再包 role=img。
            <>
              <p className="sr-only">{label}</p>
              <PieChart spec={spec} active={active} setActive={setActive} />
            </>
          ) : (
            <>
              <Readout spec={spec} active={active} />
              <div
                role="img"
                aria-label={label}
                // biome-ignore lint/a11y/noNoninteractiveTabindex: 图表可用方向键逐点读数
                tabIndex={0}
                className="oc-iui-focus"
                onKeyDown={onKey}
                onBlur={() => setActive(null)}
              >
                <CartesianChart spec={spec} width={width} active={active} setActive={setActive} />
              </div>
            </>
          )}
          {spec.kind !== "pie" && spec.xLabel && <div className="oc-iui-axis-label">{spec.xLabel}</div>}
        </div>
      )}
    </Frame>
  );
}
