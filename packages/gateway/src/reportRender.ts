/**
 * 确定性报告文档构建(oc-report 用)。
 *
 * 方案原则:章节/编号/交叉引用/参考文献由**引擎**保证,LLM 不碰排版。输入 ReportSchema
 * (LLM 产的结构)+ master 已检 EvidenceManifest(canonical quote + master 铸造 status),
 * 输出 Quarto/pandoc 兼容 markdown:
 *   - 正文 [[claim:<id>]] 占位 → 按引用顺序编号 [N];verified claim 用其支撑文献编号;
 *     **unsupported/unchecked claim 红标(不给假编号)** —— fail-closed 渲染。
 *   - 参考文献按引用顺序编号,GB/T7714/APA/BibTeX 由 protocol 单一格式化器渲染。
 *   - 图表只 embed 路径(SciencePlots 出图,禁生成式插画,见 scientific-figures skill)。
 *
 * 纯函数,无 I/O,便于单测;oc-report CLI 负责写文件 + 调 quarto/pandoc。
 */

import { type EvidenceManifest, type ReportSchema, formatCitation } from "@openclaude/protocol/research";
import { lintAiTone } from "./styleLint.js";
import { presAesthFigures } from "./presAesth.js";

export interface BuildReportResult {
  markdown: string;
  /** 参考文献(按引用顺序,已编号 + 格式化)。 */
  references: string[];
  warnings: string[];
  stats: { sections: number; citations: number; redFlags: number; figures: number };
}

const CLAIM_MARK_RE = /\[\[claim:([^\]]+)\]\]/g;

/**
 * 入口校验:schema/manifest 来自 JSON 文件,TS 类型只是名义的,运行时可能缺字段。缺字段时
 * 抛**可操作的清晰错误**(而非到下游 `.map` 才崩出裸 TypeError 栈——boss #faa3c041 见 oc-report
 * 崩 3 次的根因)。manifest 必须是 oc-cite check/fix 的输出(含 coverage)。
 */
