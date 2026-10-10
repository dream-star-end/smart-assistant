/**
 * Intelligent UI(OCV5-361)—— 组件 → Markdown / 纯文本。
 *
 * 四个用处:开关关闭时的渲染、消息复制、会话导出、组件渲染失败时的兜底。
 * 输出是普通 GFM(表格、列表、引用),任何 Markdown 阅读器都能读。
 */
import { computeOutputs } from "./formula";
import { parseUiBlock } from "./parse";
import type { CalcFormat, CalculatorSpec, Cell, IuiSpec, OutlineNode, TableSpec } from "./schema";
import { validateSpec } from "./schema";

const CURRENCY_PREFIX = new Set(["¥", "￥", "$", "€", "£", "HK$", "US$"]);

export function formatNumber(v: number, format: CalcFormat = "number", decimals?: number): string {
  if (!Number.isFinite(v)) return "—";
  const clampD = (d: number) => Math.max(0, Math.min(10, Math.trunc(d)));
  const want = decimals === undefined ? undefined : clampD(decimals);
  let maxD: number;
  let minD: number;
  if (format === "integer") {
    // integer 永远 0 位小数(忽略 decimals);否则 min > max 会让 Intl 抛 RangeError。
    maxD = 0;
    minD = 0;
  } else if (format === "currency") {
    maxD = want ?? 2;
    minD = maxD;
  } else if (format === "percent") {
    maxD = want ?? 2;
    minD = want ?? 0;
  } else {
    maxD = want ?? (Math.abs(v) >= 100 ? 2 : 4);
    minD = want ?? 0;
  }
  const n = format === "percent" ? v * 100 : v;
  let text: string;
  try {
    text = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: maxD, minimumFractionDigits: Math.min(minD, maxD) }).format(n);
  } catch {
    text = String(Number(n.toFixed(maxD)));
  }
  return format === "percent" ? `${text}%` : text;
}

/** 数值 + 单位:货币符号放前面,其它单位放后面(中文习惯不留空格的单位如 %、元)。 */
export function withUnit(text: string, unit?: string): string {
  if (!unit) return text;
  if (CURRENCY_PREFIX.has(unit)) return `${unit}${text}`;
  return /^[%‰°]|^[一-鿿]/.test(unit) ? `${text}${unit}` : `${text} ${unit}`;
}

