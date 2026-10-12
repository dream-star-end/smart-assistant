/**
 * 行情类组件（OCV5-383）的 Markdown 版本：关闭 Intelligent UI、复制、导出、朗读时用。
 * 只写块里已有的数字；分时太长时按 30 分钟取样，并写明取样方式。
 */
import {
  type IntradaySpec,
  type KlineSpec,
  type MarketSpec,
  type QuoteSpec,
  type StockListSpec,
  cnAmount,
  pctText,
  priceText,
  quoteChangePct,
} from "./marketSchema";

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(header: string[], rows: string[][], rightFrom = 1): string {
  const align = header.map((_, i) => (i >= rightFrom ? "---:" : "---"));
  return [`| ${header.map(esc).join(" | ")} |`, `| ${align.join(" | ")} |`, ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`)].join("\n");
}

function head(title?: string, subtitle?: string): string[] {
  return [...(title ? [`**${title}**`] : []), ...(subtitle ? [subtitle] : []), ...(title || subtitle ? [""] : [])];
}

function foot(source?: string, note?: string): string[] {
  return [...(note ? ["", `> ${note}`] : []), ...(source ? ["", `来源:${source}`] : [])];
}

function d8(d: string): string {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : d;
}

function quoteMd(spec: QuoteSpec): string {
  const rows = spec.items.map((q) => [
    `${q.name ?? q.code}(${q.code})`,
    priceText(q.price),
    pctText(quoteChangePct(q)),
    q.high !== undefined ? priceText(q.high) : "—",
    q.low !== undefined ? priceText(q.low) : "—",
    q.amount !== undefined ? cnAmount(q.amount) : "—",
    q.turnoverPct !== undefined ? pctText(q.turnoverPct, false) : "—",
  ]);
  const time = spec.items.find((q) => q.time)?.time;
  return [
    ...head(spec.title, spec.subtitle ?? (time ? `更新于 ${time}` : undefined)),
    table(["股票", "现价", "涨跌幅", "最高", "最低", "成交额(元)", "换手率"], rows),
    ...foot(spec.source, spec.note),
  ].join("\n");
}

function klineMd(spec: KlineSpec): string {
  const rows = spec.rows.map((r, i) => {
    const prev = spec.rows[i - 1];
    return [
      d8(r.date),
      priceText(r.open),
      priceText(r.high),
      priceText(r.low),
      priceText(r.close),
      prev ? pctText(((r.close - prev.close) / prev.close) * 100) : "—",
      r.volume === undefined ? "—" : cnAmount(r.volume / 100),
    ];
  });
  return [
    ...head(spec.title ?? [spec.name, spec.code, spec.period, "K线"].filter(Boolean).join(" "), spec.subtitle),
    table(["日期", "开", "高", "低", "收", "涨跌幅", "成交量(手)"], rows),
    ...foot(spec.source, spec.note),
  ].join("\n");
}

function intradayMd(spec: IntradaySpec): string {
  const pts = spec.points;
  const base = spec.prevClose ?? pts[0]?.price;
  // 半小时一个点 + 最后一个点；整表给全部分钟点没人看得完。
  const picked = pts.filter((p, i) => i === 0 || i === pts.length - 1 || /:(00|30)$/.test(p.time));
  const rows = picked.map((p) => [
    p.time,
    priceText(p.price),
    base ? pctText(((p.price - base) / base) * 100) : "—",
    p.avg !== undefined ? priceText(p.avg) : "—",
  ]);
  return [
    ...head(spec.title ?? [spec.name, spec.code, "分时"].filter(Boolean).join(" "), spec.subtitle ?? spec.date),
    ...(spec.prevClose !== undefined ? [`昨收 ${priceText(spec.prevClose)}`, ""] : []),
    table(["时间", "价格", "涨跌幅", "均价"], rows),
    "",
    `(每半小时取一个点，共 ${pts.length} 个分钟点)`,
    ...foot(spec.source, spec.note),
  ].join("\n");
}

function stocklistMd(spec: StockListSpec): string {
  const rows = spec.items.map((r, i) => [
    String(i + 1),
    `${r.name ?? r.code}(${r.code})`,
    r.price !== undefined ? priceText(r.price) : "—",
    r.changePct !== undefined ? pctText(r.changePct) : "—",
    r.amount !== undefined ? cnAmount(r.amount) : "—",
  ]);
  return [
    ...head(spec.title, spec.subtitle ?? (spec.total ? `共 ${spec.total} 只` : undefined)),
    table(["#", "股票", "现价", "涨跌幅", "成交额(元)"], rows, 2),
    ...foot(spec.source, spec.note),
  ].join("\n");
}

export function marketToMarkdown(spec: MarketSpec): string {
  switch (spec.type) {
    case "quote":
      return quoteMd(spec);
    case "kline":
      return klineMd(spec);
    case "intraday":
      return intradayMd(spec);
    case "stocklist":
      return stocklistMd(spec);
  }
}