function validateReportInputs(schema: ReportSchema, manifest: EvidenceManifest): void {
  const m = (manifest ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  if (!Array.isArray(m.sources)) missing.push("sources[]");
  if (!Array.isArray(m.quotes)) missing.push("quotes[]");
  if (!Array.isArray(m.claims)) missing.push("claims[]");
  const cov = m.coverage as Record<string, unknown> | undefined;
  if (!cov || typeof cov.verifiedClaims !== "number" || typeof cov.totalClaims !== "number") {
    missing.push("coverage{verifiedClaims,totalClaims}");
  }
  if (missing.length > 0) {
    throw new Error(
      `manifest 缺少字段: ${missing.join(", ")}。oc-report 的 manifest 必须是 oc-cite check 或 oc-cite fix 的输出(直接传它的输出即可,会自动取 .manifest);不要手写 manifest 或传 schema。`,
    );
  }
  const s = (schema ?? {}) as Record<string, unknown>;
  if (!Array.isArray(s.sections)) {
    throw new Error("schema 缺少 sections[]。oc-report 的 --schema 是 LLM 产出的 ReportSchema(title/abstract/sections[]),勿与 manifest 弄混。");
  }
}

export function buildReportDocument(schema: ReportSchema, manifest: EvidenceManifest): BuildReportResult {
  validateReportInputs(schema, manifest);
  // figures 可选:缺失/非数组时按"无图"处理,不让无图报告崩(图非报告必需)。
  const figures = Array.isArray(schema.figures) ? schema.figures : [];
  const warnings: string[] = [];
  const claimById = new Map(manifest.claims.map((c) => [c.id, c]));
  const quoteSourceId = new Map(manifest.quotes.map((q) => [q.id, q.sourceId]));
  const sourceById = new Map(manifest.sources.map((s) => [s.id, s]));

  // 引用顺序编号:sourceId → [N]
  const refOrder: string[] = [];
  const refNum = new Map<string, number>();
  const numberFor = (sourceId: string): number => {
    const existing = refNum.get(sourceId);
    if (existing) return existing;
    refOrder.push(sourceId);
    const n = refOrder.length;
    refNum.set(sourceId, n);
    return n;
  };

  let redFlags = 0;
  let citations = 0;

  /** 解析单个 [[claim:id]] 占位 → 编号角标 / 红标。 */
  const resolveClaim = (claimId: string): string => {
    const claim = claimById.get(claimId);
    if (!claim) {
      redFlags++;
      warnings.push(`claim ${claimId} 不在 manifest 中`);
      return "**[未核查:claim 缺失]**";
    }
    if (claim.status !== "verified") {
      redFlags++;
      warnings.push(`claim ${claimId} 状态=${claim.status},正文以红标呈现(未给引用编号)`);
      return claim.status === "unsupported" ? "**[未核查:无可信引用]**" : "**[未核查]**";
    }
    // verified:取支撑 quote 的来源编号(去重,保序)
    const nums: number[] = [];
    for (const ref of claim.supports) {
      const sid = quoteSourceId.get(ref.quoteId);
      if (sid && sourceById.has(sid)) {
        const n = numberFor(sid);
        if (!nums.includes(n)) nums.push(n);
      }
    }
    if (nums.length === 0) {
      redFlags++;
      return "**[未核查]**";
    }
    citations++;
    return `[${nums.sort((a, b) => a - b).join(",")}]`;
  };

  // ── 组装正文 ────────────────────────────────────────────────────
  const lines: string[] = [];
  // Quarto YAML frontmatter
  lines.push("---");
  lines.push(`title: "${escapeYaml(schema.title)}"`);
  lines.push("lang: zh");
  lines.push("number-sections: true");
  lines.push("---");
  lines.push("");
  if (schema.abstract?.trim()) {
    lines.push("## 摘要");
    lines.push("");
    lines.push(resolveBody(schema.abstract, resolveClaim));
    lines.push("");
  }

  for (const section of schema.sections) {
    const level = Math.min(Math.max(section.level, 1), 6);
    lines.push(`${"#".repeat(level)} ${section.heading}`);
    lines.push("");
    lines.push(resolveBody(section.bodyMd, resolveClaim));
    lines.push("");
  }

  // ── 图表(只 embed 路径;禁生成式插画由 skill 约束) ─────────────────
  for (const fig of figures) {
    lines.push(`![${escapeMd(fig.caption)}](${fig.path}){#fig-${fig.id}}`);
    lines.push("");
  }

  // ── 参考文献(按引用顺序编号 + 格式化) ────────────────────────────
  const references: string[] = [];
  if (refOrder.length > 0) {
    lines.push("## 参考文献");
    lines.push("");
    refOrder.forEach((sid, i) => {
      const src = sourceById.get(sid);
      const formatted = src ? formatCitation(src, schema.csl) : `(来源 ${sid} 缺失)`;
      const line = `${i + 1}. ${formatted}`;
      references.push(line);
      lines.push(line);
    });
    lines.push("");
  }

  // 覆盖率提示(诚实呈现接地比例)
  const { verifiedClaims, totalClaims } = manifest.coverage;
  if (totalClaims > 0 && verifiedClaims < totalClaims) {
    warnings.push(`接地覆盖率 ${verifiedClaims}/${totalClaims};${totalClaims - verifiedClaims} 条论断未核查(已红标)`);
  }

  // 去 AI 味 style lint(软信号,非硬 gate)— 对正文(摘要+各章节)跑
  const bodyText = [schema.abstract ?? "", ...schema.sections.map((s) => s.bodyMd)].join("\n");
  const style = lintAiTone(bodyText);
  for (const f of style.findings) {
    warnings.push(`去AI味[${f.kind}]: "${f.sample.slice(0, 30)}" — ${f.hint}`);
  }
  // PresAesth 图表美学(软信号:禁生成式插画、图须有 caption)
  for (const f of presAesthFigures(figures).findings) {
    warnings.push(`美学[${f.kind}] ${f.where}: ${f.hint}`);
  }

  return {
    markdown: lines.join("\n"),
    references,
    warnings,
    stats: { sections: schema.sections.length, citations, redFlags, figures: figures.length },
  };
}

function resolveBody(body: string, resolveClaim: (id: string) => string): string {
  return body.replace(CLAIM_MARK_RE, (_m, id: string) => resolveClaim(id.trim()));
}

function escapeYaml(s: string): string {
  // 折叠换行/控制字符为空格(防破坏 frontmatter),再转义引号
  // biome-ignore lint/suspicious/noControlCharactersInRegex: collapse control chars to keep YAML valid
  return s.replace(/[\r\n\t\x00-\x1F]+/g, " ").replace(/"/g, '\\"').trim();
}

function escapeMd(s: string): string {
  return s.replace(/([[\]])/g, "\\$1");
}

/** 仅供测试/校验:列出 schema 引用了但 manifest 缺失的 claim。 */
export function missingClaimRefs(schema: ReportSchema, manifest: EvidenceManifest): string[] {
  const have = new Set(manifest.claims.map((c) => c.id));
  const missing = new Set<string>();
  for (const sec of schema.sections) {
    for (const m of sec.bodyMd.matchAll(CLAIM_MARK_RE)) {
      const id = m[1].trim();
      if (!have.has(id)) missing.add(id);
    }
  }
  return [...missing];
}
