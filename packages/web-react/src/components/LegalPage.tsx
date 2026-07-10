import { ArrowLeft } from "lucide-react";
import { useEffect } from "react";
import { BRAND } from "../lib/brand";
import { LEGAL_DOCS, type LegalKind } from "../lib/legal";

/**
 * 法律文本静态页(/terms 用户协议、/privacy 隐私政策)。
 *
 * 入口:main.tsx 对 location.pathname 的特判(与 App 内 /reset-password 特判同族,
 * 但这里是纯静态页、不需要任何 App 状态,故直接在入口层短路,不进 App 的 hooks)。
 * 正文权威源在 lib/legal.ts;本组件只负责渲染,不得内嵌任何条款文案。
 */
export function LegalPage({ kind }: { kind: LegalKind }) {
  const doc = LEGAL_DOCS[kind];
  const other: LegalKind = kind === "terms" ? "privacy" : "terms";

  useEffect(() => {
    const prev = document.title;
    document.title = `${doc.title} · ${BRAND.name}`;
    return () => {
      document.title = prev;
    };
  }, [doc.title]);

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-10 border-b border-border bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-5">
          <a href="/" className="flex items-center gap-2 text-[14px] font-semibold text-fg hover:text-accent">
            <ArrowLeft size={16} />
            {BRAND.name}
          </a>
          <a href={`/${other}`} className="text-[13px] text-accent hover:underline">
            {LEGAL_DOCS[other].title}
          </a>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-10">
        <h1 className="text-[26px] font-bold tracking-tight">{doc.title}</h1>
        <p className="mt-2 text-[13px] text-faint">更新日期:{doc.updated} · 生效日期:{doc.updated}</p>
        <p className="mt-6 text-[14.5px] leading-7 text-muted">{doc.intro}</p>

        {doc.sections.map((s) => (
          <section key={s.h} className="mt-8">
            <h2 className="text-[17px] font-semibold">{s.h}</h2>
            {s.ps.map((p) => (
              <p key={p.slice(0, 24)} className="mt-3 text-[14.5px] leading-7 text-muted">
                {p}
              </p>
            ))}
          </section>
        ))}

        <footer className="mt-12 border-t border-border pt-6 text-[12.5px] text-faint">
          © {BRAND.year} {BRAND.company} · {BRAND.icp}
        </footer>
      </main>
    </div>
  );
}
