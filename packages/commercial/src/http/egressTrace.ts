/**
 * egress 第 0 步:请求入口绑定 traceId(第三阶段方案 v3.6 §7.4,OCV5-569)。
 *
 * egress 的 HTTP server 在**任何分支之前**对每个回合请求(/v1/messages 与 codex / grok / zcode /
 * antigravity 四条 relay)读一次 `x-openclaude-trace-id`(protocol TRACE_ID_HEADER;egress 的调用方都是
 * 我们自己的容器,不收 `x-trace-id` 别名),结果挂在 req 上,各 handler 的请求日志通过
 * egressTraceFields(req) 带上:
 *   - 有合法头 → `traceId`;
 *   - 没有或不合法 → `traceId: null` + `traceIdMissing`(`no-header` / `relay-without-trace` /
 *     `bad-header`),**单独计数,不从分母里消失**(计数在 egress health JSON 的 traceBinding 里)。
 * 非法值只记原因、不记原值(防日志注入,与 parseTraceIdCandidate 的约定一致)。
 * 这个头只在受控端点之间传:proxy 与各 relay 发往上游的请求头都是白名单,不会带出去(测试锁住)。
 * 派发归因(turn_dispatches 查库)仍照旧作兜底;头缺失时 proxy 用 turn_dispatches.trace_id(0323,
 * OCV5-599)把请求挂回回合 trace(dispatchTraceFallback)。
 */
import type { IncomingMessage } from 'node:http'
import { TRACE_ID_HEADER, parseTraceIdCandidate } from '@openclaude/protocol'

export type EgressTurnRoute =
  | 'messages'
  | 'codex-relay'
  | 'grok-relay'
  | 'zcode-relay'
  | 'antigravity-relay'

export type TraceIdMissing = 'no-header' | 'relay-without-trace' | 'bad-header'

export type EgressTraceFields =
  | { traceId: string }
  | { traceId: null; traceIdMissing: TraceIdMissing }

const bound = new WeakMap<IncomingMessage, EgressTraceFields>()
const counts = new Map<string, number>()

/**
 * Step 0, called by the egress server for a turn route before it branches. Returns what was bound.
 * The canonical header only; a repeated header uses its first value.
 */
export function bindEgressTrace(req: IncomingMessage, route: EgressTurnRoute): EgressTraceFields {
  const raw = req.headers[TRACE_ID_HEADER]
  const parsed = parseTraceIdCandidate(Array.isArray(raw) ? raw[0] : raw)
  const fields: EgressTraceFields = parsed.ok
    ? { traceId: parsed.traceId }
    : {
        traceId: null,
        traceIdMissing:
          parsed.issue !== 'missing'
            ? 'bad-header'
            : route === 'messages'
              ? 'no-header'
              : 'relay-without-trace',
      }
  bound.set(req, fields)
  const key = `${route}:${fields.traceId === null ? fields.traceIdMissing : 'bound'}`
  counts.set(key, (counts.get(key) ?? 0) + 1)
  return fields
}

/**
 * The fields a handler adds to its request log. A request that did not pass the egress server (unit
 * tests, the desktop listener) has nothing bound and gets no fields, so existing log shapes stay.
 */
export function egressTraceFields(req: IncomingMessage): EgressTraceFields | Record<string, never> {
  return bound.get(req) ?? {}
}

/**
 * Plan §7.4 fallback: the dispatch row's trace, used only when step 0 bound no trace (no or bad
 * header, or the request did not pass step 0). A bound header always wins; null means nothing to log.
 */
export function dispatchTraceFallback(
  fields: EgressTraceFields | Record<string, never>,
  dispatchTraceId: string | null | undefined,
): string | null {
  if ('traceId' in fields && fields.traceId !== null) return null
  return dispatchTraceId ? dispatchTraceId : null
}

/** Counts since process start, `{ "<route>": { bound, "no-header", ... } }`, for the health JSON. */
export function egressTraceBindingCounts(): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [key, n] of counts) {
    const [route, result] = key.split(':') as [string, string]
    out[route] = { ...out[route], [result]: n }
  }
  return out
}

/** Map an egress request path to its turn route, or null for non-turn paths (health, box internals). */
export function egressTurnRoute(
  path: string,
  prefixes: { codex: string; grok: string; zcode: string; antigravity: string },
): EgressTurnRoute | null {
  if (path === '/v1/messages') return 'messages'
  const under = (p: string) => path === p || path.startsWith(`${p}/`)
  if (under(prefixes.codex)) return 'codex-relay'
  if (under(prefixes.grok)) return 'grok-relay'
  if (under(prefixes.zcode)) return 'zcode-relay'
  if (under(prefixes.antigravity)) return 'antigravity-relay'
  return null
}
