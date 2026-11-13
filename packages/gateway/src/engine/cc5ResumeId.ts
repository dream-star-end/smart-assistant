/** Remote test IDs never name a local Cursor store or JSONL. */
export const CC5_RESUME_PREFIX = 'cc5-t1555u:'
export function isCc5ResumeId(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(CC5_RESUME_PREFIX)
}
export function cc5ResumeId(bindingId: string, nativeId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(bindingId) || !/^[a-f0-9-]{36}$/i.test(nativeId)) {
    throw new Error('CC5_NATIVE_SESSION_ID_INVALID')
  }
  return `${CC5_RESUME_PREFIX + bindingId}:${nativeId}`
}
export function parseCc5ResumeId(
  value: string | null | undefined,
): { bindingId: string; nativeId: string } | null {
  if (!isCc5ResumeId(value)) return null
  const rest = value!.slice(CC5_RESUME_PREFIX.length)
  const sep = rest.indexOf(':')
  if (sep <= 0) return null
  const bindingId = rest.slice(0, sep)
  const nativeId = rest.slice(sep + 1)
  if (!/^[a-f0-9-]{36}$/.test(bindingId) || !/^[a-f0-9-]{36}$/i.test(nativeId)) return null
  return { bindingId, nativeId }
}
