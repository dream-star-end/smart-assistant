/**
 * Markdown 富块（对齐设计稿 ⑧）：mermaid 流程图 + HTML 无缝嵌入(实现在 ./HtmlEmbed)。
 * 二者都在 MarkdownImpl(懒加载 chunk)内按需用：mermaid 库再经 dynamic import 拆成
 * 独立 chunk(只有真出现 ```mermaid 才下载,不拖累首屏与普通对话)。
 */
import * as Dialog from "@radix-ui/react-dialog";
import { Check, Code2, Copy, Eye, Maximize2, X } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { chatInteractionUnavailableText, useChatInteraction } from "./tool/context";
import { OptionsGroupFooter, OptionsGroupProvider, useOptionsGroup, useOptionsGroupSnapshot } from "./optionsGroup";

/** 模块级共享暗色主题订阅器：全页多个 MermaidBlock/ChartBlock 共用单一 MutationObserver 观察 <html> class。 */
const darkThemeListeners = new Set<() => void>();
let darkThemeObserver: MutationObserver | null = null;

function getIsDarkSnapshot(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

function subscribeDarkTheme(listener: () => void): () => void {
  darkThemeListeners.add(listener);
  if (!darkThemeObserver && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    darkThemeObserver = new MutationObserver(() => {
      for (const cb of darkThemeListeners) cb();
    });
    darkThemeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }
  return () => {
    darkThemeListeners.delete(listener);
    if (darkThemeListeners.size === 0 && darkThemeObserver) {
      darkThemeObserver.disconnect();
      darkThemeObserver = null;
    }
  };
}

function useIsDark(): boolean {
  return useSyncExternalStore(subscribeDarkTheme, getIsDarkSnapshot, () => false);
}

function readCssToken(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const val = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return val || fallback;
}

const toolbarBtnCls =
  "oc-spring-press inline-flex items-center justify-center rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 [@media(hover:none)]:min-w-11";

function RichBlockToolbar({
  code,
  showSource,
  onToggleSource,
  onExpand,
  canExpand = true,
}: {
  code: string;
  showSource: boolean;
  onToggleSource: () => void;
  onExpand: () => void;
  canExpand?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setCopied(false);
      }, 1800);
    } catch {
      /* clipboard unavailable */
    }
  }, [code]);

  return (
    <div
      data-testid="rich-block-toolbar"
      className="oc-surface-glass absolute right-2.5 top-2.5 z-10 flex items-center gap-0.5 rounded-lg p-0.5 opacity-0 transition-opacity duration-150 group-hover/rich:opacity-100 group-focus-within/rich:opacity-100 [@media(hover:none)]:opacity-100"
    >
      <button
        type="button"
        aria-label={showSource ? "查看图表" : "查看源码"}
        title={showSource ? "查看图表" : "查看源码"}
        onClick={onToggleSource}
        className={toolbarBtnCls}
      >
        {showSource ? <Eye size={14} /> : <Code2 size={14} />}
      </button>
      <button
        type="button"
        aria-label={copied ? "已复制源码" : "复制源码"}
        title={copied ? "已复制" : "复制源码"}
        onClick={() => void handleCopy()}
        className={toolbarBtnCls}
      >
        {copied ? <Check size={14} className="oc-check-pop text-success" /> : <Copy size={14} />}
      </button>
      {canExpand && (
        <button
          type="button"
          aria-label="全屏放大预览"
          title="全屏放大预览"
          onClick={onExpand}
          className={toolbarBtnCls}
        >
          <Maximize2 size={14} />
        </button>
      )}
    </div>
  );
}

