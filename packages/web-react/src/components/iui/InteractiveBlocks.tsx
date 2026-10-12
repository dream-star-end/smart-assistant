/**
 * Intelligent UI 交互类组件:随份数换算的食谱、本地判分的小测验、填完作为一条用户消息发出的表单。
 * 都在本机运行,不经模型;表单发送走与「后续建议」相同的发送通道。
 */
import { ArrowRight, Check, Minus, Plus, RotateCcw, Send, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { cn } from "../../lib/utils";
import { chatInteractionUnavailableText, useChatInteraction } from "../tool/context";
import type { FormField, FormSpec, QuizSpec, RecipeSpec } from "./schema";
import { Frame, Inline } from "./shell";
import { formatNumber, kitchenRound, specToMarkdown } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; readOnly?: boolean; nested?: boolean };

// ── 食谱 ──────────────────────────────────────────────────────────────

export function scaleAmount(amount: number, base: number, servings: number): number {
  return kitchenRound((amount * servings) / (base || 1));
}

export function RecipeBlock({ spec, notes, streaming, nested }: BlockProps<RecipeSpec>) {
  const [servings, setServings] = useState(spec.servings);
  const step = spec.servings % 1 === 0 ? 1 : 0.5;
  const id = useId();
  const scaled = useMemo(
    () => spec.ingredients.map((g) => ({ ...g, shown: g.amount === undefined ? undefined : scaleAmount(g.amount, spec.servings, servings) })),
    [spec, servings],
  );
  return (
    <Frame
      kind="recipe"
      title={spec.title}
      subtitle={spec.subtitle}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => specToMarkdown(spec, { servings })}
    >
      <div className="oc-iui-recipe-bar">
        {/* biome-ignore lint/a11y/useSemanticElements: 胶囊步进器是一行按钮,fieldset 的默认边框和 legend 布局不适用 */}
        <div className="oc-iui-pill-stepper" role="group" aria-labelledby={`${id}-l`}>
          <span id={`${id}-l`} className="oc-iui-pill-stepper-label">
            份量
          </span>
          <button type="button" aria-label="减少份量" onClick={() => setServings((v) => Math.max(step, v - step))} disabled={streaming || servings <= step}>
            <Minus size={14} aria-hidden />
          </button>
          <output aria-live="polite" className="oc-iui-pill-stepper-value">
            {formatNumber(servings)} {spec.unit}
          </output>
          <button type="button" aria-label="增加份量" onClick={() => setServings((v) => Math.min(999, v + step))} disabled={streaming}>
            <Plus size={14} aria-hidden />
          </button>
        </div>
        {spec.meta.length > 0 && (
          <dl className="oc-iui-recipe-meta">
            {spec.meta.map((m) => (
              <div key={m.label}>
                <dt>{m.label}</dt>
                <dd>{m.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <ul className="oc-iui-ingredients" aria-label="用料">
        {scaled.map((g, i) => (
          <li key={`${i}:${g.name}`}>
            <span className="oc-iui-ingredient-name">
              <Inline text={g.name} />
              {g.note && <span className="oc-iui-ingredient-note">{g.note}</span>}
            </span>
            <span className={cn("oc-iui-ingredient-amount", servings !== spec.servings && g.shown !== undefined && "is-changed")}>
              {g.shown === undefined ? "适量" : `${formatNumber(g.shown)}${g.unit ? ` ${g.unit}` : ""}`}
            </span>
          </li>
        ))}
      </ul>
      {spec.steps.length > 0 && (
        <ol className="oc-iui-recipe-steps" aria-label="做法">
          {spec.steps.map((s, i) => (
            <li key={`${i}:${s.slice(0, 12)}`}>
              <span className="oc-iui-step-num" aria-hidden>
                {i + 1}
              </span>
              <span className="min-w-0">
                <Inline text={s} />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Frame>
  );
}

// ── 小测验 ────────────────────────────────────────────────────────────

export function QuizBlock({ spec, notes, streaming, nested }: BlockProps<QuizSpec>) {
  const [idx, setIdx] = useState(0);
  const [picks, setPicks] = useState<(number | null)[]>(() => spec.questions.map(() => null));
  const total = spec.questions.length;
  const done = idx >= total;
  const score = picks.filter((p, i) => p === spec.questions[i]?.answer).length;
  const q = spec.questions[Math.min(idx, total - 1)]!;
  const pick = picks[idx] ?? null;
  const answered = pick !== null;
  const restart = () => {
    setPicks(spec.questions.map(() => null));
    setIdx(0);
  };
  return (
    <Frame kind="quiz" title={spec.title} subtitle={spec.subtitle} notes={notes} streaming={streaming} nested={nested} copyText={() => specToMarkdown(spec)}>
      <div className="oc-iui-quiz">
        <div className="oc-iui-quiz-progress" aria-hidden>
          {spec.questions.map((qq, i) => (
            <span
              key={`${i}:${qq.question.slice(0, 8)}`}
              className={cn(
                i === idx && !done && "is-current",
                picks[i] !== null && (picks[i] === qq.answer ? "is-right" : "is-wrong"),
              )}
            />
          ))}
        </div>
        {done ? (
          <div className="oc-iui-quiz-result" aria-live="polite">
            <div className="oc-iui-quiz-score">
              {score}
              <span> / {total}</span>
            </div>
            <p>{score === total ? "全部答对。" : score >= total / 2 ? "答对了一多半,看看错的那几题。" : "再看一遍解析,然后重做一次。"}</p>
            <button type="button" className="oc-iui-btn" onClick={restart}>
              <RotateCcw size={14} aria-hidden />
              再做一次
            </button>
          </div>
        ) : (
          <>
            <p className="oc-iui-quiz-count">
              第 {idx + 1} 题 · 共 {total} 题
            </p>
            <p className="oc-iui-quiz-q">
              <Inline text={q.question} />
            </p>
            {/* biome-ignore lint/a11y/useSemanticElements: 选项是一组按钮,点了即判分,不是表单字段 */}
            <div className="oc-iui-quiz-options" role="group" aria-label="选项">
              {q.options.map((o, i) => {
                const state = !answered ? undefined : i === q.answer ? "right" : i === pick ? "wrong" : "dim";
                return (
                  <button
                    key={`${i}:${o}`}
                    type="button"
                    className={cn("oc-iui-quiz-option", state && `is-${state}`)}
                    disabled={answered || streaming}
                    aria-pressed={pick === i}
                    onClick={() => setPicks((p) => p.map((v, j) => (j === idx ? i : v)))}
                  >
                    <span className="oc-iui-quiz-letter" aria-hidden>
                      {state === "right" ? <Check size={13} strokeWidth={3} /> : state === "wrong" ? <X size={13} strokeWidth={3} /> : String.fromCharCode(65 + i)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Inline text={o} />
                    </span>
                  </button>
                );
              })}
            </div>
            {answered && (
              <div className="oc-iui-quiz-explain" aria-live="polite">
                <p className={cn("oc-iui-quiz-verdict", pick === q.answer ? "is-right" : "is-wrong")}>
                  {pick === q.answer ? "答对了" : `正确答案是 ${String.fromCharCode(65 + q.answer)}`}
                </p>
                {q.explain && (
                  <p>
                    <Inline text={q.explain} />
                  </p>
                )}
                <button type="button" className="oc-iui-btn is-primary" onClick={() => setIdx((v) => v + 1)}>
                  {idx + 1 < total ? "下一题" : "看结果"}
                  <ArrowRight size={14} aria-hidden />
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Frame>
  );
}

// ── 表单 ──────────────────────────────────────────────────────────────

type FormValue = string | string[];

function initialValue(f: FormField): FormValue {
  if (f.kind === "chips" && f.multi) return f.value ? f.value.split(/[,,、]/).map((s) => s.trim()).filter((s) => f.options.includes(s)) : [];
  if (f.kind === "select" || f.kind === "chips") return f.value && f.options.includes(f.value) ? f.value : f.kind === "select" ? (f.options[0] ?? "") : "";
  return f.value ?? "";
}

function isFilled(v: FormValue): boolean {
  return Array.isArray(v) ? v.length > 0 : v.trim() !== "";
}

/** 表单 → 一条用户消息(纯文本,模型和人都读得懂)。 */
export function composeFormMessage(spec: FormSpec, values: Record<string, FormValue>): string {
  const lines = spec.fields
    .filter((f) => isFilled(values[f.id] ?? ""))
    .map((f) => {
      const v = values[f.id]!;
      const text = Array.isArray(v) ? v.join("、") : v.trim();
      return `- ${f.label}:${text}${f.unit && f.kind === "number" ? ` ${f.unit}` : ""}`;
    });
  return [spec.title ? `${spec.title}:` : "我的情况:", ...lines].join("\n");
}

export function FormBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<FormSpec>) {
  const { sendUserText, busy, reason } = useChatInteraction();
  const baseId = useId();
  const [values, setValues] = useState<Record<string, FormValue>>(() => Object.fromEntries(spec.fields.map((f) => [f.id, initialValue(f)])));
  const [sent, setSent] = useState(false);
  const locked = sent || !!readOnly || streaming;
  const missing = spec.fields.filter((f) => f.required && !isFilled(values[f.id] ?? ""));
  const canSend = !locked && !!sendUserText && !busy && missing.length === 0 && spec.fields.some((f) => isFilled(values[f.id] ?? ""));
  const set = (id: string, v: FormValue) => setValues((s) => ({ ...s, [id]: v }));
  return (
    <Frame kind="form" title={spec.title} subtitle={spec.subtitle} notes={notes} streaming={streaming} nested={nested}>
      <form
        className="oc-iui-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSend || !sendUserText) return;
          setSent(true);
          sendUserText(composeFormMessage(spec, values));
        }}
      >
        {spec.fields.map((f) => {
          const fid = `${baseId}-${f.id}`;
          const v = values[f.id] ?? "";
          const label = (
            <span className="oc-iui-field-label">
              {f.label}
              {f.required && <span className="oc-iui-required"> *</span>}
            </span>
          );
          if (f.kind === "chips") {
            const arr = Array.isArray(v) ? v : v ? [v] : [];
            return (
              <fieldset key={f.id} className="oc-iui-field" disabled={locked}>
                <legend className="contents">{label}</legend>
                <div className="oc-iui-chips">
                  {f.options.map((o) => {
                    const on = arr.includes(o);
                    return (
                      <button
                        key={o}
                        type="button"
                        className={cn("oc-iui-chip-btn", on && "is-on")}
                        aria-pressed={on}
                        onClick={() => {
                          if (f.multi) set(f.id, on ? arr.filter((x) => x !== o) : [...arr, o]);
                          else set(f.id, on ? "" : o);
                        }}
                      >
                        {on && <Check size={13} strokeWidth={2.75} aria-hidden />}
                        {o}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
            );
          }
          return (
            <div key={f.id} className="oc-iui-field">
              <label htmlFor={fid}>{label}</label>
              {f.kind === "select" ? (
                <select id={fid} className="oc-iui-select" value={v as string} disabled={locked} onChange={(e) => set(f.id, e.target.value)}>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="oc-iui-input-wrap">
                  <input
                    id={fid}
                    className="oc-iui-input"
                    type={f.kind === "date" ? "date" : "text"}
                    inputMode={f.kind === "number" ? "decimal" : undefined}
                    value={v as string}
                    placeholder={f.placeholder}
                    disabled={locked}
                    required={f.required}
                    onChange={(e) => set(f.id, e.target.value)}
                  />
                  {f.unit && <span className="oc-iui-field-unit">{f.unit}</span>}
                </div>
              )}
            </div>
          );
        })}
        <div className="oc-iui-form-foot">
          {sent ? (
            <span className="oc-iui-sent">
              <Check size={14} aria-hidden />
              已发送
            </span>
          ) : (
            <button type="submit" className="oc-iui-btn is-primary" disabled={!canSend}>
              <Send size={14} aria-hidden />
              {spec.submit}
            </button>
          )}
          {!sent && !readOnly && !streaming && !sendUserText && reason && <span className="oc-iui-hint">{chatInteractionUnavailableText(reason)}</span>}
        </div>
      </form>
    </Frame>
  );
}
