/**
 * 给未分类会话推荐一个项目（P5，开关 OC_P5_UNFILED_SUGGEST，默认关）。
 *
 * 只看标题（= 首条消息前 50 字）：与已在各项目里的会话标题做字符二元组 TF-IDF
 * 余弦，取最像的那个会话所在的项目。只有最高分够高、且明显高于第二个项目时才推荐，
 * 其余情况不推荐。推荐只是一个提示，永远不会自动移动会话。
 *
 * 阈值来自对真实数据的离线留一评估（evidence/p5d-eval.log）：这一档在已归档
 * 会话上精度约 0.75、覆盖约 5%，达不到启用标准，所以开关默认关。
 */
import type { ChatProject, Session } from "./types";

export const UNFILED_SUGGEST_MIN_SCORE = 0.8;
export const UNFILED_SUGGEST_MIN_MARGIN = 1.5;

export function titleGrams(text: string | null | undefined): string[] {
  const t = (text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const out: string[] = [];
  for (const w of t.split(" ")) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length > 1) out.push(w);
      continue;
    }
    const chars = Array.from(w);
    if (chars.length === 1) out.push(w);
    for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  }
  return out;
}

type Vec = { weights: Map<string, number>; norm: number };

export type UnfiledSuggestion = { projectId: string; score: number };

/**
 * 为 target 推荐项目；没有足够把握时返回 null。sessions 是已加载的会话（含已在项目里的），
 * projects 只算未归档的。
 */
export function suggestProjectForChat(
  target: Pick<Session, "id" | "title" | "projectId">,
  sessions: readonly Pick<Session, "id" | "title" | "projectId">[],
  projects: readonly Pick<ChatProject, "id" | "archivedAt">[],
): UnfiledSuggestion | null {
  if (target.projectId) return null;
  const live = new Set(projects.filter((p) => !p.archivedAt).map((p) => p.id));
  const filed = sessions.filter((s) => s.id !== target.id && s.projectId && live.has(s.projectId));
  if (filed.length === 0) return null;
  const docs = [target, ...filed].map((s) => titleGrams(s.title));
  const df = new Map<string, number>();
  for (const d of docs) for (const g of new Set(d)) df.set(g, (df.get(g) ?? 0) + 1);
  const n = docs.length;
  const vec = (grams: string[]): Vec => {
    const tf = new Map<string, number>();
    for (const g of grams) tf.set(g, (tf.get(g) ?? 0) + 1);
    const weights = new Map<string, number>();
    let sq = 0;
    for (const [g, c] of tf) {
      const w = c * (Math.log((n + 1) / ((df.get(g) ?? 0) + 1)) + 1);
      weights.set(g, w);
      sq += w * w;
    }
    return { weights, norm: Math.sqrt(sq) };
  };
  const q = vec(docs[0]);
  if (!q.norm) return null;
  const best = new Map<string, number>();
  filed.forEach((s, i) => {
    const v = vec(docs[i + 1]);
    if (!v.norm) return;
    let dot = 0;
    for (const [g, w] of q.weights) {
      const o = v.weights.get(g);
      if (o) dot += w * o;
    }
    const score = dot / (q.norm * v.norm);
    const pid = s.projectId as string;
    if (score > (best.get(pid) ?? 0)) best.set(pid, score);
  });
  const ranked = [...best.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length === 0) return null;
  const [top, second] = ranked;
  if (top[1] < UNFILED_SUGGEST_MIN_SCORE) return null;
  if (second && top[1] < UNFILED_SUGGEST_MIN_MARGIN * second[1]) return null;
  return { projectId: top[0], score: top[1] };
}

const DISMISS_KEY = (userId: string) => `oc_unfiled_suggest_dismissed:${userId}`;
const DISMISS_MAX = 500;

export function readDismissedSuggestions(userId: string): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISS_KEY(userId));
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** 「不用」之后这条会话不再推荐（按账号记在本机）。 */
export function dismissSuggestion(userId: string, sessionId: string): void {
  try {
    const list = [...readDismissedSuggestions(userId), sessionId].slice(-DISMISS_MAX);
    localStorage.setItem(DISMISS_KEY(userId), JSON.stringify(list));
  } catch {
    /* storage unavailable: the chip simply comes back next time */
  }
}
