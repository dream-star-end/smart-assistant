/**
 * Intelligent UI 其余组件:指标、步骤/清单、对比卡、提示框、分段标签、时间线、后续建议、选择。
 */
import {
  ArrowUpRight,
  Check,
  CircleAlert,
  CircleCheck,
  Info,
  Lightbulb,
  Minus,
  OctagonAlert,
  Plus,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { type KeyboardEvent, useId, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { OptionsBlock } from "../RichBlocks";
import { chatInteractionUnavailableText, useChatInteraction } from "../tool/context";
import type {
  CalloutSpec,
  ChoiceSpec,
  CompareSpec,
  StatsSpec,
  StepsSpec,
  SuggestionsSpec,
  TabsSpec,
  TimelineSpec,
} from "./schema";
import { BodyMarkdown, Frame, Inline } from "./shell";
import { formatNumber, specToMarkdown, withUnit } from "./toMarkdown";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; readOnly?: boolean };

// ── 指标 ──────────────────────────────────────────────────────────────

export function StatsBlock({ spec, notes, streaming }: BlockProps<StatsSpec>) {
  return (
    <Frame kind="stats" title={spec.title} source={spec.source} notes={notes} streaming={streaming} copyText={() => specToMarkdown(spec)}>
      <dl className={cn("oc-iui-stats", spec.items.length === 1 && "is-single")}>
        {spec.items.map((it, i) => {
          const tone = it.tone ?? (it.delta?.trim().startsWith("-") || it.delta?.trim().startsWith("−") ? "down" : it.delta ? "up" : undefined);
          const Trend = tone === "up" ? TrendingUp : tone === "down" ? TrendingDown : null;
          return (
            <div key={`${i}:${it.label}`} className="oc-iui-stat">
              <dt className="oc-iui-stat-label">
                <Inline text={it.label} />
              </dt>
              <dd className="oc-iui-stat-value">{withUnit(typeof it.value === "number" ? formatNumber(it.value) : it.value, it.unit)}</dd>
              {it.delta && (
                <dd className={cn("oc-iui-stat-delta", tone === "up" && "is-up", tone === "down" && "is-down")}>
                  {Trend && <Trend size={13} aria-hidden />}
                  {it.delta}
                </dd>
              )}
              {it.basis && (
                <dd className="oc-iui-stat-basis">
                  <Inline text={it.basis} />
                </dd>
              )}
            </div>
          );
        })}
      </dl>
    </Frame>
  );
}

// ── 步骤 / 清单 ───────────────────────────────────────────────────────

function hashText(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

function useCheckedState(key: string, initial: boolean[]) {
  const storageKey = `oc.iui.steps.${key}`;
  const [checked, setChecked] = useState<boolean[]>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(storageKey);
      if (raw) {
        const v = JSON.parse(raw) as unknown;
        if (Array.isArray(v)) return initial.map((d, i) => (typeof v[i] === "boolean" ? (v[i] as boolean) : d));
      }
    } catch {
      /* 本机存储不可用:只是不记勾选 */
    }
    return initial;
  });
  const update = (next: boolean[]) => {
    setChecked(next);
    try {
      globalThis.localStorage?.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* 忽略 */
    }
  };
  return [checked, update] as const;
}

