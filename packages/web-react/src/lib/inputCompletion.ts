/**
 * 输入预测(OCV5-375)里输入框要用的部分:预测的类型和输入中补全。在首屏包里(Composer),
 * 所以只放这几行;从回答里读预测的解析器在 ./inputPrediction,由 App 按需加载。
 */

export type InputPredictionSource = "agent" | "suggestion";

export type InputPrediction = {
  /** 输入框为空时显示的整句预测;没有时为 null。 */
  next: { text: string; source: InputPredictionSource } | null;
  /** 输入中补全的候选,优先级从高到低。 */
  candidates: readonly string[];
};

/** 补全最少要先输入几个字(CJK 一个字信息量大,拉丁字母要多几个)。 */
const MIN_CJK_PREFIX = 2;
const MIN_LATIN_PREFIX = 3;

/**
 * 正文是某个候选的开头 → 返回候选剩下的部分(从正文末尾接着显示);否则 null。
 * 只补单行;拉丁字母不区分大小写,采用时保留用户已输入的大小写。
 */
export function completionFor(value: string, candidates: readonly string[]): string | null {
  if (!value || value.includes("\n")) return null;
  const typed = value.trim();
  const cjk = /[㐀-鿿豈-﫿]/.test(typed);
  if (typed.length < (cjk ? MIN_CJK_PREFIX : MIN_LATIN_PREFIX)) return null;
  const lower = value.toLowerCase();
  for (const c of candidates) {
    if (c.length > value.length && c.toLowerCase().startsWith(lower)) return c.slice(value.length);
  }
  return null;
}
