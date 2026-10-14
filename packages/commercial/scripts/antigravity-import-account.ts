#!/usr/bin/env tsx
/**
 * OCV5-415 ops: import a Google AI subscription account that was signed in
 * with the official Antigravity CLI (its `antigravity-oauth-token` file) into
 * gemini_oauth_accounts. The admin API (/api/admin/antigravity-accounts/auth/*)
 * is the normal path; this exists so an account already authorized on the
 * host does not need a second consent round.
 *
 *   DATABASE_URL=… OPENCLAUDE_KMS_KEY=… OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET=… \
 *     npx tsx packages/commercial/scripts/antigravity-import-account.ts \
 *       --token-file /root/…/antigravity-oauth-token --label "main"
 *
 * Proves the refresh token works (one refresh grant) and reads the verified
 * email before storing anything. Prints only the account id and email.
 */
import { readFile } from 'node:fs/promises'

import {
  fetchAntigravityAccountEmail,
  refreshAntigravityGrant,
  upsertAntigravityAccount,
} from '../src/account-pool/antigravityOAuth.js'
import { closePool } from '../src/db/index.js'

function arg(name: string): string {
  const i = process.argv.indexOf(name)
  const value = i >= 0 ? process.argv[i + 1] : undefined
  if (!value) throw new Error(`missing ${name}`)
  return value
}

async function main(): Promise<void> {
  const tokenFile = arg('--token-file')
  const label = arg('--label')
  const clientSecret = process.env.OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET?.trim() ?? ''
  if (!clientSecret) throw new Error('OC_ANTIGRAVITY_OAUTH_CLIENT_SECRET is not set')
  const parsed = JSON.parse(await readFile(tokenFile, 'utf8')) as {
    token?: { refresh_token?: unknown }
    auth_method?: unknown
  }
  const refreshToken = parsed.token?.refresh_token
  if (typeof refreshToken !== 'string' || refreshToken.length < 20) {
    throw new Error('token file has no refresh token')
  }
  if (parsed.auth_method !== 'consumer')
    throw new Error('token file is not a consumer (Google account) login')
  const grant = await refreshAntigravityGrant({ clientSecret }, refreshToken)
  const email = await fetchAntigravityAccountEmail({}, grant.accessToken)
  const accountId = await upsertAntigravityAccount({
    label,
    email,
    refreshToken: grant.refreshToken ?? refreshToken,
    accessToken: grant.accessToken,
    accessExpiresAt: grant.expiresAt,
  })
  process.stdout.write(`${JSON.stringify({ accountId: accountId.toString(), email })}\n`)
}

main()
  .catch((err: unknown) => {
    process.stderr.write(
      `antigravity-import-account: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    process.exitCode = 1
  })
  .finally(() => closePool().catch(() => {}))
