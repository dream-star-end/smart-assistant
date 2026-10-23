/** Minimal, explicit profile consent. Never contains the legacy user.md document. */
export interface PromptPrivacyPolicy {
  schemaVersion: 1
  profile: { nickname: string; sessionId: string } | null
}
export const DEFAULT_PROMPT_PRIVACY: Readonly<PromptPrivacyPolicy> = Object.freeze({ schemaVersion: 1, profile: null })
export function parsePromptPrivacyPolicy(raw: unknown): PromptPrivacyPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const p = raw as Record<string, unknown>
  if (Object.keys(p).sort().join(',') !== 'profile,schemaVersion' || p.schemaVersion !== 1) return null
  if (p.profile === null) return { schemaVersion: 1, profile: null }
  if (!p.profile || typeof p.profile !== 'object' || Array.isArray(p.profile)) return null
  const v = p.profile as Record<string, unknown>
  if (Object.keys(v).sort().join(',') !== 'nickname,sessionId' || typeof v.nickname !== 'string' || typeof v.sessionId !== 'string') return null
  if (!v.nickname.trim() || v.nickname.length > 80 || !v.sessionId || v.sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(v.nickname + v.sessionId)) return null
  return { schemaVersion: 1, profile: { nickname: v.nickname.trim(), sessionId: v.sessionId } }
}
export function effectivePromptPrivacy(raw: unknown, sessionId: string | undefined): PromptPrivacyPolicy {
  const p = parsePromptPrivacyPolicy(raw)
  return p?.profile && sessionId && p.profile.sessionId === sessionId ? p : { schemaVersion: 1, profile: null }
}
