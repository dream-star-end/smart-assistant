import { ArrowDown, ArrowUp, ArrowUpDown, Check, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { Cell, TableSpec } from "./schema";
import { Frame, Inline } from "./shell";
import { formatNumber, specToMarkdown } from "./toMarkdown";

/** 单元格的排序键:数字直接比;「1,200」「35%」「¥80」这类数字字符串按数值比;其余按文字。 */
export function sortKey(c: Cell): { n: number | null; s: string } {
  if (c === null) return { n: null, s: "" };
  if (typeof c === "number") return { n: c, s: String(c) };
  const m = /^[^\d-]{0,4}(-?[\d,]*\.?\d+)\s*(%|[A-Za-z一-鿿]{0,4})$/.exec(c.trim());
  if (m) {
    const n = Number(m[1]!.replace(/,/g, ""));
    if (Number.isFinite(n)) return { n, s: c };
  }
  return { n: null, s: c };
}

const isEmpty = (c: Cell) => c === null || c === "";

const YES = new Set(["✓", "✔", "✅", "☑"]);
const NO = new Set(["✗", "✘", "✕", "×", "❌"]);

function CellContent({ c }: { c: Cell }) {
  if (c === null) return <span className="text-faint">—</span>;
  if (typeof c === "number") return <>{formatNumber(c)}</>;
  const t = c.trim();
  if (YES.has(t))
    return (
      <span className="oc-iui-mark is-yes" role="img" aria-label="是">
        <Check size={13} strokeWidth={2.75} aria-hidden />
      </span>
    );
  if (NO.has(t))
    return (
      <span className="oc-iui-mark is-no" role="img" aria-label="否">
        <X size={13} strokeWidth={2.75} aria-hidden />
      </span>
    );
  return <Inline text={c} />;
}

export function compareCells(a: Cell, b: Cell): number {
  const ka = sortKey(a);
  const kb = sortKey(b);
  // 空值永远排在最后。
  if (a === null || a === "") return b === null || b === "" ? 0 : 1;
  if (b === null || b === "") return -1;
  if (ka.n !== null && kb.n !== null) return ka.n - kb.n;
  return ka.s.localeCompare(kb.s, "zh-CN", { numeric: true });
}

export function TableBlock({ spec, notes, streaming, nested }: { spec: TableSpec; notes: string[]; streaming: boolean; nested?: boolean }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const width = spec.columns.length;
  const rows = useMemo(() => {
    const padded = spec.rows.map((r, i) => ({ r: Array.from({ length: width }, (_, j) => r[j] ?? null), i }));
    if (!sort || streaming) return padded;
    return padded
      .sort((x, y) => {
        // 空值不随升降序翻转,永远排最后。
        const ex = isEmpty(x.r[sort.col]!);
        const ey = isEmpty(y.r[sort.col]!);
        if (ex !== ey) return ex ? 1 : -1;
        return compareCells(x.r[sort.col]!, y.r[sort.col]!) * sort.dir || x.i - y.i;
      });
  }, [spec.rows, width, sort, streaming]);

  // 数据条:按列内最大绝对值归一。
  const barMax = useMemo(
    () =>
      spec.columns.map((c, i) =>
        c.bar ? Math.max(0, ...spec.rows.map((r) => (typeof r[i] === "number" ? Math.abs(r[i] as number) : 0))) : 0,
      ),
    [spec.columns, spec.rows],
  );

  const toggle = (col: number) =>
    setSort((s) => (s?.col !== col ? { col, dir: 1 } : s.dir === 1 ? { col, dir: -1 } : null));

  return (
    <Frame
      kind="table"
      nested={nested}
      title={spec.title}
      subtitle={spec.subtitle}
      source={spec.source}
      note={spec.note}
      notes={notes}
      streaming={streaming}
      copyText={() => specToMarkdown(spec)}
    >
      <section
        className="oc-iui-table-region"
        aria-label={spec.title ? `${spec.title}(可横向滚动)` : "表格(可横向滚动)"}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 横向滚动区必须可由键盘聚焦和滚动。
        tabIndex={0}
      >
        <table className="oc-iui-table">
          <thead>
            <tr>
              {spec.columns.map((c, i) => {
                const active = sort?.col === i;
                const Icon = active ? (sort!.dir === 1 ? ArrowUp : ArrowDown) : ArrowUpDown;
                return (
                  <th
                    key={`${i}:${c.label}`}
                    scope="col"
                    aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : "none"}
                    className={c.align === "right" ? "is-num" : undefined}
                  >
                    <button
                      type="button"
                      className="oc-iui-sort"
                      onClick={() => toggle(i)}
                      disabled={streaming}
                      aria-label={`按「${c.label}」排序`}
                    >
                      <span>
                        {c.label}
                        {c.unit && <span className="oc-iui-unit">({c.unit})</span>}
                      </span>
                      <Icon size={12} aria-hidden className={active ? "is-active" : undefined} />
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, i: orig }) => (
              <tr key={`r${orig}`} className={spec.highlight === orig ? "is-highlight" : undefined}>
                {r.map((c, ci) => {
                  const col = spec.columns[ci];
                  const right = col?.align === "right";
                  const Tag = ci === 0 ? "th" : "td";
                  const bar = col?.bar && typeof c === "number" && barMax[ci]! > 0 ? Math.abs(c) / barMax[ci]! : null;
                  return (
                    // biome-ignore lint/suspicious/noArrayIndexKey: 单元格位置即身份
                    <Tag key={ci} scope={ci === 0 ? "row" : undefined} className={right ? "is-num" : undefined}>
                      {bar !== null ? (
                        <span className="oc-iui-cellbar">
                          <span className="oc-iui-cellbar-track" aria-hidden>
                            <span style={{ width: `${Math.max(2, bar * 100)}%` }} />
                          </span>
                          <span>{formatNumber(c as number)}</span>
                        </span>
                      ) : (
                        <CellContent c={c} />
                      )}
                    </Tag>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </Frame>
  );
}