function cellText(c: Cell): string {
  if (c === null) return "";
  return typeof c === "number" ? formatNumber(c) : c;
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function mdTable(header: string[], rows: string[][], align?: ("left" | "right")[]): string {
  const h = `| ${header.map(esc).join(" | ")} |`;
  const sep = `| ${header.map((_, i) => (align?.[i] === "right" ? "---:" : "---")).join(" | ")} |`;
  const body = rows.map((r) => `| ${header.map((_, i) => esc(r[i] ?? "")).join(" | ")} |`);
  return [h, sep, ...body].join("\n");
}

function csvField(v: string): string {
  // 以 = + - @ 开头的文字前面加 ',避免表格软件把它当公式执行;数字原样。
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** 表格 → CSV:表头带单位,数字不做千分位格式化;开头带 BOM,Excel 打开中文不乱码。 */
export function tableToCsv(spec: TableSpec, rows: Cell[][] = spec.rows): string {
  const header = spec.columns.map((c) => csvField(c.unit ? `${c.label}(${c.unit})` : c.label));
  const body = rows.map((r) => spec.columns.map((_, i) => {
    const c = r[i] ?? null;
    return c === null ? "" : typeof c === "number" ? String(c) : csvField(c);
  }).join(","));
  return `﻿${[header.join(","), ...body].join("\r\n")}\r\n`;
}

function heading(title?: string, subtitle?: string): string[] {
  if (!title) return subtitle ? [subtitle, ""] : [];
  return subtitle ? [`**${title}**`, subtitle, ""] : [`**${title}**`, ""];
}

function sourceLines(source?: string, note?: string): string[] {
  const out: string[] = [];
  if (note) out.push("", `> ${note}`);
  if (source) out.push("", `来源:${source}`);
  return out;
}

/** 食谱换算后的用量取整到厨房里好量的精度:≥100 取 5 的倍数,≥10 取整,其余一位小数。 */
export function kitchenRound(v: number): number {
  if (v >= 100) return Math.round(v / 5) * 5;
  if (v >= 10) return Math.round(v);
  return Math.round(v * 10) / 10;
}

export function calculatorSnapshot(spec: CalculatorSpec, values?: Record<string, number>) {
  const env: Record<string, number> = {};
  for (const i of spec.inputs) env[i.id] = values?.[i.id] ?? i.value;
  const results = computeOutputs(env, spec.outputs);
  return { env, results };
}

export function specToMarkdown(spec: IuiSpec, values?: Record<string, number>): string {
  switch (spec.type) {
    case "table": {
      const header = spec.columns.map((c) => (c.unit ? `${c.label}(${c.unit})` : c.label));
      return [
        ...heading(spec.title, spec.subtitle),
        mdTable(header, spec.rows.map((r) => r.map(cellText)), spec.columns.map((c) => c.align)),
        ...sourceLines(spec.source, spec.note),
      ].join("\n");
    }
    case "chart": {
      const header = [spec.xLabel ?? "", ...spec.series.map((s) => (spec.unit ? `${s.name}(${spec.unit})` : s.name))];
      const rows = spec.labels.map((l, i) => [l, ...spec.series.map((s) => (s.values[i] == null ? "" : formatNumber(s.values[i]!)))]);
      const kindName = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图" }[spec.kind];
      return [
        ...heading(spec.title ? `${spec.title}(${kindName}数据)` : `${kindName}数据`),
        mdTable(header, rows, header.map((_, i) => (i === 0 ? "left" : "right"))),
        ...sourceLines(spec.source, spec.note),
      ].join("\n");
    }
    case "stats":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.map((it) => {
          const v = withUnit(typeof it.value === "number" ? formatNumber(it.value) : it.value, it.unit);
          const delta = it.delta ? `(${it.delta})` : "";
          const basis = it.basis ? ` —— ${it.basis}` : "";
          return `- **${it.label}**:${v}${delta}${basis}`;
        }),
        ...sourceLines(spec.source),
      ].join("\n");
    case "steps":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.map((it, i) => {
          const mark = spec.checkable ? `- [${it.done ? "x" : " "}] ` : `${i + 1}. `;
          return `${mark}${it.title}${it.detail ? `\n   ${it.detail.replace(/\n/g, "\n   ")}` : ""}`;
        }),
      ].join("\n");
    case "compare":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.flatMap((it) => [
          `### ${it.name}${it.tag ? `(${it.tag})` : ""}${it.recommended ? " · 推荐" : ""}`,
          ...(it.price ? [`**${it.price}**`] : []),
          ...(it.summary ? [it.summary] : []),
          ...it.points.map((p) => `- ${p}`),
          ...it.pros.map((p) => `- 优点:${p}`),
          ...it.cons.map((p) => `- 缺点:${p}`),
          "",
        ]),
        ...(spec.verdict ? [`**结论**:${spec.verdict}`] : []),
      ]
        .join("\n")
        .trim();
    case "choice":
      return [
        ...(spec.question ? [spec.question, ""] : []),
        ...spec.options.map((o, i) => `${i + 1}. ${o.label}${o.desc ? ` —— ${o.desc}` : ""}`),
      ].join("\n");
    case "calculator": {
      const { env, results } = calculatorSnapshot(spec, values);
      const inputs = spec.inputs.map((i) => {
        const v = env[i.id]!;
        const shown =
          i.kind === "select"
            ? (i.options.find((o) => o.value === v)?.label ?? formatNumber(v))
            : i.kind === "toggle"
              ? v
                ? "是"
                : "否"
              : withUnit(formatNumber(v), i.unit);
        return `- ${i.label}:${shown}`;
      });
      const outputs = spec.outputs.map((o) => {
        const r = results[o.id];
        const shown = r?.value == null ? `无法计算(${r?.error ?? "未知错误"})` : withUnit(formatNumber(r.value, o.format, o.decimals), o.unit);
        return `- **${o.label}** = \`${o.formula}\` = ${shown}`;
      });
      const sweep = spec.chart ? calcSweepNote(spec, env) : [];
      return [
        ...heading(spec.title, spec.subtitle),
        "输入:",
        ...inputs,
        "",
        "结果:",
        ...outputs,
        ...sweep,
        ...(spec.assumptions.length ? ["", "假设:", ...spec.assumptions.map((a) => `- ${a}`)] : []),
        ...(spec.note ? ["", `> ${spec.note}`] : []),
      ].join("\n");
    }
    case "callout": {
      const label = { info: "说明", tip: "提示", warning: "注意", danger: "警告", success: "完成" }[spec.tone];
      const head = `**${spec.title ?? label}**`;
      return [`> ${head}`, ...spec.body.split("\n").map((l) => `> ${l}`)].join("\n");
    }
    case "tabs":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.tabs.flatMap((t) => [`### ${t.label}`, ...(t.body ? [t.body] : []), ...(t.block ? ["", specToMarkdown(t.block)] : []), ""]),
      ]
        .join("\n")
        .trim();
    case "timeline":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.map((it) => `- ${it.time ? `**${it.time}** ` : ""}${it.title}${it.detail ? ` —— ${it.detail}` : ""}`),
      ].join("\n");
    case "suggestions":
      return ["你可以接着问:", ...spec.items.map((s) => `- ${s}`)].join("\n");
    case "cards":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.map((it) => {
          const name = it.url ? `[${it.title}](${it.url})` : it.title;
          const extra = [it.subtitle, it.meta, it.tags.length ? it.tags.join(" · ") : undefined].filter(Boolean).join(" · ");
          return `- **${name}**${extra ? `(${extra})` : ""}${it.body ? `:${it.body}` : ""}`;
        }),
      ].join("\n");
    case "gallery":
      // 图片不在 Markdown 里内联(与正文规则一致),列出地址和说明。
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.images.map((im, i) => `- 图片 ${i + 1}${im.caption ? `:${im.caption}` : ""}(${im.src})`),
        ...(spec.caption ? ["", spec.caption] : []),
      ].join("\n");
    case "swatches":
      return [...heading(spec.title, spec.subtitle), ...spec.colors.map((c) => `- ${c.name ? `${c.name} ` : ""}\`${c.hex}\``)].join("\n");
    case "tiles":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.map((t) => `- **${t.title}**${t.subtitle ? `:${t.subtitle}` : ""}`),
        ...(spec.caption ? ["", `> ${spec.caption}`] : []),
      ].join("\n");
    case "recipe": {
      const servings = values?.servings ?? spec.servings;
      const scale = servings / (spec.servings || 1);
      return [
        ...heading(spec.title, spec.subtitle),
        `份量:${formatNumber(servings)} ${spec.unit}`,
        ...(spec.meta.length ? [spec.meta.map((m) => `${m.label} ${m.value}`).join(" · ")] : []),
        "",
        "用料:",
        ...spec.ingredients.map(
          (g) =>
            `- ${g.name}:${g.amount === undefined ? "适量" : `${formatNumber(kitchenRound(g.amount * scale))}${g.unit ? ` ${g.unit}` : ""}`}${g.note ? `(${g.note})` : ""}`,
        ),
        ...(spec.steps.length ? ["", "做法:", ...spec.steps.map((st, i) => `${i + 1}. ${st}`)] : []),
      ].join("\n");
    }
    case "quiz":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.questions.flatMap((q, i) => [
          `${i + 1}. ${q.question}`,
          ...q.options.map((o, j) => `   ${String.fromCharCode(65 + j)}. ${o}`),
          `   答案:${String.fromCharCode(65 + q.answer)}${q.explain ? `。${q.explain}` : ""}`,
          "",
        ]),
      ]
        .join("\n")
        .trim();
    case "progress":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.items.map((it) => {
          const pct = it.max > 0 ? ` (${formatNumber((it.value / it.max) * 100, "number", 0)}%)` : "";
          return `- **${it.label}**:${withUnit(formatNumber(it.value), it.unit)} / ${withUnit(formatNumber(it.max), it.unit)}${pct}${it.note ? ` —— ${it.note}` : ""}`;
        }),
        ...sourceLines(spec.source),
      ].join("\n");
    case "kv":
      return [...heading(spec.title, spec.subtitle), mdTable(["项目", "内容"], spec.items.map((it) => [it.label, it.value])), ...sourceLines(spec.source)].join("\n");
    case "form":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.fields.map((f) => `- ${f.label}${f.required ? "(必填)" : ""}:${f.options.length ? f.options.join(" / ") : (f.placeholder ?? "____")}`),
      ].join("\n");
    case "route":
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.stops.flatMap((st, i) => {
          const leg = spec.legs[i];
          const legText = i < spec.stops.length - 1 && leg && (leg.distance || leg.duration) ? [`   ↓ ${[leg.mode, leg.distance, leg.duration].filter(Boolean).join(" · ")}`] : [];
          return [`${i + 1}. **${st.name}**${st.note ? `(${st.note})` : ""}${st.detail ? ` —— ${st.detail}` : ""}`, ...legText];
        }),
      ].join("\n");
    case "sources":
      return [
        ...heading(spec.title ?? "来源", spec.subtitle),
        ...spec.items.map((s, i) => {
          const name = s.url ? `[${s.title}](${s.url})` : s.title;
          const meta = [s.site !== s.title ? s.site : undefined, s.date].filter(Boolean).join(" · ");
          return `${i + 1}. ${name}${meta ? `(${meta})` : ""}${s.note ? ` —— ${s.note}` : ""}`;
        }),
      ].join("\n");
    case "outline":
      return [...heading(spec.title, spec.subtitle), ...outlineLines(spec.items, 0)].join("\n");
    case "draft": {
      const many = spec.variants.length > 1;
      return [
        ...heading(spec.title, spec.subtitle),
        ...spec.variants.flatMap((v) => [...(many ? [`### ${v.label}`] : []), ...(v.subject ? [`**主题**:${v.subject}`, ""] : []), v.text, ""]),
        ...(spec.original ? ["原文:", "", ...spec.original.split("\n").map((l) => `> ${l}`), ""] : []),
        ...(spec.note ? [`> ${spec.note}`] : []),
      ]
        .join("\n")
        .trim();
    }
  }
}

