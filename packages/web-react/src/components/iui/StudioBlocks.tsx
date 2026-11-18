import { Check, ChevronLeft, ChevronRight, Copy, RotateCcw, Send, Sparkles } from "lucide-react";
import { Fragment, useMemo, useRef, useState } from "react";
import { cn } from "../../lib/utils";
import { useChatInteraction } from "../tool/context";
import { countWords } from "./diff";
import { Frame, Inline, Media, Segmented, useCopiedFlag } from "./shell";
import { interpolatePromptTemplate, v2ToMarkdown } from "./v2Markdown";
import type { FlashcardsSpec, PromptTemplateSpec, StoryboardSpec } from "./v2Schema";

type BlockProps<S> = { spec: S; notes: string[]; streaming: boolean; readOnly?: boolean; nested?: boolean };

function hashKey(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── 13. Prompt Template 行内槽位模板卡 ──────────────────────────────────

export function PromptTemplateBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<PromptTemplateSpec>) {
  const { sendUserText, busy } = useChatInteraction();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.slots.map((s) => [s.id, s.value])));
  const [activeId, setActiveId] = useState<string | null>(() => spec.slots[0]?.id ?? null);
  const [copied, flashCopied] = useCopiedFlag();
  const composingRef = useRef(false);

  const filled = useMemo(() => interpolatePromptTemplate(spec.template, spec.slots, values), [spec, values]);
  const activeSlot = spec.slots.find((s) => s.id === activeId) ?? spec.slots[0] ?? null;
  const parts = spec.template.split(/(\{\{[A-Za-z0-9_\u4e00-\u9fff-]{1,40}\}\})/g);
  const canSend = !readOnly && !streaming && !!sendUserText && !!filled.trim();

  return (
    <Frame kind="prompt_template" title={spec.title ?? "提示词填空模板"} subtitle={spec.subtitle} notes={notes} streaming={streaming} nested={nested} copyText={() => v2ToMarkdown(spec, values)}>
      <div className="oc-iui-tpl-box">
        {parts.map((part, idx) => {
          const m = /^\{\{([A-Za-z0-9_\u4e00-\u9fff-]{1,40})\}\}$/.exec(part);
          if (!m) return <Fragment key={`${idx}:t`}>{part}</Fragment>;
          const id = m[1]!;
          const slot = spec.slots.find((s) => s.id === id);
          const shown = values[id]?.trim() || `[${slot?.label ?? id}]`;
          return (
            <button
              key={`${idx}:${id}`}
              type="button"
              className={cn("oc-iui-tpl-slot", activeSlot?.id === id && "is-active", !values[id]?.trim() && "is-empty")}
              aria-pressed={activeSlot?.id === id}
              onClick={() => setActiveId(id)}
            >
              {shown}
            </button>
          );
        })}
      </div>

      {activeSlot && !streaming && (
        <div className="oc-iui-tpl-editor">
          <div className="oc-iui-tpl-ed-label">当前编辑槽位：{activeSlot.label}</div>
          {activeSlot.options.length > 0 && (
            <div className="oc-iui-chips">
              {activeSlot.options.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  className={cn("oc-iui-chip-btn", values[activeSlot.id] === opt && "is-on")}
                  aria-pressed={values[activeSlot.id] === opt}
                  onClick={() => setValues((s) => ({ ...s, [activeSlot.id]: opt }))}
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
          <input
            type="text"
            className="oc-iui-tpl-input"
            aria-label={`填写${activeSlot.label}`}
            value={values[activeSlot.id] ?? ""}
            placeholder={activeSlot.placeholder ?? `输入${activeSlot.label}`}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            onKeyDown={(e) => {
              if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
              if (e.key === "Enter") {
                e.preventDefault();
                const i = spec.slots.findIndex((s) => s.id === activeSlot.id);
                if (i >= 0 && i + 1 < spec.slots.length) setActiveId(spec.slots[i + 1]!.id);
              }
            }}
            onChange={(e) => setValues((s) => ({ ...s, [activeSlot.id]: e.target.value }))}
          />
        </div>
      )}

      <div className="oc-iui-draft-bar">
        <span className="oc-iui-draft-count">共 {countWords(filled)} 字</span>
        <span className="oc-iui-draft-actions">
          <button
            type="button"
            className="oc-iui-btn"
            disabled={streaming}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(filled);
                flashCopied();
              } catch {
                /* ignore */
              }
            }}
          >
            {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
            {copied ? "已复制" : "复制完整内容"}
          </button>
          {canSend && (
            <button type="button" className="oc-iui-btn is-primary" disabled={!!busy} onClick={() => sendUserText(filled)}>
              <Send size={14} aria-hidden />
              {spec.submit ?? "发给助手执行"}
            </button>
          )}
        </span>
      </div>
    </Frame>
  );
}

// ── 14. Storyboard 音视频分镜与脚本卡 ───────────────────────────────────