function RichFullscreenModal({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[var(--z-viewer)] bg-fg/35 backdrop-blur-xs data-[state=open]:animate-fade" />
        <Dialog.Content
          aria-describedby={undefined}
          className="oc-surface-popover oc-dialog-in fixed inset-3 z-[var(--z-viewer)] flex flex-col overflow-hidden rounded-2xl outline-none sm:inset-6"
        >
          <div className="flex shrink-0 items-center justify-between border-b border-border/80 px-4 py-2.5">
            <Dialog.Title className="text-section font-semibold text-fg">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="关闭全屏预览"
                className="oc-spring-press inline-flex size-9 items-center justify-center rounded-lg text-muted outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:size-11"
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 sm:p-6">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** 流式防抖：避免 ```mermaid 流式输出期间每个 chunk 都触发 parse/render 与骨架闪烁。 */
const MERMAID_RENDER_DEBOUNCE_MS = 160;

/** ```mermaid 代码块 → 渲染成 SVG 流程图;失败回退源码。 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const rawId = useId();
  const isDark = useIsDark();
  const prevCodeRef = useRef(code);

  useEffect(() => {
    let alive = true;
    const codeChanged = prevCodeRef.current !== code;
    prevCodeRef.current = code;
    const delay = codeChanged ? MERMAID_RENDER_DEBOUNCE_MS : 0;

    const run = async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        const accent = readCssToken("--accent", isDark ? "hsl(16, 68%, 61%)" : "hsl(16, 71%, 38%)");
        const fg = readCssToken("--fg", isDark ? "hsl(40, 18%, 94%)" : "hsl(240, 6%, 10%)");
        const surface = readCssToken("--surface", isDark ? "hsl(240, 7%, 11%)" : "hsl(0, 0%, 100%)");
        const bg = readCssToken("--bg", isDark ? "hsl(240, 5%, 8%)" : "hsl(45, 25%, 97%)");
        const bubble = readCssToken("--bubble", isDark ? "hsl(240, 7%, 14%)" : "hsl(43, 21%, 93%)");
        const borderControl = readCssToken("--border-control", isDark ? "hsl(40, 4%, 44%)" : "hsl(40, 5%, 51%)");
        const fontFamily = readCssToken("--font-sans", "sans-serif");
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: {
            darkMode: isDark,
            background: surface,
            primaryColor: bubble,
            primaryTextColor: fg,
            primaryBorderColor: accent,
            lineColor: accent,
            secondaryColor: bg,
            secondaryTextColor: fg,
            secondaryBorderColor: borderControl,
            tertiaryColor: surface,
            tertiaryTextColor: fg,
            mainBkg: bubble,
            nodeBorder: accent,
            clusterBkg: bg,
            clusterBorder: borderControl,
            edgeLabelBackground: surface,
            titleColor: fg,
            textColor: fg,
            fontFamily,
          },
        });
        // 先 parse 校验(suppressErrors→只返 bool,不向 document.body 注入错误图)。
        // 流式时代码常是半截 → parse=false → 回退源码,绝不调 render(render 对坏输入会把
        // "Syntax error" SVG 注入 body 残留)。代码写完变有效后,effect 重跑再真正 render。
        const ok = await mermaid.parse(code, { suppressErrors: true });
        if (!ok) {
          if (alive) {
            setSvg(null);
            setErr(true);
          }
          return;
        }
        const id = "mmd" + rawId.replace(/[^a-zA-Z0-9]/g, "");
        const out = await mermaid.render(id, code);
        if (alive) {
          setErr(false);
          setSvg(out.svg);
        }
      } catch {
        if (alive) {
          setSvg(null);
          setErr(true);
        }
      }
    };

    const timer = window.setTimeout(() => {
      void run();
    }, delay);

    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [code, rawId, isDark]);

  if (err) {
    return (
      <pre className="oc-code-shell my-3 overflow-auto rounded-xl bg-code px-3.5 py-2.5 font-mono text-meta text-fg">{code}</pre>
    );
  }
  if (!svg) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="oc-surface-card my-3 flex flex-col items-center gap-3 rounded-xl px-5 py-6"
      >
        <div aria-hidden className="flex w-full max-w-sm items-center justify-center gap-3">
          <span className="oc-img-skeleton h-9 flex-1 rounded-lg" />
          <span className="h-0.5 w-6 rounded-full bg-border-strong" />
          <span className="oc-img-skeleton h-9 flex-1 rounded-lg" />
          <span className="h-0.5 w-6 rounded-full bg-border-strong" />
          <span className="oc-img-skeleton h-9 flex-1 rounded-lg" />
        </div>
        <span className="text-caption text-faint">图表渲染中…</span>
      </div>
    );
  }
  return (
    <div className="group/rich relative my-3 not-prose">
      <RichBlockToolbar
        code={code}
        showSource={showSource}
        onToggleSource={() => setShowSource((v) => !v)}
        onExpand={() => setFullscreen(true)}
      />
      {showSource ? (
        <pre className="oc-code-shell overflow-auto rounded-xl bg-code px-3.5 py-3 pr-28 font-mono text-meta text-fg">
          {code}
        </pre>
      ) : (
        // mermaid securityLevel:'strict' 已清洗 SVG
        <div
          className="oc-surface-card flex justify-center overflow-x-auto rounded-xl p-4"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-sanitized SVG
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      )}
      <RichFullscreenModal open={fullscreen} onOpenChange={setFullscreen} title="流程图预览">
        <div
          className="flex max-h-full max-w-full items-center justify-center [&_svg]:h-auto [&_svg]:max-h-[80dvh] [&_svg]:max-w-full"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-sanitized SVG
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </RichFullscreenModal>
    </div>
  );
}


// ── ```options 选择卡片 ──────────────────────────────────────────────────────
// AI 提问时输出 {"question","multi"?,"options":[{"label","desc"?}]} 的 options 代码块,
// 渲染为可点击选项卡:非流式单选点击即发「我选择:<label>」;多选勾选后点「确认选择」。
// 流式期点选只暂存,由组页脚显式发送。无 ChatInteractionContext(历史/demo)
// 或 JSON 半截时回退纯展示。

interface OptionItem {
  label: string;
  desc?: string;
}

interface ParsedOptionsItem {
  question?: string;
  multi: boolean;
  options: OptionItem[];
}

const MAX_QUESTIONS_PER_BLOCK = 8;

function extractFirstJsonValue(source: string): { json: string; rest: string } | null {
  const start = source.search(/\S/);
  if (start < 0) return null;
  const open = source[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i]!;
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return { json: source.slice(start, i + 1), rest: source.slice(i + 1) };
    }
  }
  return null;
}

function parseStringOption(raw: string): OptionItem | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // 兼容 `ask_question` 等原生风格里的 "标题 — 说明" 字符串写法。
  const split = /^(.{1,120}?)\s+—\s+(.+)$/s.exec(trimmed);
  if (split) {
    const label = split[1]!.trim();
    const desc = split[2]!.trim();
    if (label && desc) return { label, desc };
  }
  return { label: trimmed };
}

function normalizeOptionEntry(o: unknown): OptionItem | null {
  if (typeof o === "string") return parseStringOption(o);
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const oo = o as Record<string, unknown>;
  if (Array.isArray(oo.options) || Array.isArray(oo.choices) || Array.isArray(oo.items)) return null;
  const label =
    typeof oo.label === "string" && oo.label.trim()
      ? oo.label
      : typeof oo.title === "string" && oo.title.trim()
        ? oo.title.trim()
        : typeof oo.text === "string" && oo.text.trim()
          ? oo.text.trim()
          : "";
  if (!label) return null;
  let desc: string | undefined;
  for (const k of ["desc", "description", "detail", "sublabel"] as const) {
    const v = oo[k];
    if (typeof v === "string" && v.trim()) {
      desc = v;
      break;
    }
  }
  return desc ? { label, desc } : { label };
}

function normalizeSingleOptionsItem(raw: unknown): ParsedOptionsItem | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const rawList = Array.isArray(rec.options)
    ? rec.options
    : Array.isArray(rec.choices)
      ? rec.choices
      : Array.isArray(rec.items)
        ? rec.items
        : null;
  if (!rawList) return null;
  const options: OptionItem[] = [];
  for (const o of rawList) {
    const parsed = normalizeOptionEntry(o);
    if (parsed) options.push(parsed);
  }
  if (options.length === 0 || options.length > 12) return null;
  let question: string | undefined;
  for (const k of ["question", "prompt", "header", "title"] as const) {
    const v = rec[k];
    if (typeof v === "string" && v.trim()) {
      question = v;
      break;
    }
  }
  return {
    question,
    multi:
      rec.multi === true ||
      rec.multiSelect === true ||
      rec.is_multi_select === true ||
      rec.allowMultiple === true,
    options,
  };
}

function expandOptionsPayload(val: unknown): ParsedOptionsItem[] | null {
  if (Array.isArray(val)) {
    if (val.length === 0) return null;
    if (val.length <= MAX_QUESTIONS_PER_BLOCK) {
      const multiQ: ParsedOptionsItem[] = [];
      let allQuestions = true;
      for (const item of val) {
        const norm = normalizeSingleOptionsItem(item);
        if (!norm) {
          allQuestions = false;
          break;
        }
        multiQ.push(norm);
      }
      if (allQuestions) return multiQ;
    }
    if (val.length <= 12) {
      const bareOptions: OptionItem[] = [];
      for (const entry of val) {
        const norm = normalizeOptionEntry(entry);
        if (!norm) return null;
        bareOptions.push(norm);
      }
      return bareOptions.length > 0 ? [{ question: undefined, multi: false, options: bareOptions }] : null;
    }
    return null;
  }
  if (val && typeof val === "object") {
    const rec = val as Record<string, unknown>;
    if (Array.isArray(rec.questions)) {
      if (rec.questions.length === 0 || rec.questions.length > MAX_QUESTIONS_PER_BLOCK) return null;
      const out: ParsedOptionsItem[] = [];
      for (const item of rec.questions) {
        const norm = normalizeSingleOptionsItem(item);
        if (!norm) return null;
        out.push(norm);
      }
      return out;
    }
  }
  const one = normalizeSingleOptionsItem(val);
  return one ? [one] : null;
}

function parseOptionsBlocks(
  code: string,
): { items: ParsedOptionsItem[]; trailing: string } | null {
  try {
    const first = extractFirstJsonValue(code);
    if (!first) return null;
    const items = expandOptionsPayload(JSON.parse(first.json));
    if (!items || items.length === 0) return null;
    let rest = first.rest;
    while (items.length < MAX_QUESTIONS_PER_BLOCK) {
      const trimmed = rest.trimStart();
      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) break;
      const next = extractFirstJsonValue(trimmed);
      if (!next) break;
      const more = expandOptionsPayload(JSON.parse(next.json));
      if (!more || items.length + more.length > MAX_QUESTIONS_PER_BLOCK) break;
      items.push(...more);
      rest = next.rest;
    }
    return {
      items,
      trailing: rest.trim() ? rest.trim() : "",
    };
  } catch {
    return null; // 流式半截 / 非法 JSON → 调用方回退源码
  }
}

function detectFollowingUserAnswer(el: HTMLElement | null): string | null {
  const assistantRow = el?.closest<HTMLElement>('[data-testid="assistant-row"]');
  if (!assistantRow) return null;
  const root =
    assistantRow.closest<HTMLElement>('[data-testid="timeline-short-list"], [data-testid="message-list"]') ??
    assistantRow.parentElement?.parentElement;
  if (!root) return null;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="assistant-row"], [data-testid="user-row"]'));
  const idx = rows.indexOf(assistantRow);
  if (idx < 0) return null;
  for (let i = idx + 1; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (row.getAttribute("data-testid") === "user-row") {
      const text = row.querySelector<HTMLElement>('[data-testid="message-text"]')?.textContent?.trim() ?? "";
      if (/^我选择[:：]/.test(text)) return text.replace(/^我选择[:：]/, "").trim() || text;
      if (/^我的选择[:：]/.test(text)) return text.replace(/^我的选择[:：]/, "").trim() || "已作答";
      return text ? "已通过后续消息回复" : "已作答";
    }
  }
  return null;
}

function OptionsCardItem({ parsed, readOnly }: { parsed: ParsedOptionsItem; readOnly?: boolean }) {
  const { sendUserText, busy, reason } = useChatInteraction();
  const group = useOptionsGroup();
  const groupSnap = useOptionsGroupSnapshot();
  const blockKey = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  const [historyAnswer, setHistoryAnswer] = useState<string | null>(null);
  const [reopenedHistory, setReopenedHistory] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [customNote, setCustomNote] = useState("");
  const composingRef = useRef(false);

  // 刷新或切回历史会话时，若该条助手消息后方已存在用户回复，则默认判定为历史已作答态，防止单选误触重发。
  useEffect(() => {
    if (readOnly || sentLocal !== null) return;
    const found = detectFollowingUserAnswer(cardRef.current);
    setHistoryAnswer(found);
  }, [readOnly, sentLocal, busy]);

  // 注册到消息级分组(多题聚合作答的前提;流式半截时不注册,解析成功即补登)。
  // 用 layout effect:passive effect 在 commit 之后才跑,中间那帧里块已可点、分组还没数到它,
  // 点选会误走「单块点击即发」(t-839 OG-01 实证:三题消息第一题被单独发出)。
  useLayoutEffect(() => {
    if (readOnly || !group) return;
    group.register(blockKey, { question: parsed.question, multi: parsed.multi });
    return () => group.unregister(blockKey);
    // question/multi 变化(流式补全)时重登;blockKey 稳定。
  }, [group, blockKey, parsed, readOnly]);

  // 同消息多题 → 聚合模式:点选只记录,由 GroupFooter 统一发送。
  // 流式(live)期间即使目前只注册到 1 块也不走点击即发——长回合中途就会贴卡,
  // 后继 options 的 JSON 也可能还是半截;点选永远可点,发送必须用户显式点页脚。
  // 流式期点过、流式结束后也留在聚合模式(点选不丢,由页脚显式发出)。
  // 非流式单题(或无分组)保持点击即发/块内确认。口径统一取 snapshot.grouped。
  const streaming = groupSnap?.live === true;
  const grouped = !!group && (groupSnap?.grouped ?? false);
  const groupEntry = groupSnap?.entries.find((e) => e.key === blockKey);
  const lockedByHistory = !streaming && historyAnswer !== null && !reopenedHistory;
  const sent = sentLocal !== null || (groupSnap?.sent ?? false) || lockedByHistory;
  const sentText =
    sentLocal ??
    (groupEntry?.labels.length ? groupEntry.labels.join("、") : null) ??
    (lockedByHistory ? historyAnswer : null);
  const interactive = !readOnly && !!sendUserText && !sent;
  // 生产里 busy===sending===live;流式期忽略 busy,否则长回合选项卡仍不可点。
  // 非流式仍尊重 busy(历史卡在新回合进行中不可点)。
  const blockedByBusy = !!busy && !streaming;

  const report = (labels: string[]) => group?.setAnswer(blockKey, labels);
  // 点击时刻直接读 store:同一 commit 里兄弟块刚注册完、本块还没因快照变化重渲时,
  // 渲染期算出的 grouped 可能还是旧值(单块),读 store 才不会误走「点击即发」。
  const groupedNow = () => !!group && group.getSnapshot().grouped;
  const trimmedNote = customNote.trim();
  const formatPick = (base: string) => (trimmedNote ? `${base}（补充：${trimmedNote}）` : base);

  const choose = (i: number) => {
    if (!interactive || blockedByBusy) return;
    const label = parsed.options[i].label;
    const inGroup = groupedNow();
    if (parsed.multi) {
      setPicked((p) => {
        const n = new Set(p);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        if (inGroup) report([...n].sort((a, b) => a - b).map((x) => parsed.options[x].label));
        return n;
      });
    } else if (inGroup) {
      // 聚合模式单选:标记/换选,不发送。
      setPicked(new Set([i]));
      report([label]);
    } else {
      const display = formatPick(label);
      setSentLocal(display);
      sendUserText?.(`我选择:${display}`);
    }
  };
  const confirmMulti = () => {
    if (!interactive || blockedByBusy || picked.size === 0 || groupedNow()) return;
    const labels = [...picked].sort((a, b) => a - b).map((i) => parsed.options[i].label).join("、");
    const display = formatPick(labels);
    setSentLocal(display);
    sendUserText?.(`我选择:${display}`);
  };
  const sendCustomNote = () => {
    if (!interactive || blockedByBusy || !trimmedNote || groupedNow()) return;
    setSentLocal(trimmedNote);
    sendUserText?.(trimmedNote);
  };
  return (
    <div ref={cardRef} className="oc-surface-card my-2.5 flex flex-col gap-3 rounded-2xl p-3.5 not-prose">
      {(parsed.question || parsed.options.length > 0) && (
        <div className="flex items-start justify-between gap-3 px-0.5">
          {parsed.question ? (
            <p className="text-section font-semibold leading-snug text-fg">{parsed.question}</p>
          ) : (
            <span />
          )}
          <span className="oc-surface-recessed shrink-0 rounded-full border border-border/70 px-2.5 py-0.5 text-micro font-medium text-muted">
            {parsed.multi ? "可多选" : "单选"}
          </span>
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {parsed.options.map((o, i) => {
          const chosen = parsed.multi || grouped ? picked.has(i) : sentText === o.label || (trimmedNote ? sentText === formatPick(o.label) : false);
          const canClick = interactive && !blockedByBusy;
          const badgeChar = i < 26 ? String.fromCharCode(65 + i) : String(i + 1);
          return (
            <button
              key={`${i}-${o.label}`}
              type="button"
              disabled={!canClick}
              onClick={() => choose(i)}
              className={
                "group/opt relative flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 " +
                (chosen
                  ? "border-accent bg-accent-soft shadow-soft ring-1 ring-accent/20"
                  : canClick
                    ? "oc-surface-card-hover border-border bg-elevated/90 hover:border-accent/45 hover:bg-surface"
                    : "border-border/80 bg-elevated/70") +
                (!canClick ? " cursor-default opacity-80" : " oc-btn-tactile cursor-pointer")
              }
            >
              <span
                aria-hidden="true"
                className={
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center border font-mono text-micro font-semibold transition-all duration-150 " +
                  (parsed.multi ? "rounded-xs " : "rounded-full ") +
                  (chosen
                    ? "border-accent bg-accent text-accent-fg shadow-soft"
                    : "border-border-strong/70 bg-surface text-faint group-hover/opt:border-accent/50 group-hover/opt:text-accent")
                }
              >
                {chosen ? <Check size={11} strokeWidth={2.75} className="oc-check-pop" /> : badgeChar}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-body font-medium leading-snug text-fg">{o.label}</span>
                {o.desc && <span className="mt-0.5 block text-caption leading-snug text-muted">{o.desc}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {interactive && !grouped && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-0.5 pt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              aria-expanded={noteOpen}
              disabled={blockedByBusy}
              onClick={() => setNoteOpen((v) => !v)}
              className="rounded-md px-1.5 py-1 text-caption font-medium text-muted transition-colors hover:bg-hover hover:text-fg disabled:opacity-40 [@media(hover:none)]:min-h-11"
            >
              {noteOpen ? "收起补充说明" : "补充说明后再发"}
            </button>
            {parsed.multi && (
              <button
                type="button"
                disabled={picked.size === 0 || blockedByBusy}
                onClick={confirmMulti}
                className="oc-btn-tactile oc-btn-accent-craft ml-auto rounded-lg bg-accent px-3.5 py-1.5 text-meta font-medium text-accent-fg transition-opacity disabled:opacity-40 [@media(hover:none)]:min-h-11"
              >
                确认选择{picked.size > 0 ? `(${picked.size})` : ""}
              </button>
            )}
          </div>
          {noteOpen && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                aria-label="补充说明"
                value={customNote}
                disabled={blockedByBusy}
                onChange={(e) => setCustomNote(e.target.value)}
                onCompositionStart={() => {
                  composingRef.current = true;
                }}
                onCompositionEnd={() => {
                  composingRef.current = false;
                }}
                onKeyDown={(e) => {
                  if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && !parsed.multi && picked.size === 0 && trimmedNote) {
                    e.preventDefault();
                    sendCustomNote();
                  }
                }}
                placeholder="选填：输入补充要求，点上方选项将一并带出"
                className="oc-surface-recessed min-w-0 flex-1 rounded-lg border border-border-control/70 bg-elevated px-3 py-1.5 text-base text-fg outline-none transition-[border-color,box-shadow] focus:border-accent focus-visible:ring-2 focus-visible:ring-ring md:text-meta"
              />
              {trimmedNote && (
                <button
                  type="button"
                  disabled={blockedByBusy}
                  onClick={sendCustomNote}
                  className="oc-btn-tactile oc-btn-secondary-craft shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-caption font-medium text-fg hover:bg-hover disabled:opacity-40 [@media(hover:none)]:min-h-11"
                >
                  直接发送说明
                </button>
              )}
            </div>
          )}
        </div>
      )}
      {sent && sentText && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-0.5 pt-2 text-caption text-faint">
          <p className="min-w-0 truncate">已选择:{sentText}</p>
          {lockedByHistory && !readOnly && !!sendUserText && !busy && (
            <button
              type="button"
              data-testid="options-reopen-history"
              onClick={() => setReopenedHistory(true)}
              className="oc-btn-tactile shrink-0 rounded-md px-2 py-0.5 font-medium text-accent transition-colors hover:bg-accent-soft [@media(hover:none)]:min-h-11"
            >
              重新选择
            </button>
          )}
        </div>
      )}
      {grouped && !sent && (groupEntry?.labels.length ?? 0) > 0 && (
        <p className="border-t border-border/60 px-0.5 pt-2 text-caption text-faint">已选:{groupEntry?.labels.join("、")}(可在下方发送选择)</p>
      )}
      {/* 没有发送能力时说清原因:demo 是「演示模式仅供浏览」,不再笼统一句「此会话中不可交互」(D-08)。 */}
      {!readOnly && !sendUserText && (
        <p className="px-0.5 text-caption text-faint">{chatInteractionUnavailableText(reason)}</p>
      )}
      {/* 新回合进行中历史选项卡不可点:说明原因,而不是只把选项压成 opacity-80 让人干等。 */}
      {interactive && blockedByBusy && (
        <output className="block px-0.5 text-caption text-faint">等待当前回合结束后可选择</output>
      )}
    </div>
  );
}