export function StepsBlock({ spec, notes, streaming }: BlockProps<StepsSpec>) {
  const key = useMemo(() => hashText(spec.items.map((i) => i.title).join("\n")), [spec.items]);
  const [checked, setChecked] = useCheckedState(key, spec.items.map((i) => i.done));
  const done = spec.items.filter((_, i) => checked[i] ?? spec.items[i]!.done).length;
  const total = spec.items.length;
  return (
    <Frame
      kind="steps"
      title={spec.title}
      notes={notes}
      streaming={streaming}
      copyText={() => specToMarkdown({ ...spec, items: spec.items.map((it, i) => ({ ...it, done: checked[i] ?? it.done })) })}
      actions={
        spec.checkable && total > 0 ? (
          <span className="oc-iui-progress-text" aria-live="polite">
            已完成 {done} / {total}
          </span>
        ) : undefined
      }
    >
      {spec.checkable && total > 0 && (
        <div className="oc-iui-progress" aria-hidden>
          <span style={{ width: `${(done / total) * 100}%` }} />
        </div>
      )}
      <ol className={cn("oc-iui-steps", spec.checkable && "is-checkable")}>
        {spec.items.map((it, i) => {
          const isDone = checked[i] ?? it.done;
          return (
            <li key={`${i}:${it.title}`} className={cn(isDone && "is-done")}>
              {spec.checkable ? (
                <label className="oc-iui-check">
                  <input
                    type="checkbox"
                    checked={isDone}
                    disabled={streaming}
                    onChange={() => {
                      const next = spec.items.map((s, j) => checked[j] ?? s.done);
                      next[i] = !isDone;
                      setChecked(next);
                    }}
                  />
                  <span className="oc-iui-check-box" aria-hidden>
                    {isDone && <Check size={12} strokeWidth={3} />}
                  </span>
                  <span className="oc-iui-step-text">
                    <span className="oc-iui-step-title">
                      <Inline text={it.title} />
                    </span>
                    {it.detail && (
                      <span className="oc-iui-step-detail">
                        <Inline text={it.detail} />
                      </span>
                    )}
                  </span>
                </label>
              ) : (
                <>
                  <span className="oc-iui-step-num" aria-hidden>
                    {i + 1}
                  </span>
                  <span className="oc-iui-step-text">
                    <span className="oc-iui-step-title">
                      <Inline text={it.title} />
                    </span>
                    {it.detail && (
                      <span className="oc-iui-step-detail">
                        <Inline text={it.detail} />
                      </span>
                    )}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}

// ── 对比卡 ────────────────────────────────────────────────────────────

export function CompareBlock({ spec, notes, streaming }: BlockProps<CompareSpec>) {
  return (
    <Frame kind="compare" title={spec.title} notes={notes} streaming={streaming} copyText={() => specToMarkdown(spec)} bare>
      <div className={cn("oc-iui-compare", spec.items.length >= 3 && "is-scroll")} data-count={spec.items.length}>
        {spec.items.map((it, i) => (
          <section key={`${i}:${it.name}`} className={cn("oc-iui-compare-card", it.recommended && "is-recommended")} aria-label={it.name}>
            <header>
              <h4>
                <Inline text={it.name} />
              </h4>
              {(it.recommended || it.tag) && (
                <span className="oc-iui-badge">{it.recommended ? (it.tag ? `推荐 · ${it.tag}` : "推荐") : it.tag}</span>
              )}
            </header>
            {it.summary && (
              <p className="oc-iui-compare-summary">
                <Inline text={it.summary} />
              </p>
            )}
            {it.points.length > 0 && (
              <ul className="oc-iui-compare-list">
                {it.points.map((p) => (
                  <li key={p}>
                    <span className="oc-iui-dot" aria-hidden />
                    <Inline text={p} />
                  </li>
                ))}
              </ul>
            )}
            {it.pros.length > 0 && (
              <ul className="oc-iui-compare-list is-pros" aria-label="优点">
                {it.pros.map((p) => (
                  <li key={p}>
                    <Plus size={13} aria-hidden />
                    <Inline text={p} />
                  </li>
                ))}
              </ul>
            )}
            {it.cons.length > 0 && (
              <ul className="oc-iui-compare-list is-cons" aria-label="缺点">
                {it.cons.map((p) => (
                  <li key={p}>
                    <Minus size={13} aria-hidden />
                    <Inline text={p} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      {spec.verdict && (
        <p className="oc-iui-verdict">
          <span className="font-medium text-fg">结论 </span>
          <Inline text={spec.verdict} />
        </p>
      )}
    </Frame>
  );
}

// ── 提示框 ────────────────────────────────────────────────────────────

const CALLOUT_ICON = { info: Info, tip: Lightbulb, warning: CircleAlert, danger: OctagonAlert, success: CircleCheck } as const;
const CALLOUT_LABEL = { info: "说明", tip: "提示", warning: "注意", danger: "警告", success: "完成" } as const;

export function CalloutBlock({ spec, streaming }: BlockProps<CalloutSpec>) {
  const Icon = CALLOUT_ICON[spec.tone];
  return (
    <Frame kind="callout" streaming={streaming} bare>
      <div className={cn("oc-iui-callout", `is-${spec.tone}`)} role={spec.tone === "danger" || spec.tone === "warning" ? "note" : undefined}>
        <Icon size={16} aria-hidden className="oc-iui-callout-icon" />
        <div className="min-w-0 flex-1">
          <div className="oc-iui-callout-title">{spec.title ? <Inline text={spec.title} /> : CALLOUT_LABEL[spec.tone]}</div>
          {spec.body && <BodyMarkdown text={spec.body} />}
        </div>
      </div>
    </Frame>
  );
}

// ── 分段标签 ──────────────────────────────────────────────────────────

export function TabsBlock({ spec, notes, streaming }: BlockProps<TabsSpec>) {
  const [active, setActive] = useState(0);
  const baseId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const n = spec.tabs.length;
  const cur = Math.min(active, Math.max(0, n - 1));
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowRight") next = (cur + 1) % n;
    else if (e.key === "ArrowLeft") next = (cur - 1 + n) % n;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = n - 1;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    refs.current[next]?.focus();
  };
  const tab = spec.tabs[cur];
  return (
    <Frame kind="tabs" title={spec.title} notes={notes} streaming={streaming} copyText={() => specToMarkdown(spec)}>
      <div role="tablist" aria-label={spec.title ?? "分段内容"} className="oc-iui-tablist" onKeyDown={onKey}>
        {spec.tabs.map((t, i) => (
          <button
            key={`${i}:${t.label}`}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${baseId}-t${i}`}
            aria-selected={i === cur}
            aria-controls={`${baseId}-p`}
            tabIndex={i === cur ? 0 : -1}
            className="oc-iui-tab"
            onClick={() => setActive(i)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab && (
        <div role="tabpanel" id={`${baseId}-p`} aria-labelledby={`${baseId}-t${cur}`} className="oc-iui-tabpanel">
          <BodyMarkdown text={tab.body} />
        </div>
      )}
    </Frame>
  );
}

// ── 时间线 ────────────────────────────────────────────────────────────

export function TimelineBlock({ spec, notes, streaming }: BlockProps<TimelineSpec>) {
  return (
    <Frame kind="timeline" title={spec.title} notes={notes} streaming={streaming} copyText={() => specToMarkdown(spec)}>
      <ol className="oc-iui-timeline">
        {spec.items.map((it, i) => (
          <li key={`${i}:${it.title}`}>
            {it.time && <span className="oc-iui-timeline-time">{it.time}</span>}
            <span className="oc-iui-timeline-title">
              <Inline text={it.title} />
            </span>
            {it.detail && (
              <span className="oc-iui-timeline-detail">
                <Inline text={it.detail} />
              </span>
            )}
          </li>
        ))}
      </ol>
    </Frame>
  );
}

// ── 后续建议 ──────────────────────────────────────────────────────────

export function SuggestionsBlock({ spec, streaming, readOnly }: BlockProps<SuggestionsSpec>) {
  const { sendUserText, busy, reason } = useChatInteraction();
  const [sent, setSent] = useState<string | null>(null);
  const canSend = !readOnly && !!sendUserText && !streaming;
  return (
    <Frame kind="suggestions" streaming={streaming} bare className="oc-iui-suggestions-frame">
      {/* biome-ignore lint/a11y/useSemanticElements: 一组发送按钮,不是表单字段组 */}
      <div className="oc-iui-suggestions" role="group" aria-label="接着问">
        {spec.items.map((s) => (
          <button
            key={s}
            type="button"
            className={cn("oc-iui-suggestion", sent === s && "is-sent")}
            disabled={!canSend || !!busy || sent !== null}
            onClick={() => {
              if (!sendUserText) return;
              setSent(s);
              sendUserText(s);
            }}
          >
            <span>{s}</span>
            <ArrowUpRight size={14} aria-hidden />
          </button>
        ))}
      </div>
      {!sendUserText && !readOnly && !streaming && reason && <p className="oc-iui-hint">{chatInteractionUnavailableText(reason)}</p>}
    </Frame>
  );
}

// ── 选择(复用 options 卡的发送与同消息多题聚合) ─────────────────────

export function ChoiceBlock({ spec, readOnly }: BlockProps<ChoiceSpec>) {
  const code = useMemo(
    () =>
      JSON.stringify({
        ...(spec.question ? { question: spec.question } : {}),
        ...(spec.multi ? { multi: true } : {}),
        options: spec.options,
      }),
    [spec],
  );
  // OptionsBlock 自带外观与交互;只在外层加统一的上下间距。
  return (
    <div className="oc-iui oc-iui-bare" data-iui="choice">
      <OptionsBlock code={code} readOnly={readOnly} />
    </div>
  );
}
