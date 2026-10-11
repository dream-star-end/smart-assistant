/**
 * Markdown 富块（对齐设计稿 ⑧）：mermaid 流程图 + HTML 无缝嵌入(实现在 ./HtmlEmbed)。
 * 二者都在 MarkdownImpl(懒加载 chunk)内按需用：mermaid 库再经 dynamic import 拆成
 * 独立 chunk(只有真出现 ```mermaid 才下载,不拖累首屏与普通对话)。
 */
import { chatInteractionUnavailableText, useChatInteraction } from "./tool/context";
import { useOptionsGroup, useOptionsGroupSnapshot } from "./optionsGroup";
import { useMemo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

/** 主题响应:观察 <html> class(useTheme 切换写入 .dark)。mermaid/chart 的配色在渲染时
 *  快照,若不进依赖,切明暗主题后已渲染的图配色错乱(暗底浅字/浅底暗字)。 */
function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  useEffect(() => {
    const mo = new MutationObserver(() => {
      setDark(document.documentElement.classList.contains("dark"));
    });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
  return dark;
}

/** ```mermaid 代码块 → 渲染成 SVG 流程图;失败回退源码。 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const rawId = useId();
  const isDark = useIsDark();

  useEffect(() => {
    let alive = true;
    setSvg(null);
    setErr(false);
    (async () => {
      try {
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: isDark ? "dark" : "default",
        });
        // 先 parse 校验(suppressErrors→只返 bool,不向 document.body 注入错误图)。
        // 流式时代码常是半截 → parse=false → 回退源码,绝不调 render(render 对坏输入会把
        // "Syntax error" SVG 注入 body 残留)。代码写完变有效后,effect 重跑再真正 render。
        const ok = await mermaid.parse(code, { suppressErrors: true });
        if (!ok) {
          if (alive) setErr(true);
          return;
        }
        const id = "mmd" + rawId.replace(/[^a-zA-Z0-9]/g, "");
        const out = await mermaid.render(id, code);
        if (alive) setSvg(out.svg);
      } catch {
        if (alive) setErr(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, rawId, isDark]);

  if (err) {
    return (
      <pre className="my-3 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-xs text-fg">{code}</pre>
    );
  }
  if (!svg) {
    return (
      <div className="my-3 flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-6 text-meta text-faint">
        图表渲染中…
      </div>
    );
  }
  return (
    // mermaid securityLevel:'strict' 已清洗 SVG
    <div
      className="my-3 flex justify-center overflow-x-auto rounded-lg border border-border bg-surface p-3"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: mermaid strict-sanitized SVG
      dangerouslySetInnerHTML={{ __html: svg }}
    />
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

function extractFirstJsonObject(source: string): { json: string; rest: string } | null {
  const start = source.search(/\S/);
  if (start < 0 || source[start] !== "{") return null;
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
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return { json: source.slice(start, i + 1), rest: source.slice(i + 1) };
    }
  }
  return null;
}

function parseOptionsBlock(
  code: string,
): { question?: string; multi: boolean; options: OptionItem[]; trailing: string } | null {
  try {
    const extracted = extractFirstJsonObject(code);
    if (!extracted) return null;
    const raw = JSON.parse(extracted.json) as Record<string, unknown>;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.options)) return null;
    const options: OptionItem[] = [];
    for (const o of raw.options as unknown[]) {
      if (typeof o === "string") options.push({ label: o });
      else if (o && typeof o === "object" && typeof (o as { label?: unknown }).label === "string") {
        const oo = o as { label: string; desc?: unknown };
        options.push({ label: oo.label, ...(typeof oo.desc === "string" ? { desc: oo.desc } : {}) });
      }
    }
    if (options.length === 0 || options.length > 12) return null;
    return {
      question: typeof raw.question === "string" ? raw.question : undefined,
      multi: raw.multi === true,
      options,
      trailing: extracted.rest.trim() ? extracted.rest.trim() : "",
    };
  } catch {
    return null; // 流式半截 / 非法 JSON → 调用方回退源码
  }
}

export function OptionsBlock({ code, readOnly }: { code: string; readOnly?: boolean }) {
  const { sendUserText, busy, reason } = useChatInteraction();
  const group = useOptionsGroup();
  const groupSnap = useOptionsGroupSnapshot();
  const blockKey = useId();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  const parsed = useMemo(() => parseOptionsBlock(code), [code]);

  // 注册到消息级分组(多题聚合作答的前提;流式半截时不注册,解析成功即补登)。
  // 用 layout effect:passive effect 在 commit 之后才跑,中间那帧里块已可点、分组还没数到它,
  // 点选会误走「单块点击即发」(t-839 OG-01 实证:三题消息第一题被单独发出)。
  useLayoutEffect(() => {
    if (readOnly || !group || !parsed) return;
    group.register(blockKey, { question: parsed.question, multi: parsed.multi });
    return () => group.unregister(blockKey);
    // question/multi 变化(流式补全)时重登;blockKey 稳定。
  }, [group, blockKey, parsed, readOnly]);

  if (!parsed) {
    return (
      <pre className="overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-meta text-fg">{code}</pre>
    );
  }

  // 同消息多题 → 聚合模式:点选只记录,由 GroupFooter 统一发送。
  // 流式(live)期间即使目前只注册到 1 块也不走点击即发——长回合中途就会贴卡,
  // 后继 options 的 JSON 也可能还是半截;点选永远可点,发送必须用户显式点页脚。
  // 流式期点过、流式结束后也留在聚合模式(点选不丢,由页脚显式发出)。
  // 非流式单题(或无分组)保持点击即发/块内确认。口径统一取 snapshot.grouped。
  const streaming = groupSnap?.live === true;
  const grouped = !!group && (groupSnap?.grouped ?? false);
  const groupEntry = groupSnap?.entries.find((e) => e.key === blockKey);
  const sent = sentLocal !== null || (groupSnap?.sent ?? false);
  const sentText = sentLocal ?? (groupEntry?.labels.length ? groupEntry.labels.join("、") : null);
  const interactive = !readOnly && !!sendUserText && !sent;
  // 生产里 busy===sending===live;流式期忽略 busy,否则长回合选项卡仍不可点。
  // 非流式仍尊重 busy(历史卡在新回合进行中不可点)。
  const blockedByBusy = !!busy && !streaming;

  const report = (labels: string[]) => group?.setAnswer(blockKey, labels);
  // 点击时刻直接读 store:同一 commit 里兄弟块刚注册完、本块还没因快照变化重渲时,
  // 渲染期算出的 grouped 可能还是旧值(单块),读 store 才不会误走「点击即发」。
  const groupedNow = () => !!group && group.getSnapshot().grouped;

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
      setSentLocal(label);
      sendUserText?.(`我选择:${label}`);
    }
  };
  const confirmMulti = () => {
    if (!interactive || blockedByBusy || picked.size === 0 || groupedNow()) return;
    const labels = [...picked].sort((a, b) => a - b).map((i) => parsed.options[i].label);
    setSentLocal(labels.join("、"));
    sendUserText?.(`我选择:${labels.join("、")}`);
  };
  return (
    <>
    <div className="my-1.5 flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-2.5 not-prose">
      {parsed.question && <p className="px-1 text-body font-medium text-fg">{parsed.question}</p>}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {parsed.options.map((o, i) => {
          const chosen = parsed.multi || grouped ? picked.has(i) : sentText === o.label;
          return (
            <button
              key={`${i}-${o.label}`}
              type="button"
              disabled={!interactive || blockedByBusy}
              onClick={() => choose(i)}
              className={
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(hover:none)]:min-h-11 " +
                (chosen
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-elevated hover:border-accent/40 hover:bg-hover") +
                (!interactive || blockedByBusy ? " cursor-default opacity-80" : "")
              }
            >
              <span
                className={
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-micro " +
                  (chosen ? "border-accent bg-accent text-accent-fg" : "border-border text-transparent")
                }
              >
                ✓
              </span>
              <span className="min-w-0">
                <span className="block text-body font-medium text-fg">{o.label}</span>
                {o.desc && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{o.desc}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {parsed.multi && interactive && !grouped && (
        <button
          type="button"
          disabled={picked.size === 0 || blockedByBusy}
          onClick={confirmMulti}
          className="self-end rounded-lg bg-accent px-3.5 py-1.5 text-meta font-medium text-accent-fg transition-opacity disabled:opacity-40"
        >
          确认选择{picked.size > 0 ? `(${picked.size})` : ""}
        </button>
      )}
      {sent && sentText && <p className="px-1 text-caption text-faint">已选择:{sentText}</p>}
      {grouped && !sent && (groupEntry?.labels.length ?? 0) > 0 && (
        <p className="px-1 text-caption text-faint">已选:{groupEntry?.labels.join("、")}(可在下方发送选择)</p>
      )}
      {/* 没有发送能力时说清原因:demo 是「演示模式仅供浏览」,不再笼统一句「此会话中不可交互」(D-08)。 */}
      {!readOnly && !sendUserText && (
        <p className="px-1 text-caption text-faint">{chatInteractionUnavailableText(reason)}</p>
      )}
      {/* 新回合进行中历史选项卡不可点:说明原因,而不是只把选项压成 opacity-80 让人干等。 */}
      {interactive && blockedByBusy && (
        <output className="block px-1 text-caption text-faint">等待当前回合结束后可选择</output>
      )}
    </div>
    {parsed.trailing ? (
      <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-fg">{parsed.trailing}</p>
    ) : null}
    </>
  );
}

