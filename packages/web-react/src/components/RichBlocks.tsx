/**
 * Markdown 富块（对齐设计稿 ⑧）：mermaid 流程图 + HTML 沙盒预览。
 * 二者都在 MarkdownImpl(懒加载 chunk)内按需用：mermaid 库再经 dynamic import 拆成
 * 独立 chunk(只有真出现 ```mermaid 才下载,不拖累首屏与普通对话)。
 */
import { Maximize2, X } from "lucide-react";
import { useChatInteraction } from "./tool/context";
import { useOptionsGroup, useOptionsGroupSnapshot } from "./optionsGroup";
import { useMemo, useEffect, useId, useRef, useState } from "react";

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
      <div className="my-3 flex items-center justify-center rounded-lg border border-border bg-surface px-3 py-6 text-[12.5px] text-faint">
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
// 渲染为可点击选项卡:单选点击即替用户发送「我选择:<label>」;多选勾选后点「确认选择」。
// 无 ChatInteractionContext provider(历史/demo)或 JSON 半截(流式)时回退纯展示。

interface OptionItem {
  label: string;
  desc?: string;
}

function parseOptionsBlock(
  code: string,
): { question?: string; multi: boolean; options: OptionItem[] } | null {
  try {
    const raw = JSON.parse(code) as Record<string, unknown>;
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
    };
  } catch {
    return null; // 流式半截 / 非法 JSON → 调用方回退源码
  }
}

