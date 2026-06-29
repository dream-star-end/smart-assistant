/**
 * CiteFix 引用纠错(闸⑥,后处理重对齐)— 方案 §5 P2 增强。
 *
 * 对**未接地**(unsupported / 无有效 support)的 claim,用 litrag 在用户权威文档集里
 * 重检索更匹配的 verbatim quote 并重绑,再交 oc-cite check 重铸 status。
 *
 * 红线不破:
 *   - 重检索得到的 quote 由 master 从权威 span 铸造(litrag 输出,非凭空生成);
 *   - 若 manifest 已有同 id quote(可能是容器提交的伪造同 id),用 litrag 铸造的 best
 *     **覆盖**它(不信提交);
 *   - 本模块只产"待 recheck"的重绑候选,verified 仍由 master checkManifest 铸造。
 *   - 已 verified 的 claim 不动。
 *
 * 请求级预算:至多 FIX_MAX_CLAIMS 条;有界并发 FIX_CONCURRENCY;docs 由调用方预加载一次
 * (query 闭包内复用,避免每 claim 重读 DB)。
 */

import type { Claim, EvidenceManifest, QuoteHandle } from "@openclaude/protocol/research";

const FIX_MAX_CLAIMS = 200;
const FIX_CONCURRENCY = 5;

export interface CiteFixDeps {
  /** 在(预加载的)权威文档集上检索 → quote handles(master litrag,逐字取权威 span)。 */
  query: (claimText: string) => Promise<QuoteHandle[]>;
  /** 候选最低分(低于不重绑,避免硬塞弱相关来源)。默认 0。 */
  minScore?: number;
}

export interface CiteFixChange {
  claimId: string;
  /** 重绑到的 quote id;'none' 表示没找到合适候选(保持未接地)。 */
  requotedTo: string | "none";
}

/**
 * 对未接地 claim 重检索重绑(产出"待 recheck"的 manifest)。不就地改入参。
 * `hasDocs=false`(无权威文档)→ 全部跳过。
 */
export async function realignUnsupportedClaims(
  manifest: EvidenceManifest,
  hasDocs: boolean,
  deps: CiteFixDeps,
): Promise<{ manifest: EvidenceManifest; changes: CiteFixChange[] }> {
  const minScore = deps.minScore ?? 0;
  // 按 id 维护 quote 集(litrag 铸造的 best 覆盖任何同 id 提交项,防伪造同 id)
  const quoteMap = new Map<string, QuoteHandle>(manifest.quotes.map((q) => [q.id, q]));
  const changes: CiteFixChange[] = [];
  const claims: Claim[] = manifest.claims.map((c) => c); // 浅拷贝数组,逐条替换

  if (hasDocs) {
    // 仅取未接地 + 有文本的 claim 索引,限量
    const targets: number[] = [];
    for (let i = 0; i < claims.length && targets.length < FIX_MAX_CLAIMS; i++) {
      const c = claims[i];
      if (c.status !== "verified" && c.text.trim()) targets.push(i);
    }
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < targets.length) {
        const i = targets[cursor++];
        const c = claims[i];
        let cands: QuoteHandle[] = [];
        try {
          cands = await deps.query(c.text);
        } catch {
          cands = [];
        }
        const best = cands.find((q) => (q.score ?? 0) >= minScore);
        if (!best) {
          changes.push({ claimId: c.id, requotedTo: "none" });
          continue;
        }
        // litrag 铸造的 best 覆盖同 id 提交项(red-line:重绑目标必为 master 铸造候选)
        quoteMap.set(best.id, best);
        changes.push({ claimId: c.id, requotedTo: best.id });
        claims[i] = { ...c, supports: [{ quoteId: best.id }], status: "unchecked" };
      }
    };
    await Promise.all(Array.from({ length: Math.min(FIX_CONCURRENCY, targets.length) }, worker));
  }

  return { manifest: { ...manifest, quotes: [...quoteMap.values()], claims }, changes };
}
