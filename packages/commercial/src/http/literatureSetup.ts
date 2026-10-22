import type { IncomingMessage, ServerResponse } from 'node:http'
import { PluginAccountLeaseError } from '../plugins/accountLease.js'
import { PluginAccountError } from '../plugins/accounts.js'
import { LiteratureError } from '../plugins/literatureDb/errors.js'
import {
  LiteratureSetupError,
  type LiteratureSetupService,
} from '../plugins/literatureDb/setupService.js'
import { HttpError, readJsonBody, sendJson } from './util.js'

function safeError(error: unknown): never {
  if (error instanceof HttpError) throw error
  let code = 'SETUP_FAILED'
  let status = 500
  if (
    error instanceof LiteratureError ||
    error instanceof LiteratureSetupError ||
    error instanceof PluginAccountError ||
    error instanceof PluginAccountLeaseError
  ) {
    code = error.code
    if (['NOT_FOUND', 'ACCOUNT_NOT_FOUND'].includes(code)) status = 404
    else if (['INVALID_INPUT', 'INVALID_STATE', 'TERMS_REQUIRED'].includes(code)) status = 400
    else if (['NOT_INSTALLED'].includes(code)) status = 403
    else if (['CAPACITY', 'RATE_LIMITED'].includes(code)) status = 429
    else if (code === 'CREDENTIALS_INVALID') status = 422
    else if (['UNAVAILABLE', 'LEASE_UNAVAILABLE', 'MODEL_UNAVAILABLE'].includes(code)) status = 503
    else status = 409
  }
  throw new HttpError(status, code, 'Literature authorization could not complete')
}
async function body(
  req: IncomingMessage,
  limit: number,
  keys: string[],
): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] ?? ''))
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON is required')
  const raw = await readJsonBody(req, limit)
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !keys.includes(key))
  )
    throw new HttpError(400, 'INVALID_INPUT', 'Invalid authorization input')
  return raw as Record<string, unknown>
}
/** The caller has already authenticated Bearer identity. This is a separate, non-QR route. */
export async function dispatchLiteratureSetup(
  req: IncomingMessage,
  res: ServerResponse,
  userId: number,
  service: LiteratureSetupService | undefined,
  path: string,
): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, private')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  try {
    if (!service) throw new LiteratureSetupError('UNAVAILABLE')
    const method = req.method ?? 'GET'
    if (path === '/api/plugins/literature-db/setup') {
      if (method === 'GET') {
        sendJson(res, 200, await service.capability(userId))
        return
      }
      if (method === 'POST') {
        await service.assertAvailable(userId)
        const value = await body(req, 8192, ['username', 'password', 'acceptTerms', 'accountId'])
        if (
          typeof value.username !== 'string' ||
          typeof value.password !== 'string' ||
          typeof value.acceptTerms !== 'boolean' ||
          (value.accountId !== undefined && typeof value.accountId !== 'string')
        )
          throw new LiteratureError('INVALID_INPUT')
        sendJson(
          res,
          202,
          await service.start(userId, {
            username: value.username,
            password: value.password,
            acceptTerms: value.acceptTerms,
            ...(value.accountId !== undefined ? { accountId: value.accountId as string } : {}),
          }),
        )
        return
      }
    }
    const match =
      /^\/api\/plugins\/literature-db\/setup\/([0-9a-f-]{36})(?:\/(answer)|\/challenges\/([0-9a-f-]{36})\/(image))?$/.exec(
        path,
      )
    if (!match) throw new HttpError(404, 'NOT_FOUND', 'Authorization endpoint not found')
    const id = match[1]!
    if (method === 'GET' && match[4] === 'image') {
      const image = await service.image(userId, id, match[3]!)
      res.statusCode = 200
      res.setHeader('Content-Type', 'image/png')
      res.setHeader('Content-Length', image.data.length)
      res.end(image.data)
      return
    }
    if (method === 'POST' && match[2] === 'answer') {
      // Ownership is checked before consuming a secret answer body.
      await service.status(userId, id)
      const value = await body(req, 1024, ['challengeId', 'answer'])
      if (typeof value.challengeId !== 'string' || typeof value.answer !== 'string')
        throw new LiteratureError('INVALID_INPUT')
      sendJson(res, 202, await service.answer(userId, id, value.challengeId, value.answer))
      return
    }
    if (!match[2] && !match[4]) {
      if (method === 'GET') {
        sendJson(res, 200, await service.status(userId, id))
        return
      }
      if (method === 'DELETE') {
        sendJson(res, 200, await service.cancel(userId, id))
        return
      }
    }
    throw new HttpError(404, 'NOT_FOUND', 'Authorization endpoint not found')
  } catch (error) {
    safeError(error)
  }
}
