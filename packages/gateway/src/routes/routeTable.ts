/**
 * Declarative HTTP route tables for the Gateway (FINDINGS §7.5 step 2b).
 *
 * Gateway._handleHttpAfterCommercial used to be one long if-chain. Route groups move into ordered
 * tables of { id, match, handle } and are dispatched at the spot the inline block used to be, so
 * the global match order does not change. Semantics are those of the chain:
 * - entries are tried in table order;
 * - an entry whose match hits runs its handler; `true` = handled (the old `return`), `false` =
 *   the old branch fell through and the next entry is tried.
 *
 * Unlike the if-chain, a table is readable at runtime: tests assert ids and order directly instead
 * of grepping server.ts source, and allowlists can be checked against it.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export type RouteMatch = RegExpMatchArray | true

export interface HttpRoute<Io> {
  /** Stable id: literal path(s) with a fixed method prefix, or the regex as a :1/:2 pattern. */
  readonly id: string
  /** The original branch condition; null/false = not this route. */
  readonly match: (req: IncomingMessage, url: URL) => RouteMatch | null | false
  /** The original branch body; true = handled. */
  readonly handle: (
    io: Io,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    m: RouteMatch,
  ) => boolean
}

/** `if (cond) { … }` */
export function predicateRoute<Io>(
  id: string,
  match: (req: IncomingMessage, url: URL) => unknown,
  handle: (io: Io, req: IncomingMessage, res: ServerResponse, url: URL) => boolean,
): HttpRoute<Io> {
  return {
    id,
    // truthiness exactly as the original `if (cond)`
    match: (req, url) => (match(req, url) ? true : null),
    handle: (io, req, res, url) => handle(io, req, res, url),
  }
}

/** `const m = url.pathname.match(re); if (m) { … }` */
export function regexRoute<Io>(
  id: string,
  match: (req: IncomingMessage, url: URL) => RegExpMatchArray | null,
  handle: (
    io: Io,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    m: RegExpMatchArray,
  ) => boolean,
): HttpRoute<Io> {
  return {
    id,
    match,
    handle: (io, req, res, url, m) => handle(io, req, res, url, m as RegExpMatchArray),
  }
}

export function dispatchRoutes<Io>(
  routes: readonly HttpRoute<Io>[],
  io: Io,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): boolean {
  for (const route of routes) {
    const m = route.match(req, url)
    if (m && route.handle(io, req, res, url, m)) return true
  }
  return false
}

/** Ids of the entries whose match hits, in table order (for tests and diagnostics). */
export function matchingRouteIds<Io>(
  routes: readonly HttpRoute<Io>[],
  req: IncomingMessage,
  url: URL,
): string[] {
  return routes.filter((route) => route.match(req, url)).map((route) => route.id)
}
