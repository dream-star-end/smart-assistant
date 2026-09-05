/**
 * /api/chatgpt-proxy/* — browser-facing management of the ChatGPT direct-connect
 * proxy (see ../chatgptProxy/server.ts for the CONNECT listener itself).
 *
 *   GET    /api/chatgpt-proxy/access      → entitlement + connection details
 *   POST   /api/chatgpt-proxy/credential  → issue / rotate (plaintext returned once)
 *   DELETE /api/chatgpt-proxy/credential  → revoke
 *
 * Unentitled users only ever see `{ enabled: false }`; proxy host/port/PAC are
 * not disclosed to them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  CHATGPT_PROXY_HOME_URL,
  CHATGPT_PROXY_PAC_PATH,
  chatGptProxyUsername,
} from '@openclaude/protocol/chatgptProxy'

import type { ChatGptProxyCredentialStore } from '../chatgptProxy/credentials.js'
import type { ChatGptProxyFlagSnapshot } from '../chatgptProxy/flags.js'
import { isChatGptProxyEntitled } from '../chatgptProxy/flags.js'
import { requireAuth } from './auth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { requireActiveAccountVerifyDb, type VerifiedAccount } from './requireUser.js'
import { HttpError, sendJson } from './util.js'

/** Assembled once in index.ts; undefined when the proxy listener is not running. */
export interface ChatGptProxyHttpDeps {
  publicHost: string
  port: number
  credentials: ChatGptProxyCredentialStore
  getFlags(): Promise<ChatGptProxyFlagSnapshot>
}

async function authorize(
  req: IncomingMessage,
  deps: CommercialHttpDeps,
): Promise<{
  account: VerifiedAccount
  uid: number
  proxy: ChatGptProxyHttpDeps | undefined
  entitled: boolean
}> {
  const user = await requireAuth(req, deps.jwtSecret)
  if (!deps.v3Supervisor)
    throw new HttpError(503, 'CHATGPT_PROXY_UNAVAILABLE', 'ChatGPT 直连暂不可用')
  const account = await requireActiveAccountVerifyDb(
    user.id,
    ['user', 'admin'],
    deps.v3Supervisor.pool,
  )
  if (!account) throw new HttpError(403, 'FORBIDDEN', 'account is not active')
  const uid = Number(account.id)
  if (!Number.isSafeInteger(uid) || uid < 1)
    throw new HttpError(403, 'FORBIDDEN', 'invalid account id')
  const proxy = deps.chatgptProxy
  if (!proxy) return { account, uid, proxy, entitled: false }
  const flags = await proxy.getFlags()
  const entitled = flags.assembled && isChatGptProxyEntitled(uid, account.role, flags.allowlist)
  return { account, uid, proxy, entitled }
}

export async function handleGetChatGptProxyAccess(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const { uid, proxy, entitled } = await authorize(req, deps)
  if (!proxy || !entitled) {
    sendJson(res, 200, { enabled: false })
    return
  }
  const info = await proxy.credentials.info(uid)
  sendJson(res, 200, {
    enabled: true,
    proxyHost: proxy.publicHost,
    proxyPort: proxy.port,
    pacUrl: `https://${proxy.publicHost}:${proxy.port}${CHATGPT_PROXY_PAC_PATH}`,
    homeUrl: CHATGPT_PROXY_HOME_URL,
    username: chatGptProxyUsername(uid),
    hasCredential: info.hasCredential,
    createdAt: info.createdAt,
    rotatedAt: info.rotatedAt,
    lastUsedAt: info.lastUsedAt,
  })
}

export async function handleIssueChatGptProxyCredential(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const { uid, proxy, entitled } = await authorize(req, deps)
  if (!proxy) throw new HttpError(503, 'CHATGPT_PROXY_UNAVAILABLE', 'ChatGPT 直连暂不可用')
  if (!entitled)
    throw new HttpError(403, 'CHATGPT_PROXY_FORBIDDEN', '当前账号未被授权使用 ChatGPT 直连')
  const issued = await proxy.credentials.issue(uid)
  ctx.log.info('chatgpt_proxy_credential_issued', { uid })
  sendJson(res, 201, {
    username: chatGptProxyUsername(uid),
    password: issued.secret,
    rotatedAt: issued.rotatedAt,
  })
}

export async function handleRevokeChatGptProxyCredential(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  const { uid, proxy } = await authorize(req, deps)
  if (!proxy) throw new HttpError(503, 'CHATGPT_PROXY_UNAVAILABLE', 'ChatGPT 直连暂不可用')
  // Revocation is allowed even after entitlement was withdrawn: users must
  // always be able to kill their own credential.
  await proxy.credentials.revoke(uid)
  ctx.log.info('chatgpt_proxy_credential_revoked', { uid })
  sendJson(res, 200, { ok: true })
}
