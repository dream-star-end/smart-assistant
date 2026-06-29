/**
 * 确定性排名(方案 §12/§15:Google AI co-scientist tournament debate)。
 *
 * "编排走 CC 原生":leader 用 delegate 生成 N 个候选方案 + 跑两两评审(pairwise judge),
 * 把**评审结果**喂给本模块算 Elo 排名 —— **排名是确定性的**,不让 LLM 心算 Elo(必错)。
 * 同样可用于 agentic tree-search 的变体打分/best-first 选择。纯函数,可单测。
 */

export interface Match {
  /** 候选 a / b 的 id。 */
  a: string;
  b: string;
  /** 胜者:'a' | 'b' | 'draw'。 */
  winner: "a" | "b" | "draw";
}

export interface EloRank {
  id: string;
  rating: number;
  wins: number;
  losses: number;
  draws: number;
}

export interface EloOptions {
  /** K 因子(默认 32)。 */
  k?: number;
  /** 初始分(默认 1500)。 */
  initial?: number;
}

/**
 * 由 pairwise 评审结果算 Elo 排名(**单遍**)。items 是全部候选 id(确保未参赛者也列出);
 * 非法 match(引用未知 id 或自比)忽略。返回按 rating 降序。
 *
 * 注:不做"重放同批 match 多遍"——那会因 Elo 非线性放大并可能反转明确胜负关系。
 * 排名稳定性靠**更多 pairwise 判断**(更多 match),而非重放。
 */
export function computeElo(items: string[], matches: Match[], opts: EloOptions = {}): EloRank[] {
  const k = opts.k ?? 32;
  const initial = opts.initial ?? 1500;

  const ids = [...new Set(items)];
  const idSet = new Set(ids);
  const rating = new Map<string, number>(ids.map((id) => [id, initial]));
  const wins = new Map<string, number>(ids.map((id) => [id, 0]));
  const losses = new Map<string, number>(ids.map((id) => [id, 0]));
  const draws = new Map<string, number>(ids.map((id) => [id, 0]));

  const valid = matches.filter((m) => m.a !== m.b && idSet.has(m.a) && idSet.has(m.b));

  for (const m of valid) {
    const ra = rating.get(m.a) as number;
    const rb = rating.get(m.b) as number;
    const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
    const eb = 1 - ea;
    const sa = m.winner === "a" ? 1 : m.winner === "draw" ? 0.5 : 0;
    const sb = 1 - sa;
    rating.set(m.a, ra + k * (sa - ea));
    rating.set(m.b, rb + k * (sb - eb));
    if (m.winner === "a") {
      wins.set(m.a, (wins.get(m.a) as number) + 1);
      losses.set(m.b, (losses.get(m.b) as number) + 1);
    } else if (m.winner === "b") {
      wins.set(m.b, (wins.get(m.b) as number) + 1);
      losses.set(m.a, (losses.get(m.a) as number) + 1);
    } else {
      draws.set(m.a, (draws.get(m.a) as number) + 1);
      draws.set(m.b, (draws.get(m.b) as number) + 1);
    }
  }

  return ids
    .map((id) => ({
      id,
      rating: Math.round((rating.get(id) as number) * 10) / 10,
      wins: wins.get(id) as number,
      losses: losses.get(id) as number,
      draws: draws.get(id) as number,
    }))
    .sort((x, y) => y.rating - x.rating || y.wins - x.wins || x.id.localeCompare(y.id));
}
