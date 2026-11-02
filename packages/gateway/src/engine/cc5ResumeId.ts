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
