/**
 * Commercial Master HTTP endpoint for issuing short-lived `/ws/live-browser` stream tickets
 * (OCV5-857):
 *   POST /api/agents/:id/browser/stream-ticket
 *
 * Security invariants:
 * - Authenticates caller via Bearer JWT / `oc_session` cookie + active DB account verification.
 * - Mints a single-use 30s ticket bound to `(uid, agentId)` only when the live browser WS bridge
 *   is assembled and ready.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import {
  LIVE_BROWSER_PUBLIC_WS_PATH,
  LIVE_BROWSER_TICKET_PROTOCOL,
  type LiveBrowserStreamTicketResponse,
} from '@openclaude/protocol'

import { authenticateActiveCommercialUser } from './activeUserAuth.js'
import type { CommercialHttpDeps, RequestContext } from './handlers.js'
import { HttpError, sendJson } from './util.js'

export const LIVE_BROWSER_STREAM_TICKET_ROUTE_RE =
  /^\/api\/agents\/([A-Za-z0-9._-]{1,64})\/browser\/stream-ticket$/

export function isLiveBrowserStreamTicketPath(pathname: string): boolean {
  return LIVE_BROWSER_STREAM_TICKET_ROUTE_RE.test(pathname)
}

export async function handleCreateLiveBrowserStreamTicket(
  req: IncomingMessage,
  res: ServerResponse,
  _ctx: RequestContext,
  deps: CommercialHttpDeps,
): Promise<void> {
  if ((req.method ?? '').toUpperCase() !== 'POST') {
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST required', {
      extraHeaders: { Allow: 'POST' },
    })
  }

  const user = await authenticateActiveCommercialUser(req, deps.jwtSecret, {
    pool: deps.v3Supervisor?.pool,
    verifyActiveAccount: deps.verifyActiveAccount,
  })

  if (
    !deps.liveBrowserTickets ||
    !deps.v3Supervisor ||
    deps.liveBrowserStreamAvailable?.() !== true
  ) {
    throw new HttpError(503, 'LIVE_BROWSER_STREAM_UNAVAILABLE', '实时浏览器流通道暂不可用')
  }

  const pathname = new URL(req.url ?? '/', 'http://x').pathname
  const match = LIVE_BROWSER_STREAM_TICKET_ROUTE_RE.exec(pathname)
  if (!match) {
    throw new HttpError(404, 'NOT_FOUND', 'live browser stream ticket route not found')
  }
  const agentId = match[1]!

  const issued = deps.liveBrowserTickets.issue(BigInt(user.id), agentId)
  const payload: LiveBrowserStreamTicketResponse = {
    ticket: issued.ticket,
    expiresAt: issued.expiresAt,
    agentId: issued.agentId,
    wsPath: LIVE_BROWSER_PUBLIC_WS_PATH,
    protocol: LIVE_BROWSER_TICKET_PROTOCOL,
  }
  res.setHeader('Cache-Control', 'no-store')
  sendJson(res, 201, payload)
}
