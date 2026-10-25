// OCV5-591 A2-1b-1 — brief moderation before planning (plan §1.6, D7; platform-paid). A clear
// violation stops the project; an unsure verdict passes only while visual QA will judge every
// image (each version carries its own moderation verdict there).

export type BriefVerdict = 'pass' | 'uncertain' | 'block'

export function buildModerationPrompt(brief: string): string {
  return [
    '你是内容审核员。判断下面这条短视频需求能否制作：',
    'block：明显违规（成人色情、血腥暴力、仇恨歧视、冒用真实人物、违法内容等）；',
    'uncertain：可能违规、拿不准；pass：可以制作。',
    '只输出一个 JSON 对象：{"verdict":"pass","reason":"一句中文说明（≤ 60 字）"}',
    `需求：${brief.slice(0, 4000)}`,
  ].join('\n')
}

/** A broken answer is "uncertain", never "pass". */
export function parseModeration(answer: string): { verdict: BriefVerdict; reason: string } {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  try {
    const raw = JSON.parse(answer.slice(start, end + 1)) as { verdict?: unknown; reason?: unknown }
    const verdict =
      raw.verdict === 'pass' || raw.verdict === 'block' || raw.verdict === 'uncertain'
        ? raw.verdict
        : 'uncertain'
    const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 120) : ''
    return { verdict, reason }
  } catch {
    return { verdict: 'uncertain', reason: '' }
  }
}

/** What the project does with a verdict (visual QA on → unsure passes; off → back to draft). */
export function moderationOutcome(
  verdict: BriefVerdict | 'unavailable',
  qaOn: boolean,
): 'plan' | 'fail' | 'draft' {
  if (verdict === 'pass') return 'plan'
  if (verdict === 'block') return 'fail'
  return qaOn ? 'plan' : 'draft'
}
