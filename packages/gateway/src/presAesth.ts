/**
 * PresAesth 美学闸(方案 §12 P3)— 演示产物的**确定性启发式**检查,**软信号非硬 gate**。
 *
 * 针对 v3 用户"图片 AI 味 / PPT 单调"反馈,对 slides / 图表做可读性 + 反 AI 味检查:
 * 每页要点过多/过长、缺标题、图疑似生成式插画。命中给 hint,**不阻断**产出。纯逻辑可测。
 */

import type { Figure, SlideDeck } from "@openclaude/protocol/research";

export type AesthKind = "dense-bullets" | "long-bullet" | "no-heading" | "generated-illustration" | "no-figure";

export interface AesthFinding {
  kind: AesthKind;
  where: string;
  hint: string;
}

export interface AesthResult {
  findings: AesthFinding[];
  /** 0~1 软指标(命中类别数 / 类别总数)。 */
  score: number;
}

const MAX_BULLETS = 6;
const MAX_BULLET_CHARS = 120;

/** 路径疑似生成式插画(禁):AI 出图工具/标记。 */
const GENERATED_RE = /(midjourney|dall[-_ ]?e|stable[-_ ]?diffusion|sdxl|gen(erated)?[-_]?(img|image|illustration)|ai[-_]?art)/i;

function isGenerated(path: string): boolean {
  return GENERATED_RE.test(path);
}

/** SlideDeck 美学检查。 */
export function presAesthSlides(deck: SlideDeck): AesthResult {
  const findings: AesthFinding[] = [];
  deck.slides.forEach((s, i) => {
    const where = `slide ${i + 1}「${s.heading.slice(0, 16)}」`;
    if (!s.heading.trim()) findings.push({ kind: "no-heading", where: `slide ${i + 1}`, hint: "每页应有标题" });
    if (s.bullets.length > MAX_BULLETS) {
      findings.push({ kind: "dense-bullets", where, hint: `要点 ${s.bullets.length} 条偏多(建议 ≤${MAX_BULLETS}),拆页或精简` });
    }
    for (const b of s.bullets) {
      if (b.length > MAX_BULLET_CHARS) {
        findings.push({ kind: "long-bullet", where, hint: "单条要点过长,精简成短句(细节放讲稿/报告)" });
        break;
      }
    }
    if (s.figure && isGenerated(s.figure)) {
      findings.push({ kind: "generated-illustration", where, hint: "疑似生成式插画,改用 SciencePlots/Mermaid 确定性出图" });
    }
  });
  return { findings, score: scoreOf(findings) };
}

/** 报告/海报图表美学检查(禁生成式插画;图应有 caption)。 */
export function presAesthFigures(figures: Figure[]): AesthResult {
  const findings: AesthFinding[] = [];
  for (const f of figures) {
    if (isGenerated(f.path)) {
      findings.push({ kind: "generated-illustration", where: `figure ${f.id}`, hint: "疑似生成式插画,改用 SciencePlots/Mermaid" });
    }
    if (!f.caption.trim()) {
      findings.push({ kind: "no-figure", where: `figure ${f.id}`, hint: "图应有 caption" });
    }
  }
  return { findings, score: scoreOf(findings) };
}

function scoreOf(findings: AesthFinding[]): number {
  const kinds = new Set(findings.map((f) => f.kind));
  return Math.min(1, kinds.size / 5);
}
