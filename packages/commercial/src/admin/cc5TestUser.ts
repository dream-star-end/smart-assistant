/** Task-only create-only account domain. No session, mail, verification, billing or container calls. */
import { z } from 'zod'
import { hashPassword } from '../auth/passwords.js'
import {
  VERIFY_EMAIL_TTL_SECONDS,
  insertUnverifiedAccount,
  newVerifyCode,
  passwordSchema,
} from '../auth/register.js'
import { tx } from '../db/queries.js'
import { type AdminAuditRequestCtx, writeAdminAudit } from './audit.js'

export const CC5_TEST_ACCOUNT_EMAIL = 'dengxuan+v5remote1@mail.grokbot.com'
export const CC5_TEST_ACCOUNT_TASK = 'AGENT-REMOTE-T1555U'
const inputSchema = z.object({ password: passwordSchema }).strict()
export class Cc5TestUserError extends Error {
  constructor(readonly code: 'VALIDATION' | 'CONFLICT' | 'FAILED') {
    super('CC5_TEST_ACCOUNT_CREATE_REJECTED')
  }
}
export async function createCc5UnverifiedTestUser(body: unknown, audit: AdminAuditRequestCtx) {
  const parsed = inputSchema.safeParse(body)
  if (!parsed.success) throw new Cc5TestUserError('VALIDATION')
  try {
    const passwordHash = await hashPassword(parsed.data.password)
    const verificationHash = newVerifyCode().hash // The unsent raw code is never returned/persisted/logged.
    const expiresAtIso = new Date(Date.now() + VERIFY_EMAIL_TTL_SECONDS * 1000).toISOString()
    const userId = await tx(async (client) => {
      const uid = await insertUnverifiedAccount(client, {
        email: CC5_TEST_ACCOUNT_EMAIL,
        passwordHash,
        verificationHash,
        expiresAtIso,
      })
      await writeAdminAudit(client, {
        ...audit,
        action: 'user.create',
        target: `user:${uid}`,
        after: {
          task: CC5_TEST_ACCOUNT_TASK,
          email: CC5_TEST_ACCOUNT_EMAIL,
          role: 'user',
          email_verified: false,
          mail_suppressed: true,
          prewarm: false,
        },
      })
      return uid
    })
    return { user_id: userId, email_verified: false, verify_email_sent: false, prewarmed: false }
  } catch (error) {
    if ((error as { code?: unknown })?.code === '23505') throw new Cc5TestUserError('CONFLICT')
    throw new Cc5TestUserError('FAILED') // Never expose DB details, password, hash or verification code.
  }
}
