/**
 * Mirror pgSessionsBackend's canonical first-message title rule.
 * 空文本回退「新对话」：侧栏 / 列表 / 搜索 / App 建行（ensureSession）全部用「新对话」，
 * 此前这里独自回退「新会话」，同一实体两个名字，刷新后还会被服务端行上的「新对话」盖回（审计 ST-01）。
 */
export const EMPTY_SESSION_TITLE = '新对话'

export function sessionTitleFromText(text: string): string {
  return text.length > 50 ? `${text.slice(0, 50)}…` : text || EMPTY_SESSION_TITLE
}