export function OptionsBlock({ code, readOnly }: { code: string; readOnly?: boolean }) {
  const outerGroup = useOptionsGroup();
  const parsed = useMemo(() => parseOptionsBlocks(code), [code]);

  if (!parsed) {
    return (
      <pre className="overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-meta text-fg">{code}</pre>
    );
  }

  const content = (
    <>
      {parsed.items.map((item, idx) => (
        <OptionsCardItem key={`${idx}-${item.question ?? ""}`} parsed={item} readOnly={readOnly} />
      ))}
      {parsed.trailing ? (
        <p className="whitespace-pre-wrap text-body leading-relaxed text-fg">{parsed.trailing}</p>
      ) : null}
    </>
  );

  // 未包外层分组（单独挂载测试或无 Provider 上下文）且同块拆出 ≥2 题时，就地补组上下文避免误触即发。
  if (!outerGroup && !readOnly && parsed.items.length >= 2) {
    return (
      <OptionsGroupProvider>
        {content}
        <OptionsGroupFooter />
      </OptionsGroupProvider>
    );
  }
  return content;
}

function useChartInstance(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  code: string,
  isDark: boolean,
  active: boolean,
  onError?: () => void,
) {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let chart: { destroy: () => void } | null = null;
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(code);
    } catch {
      onError?.(); // 流式半截 / 非法 JSON → 回退源码,不动 chart.js
      return;
    }
    (async () => {
      try {
        const { Chart, registerables } = await import("chart.js");
        Chart.register(...registerables);
        if (!alive || !canvasRef.current) return;
        // 从 CSS 变量读 token(权威=styles.css),不手抄 hex 副本 —— token 改版不漂移。
        const text = readCssToken("--muted", isDark ? "hsl(40, 5%, 60%)" : "hsl(45, 5%, 35%)");
        const grid = readCssToken("--border", isDark ? "hsla(40, 18%, 94%, 0.09)" : "hsla(24, 10%, 10%, 0.09)");
        const opts = (config.options ??= {}) as Record<string, any>;
        ((opts.plugins ??= {}).legend ??= {}).labels ??= {};
        opts.plugins.legend.labels.color ??= text;
        opts.scales ??= {};
        for (const ax of ["x", "y"]) {
          const a = (opts.scales[ax] ??= {});
          (a.ticks ??= {}).color ??= text;
          (a.grid ??= {}).color ??= grid;
        }
        opts.responsive = true;
        opts.maintainAspectRatio = true;
        // biome-ignore lint/suspicious/noExplicitAny: chart.js config 是动态 JSON
        chart = new Chart(canvasRef.current, config as any);
      } catch {
        if (alive) onError?.();
      }
    })();
    return () => {
      alive = false;
      try {
        chart?.destroy();
      } catch {
        /* ignore */
      }
    };
  }, [canvasRef, code, isDark, active, onError]);
}

