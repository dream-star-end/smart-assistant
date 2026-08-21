/** 把 query 在 text 中的命中用 <mark> 标出。不走 innerHTML，避免未转义拼接。 */
export function HighlightedText({ text, query }: { text: string; query: string }) {
  const needle = query.trim();
  if (!needle) return <>{text}</>;
  const parts = splitKeep(text, needle);
  return (
    <>
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded-sm bg-accent-soft text-fg">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function splitKeep(text: string, query: string): { text: string; hit: boolean }[] {
  const src = text;
  const q = query.toLowerCase();
  const out: { text: string; hit: boolean }[] = [];
  let i = 0;
  const lower = src.toLowerCase();
  while (i < src.length) {
    const at = lower.indexOf(q, i);
    if (at < 0) {
      out.push({ text: src.slice(i), hit: false });
      break;
    }
    if (at > i) out.push({ text: src.slice(i, at), hit: false });
    out.push({ text: src.slice(at, at + query.length), hit: true });
    i = at + query.length;
  }
  return out.filter((p) => p.text.length > 0);
}
