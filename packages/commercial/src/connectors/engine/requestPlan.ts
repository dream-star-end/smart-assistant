/**
 * 连接器平台 · 引擎 driver 之 canonical request plan 构造(RFC §4 步骤2)。
 *
 * `buildRequestPlan(action, params, targetOrigin)` → 未注入凭据的 canonical plan:
 *   { method, origin, path, query, targetUrl, headers, body }。
 *
 * 铁律(RFC §2/§4):**path/query 按 URL component 构造**,禁模板整 URL / `//host` /
 * userinfo / CRLF。动态值只来自 `params.*`(JSON-Pointer),凭据结构上进不来
 * (凭据只有 placement.ts 在 driver 里按 origin 匹配后注入)。
 *   - path:`pathTemplate` 里的 `{<json-pointer>}` 占位符 materialize;pointer 必须
 *     指向 `/params/…`;解析出的标量 URL-encode 后回填,再复核路径安全形状。
 *   - query:`request.query{name: paramPointer}`,值取自 params(URLSearchParams 编码)。
 *   - body:`request.bodyTemplate`(lit/ref/obj/arr 判别联合)materialize 成 JSON。
 *
 * **原型污染封堵**:params 先深拷贝进 null-prototype 对象(拒 __proto__/prototype/
 * constructor 键),pointer 解析与 obj materialize 全程再拒污染段(§2,P1-6)。
 *
 * `redactedPlan(plan)` 供迁移期 legacy/new plan diff + 审计:**绝不含凭据**
 * (plan 本就是注入前产物),并可选再抹 secret 值做双保险。
 */

import { ConnectorError } from '../errors.js'
import { normalizeHttpsOrigin } from '../outboundPolicy.js'
import type { ExecActionT, HttpMethodValue, TemplateValueT } from '../spec/types.js'
import { redactSecrets } from './redact.js'

/** 原型污染键(与编译器 POLLUTION_KEYS 对齐:递归拒)。 */
const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_MATERIALIZE_DEPTH = 64

// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally detect CR/LF/control for header/path injection
const CONTROL_CHARS = /[\x00-\x1f\x7f]/

/** 注入前的 canonical request plan(无凭据)。 */
export interface CanonicalRequestPlan {
  method: HttpMethodValue
  /** 规范化 origin `https://host:port`(与编译器 normalizeOrigin 输出一致)。 */
  origin: string
  /** 已 materialize + encode 的路径(无 query)。 */
  path: string
  /** 有序 query 键值对(值取自 params,尚无凭据)。 */
  query: Array<[string, string]>
  /** origin + path + '?'query。 */
  targetUrl: string
  /** 注入前头部(如 content-type;不含任何凭据)。 */
  headers: Record<string, string>
  /** 序列化后的 JSON body(仅非 GET/HEAD 且有 bodyTemplate 时)。 */
  body?: string
}

/** 脱敏后的 plan 投影(legacy/new diff + 审计;绝不含凭据)。 */
export interface RedactedRequestPlan {
  method: string
  origin: string
  path: string
  query: Array<[string, string]>
  hasBody: boolean
  bodyBytes: number
}

// ─── origin 规范化(与 spec/compiler.ts normalizeOrigin 语义对齐) ────────────

/**
 * 规范化到 `https://host:port`:https-only、禁 userinfo/path/query/fragment、host 小写、
 * 禁尾点/`..`/`*`、非 IP 字面量(复用 assertHostnameShape)。输出必须与编译器
 * normalizeOrigin 逐字节一致,否则 audience 精确匹配会漏判。
 */
// 单一权威:与编译器 audience 归一化共用 outboundPolicy.normalizeHttpsOrigin(逐字节一致)。
export const normalizeRequestOrigin = normalizeHttpsOrigin

// ─── params → null-prototype 深拷贝(拒污染键) ───────────────────────────────

