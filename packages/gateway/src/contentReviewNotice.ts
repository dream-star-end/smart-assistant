/** Active or still-pending strikes that count toward an account ban. */
export const CONTENT_REVIEW_STRIKE_LIMIT = 3

const APPEAL_MARKER = /<!--\s*oc-appeal:(\d+)\s*-->/

export function shouldBanForStrikes(activeCount: number): boolean {
  return activeCount >= CONTENT_REVIEW_STRIKE_LIMIT
}

export function appealStrikeId(body: string): string | null {
  const match = APPEAL_MARKER.exec(body)
  return match?.[1] ?? null
}

export function violationInbox(input: {
  strikeId: string
  excerpt: string
  activeCount: number
}): { title: string; bodyMd: string } {
  const banned = shouldBanForStrikes(input.activeCount)
  const title = banned ? '账号已因累计违规被封禁' : '内容违规说明'
  const bodyMd = [
    '管理员确认了一条消息违规。本条消息本身没有被拦截。',
    '',
    `摘录：${input.excerpt}`,
    '',
    `这是第 ${input.activeCount} 次记录。累计 ${CONTENT_REVIEW_STRIKE_LIMIT} 次将封禁账号。`,
    banned ? '这次已经达到上限，账号已被封禁。' : '尚未封禁账号。',
    '',
    '如果认为这是误判，可以申诉。申诉通过后，这一次不再计入。',
    `<!-- oc-appeal:${input.strikeId} -->`,
  ].join('\n')
  return { title, bodyMd }
}