function outlineLines(nodes: OutlineNode[], depth: number): string[] {
  return nodes.flatMap((n) => [`${"  ".repeat(depth)}- ${depth === 0 ? `**${n.title}**` : n.title}${n.detail ? ` —— ${n.detail}` : ""}`, ...outlineLines(n.children, depth + 1)]);
}

/** 计算器曲线在 Markdown 里的样子:按当前输入算首尾两个点的数值(完整曲线只在界面里看)。 */
function calcSweepNote(spec: CalculatorSpec, env: Record<string, number>): string[] {
  const c = spec.chart!;
  const to = typeof c.to === "string" ? env[c.to] : c.to;
  if (to === undefined) return [];
  const at = (x: number) => computeOutputs({ ...env, [c.x]: x }, spec.outputs);
  const a = at(c.from);
  const b = at(to);
  const label = spec.inputs.find((i) => i.id === c.x)?.label ?? c.x;
  return [
    "",
    `曲线(${label} 从 ${formatNumber(c.from)} 到 ${formatNumber(to)}):`,
    ...c.series.map((id) => {
      const o = spec.outputs.find((x) => x.id === id);
      const f = (v: number | null | undefined) => (v == null ? "—" : withUnit(formatNumber(v, o?.format, o?.decimals), o?.unit));
      return `- ${o?.label ?? id}:${f(a[id]?.value)} → ${f(b[id]?.value)}`;
    }),
  ];
}