function cloneNullProto(v: unknown, depth: number): unknown {
  if (depth > MAX_MATERIALIZE_DEPTH)
    throw new ConnectorError('BAD_REQUEST', 'params nesting too deep')
  if (v === null) return null
  const t = typeof v
  if (t === 'string' || t === 'boolean') return v
  if (t === 'number') {
    if (!Number.isFinite(v as number))
      throw new ConnectorError('BAD_REQUEST', 'non-finite number param')
    return v
  }
  if (t === 'undefined') return undefined
  if (Array.isArray(v)) return v.map((x) => cloneNullProto(x, depth + 1))
  if (t === 'object') {
    const out = Object.create(null) as Record<string, unknown>
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (POLLUTION_KEYS.has(k))
        throw new ConnectorError('BAD_REQUEST', 'forbidden param key (prototype pollution)')
      out[k] = cloneNullProto((v as Record<string, unknown>)[k], depth + 1)
    }
    return out
  }
  // bigint / function / symbol → 非 JSON,拒
  throw new ConnectorError('BAD_REQUEST', 'unsupported param value type')
}

// ─── JSON-Pointer 解析(仅 /params;拒污染段) ──────────────────────────────

function unescapePointerSegment(s: string): string {
  return s.replace(/~1/g, '/').replace(/~0/g, '~')
}

/** 解析 `/params[/seg…]` pointer;缺失返回 undefined;污染段/越界拒或 undefined。 */
function resolveParamPointer(root: unknown, pointer: string): unknown {
  if (pointer === '/params') return root
  if (!pointer.startsWith('/params/'))
    throw new ConnectorError('BAD_REQUEST', 'pointer must target /params')
  const segs = pointer
    .slice('/params'.length)
    .split('/')
    .slice(1)
    .map(unescapePointerSegment)
  let cur = root
  for (const seg of segs) {
    if (POLLUTION_KEYS.has(seg))
      throw new ConnectorError('BAD_REQUEST', 'forbidden pointer segment (prototype pollution)')
    if (cur === null || typeof cur !== 'object') return undefined
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      const idx = Number(seg)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return undefined
      cur = cur[idx]
    } else {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined
      cur = (cur as Record<string, unknown>)[seg]
    }
  }
  return cur
}

/** 标量 → 字符串(用于 path/query component);非标量拒。 */
function scalarToString(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  throw new ConnectorError('BAD_REQUEST', 'param value is not a scalar for url component')
}

/** CRLF / 控制字符 → 头/路径注入,构造期拒(RFC §4)。 */
function assertNoControlChars(s: string): void {
  if (CONTROL_CHARS.test(s))
    throw new ConnectorError('BAD_REQUEST', 'control char / CRLF in request component')
}

// ─── path materialize + 复核 ─────────────────────────────────────────────────

function assertPathSafe(path: string): void {
  if (!path.startsWith('/')) throw new ConnectorError('BAD_REQUEST', 'path must start with /')
  if (
    path.includes('//') ||
    path.includes('://') ||
    path.includes('\\') ||
    path.includes('@')
  )
    throw new ConnectorError('BAD_REQUEST', 'illegal sequence in materialized path')
  if (CONTROL_CHARS.test(path))
    throw new ConnectorError('BAD_REQUEST', 'control char / CRLF in materialized path')
  if (/(^|\/)\.\.(\/|$)/.test(path))
    throw new ConnectorError('BAD_REQUEST', 'dot-dot segment in materialized path')
}

function materializePath(template: string, mat: unknown): string {
  const out = template.replace(/\{([^}]*)\}/g, (_m, inner: string) => {
    const val = resolveParamPointer(mat, inner)
    if (val === undefined || val === null)
      throw new ConnectorError('BAD_REQUEST', 'path param unresolved')
    const s = scalarToString(val)
    assertNoControlChars(s)
    // encode 中和 `/` `@` `:` 等;`{}` 占位符只出现在此处,不会残留。
    return encodeURIComponent(s)
  })
  assertPathSafe(out)
  return out
}

// ─── body materialize(lit/ref/obj/arr) ──────────────────────────────────────

