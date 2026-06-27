/**
 * Markdown 富块（对齐设计稿 ⑧）：mermaid 流程图 + HTML 沙盒预览。
 * 二者都在 MarkdownImpl(懒加载 chunk)内按需用：mermaid 库再经 dynamic import 拆成
 * 独立 chunk(只有真出现 ```mermaid 才下载,不拖累首屏与普通对话)。
 */
import { useEffect, useId, useState } from "react";

/** ```mermaid 代码块 → 渲染成 SVG 流程图;失败回退源码。 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  const rawId = useId();

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
          theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
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
  }, [code, rawId]);

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

/** ```html 代码块 → 默认显示源码,可切到沙盒 iframe 预览(allow-scripts,无 same-origin)。 */
export function HtmlPreview({ code }: { code: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-hover px-3 py-1.5 text-[12px] text-muted">
        <span>HTML {show ? "预览(沙盒)" : "源码"}</span>
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="rounded-md px-2 py-0.5 text-accent outline-none hover:bg-accent-soft focus-visible:ring-2 focus-visible:ring-ring"
        >
          {show ? "看源码" : "预览"}
        </button>
      </div>
      {show ? (
        <iframe
          // sandbox 不含 allow-same-origin → 取不到父页 cookie/storage;仅 allow-scripts 跑演示。
          sandbox="allow-scripts"
          srcDoc={code}
          title="HTML 沙盒预览"
          className="h-64 w-full bg-white"
        />
      ) : (
        <pre className="max-h-72 overflow-auto bg-code px-3 py-2 font-mono text-xs text-fg">{code}</pre>
      )}
    </div>
  );
}