export function OptionsBlock({ code }: { code: string }) {
  const { sendUserText, busy } = useChatInteraction();
  const group = useOptionsGroup();
  const groupSnap = useOptionsGroupSnapshot();
  const blockKey = useId();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [sentLocal, setSentLocal] = useState<string | null>(null);
  const parsed = useMemo(() => parseOptionsBlock(code), [code]);

  // 注册到消息级分组(多题聚合作答的前提;流式半截时不注册,解析成功即补登)。
  useEffect(() => {
    if (!group || !parsed) return;
    group.register(blockKey, { question: parsed.question, multi: parsed.multi });
    return () => group.unregister(blockKey);
    // question/multi 变化(流式补全)时重登;blockKey 稳定。
  }, [group, blockKey, parsed?.question, parsed?.multi, !parsed]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!parsed) {
    return (
      <pre className="overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-[12px] text-fg">{code}</pre>
    );
  }

  // 同消息多题 → 聚合模式:点选只记录,由 GroupFooter 统一发送(修 boss 实测:
  // 点第一题即发送、其余题作废)。单题(或无分组)保持点击即发/块内确认。
  const grouped = !!group && (groupSnap?.count ?? 0) >= 2;
  const groupEntry = groupSnap?.entries.find((e) => e.key === blockKey);
  const sent = grouped ? (groupSnap?.sent ?? false) : sentLocal !== null;
  const sentText = grouped ? (groupEntry?.labels.join("、") ?? null) : sentLocal;
  const interactive = !!sendUserText && !sent;

  const report = (labels: string[]) => group?.setAnswer(blockKey, labels);

  const choose = (i: number) => {
    if (!interactive || busy) return;
    const label = parsed.options[i].label;
    if (parsed.multi) {
      setPicked((p) => {
        const n = new Set(p);
        if (n.has(i)) n.delete(i);
        else n.add(i);
        if (grouped) report([...n].sort((a, b) => a - b).map((x) => parsed.options[x].label));
        return n;
      });
    } else if (grouped) {
      // 聚合模式单选:标记/换选,不发送。
      setPicked(new Set([i]));
      report([label]);
    } else {
      setSentLocal(label);
      sendUserText?.(`我选择:${label}`);
    }
  };
  const confirmMulti = () => {
    if (!interactive || busy || picked.size === 0 || grouped) return;
    const labels = [...picked].sort((a, b) => a - b).map((i) => parsed.options[i].label);
    setSentLocal(labels.join("、"));
    sendUserText?.(`我选择:${labels.join("、")}`);
  };
  return (
    <div className="my-1.5 flex flex-col gap-1.5 rounded-xl border border-border bg-surface p-2.5 not-prose">
      {parsed.question && <p className="px-1 text-[13px] font-medium text-fg">{parsed.question}</p>}
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {parsed.options.map((o, i) => {
          const chosen = parsed.multi || grouped ? picked.has(i) : sentText === o.label;
          return (
            <button
              key={`${i}-${o.label}`}
              type="button"
              disabled={!interactive || !!busy}
              onClick={() => choose(i)}
              className={
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                (chosen
                  ? "border-accent bg-accent-soft"
                  : "border-border bg-elevated hover:border-accent/40 hover:bg-hover") +
                (!interactive || busy ? " cursor-default opacity-80" : "")
              }
            >
              <span
                className={
                  "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border text-[10px] " +
                  (chosen ? "border-accent bg-accent text-white" : "border-border text-transparent")
                }
              >
                ✓
              </span>
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-fg">{o.label}</span>
                {o.desc && <span className="mt-0.5 block text-[11.5px] leading-snug text-muted">{o.desc}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {parsed.multi && interactive && !grouped && (
        <button
          type="button"
          disabled={picked.size === 0 || !!busy}
          onClick={confirmMulti}
          className="self-end rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-white transition-opacity disabled:opacity-40"
        >
          确认选择{picked.size > 0 ? `(${picked.size})` : ""}
        </button>
      )}
      {sent && sentText && <p className="px-1 text-[11.5px] text-faint">已选择:{sentText}</p>}
      {grouped && !sent && (groupEntry?.labels.length ?? 0) > 0 && (
        <p className="px-1 text-[11.5px] text-faint">已选:{groupEntry?.labels.join("、")}(答完全部问题后统一发送)</p>
      )}
      {!sendUserText && <p className="px-1 text-[11px] text-faint">(此会话中不可交互)</p>}
    </div>
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

/** ```html 代码块 → **默认沙盒预览**(allow-scripts,无 same-origin),可切源码 + 全屏放大。 */
export function HtmlPreview({ code }: { code: string }) {
  const [show, setShow] = useState(true); // 默认预览(boss:html 应默认渲染,而非看源码)
  const [full, setFull] = useState(false);
  // 全屏时按 Esc 退出。
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFull(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);
  // sandbox 不含 allow-same-origin → 取不到父页 cookie/storage;仅 allow-scripts 跑演示。
  const frame = (cls: string) => (
    <iframe sandbox="allow-scripts" srcDoc={code} title="HTML 沙盒预览" className={cls} />
  );
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-hover px-3 py-1.5 text-[12px] text-muted">
        <span>HTML {show ? "预览(沙盒)" : "源码"}</span>
        <div className="flex items-center gap-1">
          {show && (
            <button
              type="button"
              onClick={() => setFull(true)}
              title="全屏放大"
              aria-label="全屏放大预览"
              className="rounded-md p-1 text-muted outline-none hover:bg-accent-soft hover:text-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Maximize2 size={13} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="rounded-md px-2 py-0.5 text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
          >
            {show ? "看源码" : "预览"}
          </button>
        </div>
      </div>
      {show ? (
        frame("h-72 w-full bg-white")
      ) : (
        <pre className="max-h-72 overflow-auto bg-code px-3 py-2 font-mono text-xs text-fg">{code}</pre>
      )}
      {full && (
        <div className="fixed inset-0 z-[60] flex flex-col bg-black/80 p-3 animate-in sm:p-6">
          <div className="mb-2 flex items-center justify-between text-white">
            <span className="text-sm opacity-80">HTML 预览(沙盒) · 按 Esc 退出</span>
            <button
              type="button"
              onClick={() => setFull(false)}
              aria-label="关闭全屏"
              className="flex items-center gap-1 rounded-md bg-white/15 px-3 py-1.5 text-sm outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white/50"
            >
              <X size={16} /> 关闭
            </button>
          </div>
          {frame("min-h-0 flex-1 w-full rounded-lg bg-white")}
        </div>
      )}
    </div>
  );
}