const SPEEDS = [4.0, 4.5, 5.2] as const;
const SPEED_LABELS = ["沉稳 4字/s", "标准 4.5字/s", "轻快 5.2字/s"];

function fmtSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function StoryboardBlock({ spec, notes, streaming, readOnly, nested }: BlockProps<StoryboardSpec>) {
  const { sendUserText, busy } = useChatInteraction();
  const [speedIdx, setSpeedIdx] = useState<number>(() => {
    let best = 1;
    let diff = Number.POSITIVE_INFINITY;
    SPEEDS.forEach((v, i) => {
      if (Math.abs(v - spec.cps) < diff) {
        diff = Math.abs(v - spec.cps);
        best = i;
      }
    });
    return best;
  });
  const [editedLines, setEditedLines] = useState<Record<number, string>>({});
  const lines = spec.shots.map((sh, i) => editedLines[i] ?? sh.line);
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null);
  const cps = SPEEDS[speedIdx]!;
  const durations = spec.shots.map((sh, i) => sh.duration ?? Math.max(2, Math.round(((lines[i] ?? sh.line).replace(/\s+/g, "").length || 1) / cps)));
  const totalChars = lines.reduce((n, l) => n + l.replace(/\s+/g, "").length, 0);
  const totalSec = durations.reduce((a, b) => a + b, 0);
  const canSend = !readOnly && !streaming && !!sendUserText;

  return (
    <Frame
      kind="storyboard"
      title={spec.title ?? "视频分镜脚本"}
      subtitle={spec.subtitle ?? `共 ${spec.shots.length} 镜 · 口播 ${totalChars} 字 · 预计总长 ${fmtSeconds(totalSec)}`}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => v2ToMarkdown({ ...spec, cps, shots: spec.shots.map((sh, i) => ({ ...sh, line: lines[i] ?? sh.line })) })}
      actions={
        !streaming ? (
          <Segmented role="radiogroup" items={SPEED_LABELS} value={speedIdx} onChange={setSpeedIdx} label="语速" className="is-compact" />
        ) : undefined
      }
    >
      <div className="oc-iui-shot-list">
        {spec.shots.map((sh, i) => {
          const text = lines[i] ?? sh.line;
          const sec = durations[i]!;
          return (
            <div key={`${sh.no}:${i}`} className="oc-iui-shot-row">
              <div className="oc-iui-shot-thumb">
                {sh.image ? (
                  <Media src={sh.image} alt={`镜 ${sh.no}`} className="oc-iui-shot-media" />
                ) : (
                  <div className={cn("oc-iui-shot-clapper", `is-tone-${i % 6}`)}>
                    <span>镜 {sh.no}</span>
                    <span>~{sec}s</span>
                  </div>
                )}
                {sh.shotType && <div className="oc-iui-shot-type">{sh.shotType}</div>}
              </div>
              <div className="min-w-0 flex-1 flex flex-col gap-2">
                {sh.prompt && <div className="oc-iui-shot-prompt">画面：{sh.prompt}</div>}
                <textarea
                  className="oc-iui-textarea oc-iui-shot-line"
                  aria-label={`镜 ${sh.no} 口播台词`}
                  rows={2}
                  disabled={streaming}
                  value={text}
                  onChange={(e) => setEditedLines((prev) => ({ ...prev, [i]: e.target.value }))}
                />
                <div className="oc-iui-shot-foot">
                  <span>{text.replace(/\s+/g, "").length} 字 · 预计 {sec} 秒</span>
                  <div className="flex flex-wrap gap-1.5">
                    {sh.prompt && !streaming && (
                      <button
                        type="button"
                        className="oc-iui-text-btn"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(sh.prompt!);
                            setCopiedIdx(i);
                            setTimeout(() => setCopiedIdx(null), 1500);
                          } catch {
                            /* ignore */
                          }
                        }}
                      >
                        {copiedIdx === i ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
                        {copiedIdx === i ? "已复制" : "复制画面 Prompt"}
                      </button>
                    )}
                    {canSend && (
                      <button
                        type="button"
                        className="oc-iui-text-btn"
                        disabled={!!busy}
                        onClick={() => sendUserText(`请帮我细化并生成分镜 ${sh.no}（${sh.shotType ?? "镜头"}）的画面：${sh.prompt || text}`)}
                      >
                        <Sparkles size={13} aria-hidden />
                        生成此镜画面
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </Frame>
  );
}

// ── 15. Flashcards 双面记忆闪卡 ─────────────────────────────────────────

export function FlashcardsBlock({ spec, notes, streaming, nested }: BlockProps<FlashcardsSpec>) {
  const storeKey = `oc.iui.flashcards.${hashKey(JSON.stringify([spec.title ?? "", spec.cards.map((c) => c.front)]))}`;
  const [known, setKnown] = useState<boolean[]>(() => {
    try {
      const raw = globalThis.localStorage?.getItem(storeKey);
      if (raw) {
        const arr = JSON.parse(raw) as unknown;
        if (Array.isArray(arr)) return spec.cards.map((_, i) => arr[i] === true);
      }
    } catch {
      /* ignore */
    }
    return spec.cards.map(() => false);
  });
  const [onlyUnlearned, setOnlyUnlearned] = useState(false);
  const [idx, setIdx] = useState(0);
  const [flipped, setFlipped] = useState(false);

  const saveKnown = (next: boolean[]) => {
    setKnown(next);
    try {
      globalThis.localStorage?.setItem(storeKey, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const indices = onlyUnlearned ? spec.cards.map((_, i) => i).filter((i) => !known[i]) : spec.cards.map((_, i) => i);
  const curPos = indices.length > 0 ? Math.min(idx, indices.length - 1) : 0;
  const origIdx = indices[curPos];
  const curCard = origIdx !== undefined ? spec.cards[origIdx] : undefined;
  const knownCount = known.filter(Boolean).length;

  const mark = (state: boolean) => {
    if (origIdx === undefined) return;
    const next = known.map((v, i) => (i === origIdx ? state : v));
    saveKnown(next);
    setFlipped(false);
    const remaining = onlyUnlearned ? indices.filter((i) => !next[i]) : indices;
    if (remaining.length > 0) setIdx((curPos + 1) % remaining.length);
  };

  return (
    <Frame
      kind="flashcards"
      title={spec.title ?? "记忆闪卡"}
      subtitle={spec.subtitle ?? `已掌握 ${knownCount} / ${spec.cards.length} 张 · 点击卡片翻面`}
      notes={notes}
      streaming={streaming}
      nested={nested}
      copyText={() => v2ToMarkdown(spec)}
      actions={
        !streaming ? (
          <button
            type="button"
            className="oc-iui-text-btn"
            aria-pressed={onlyUnlearned}
            onClick={() => {
              setOnlyUnlearned((v) => !v);
              setIdx(0);
              setFlipped(false);
            }}
          >
            {onlyUnlearned ? "显示全部卡片" : "只看未掌握"}
          </button>
        ) : undefined
      }
    >
      <div className="oc-iui-fc-wrap">
        {!curCard ? (
          <div className="oc-iui-fc-done">
            <p>当前未掌握卡片已全部清空！</p>
            <div className="flex justify-center gap-2">
              <button
                type="button"
                className="oc-iui-btn"
                onClick={() => {
                  setOnlyUnlearned(false);
                  setIdx(0);
                }}
              >
                查看全部卡片
              </button>
              <button
                type="button"
                className="oc-iui-btn"
                onClick={() => {
                  saveKnown(spec.cards.map(() => false));
                  setOnlyUnlearned(false);
                  setIdx(0);
                }}
              >
                <RotateCcw size={14} aria-hidden />
                重置进度
              </button>
            </div>
          </div>
        ) : (
          <>
            <button
              type="button"
              className={cn("oc-iui-fc-card", flipped && "is-flipped")}
              aria-label={`${flipped ? "背面" : "正面"}：${flipped ? curCard.back : curCard.front}，点击翻面`}
              onClick={() => setFlipped((v) => !v)}
            >
              <div className="oc-iui-fc-top">
                <span className={cn("oc-iui-chip", flipped && "is-accent")}>{flipped ? "背面 · 解析答案" : "正面 · 点击翻面"}</span>
                {curCard.tag && <span className="oc-iui-chip">{curCard.tag}</span>}
                <span className="oc-iui-fc-pos">
                  {curPos + 1} / {indices.length}
                </span>
              </div>
              <div className="oc-iui-fc-body">
                <Inline text={flipped ? curCard.back : curCard.front} />
              </div>
              <div className="oc-iui-fc-foot">
                <span>{curCard.hint && !flipped ? `提示：${curCard.hint}` : known[origIdx!] ? "状态：已掌握" : "状态：待巩固"}</span>
              </div>
            </button>
            <div className="oc-iui-fc-controls">
              <button
                type="button"
                className="oc-iui-btn"
                disabled={indices.length <= 1}
                onClick={() => {
                  setFlipped(false);
                  setIdx((curPos - 1 + indices.length) % indices.length);
                }}
              >
                <ChevronLeft size={14} aria-hidden />
                上一张
              </button>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="oc-iui-btn" onClick={() => mark(false)}>
                  待巩固
                </button>
                <button type="button" className="oc-iui-btn is-primary" onClick={() => mark(true)}>
                  <Check size={14} aria-hidden />
                  已掌握
                </button>
                <button
                  type="button"
                  className="oc-iui-btn"
                  disabled={indices.length <= 1}
                  aria-label="下一张"
                  onClick={() => {
                    setFlipped(false);
                    setIdx((curPos + 1) % indices.length);
                  }}
                >
                  <ChevronRight size={14} aria-hidden />
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Frame>
  );
}
