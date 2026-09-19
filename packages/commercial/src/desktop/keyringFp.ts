/**
 * Desktop keyring fingerprint — same function register_ok uses.
 * Empty ring (file missing) hashes a fixed seed so client/server stay aligned.
 */

import { createHash } from 'node:crypto'
import { type AuthorityKeyring, keyringFingerprint } from '@openclaude/protocol'

export function hashEmptyKeyring(): string {
  return createHash('sha256').update('openclaude-desktop-keyring').digest('hex')
}

export function desktopKeyringFpFrom(keyring: AuthorityKeyring | null | undefined): string {
  if (!keyring || keyring.size === 0) return hashEmptyKeyring()
  return keyringFingerprint(keyring)
}