/** ```chart 代码块(Chart.js config JSON）→ canvas 图表;无效/半截回退源码(对齐 v3 markdown.js）。 */
export function ChartBlock({ code }: { code: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState(false);
  const isDark = useIsDark();

  useEffect(() => {
    let alive = true;
    let chart: { destroy: () => void } | null = null;
    setErr(false);
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(code);
    } catch {
      setErr(true); // 流式半截 / 非法 JSON → 回退源码,不动 chart.js
      return;
    }
    (async () => {
      try {
        const { Chart, registerables } = await import("chart.js");
        Chart.register(...registerables);
        if (!alive || !canvasRef.current) return;
        // 从 CSS 变量读 token(权威=styles.css),不手抄 hex 副本 —— token 改版不漂移。
        const text =
          getComputedStyle(document.documentElement).getPropertyValue("--muted").trim() ||
          (isDark ? "#bcbcc7" : "#51515c");
        const grid = isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)";
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
        if (alive) setErr(true);
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
  }, [code, isDark]);

  if (err) {
    return (
      <pre className="my-3 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-xs text-fg">{code}</pre>
    );
  }
  return (
    <div className="my-3 rounded-lg border border-border bg-surface p-3">
      <canvas ref={canvasRef} className="max-h-80 w-full" />
    </div>
  );
}

/** ```html / ```htmlpreview 代码块 → 无缝嵌入(见 ./HtmlEmbed)。保留原导出名,调用方不变。 */
export { HtmlPreview } from "./HtmlEmbed";
