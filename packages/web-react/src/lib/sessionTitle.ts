/** Mirror pgSessionsBackend's canonical first-message title rule. */
export function sessionTitleFromText(text: string): string {
  return text.length > 50 ? `${text.slice(0, 50)}…` : text || '新会话'
}
