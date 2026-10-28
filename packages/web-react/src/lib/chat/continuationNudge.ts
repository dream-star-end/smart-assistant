/**
 * 「继续」类消息判定(B4-SPEC §3.5,UXE-B4a)。
 *
 * 本轮还在跑时,再发一条「继续 / 在吗 / ？」不会让它更快:前端单槽 FIFO 和容器 session.lock
 * 会把它排在本轮之后,作为一整轮新回合执行、重新读上下文、单独计费。这里只做判定,
 * 弹不弹确认、弹什么由调用方决定;带具体指令的消息(「继续优化第三段」)一律不算。
 */

/** 原文(trim 后)超过这个长度就不当催促看,哪怕归一化后命中词表。 */
export const NUDGE_MAX_CHARS = 20;

const NUDGE_WORDS: ReadonlySet<string> = new Set([
  "继续", "请继续", "继续吧", "继续啊", "继续呀", "接着", "接着来", "接着做", "接着写", "接着说",
  "往下", "往下写", "然后呢", "下一步",
  "go", "goon", "continue", "keepgoing", "next",
  "在吗", "还在吗", "在不在", "好了吗", "好了没", "完成了吗", "做完了吗", "怎么样了",
  "进度呢", "进度如何", "有结果吗",
  "卡住了", "卡住了吗", "卡了吗", "动了吗", "还在跑吗", "人呢", "hello", "hi", "ping", "1",
]);

/** 纯标点催促:「？」「……」「!!」「~」。 */
const PUNCT_ONLY = /^[?？.。…!！~～\s]+$/u;

/** 归一化:NFKC + 小写,去掉标点、符号和空白,只留可比较的字。 */
export function normalizeNudgeText(text: string): string {
  return text.trim().normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\p{Z}\s]/gu, "");
}

export function isContinuationNudge(text: string): boolean {
  const raw = text.trim();
  if (raw.length === 0 || raw.length > NUDGE_MAX_CHARS) return false;
  const n = normalizeNudgeText(raw);
  if (n === "") return PUNCT_ONLY.test(raw);
  return NUDGE_WORDS.has(n);
}

/** 与正在运行的那条用户消息归一化后相同。 */
export function isDuplicateOfRunning(text: string, runningText: string | undefined): boolean {
  if (runningText === undefined) return false;
  const n = normalizeNudgeText(text);
  return n !== "" && n === normalizeNudgeText(runningText);
}

export type BackgroundSendKind = "nudge" | "duplicate";

/** 本轮在跑时这条消息该不该软确认;带附件的不确认。 */
export function classifyBackgroundSend(input: {
  text: string;
  hasMedia: boolean;
  runningText?: string;
}): BackgroundSendKind | null {
  if (input.hasMedia) return null;
  if (isContinuationNudge(input.text)) return "nudge";
  if (isDuplicateOfRunning(input.text, input.runningText)) return "duplicate";
  return null;
}
