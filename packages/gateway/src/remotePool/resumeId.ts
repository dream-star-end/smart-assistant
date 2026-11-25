/**
 * Bound resume-id helper for `remote-driver-v4` lanes (`remotev4:<bindingId>:<nativeId>`).
 *
 * Prevents cross-lane or local-transcript replay if a session switches models or loses its
 * signed remote execution backend.
 */
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const NATIVE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export const REMOTE_V4_RESUME_PREFIX = 'remotev4:' as const

export function remoteV4ResumeId(bindingId: string, nativeId: string): string {
  if (!UUID_RE.test(bindingId) || !NATIVE_ID_RE.test(nativeId)) {
    throw new Error('REMOTE_V4_RESUME_ID_INVALID')
  }
  return `${REMOTE_V4_RESUME_PREFIX}${bindingId.toLowerCase()}:${nativeId}`
}

export function isRemoteV4ResumeId(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.startsWith(REMOTE_V4_RESUME_PREFIX)
}

export function parseRemoteV4ResumeId(
  value: string | null | undefined,
): { readonly bindingId: string; readonly nativeId: string } | null {
  if (!isRemoteV4ResumeId(value)) return null
  const rest = value.slice(REMOTE_V4_RESUME_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep !== 36) return null
  const bindingId = rest.slice(0, 36)
  const nativeId = rest.slice(37)
  if (!UUID_RE.test(bindingId) || !NATIVE_ID_RE.test(nativeId)) return null
  return { bindingId: bindingId.toLowerCase(), nativeId }
}

/**
 * Extracts the bare portable `nativeId` from a `remotev4:<bindingId>:<nativeId>` token,
 * or validates and returns a bare native session id as-is. Malformed inputs return `null`.
 */
export function extractPortableNativeSessionId(
  resumeId: string | null | undefined,
): string | null {
  if (typeof resumeId !== 'string' || resumeId.length === 0) return null
  if (isRemoteV4ResumeId(resumeId)) {
    return parseRemoteV4ResumeId(resumeId)?.nativeId ?? null
  }
  return NATIVE_ID_RE.test(resumeId) ? resumeId : null
}

/**
 * Rebinds a previous `remotev4:<oldBindingId>:<nativeId>` (or validated bare `nativeId`)
 * to `nextBindingId` after a controlled cross-node migration. Returns `null` on invalid inputs.
 */
export function rebindRemoteV4ResumeId(
  previousResumeId: string,
  nextBindingId: string,
): string | null {
  if (typeof nextBindingId !== 'string' || !UUID_RE.test(nextBindingId)) return null
  const nativeId = extractPortableNativeSessionId(previousResumeId)
  if (!nativeId) return null
  return remoteV4ResumeId(nextBindingId, nativeId)
}
