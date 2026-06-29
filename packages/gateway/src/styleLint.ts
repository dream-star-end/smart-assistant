/**
 * 去 AI 味 style lint(方案 §6 第 4 条用户反馈)— **软信号,非硬 gate**。
 *
 * v3 用户高频反馈"文字 AI 味"。检测器误伤高,故只做 soft lint:列出可疑处供 reviewer/
 * 作者自查,**不阻断**产出(不当 gate 拒答)。纯逻辑、确定性、可单测。
 *
 * 覆盖常见中文 AI 腔:套话开场/收尾、空泛强调词堆叠、千篇一律的"首先/其次/最后"结构、
 * emoji 滥用。命中即给可读 hint。
 */

export type AiToneKind = "cliche" | "filler-emphasis" | "formulaic" | "emoji";

export interface StyleFinding {
  kind: AiToneKind;
  /** 命中的样本片段。 */
  sample: string;
  hint: string;
}

export interface StyleLintResult {
  findings: StyleFinding[];
  /** 0~1,越高越像 AI 腔(soft 指标,仅供参考)。 */
  score: number;
}

// 套话/陈词(开场、收尾、过渡)
const CLICHE = [
  "在当今",
  "随着科技的不断发展",
  "随着社会的不断发展",
  "随着.{0,6}的不断发展",
  "综上所述",
  "总而言之",
  "众所周知",
  "值得注意的是",
  "值得一提的是",
  "不可否认",
  "本文将(深入)?探讨",
  "本文旨在",
  "在.{0,8}的背景下",
  "首先.{0,40}其次.{0,40}(最后|再次)",
];

// 空泛强调词(堆叠时尤甚)
const FILLER = ["至关重要", "不可或缺", "极其重要", "举足轻重", "意义重大", "息息相关", "日新月异", "层出不穷"];

// 千篇一律的分点结构标志(单段内多个)
const FORMULAIC_MARK = /(^|[。;\n])\s*(首先|其次|再次|最后|第一|第二|第三)[,，、]/g;

// emoji 粗匹配(BMP 外的 emoji 平面 + 常见符号区)
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/gu;

function firstMatch(text: string, pattern: string): string | null {
  const re = new RegExp(pattern);
  const m = re.exec(text);
  return m ? m[0] : null;
}

export function lintAiTone(text: string): StyleLintResult {
  const findings: StyleFinding[] = [];
  if (!text || !text.trim()) return { findings, score: 0 };

  for (const c of CLICHE) {
    const hit = firstMatch(text, c);
    if (hit) findings.push({ kind: "cliche", sample: hit, hint: "套话/陈词,删或改成具体内容" });
  }

  const fillerHits = FILLER.filter((f) => text.includes(f));
  if (fillerHits.length >= 2) {
    findings.push({
      kind: "filler-emphasis",
      sample: fillerHits.slice(0, 3).join("、"),
      hint: "空泛强调词堆叠,用具体数字/机制代替",
    });
  }

  const formulaic = text.match(FORMULAIC_MARK);
  if (formulaic && formulaic.length >= 3) {
    findings.push({
      kind: "formulaic",
      sample: formulaic.slice(0, 3).map((s) => s.trim()).join(" "),
      hint: "千篇一律的分点结构,句式可多变化",
    });
  }

  const emojis = text.match(EMOJI_RE);
  if (emojis && emojis.length >= 3) {
    findings.push({ kind: "emoji", sample: emojis.slice(0, 5).join(""), hint: "学术语体不宜滥用 emoji" });
  }

  // soft score:命中类别数 / 4(四类),封顶 1
  const kinds = new Set(findings.map((f) => f.kind));
  return { findings, score: Math.min(1, kinds.size / 4) };
}
