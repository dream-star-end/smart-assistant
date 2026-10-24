/** Keep the bootstrap state setters synchronous. Managed callers await this
 * before changing SID/cwd/metadata; the storage import is deliberately lazy. */
export async function flushBeforeSessionChange(): Promise<void> {
  if (process.env.OPENCLAUDE_TRANSCRIPT_INTEGRITY === '1') {
    await (await import('./sessionStorage.js')).flushSessionStorage()
  }
}