/** 解析不了的块:原样作为 JSON 代码块保留(复制/导出不丢信息)。 */
function rawFence(code: string): string {
  return `\`\`\`json\n${code.replace(/\n$/, "")}\n\`\`\``;
}

/** 单个 ui 块源码 → Markdown;`partial` = 未闭合的流式块。 */
export function uiCodeToMarkdown(code: string, partial = false): string {
  // 复制 / 导出 / 关闭开关都走这里:任何意外都退回原文,绝不让整条消息渲染失败。
  try {
    const parsed = parseUiBlock(code, partial);
    if (!parsed.ok) return partial ? "" : rawFence(code);
    const v = validateSpec(parsed.value, !parsed.complete);
    if (!v.ok) return partial ? "" : rawFence(code);
    return specToMarkdown(v.spec);
  } catch {
    return partial ? "" : rawFence(code);
  }
}

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n`]*$/;

/**
 * 整段 Markdown 里的 ```ui 围栏全部换成等价 Markdown;其它围栏(含其中的 ```ui 字样)不动。
 * `streaming` = 最后一个未闭合的 ui 围栏按半截处理(能转多少转多少);否则未闭合的也按完整处理。
 */
export function uiFencesToMarkdown(text: string, streaming = false): string {
  if (!text.includes("```ui") && !text.includes("~~~ui")) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = FENCE_OPEN.exec(lines[i]!);
    if (!m) {
      out.push(lines[i]!);
      i += 1;
      continue;
    }
    const fence = m[2]!;
    const lang = m[3]!.toLowerCase();
    const closeRe = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`);
    let j = i + 1;
    while (j < lines.length && !closeRe.test(lines[j]!)) j += 1;
    const closed = j < lines.length;
    if (lang !== "ui") {
      // 非 ui 围栏整段原样保留(里面即使出现 ```ui 也不是真的组件)。
      out.push(...lines.slice(i, closed ? j + 1 : lines.length));
      i = closed ? j + 1 : lines.length;
      continue;
    }
    const body = lines.slice(i + 1, j).join("\n");
    out.push(uiCodeToMarkdown(body, !closed && streaming));
    i = closed ? j + 1 : lines.length;
  }
  return out.join("\n");
}
