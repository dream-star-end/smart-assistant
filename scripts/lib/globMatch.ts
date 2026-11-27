/**
 * Authoritative single-pass glob matcher for A0 path-scope enforcement (OCV5-912 / B8).
 *
 * Shared by both host A0 receipt verification (`a0ApprovalReceipt.ts`) and GitHub
 * `oc-v5/a0-approval` status verification (`githubTrustedApproval.ts`) so recursive
 * patterns like `docs/**`, `packages/**`, and `** /foo.ts` behave identically everywhere.
 */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.+/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if ('+?^${}()|[]\\.'.includes(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}

export function matchesAnyGlob(filePath: string, globs: readonly string[]): boolean {
  return globs.some((g) => globToRegExp(g).test(filePath))
}
