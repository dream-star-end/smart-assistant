/**
 * Gateway HTTP routes split out of server.ts by domain (OCV5-376 P2).
 *
 * server.ts dispatched every container HTTP route from one if-chain inside the 20k-line Gateway
 * class. Route domains that only need these three Gateway helpers move into routes/<domain>.ts as
 * `handle…Http(io, req, res, url): boolean` (true = handled). The Gateway keeps the order of the
 * chain and calls them at the spot the inline block used to be. Moves are mechanical: same
 * branches, same responses, `return` → `return true`.
 *
 * The container route inventory (packages/commercial/src/__tests__/helpers/
 * containerRouteInventory.ts) scans server.ts and these files for `url.pathname` dispatch forms,
 * so a moved route stays visible to the bridge-allowlist closure checks.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface GatewayHttpIo {
  sendJson(res: ServerResponse, code: number, body: unknown): void
  readBody(req: IncomingMessage, maxBytes?: number): Promise<string>
  getUserId(req: IncomingMessage): string
}