function FullscreenChartCanvas({ code, isDark }: { code: string; isDark: boolean }) {
  const fullCanvasRef = useRef<HTMLCanvasElement>(null);
  useChartInstance(fullCanvasRef, code, isDark, true);
  return <canvas ref={fullCanvasRef} className="max-h-[78dvh] w-full max-w-5xl" />;
}

/** ```chart 代码块(Chart.js config JSON）→ canvas 图表;无效/半截回退源码(对齐 v3 markdown.js）。 */
export function ChartBlock({ code }: { code: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const isDark = useIsDark();

  useEffect(() => {
    setErr(false);
  }, [code, isDark]);

  const markError = useCallback(() => setErr(true), []);
  useChartInstance(canvasRef, code, isDark, !showSource, markError);

  if (err) {
    return (
      <pre className="oc-code-shell my-3 overflow-auto rounded-xl bg-code px-3.5 py-2.5 font-mono text-meta text-fg">{code}</pre>
    );
  }
  return (
    <div className="group/rich relative my-3 not-prose">
      <RichBlockToolbar
        code={code}
        showSource={showSource}
        onToggleSource={() => setShowSource((v) => !v)}
        onExpand={() => setFullscreen(true)}
      />
      {showSource ? (
        <pre className="oc-code-shell overflow-auto rounded-xl bg-code px-3.5 py-3 pr-28 font-mono text-meta text-fg">
          {code}
        </pre>
      ) : (
        <div className="oc-surface-card rounded-xl p-4">
          <canvas ref={canvasRef} className="max-h-80 w-full" />
        </div>
      )}
      <RichFullscreenModal open={fullscreen} onOpenChange={setFullscreen} title="图表预览">
        {fullscreen && <FullscreenChartCanvas code={code} isDark={isDark} />}
      </RichFullscreenModal>
    </div>
  );
}

/** ```html / ```htmlpreview 代码块 → 无缝嵌入(见 ./HtmlEmbed)。保留原导出名,调用方不变。 */
export { HtmlPreview } from "./HtmlEmbed";