function materializeTemplate(t: TemplateValueT, mat: unknown, depth: number): unknown {
  if (depth > MAX_MATERIALIZE_DEPTH)
    throw new ConnectorError('BAD_REQUEST', 'body template too deep')
  if ('lit' in t) return t.lit
  if ('ref' in t) return resolveParamPointer(mat, t.ref)
  if ('obj' in t) {
    const out = Object.create(null) as Record<string, unknown>
    for (const k of Object.keys(t.obj)) {
      if (POLLUTION_KEYS.has(k))
        throw new ConnectorError('BAD_REQUEST', 'forbidden body key (prototype pollution)')
      out[k] = materializeTemplate(t.obj[k] as TemplateValueT, mat, depth + 1)
    }
    return out
  }
  if ('arr' in t) return t.arr.map((x) => materializeTemplate(x, mat, depth + 1))
  throw new ConnectorError('BAD_REQUEST', 'invalid body template node')
}

// ─── URL 组装 ────────────────────────────────────────────────────────────────

/** origin + path + query → 完整 URL(URLSearchParams 编码 query 值)。 */
export function composeUrl(origin: string, path: string, query: Array<[string, string]>): string {
  if (query.length === 0) return `${origin}${path}`
  const qs = new URLSearchParams(query).toString()
  return qs ? `${origin}${path}?${qs}` : `${origin}${path}`
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

/**
 * 构造 canonical request plan(注入凭据前)。
 * targetOrigin = driver 传入的目标 origin;此处只规范化 + 拼 URL,audience 匹配在
 * driver(engineHttpRequest)那一层做单点强制(凭据流向不变量)。
 */
export function buildRequestPlan(
  action: ExecActionT,
  params: unknown,
  targetOrigin: string,
): CanonicalRequestPlan {
  const origin = normalizeRequestOrigin(targetOrigin)
  const mat = cloneNullProto(params ?? {}, 0)
  const req = action.request

  const path = materializePath(req.pathTemplate, mat)

  const query: Array<[string, string]> = []
  if (req.query) {
    for (const name of Object.keys(req.query)) {
      if (POLLUTION_KEYS.has(name)) continue
      const ptr = req.query[name] as string
      const val = resolveParamPointer(mat, ptr)
      if (val === undefined || val === null) continue
      const s = scalarToString(val)
      assertNoControlChars(s)
      query.push([name, s])
    }
  }

  const targetUrl = composeUrl(origin, path, query)

  const headers: Record<string, string> = {}
  // 静态请求头(非凭据):编译期已禁保留头,运行期再复核保留/CRLF(双保险)。
  if (req.staticHeaders) {
    for (const [name, value] of Object.entries(req.staticHeaders)) {
      const lower = name.toLowerCase()
      if (lower === 'authorization' || lower === 'host' || lower === 'content-type') continue
      if (CONTROL_CHARS.test(name) || CONTROL_CHARS.test(value))
        throw new ConnectorError('BAD_REQUEST', 'control char in static header')
      headers[name] = value
    }
  }
  let body: string | undefined
  const allowsBody = req.method !== 'GET' && req.method !== 'HEAD'
  if (allowsBody && req.bodyTemplate !== undefined) {
    const bodyValue = materializeTemplate(req.bodyTemplate, mat, 0)
    body = JSON.stringify(bodyValue)
    headers['content-type'] = 'application/json'
  }

  return { method: req.method, origin, path, query, targetUrl, headers, body }
}

/**
 * 脱敏 plan 投影:method/origin/path/query 键值(param 派生,非凭据)+ body 形状。
 * plan 本就是注入前产物(无凭据);传 secretValues 再抹一遍以防某 param 值恰为 secret。
 */
export function redactedPlan(
  plan: CanonicalRequestPlan,
  secretValues: readonly string[] = [],
): RedactedRequestPlan {
  return {
    method: plan.method,
    origin: plan.origin,
    path: redactSecrets(plan.path, secretValues),
    query: plan.query.map(([k, v]) => [k, redactSecrets(v, secretValues)] as [string, string]),
    hasBody: plan.body !== undefined,
    bodyBytes: plan.body ? Buffer.byteLength(plan.body, 'utf8') : 0,
  }
}
