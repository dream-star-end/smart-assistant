/**
 * Intelligent UI 计算器:改任一输入,全部输出立即按公式重算(本机计算,不经模型)。
 * 「公式」展开逐项列出公式原文与代入值 —— 让用户能核对,而不是只看一个漂亮的数字。
 */
import { ChevronDown, Minus, Plus } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { computeOutputs, substitute } from "./formula";
import type { CalcInput, CalculatorSpec } from "./schema";
import { Frame, Inline } from "./shell";
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
  return (
    <div className="oc-iui-field">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="oc-iui-field-label">
          {input.label}
        </label>
        <span className="text-[14px] font-medium tabular-nums text-fg">{withUnit(formatNumber(value), input.unit)}</span>
      </div>
      <input
        id={id}
        type="range"
        className="oc-iui-range"
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

export function CalculatorBlock({ spec, notes, streaming }: { spec: CalculatorSpec; notes: string[]; streaming: boolean }) {
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
  const primary = spec.outputs.find((o) => o.primary) ?? (spec.outputs.length === 1 ? spec.outputs[0] : undefined);
  const others = spec.outputs.filter((o) => o !== primary);
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
      note={spec.note}
      notes={notes}
      streaming={streaming}
      copyText={() => specToMarkdown(spec, values)}
      actions={
        touched ? (
          <button type="button" className="oc-iui-text-btn" onClick={() => setValues({})}>
            还原
          </button>
        ) : undefined
      }
    >
      <div className="oc-iui-calc-inputs">
        {spec.inputs.map((i) => {
          const props = { input: i, value: env[i.id]!, onChange: (v: number) => set(i.id, v), disabled: streaming };
          if (i.kind === "slider") return <SliderField key={i.id} {...props} />;
          if (i.kind === "select") return <SelectField key={i.id} {...props} />;
          if (i.kind === "toggle") return <ToggleField key={i.id} {...props} />;
          return <NumberField key={i.id} {...props} />;
        })}
      </div>

      <div className="oc-iui-calc-outputs" aria-live="polite">
        {primary && (
          <div className="oc-iui-calc-primary">
            <div className="oc-iui-stat-label">{primary.label}</div>
            <div className="oc-iui-calc-primary-value">{show(primary.id)}</div>
            {results[primary.id]?.error && <div className="oc-iui-error">无法计算:{results[primary.id]!.error}</div>}
          </div>
        )}
        {others.length > 0 && (
          <dl className="oc-iui-calc-list">
            {others.map((o) => (
              <div key={o.id}>
                <dt>{o.label}</dt>
                <dd>
                  {show(o.id)}
                  {results[o.id]?.error && <span className="oc-iui-error">{results[o.id]!.error}</span>}
                </dd>
              </div>
            ))}
          </dl>
        )}
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
