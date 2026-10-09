/**
 * Intelligent UI 计算器:改任一输入,全部输出立即按公式重算(本机计算,不经模型)。
 * 「公式」展开逐项列出公式原文与代入值 —— 让用户能核对,而不是只看一个漂亮的数字。
 */
import { ChevronDown, Minus, Plus, TrendingDown, TrendingUp } from "lucide-react";
import { type CSSProperties, useId, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { CartesianChart, useWidth } from "./ChartBlock";
import { computeOutputs, substitute } from "./formula";
import type { CalcInput, CalcOutput, CalculatorSpec, ChartSpec } from "./schema";
import { Frame, Inline, useTweenedNumber } from "./shell";
import { formatNumber, specToMarkdown, withUnit } from "./toMarkdown";

function clamp(v: number, input: CalcInput): number {
  let x = v;
  if (input.min !== undefined) x = Math.max(input.min, x);
  if (input.max !== undefined) x = Math.min(input.max, x);
  return x;
}

function decimalsOf(step: number): number {
  const s = String(step);
  return s.includes(".") ? s.split(".")[1]!.length : 0;
}

function NumberField({ input, value, onChange, disabled }: { input: CalcInput; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const id = useId();
  const step = input.step ?? 1;
  const [draft, setDraft] = useState<string | null>(null);
  const bump = (d: number) => onChange(clamp(Number((value + d * step).toFixed(Math.min(10, decimalsOf(step) + 2))), input));
  return (
    <div className="oc-iui-field">
      <label htmlFor={id} className="oc-iui-field-label">
        {input.label}
      </label>
      <div className="oc-iui-stepper">
        <button type="button" aria-label={`减少${input.label}`} onClick={() => bump(-1)} disabled={disabled || (input.min !== undefined && value <= input.min)}>
          <Minus size={14} aria-hidden />
        </button>
        <input
          id={id}
          inputMode="decimal"
          value={draft ?? String(value)}
          disabled={disabled}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = Number(e.target.value.replace(/[,\s]/g, ""));
            if (e.target.value.trim() !== "" && Number.isFinite(n)) onChange(clamp(n, input));
          }}
          onBlur={() => setDraft(null)}
          aria-describedby={input.unit ? `${id}-u` : undefined}
        />
        {input.unit && (
          <span id={`${id}-u`} className="oc-iui-field-unit">
            {input.unit}
          </span>
        )}
        <button type="button" aria-label={`增加${input.label}`} onClick={() => bump(1)} disabled={disabled || (input.max !== undefined && value >= input.max)}>
          <Plus size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

function SliderField({ input, value, onChange, disabled }: { input: CalcInput; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const id = useId();
  const lo = input.min ?? 0;
  const hi = input.max ?? 100;
  const pct = hi > lo ? Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100)) : 0;
  return (
    <div className="oc-iui-field">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="oc-iui-field-label">
          {input.label}
        </label>
        <span className="oc-iui-field-value">{withUnit(formatNumber(value), input.unit)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="oc-iui-range"
        style={{ "--pct": `${pct}%` } as CSSProperties}
        min={input.min}
        max={input.max}
        step={input.step ?? "any"}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function SelectField({ input, value, onChange, disabled }: { input: CalcInput; value: number; onChange: (v: number) => void; disabled: boolean }) {
  const id = useId();
  return (
    <div className="oc-iui-field">
      <label htmlFor={id} className="oc-iui-field-label">
        {input.label}
      </label>
      <select id={id} className="oc-iui-select" value={String(value)} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))}>
        {input.options.map((o) => (
          <option key={`${o.value}:${o.label}`} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function ToggleField({ input, value, onChange, disabled }: { input: CalcInput; value: number; onChange: (v: number) => void; disabled: boolean }) {
  return (
    <div className="oc-iui-field oc-iui-field-row">
      <span className="oc-iui-field-label">{input.label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={value !== 0}
        aria-label={input.label}
        className="oc-iui-switch"
        disabled={disabled}
        onClick={() => onChange(value !== 0 ? 0 : 1)}
      >
        <span aria-hidden />
      </button>
    </div>
  );
}

/** 扫描 x 输入得到的曲线(本机重算每个点)。 */
function useSweep(spec: CalculatorSpec, env: Record<string, number>) {
  return useMemo(() => {
    const c = spec.chart;
    if (!c) return null;
    const input = spec.inputs.find((i) => i.id === c.x);
    const to = typeof c.to === "string" ? env[c.to] : c.to;
    if (!input || to === undefined || !Number.isFinite(to) || !Number.isFinite(c.from) || to === c.from) return null;
    const span = to - c.from;
    const intRange = Number.isInteger(c.from) && Number.isInteger(to) && Math.abs(span) <= 60;
    const count = c.points || (intRange ? Math.abs(span) + 1 : 24);
    const xs = Array.from({ length: count }, (_, k) => c.from + (span * k) / (count - 1));
    const series = c.series.map((id) => ({ id, name: spec.outputs.find((o) => o.id === id)?.label ?? id, values: [] as (number | null)[] }));
    for (const x of xs) {
      const r = computeOutputs({ ...env, [c.x]: x }, spec.outputs);
      for (const s of series) {
        const v = r[s.id]?.value;
        s.values.push(v === null || v === undefined || !Number.isFinite(v) ? null : v);
      }
    }
    const firstOut = spec.outputs.find((o) => o.id === c.series[0]);
    const chart: ChartSpec = {
      type: "chart",
      kind: c.kind,
      labels: xs.map((x) => withUnit(formatNumber(x, "number", intRange ? 0 : 2), input.unit)),
      series: series.map((s) => ({ name: s.name, values: s.values })),
      ...(firstOut?.unit && !["%", "‰"].includes(firstOut.unit) ? { unit: firstOut.unit } : {}),
      stacked: false,
    };
    return { chart, xLabel: c.xLabel ?? input.label, outputs: c.series.map((id) => spec.outputs.find((o) => o.id === id)!) };
  }, [spec, env]);
}

function SweepChart({ sweep }: { sweep: NonNullable<ReturnType<typeof useSweep>> }) {
  const [ref, width] = useWidth(480);
  const [active, setActive] = useState<number | null>(null);
  const { chart, outputs } = sweep;
  const at = active ?? chart.labels.length - 1;
  return (
    <div className="oc-iui-calc-chart" ref={ref}>
      <div className="oc-iui-readout" aria-live="polite">
        <span className="font-medium text-fg">{chart.labels[at]}</span>
        {chart.series.map((s, i) => {
          const o = outputs[i]!;
          const v = s.values[at];
          return (
            <span key={s.name} className="oc-iui-legend-item">
              <span className="oc-iui-swatch" style={{ background: `var(--iui-c${(i % 6) + 1})` }} aria-hidden />
              {s.name}
              <span className="tabular-nums text-fg">{v == null ? "—" : withUnit(formatNumber(v, o.format, o.decimals), o.unit)}</span>
            </span>
          );
        })}
      </div>
      <CartesianChart spec={chart} width={width} active={active} setActive={setActive} height={width < 420 ? 170 : 190} />
    </div>
  );
}

function Breakdown({ outs, results }: { outs: CalcOutput[]; results: ReturnType<typeof computeOutputs> }) {
  const vals = outs.map((o) => Math.max(0, results[o.id]?.value ?? 0));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return (
    <div className="oc-iui-breakdown">
      <div className="oc-iui-breakdown-bar" aria-hidden>
        {outs.map((o, i) => (
          <span key={o.id} style={{ flexGrow: vals[i]! / total, background: `var(--iui-c${(i % 6) + 1})` }} />
        ))}
      </div>
      <dl className="oc-iui-breakdown-legend">
        {outs.map((o, i) => (
          <div key={o.id}>
            <dt>
              <span className="oc-iui-swatch" style={{ background: `var(--iui-c${(i % 6) + 1})` }} aria-hidden />
              {o.label}
            </dt>
            <dd>{withUnit(formatNumber(vals[i]!, o.format, o.decimals), o.unit)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PrimaryValue({ output, value }: { output: CalcOutput; value: number | null }) {
  const shown = useTweenedNumber(value);
  if (shown === null) return <span className="text-faint">—</span>;
  return <>{withUnit(formatNumber(shown, output.format, output.decimals ?? (output.format === "number" && Math.abs(value ?? 0) >= 100 ? 0 : undefined)), output.unit)}</>;
}

export function CalculatorBlock({ spec, notes, streaming, nested }: { spec: CalculatorSpec; notes: string[]; streaming: boolean; nested?: boolean }) {
  const [values, setValues] = useState<Record<string, number>>({});
  const [showFormulas, setShowFormulas] = useState(false);
  const env = useMemo(() => {
    const e: Record<string, number> = {};
    for (const i of spec.inputs) e[i.id] = values[i.id] ?? i.value;
    return e;
  }, [spec.inputs, values]);
  const results = useMemo(() => computeOutputs(env, spec.outputs), [env, spec.outputs]);
  const fullEnv = useMemo(() => {
    const e = { ...env };
    for (const o of spec.outputs) if (results[o.id]?.value != null) e[o.id] = results[o.id]!.value!;
    return e;
  }, [env, results, spec.outputs]);
  const sweep = useSweep(spec, env);
  const primary = spec.outputs.find((o) => o.primary) ?? (spec.outputs.length === 1 ? spec.outputs[0] : undefined);
  // 带 tone 的输出显示在主结果下面(如「+170,851 收益」),同时可以出现在占比条里。
  const toned = spec.outputs.filter((o) => o !== primary && o.tone);
  const others = spec.outputs.filter((o) => o !== primary && !toned.includes(o) && !spec.breakdown.includes(o.id));
  const breakdownOuts = spec.breakdown.map((id) => spec.outputs.find((o) => o.id === id)!).filter(Boolean);
  const set = (id: string, v: number) => setValues((s) => ({ ...s, [id]: v }));
  const touched = Object.keys(values).length > 0;

  const show = (id: string) => {
    const o = spec.outputs.find((x) => x.id === id)!;
    const r = results[id];
    if (!r || r.value === null) return <span className="text-faint" title={r?.error}>—</span>;
    return withUnit(formatNumber(r.value, o.format, o.decimals), o.unit);
  };

  return (
    <Frame
      kind="calculator"
      title={spec.title}
      subtitle={spec.subtitle}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec, values)}
      actions={
        touched ? (
          <button type="button" className="oc-iui-text-btn" onClick={() => setValues({})}>
            还原
          </button>
        ) : undefined
      }
    >
      <div className="oc-iui-calc-outputs" aria-live="polite">
        {primary && (
          <div className="oc-iui-calc-primary">
            <div className="oc-iui-calc-primary-label">{primary.label}</div>
            <div className={cn("oc-iui-calc-primary-value", primary.tone && `is-${primary.tone}`)}>
              <PrimaryValue output={primary} value={results[primary.id]?.value ?? null} />
            </div>
            {toned.map((o) => {
              const Icon = o.tone === "down" ? TrendingDown : TrendingUp;
              return (
                <div key={o.id} className={cn("oc-iui-calc-delta", `is-${o.tone}`)}>
                  <Icon size={15} aria-hidden />
                  <span className="tabular-nums">{show(o.id)}</span>
                  <span>{o.label}</span>
                </div>
              );
            })}
            {results[primary.id]?.error && <div className="oc-iui-error">无法计算:{results[primary.id]!.error}</div>}
          </div>
        )}
        {breakdownOuts.length >= 2 && <Breakdown outs={breakdownOuts} results={results} />}
        {sweep && <SweepChart sweep={sweep} />}
        {(others.length > 0 || (!primary && toned.length > 0)) && (
          <dl className="oc-iui-calc-list">
            {(primary ? others : [...toned, ...others]).map((o) => (
              <div key={o.id}>
                <dt>{o.label}</dt>
                <dd className={cn(o.tone && `is-${o.tone}`)}>
                  {show(o.id)}
                  {results[o.id]?.error && <span className="oc-iui-error">{results[o.id]!.error}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>

      <div className="oc-iui-calc-inputs">
        {spec.inputs.map((i) => {
          const props = { input: i, value: env[i.id]!, onChange: (v: number) => set(i.id, v), disabled: streaming };
          if (i.kind === "slider") return <SliderField key={i.id} {...props} />;
          if (i.kind === "select") return <SelectField key={i.id} {...props} />;
          if (i.kind === "toggle") return <ToggleField key={i.id} {...props} />;
          return <NumberField key={i.id} {...props} />;
        })}
      </div>

      <div className="oc-iui-calc-basis">
        <button type="button" className="oc-iui-disclosure" aria-expanded={showFormulas} onClick={() => setShowFormulas((v) => !v)}>
          <ChevronDown size={14} aria-hidden className={cn("transition-transform", showFormulas && "rotate-180")} />
          公式与假设
        </button>
        {showFormulas && (
          <div className="oc-iui-formulas">
            <ul>
              {spec.outputs.map((o) => (
                <li key={o.id}>
                  <span className="text-fg">{o.label}</span> = <code>{o.formula}</code>
                  <div className="text-faint">
                    = <code>{substitute(o.formula, fullEnv, (n) => formatNumber(n))}</code> = {show(o.id)}
                  </div>
                </li>
              ))}
            </ul>
            {spec.assumptions.length > 0 && (
              <ul className="oc-iui-assumptions">
                {spec.assumptions.map((a) => (
                  <li key={a}>
                    <Inline text={a} />
                  </li>
                ))}
              </ul>
            )}
            <p className="text-faint">结果在本机按上面的公式计算,只代表这些公式和假设下的估算。</p>
          </div>
        )}
      </div>
    </Frame>
  );
}
