/**
 * 连接器 Contract 内核 · 编译器(RFC §2/§3/§4/§6.1/§10)。
 *
 * `compileSpec(rawSpec, securityDecision)` → ExecContract:**纯确定性**(同输入同输出,
 * 无 env/无时间/无随机)。步骤:
 *   ① ConnectorSpec schema 严格校验 + auth 按 authMode 权威逐字段校验 + originMode↔authMode 一致性
 *   ② spec_hash = sha256(canonical(rawSpec))
 *   ③ 从 securityDecision 取受众 origin(fixed-reviewed 规范化)+ 每 action 的 effect
 *      (含 safe-read-non-get 例外:非 GET 默认 write,仅 reviewer 签且 method∉{DELETE,PUT,PATCH} 才 read)
 *   ④ resolve apiCredentialPlacements(判别联合:保留头禁令 + source 有限枚举)
 *   ⑤ exec_contract_hash = sha256(canonical(execContract))
 *
 * securityDecision 是 reviewer 签的输入(受众 origin + per-action effect override),
 * **不是**作者声明。effect 只出现在 ExecContract。
 */

import { Value } from '@sinclair/typebox/value'
import { normalizeHttpsOrigin } from '../outboundPolicy.js'
import { canonicalSha256Hex } from './canonical.js'
import {
  AUTH_SCHEMAS,
  type ApiCredentialPlacementT,
  ConnectorSpec,
  ConnectorSpecError,
  type ConnectorSpecT,
  type CredentialAudiencePolicyT,
  type EffectValue,
  ExecContract,
  type ExecContractT,
  type HttpMethodValue,
  PROTOCOL_AUTH_MODES,
  SecurityDecision,
  type SecurityDecisionT,
  type TokenAcquisitionT,
  type TokenOutputsT,
} from './types.js'

/** token-exchange 交换请求可引用的**规范凭据 source 名**(引擎注入进交换体/basic-auth)。 */
const TOKEN_EXCHANGE_SOURCES: ReadonlySet<string> = new Set([
  'refresh_token',
  'client_id',
  'client_secret',
])

/** 编译器语义版本(改任何编译规则/输出结构必须 bump → 新 exec_contract_hash)。 */
export const COMPILER_VERSION = 1
/** auth 契约语义版本(三表 pin;换 auth 语义须 bump)。 */
export const AUTH_CONTRACT_VERSION = 1
/** credentialPipeline 最大深度(有界 DAG,§3.4)。 */
const MAX_PIPELINE_DEPTH = 4

/**
 * slice① 无内置 builtin 注册表 → 任何 transform/operation 引用一律 fail-closed。
 * 白名单随 builtin 层(切片②)落地时收口(RFC §5)。
 */
const BUILTIN_ALLOWLIST: ReadonlySet<string> = new Set()

const RESERVED_HEADERS: ReadonlySet<string> = new Set(['authorization', 'host'])

/** 原型污染键(P1-6):递归拒 + 执行期须 null-prototype materialize(后续切片)。 */
const POLLUTION_KEYS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor'])
const MAX_WALK_DEPTH = 64

/** params/result 里禁的 JSON Schema 关键字(P0-4:禁远程 $ref/不受控扩展)。 */
const FORBIDDEN_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  '$ref',
  '$dynamicRef',
  '$recursiveRef',
  '$id',
  '$anchor',
  '$dynamicAnchor',
])
const MAX_SCHEMA_DEPTH = 32

export interface CompiledContract {
  execContract: ExecContractT
  specHash: string
  execContractHash: string
}

// ─── 原型污染:递归拒 __proto__/prototype/constructor 键(P1-6) ──────────────

function assertNoPollutionKeysDeep(value: unknown, depth = 0): void {
  if (depth > MAX_WALK_DEPTH)
    throw new ConnectorSpecError('SPEC_SCHEMA_INVALID', 'spec nesting too deep')
  if (Array.isArray(value)) {
    for (const it of value) assertNoPollutionKeysDeep(it, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    // JSON.parse 生成的 "__proto__" 是自有可枚举属性,Object.keys 可见 → 先检测再拒,
    // 绝不读它的值(不触发原型 getter)。
    for (const k of Object.keys(value as Record<string, unknown>)) {
      if (POLLUTION_KEYS.has(k))
        throw new ConnectorSpecError('POLLUTION_KEY', `forbidden object key '${k}'`)
      assertNoPollutionKeysDeep((value as Record<string, unknown>)[k], depth + 1)
    }
  }
}

// ─── params/result schema 安全子集(P0-4) ───────────────────────────────────

function assertSafeSchemaDeep(node: unknown, depth: number): void {
  if (depth > MAX_SCHEMA_DEPTH) throw new ConnectorSpecError('UNSAFE_SCHEMA', 'schema too deep')
  if (Array.isArray(node)) {
    for (const it of node) assertSafeSchemaDeep(it, depth + 1)
    return
  }
  if (node !== null && typeof node === 'object') {
    for (const k of Object.keys(node as Record<string, unknown>)) {
      if (FORBIDDEN_SCHEMA_KEYS.has(k))
        throw new ConnectorSpecError('UNSAFE_SCHEMA', `schema keyword '${k}' not allowed`)
      assertSafeSchemaDeep((node as Record<string, unknown>)[k], depth + 1)
    }
  }
}

/**
 * params 顶层必须 object + strict(支撑 `{/params/x}` 占位符解析与严格入参)。
 * result 顶层 object + allowlist,**或**顶层数组(list 端点:GitHub /user/repos、issues、commits 等
 * 一整类返回顶层数组的只读 REST;运行时 projectResultAllowlist 早已按 items 递归投影)——此时 items
 * 必须是严格 object allowlist(additionalProperties:false),深度/污染键/字节上限护栏与 object 同。
 */
function assertSafeActionSchema(schema: unknown, kind: 'params' | 'result'): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema))
    throw new ConnectorSpecError('UNSAFE_SCHEMA', `${kind} schema must be a JSON Schema object`)
  const s = schema as Record<string, unknown>
  if (kind === 'result' && s.type === 'array') {
    const items = s.items
    if (items === null || typeof items !== 'object' || Array.isArray(items))
      throw new ConnectorSpecError('UNSAFE_SCHEMA', 'result array items must be a JSON Schema object')
    const it = items as Record<string, unknown>
    if (it.type !== 'object')
      throw new ConnectorSpecError('UNSAFE_SCHEMA', "result array items type must be 'object'")
    if (it.additionalProperties !== false)
      throw new ConnectorSpecError(
        'UNSAFE_SCHEMA',
        'result array items must be strict (additionalProperties:false)',
      )
    assertSafeSchemaDeep(schema, 0)
    return
  }
  if (s.type !== 'object')
    throw new ConnectorSpecError('UNSAFE_SCHEMA', `${kind} schema top-level type must be 'object'`)
  if (s.additionalProperties !== false)
    throw new ConnectorSpecError(
      'UNSAFE_SCHEMA',
      `${kind} schema top-level must be strict (additionalProperties:false)`,
    )
  assertSafeSchemaDeep(schema, 0)
}

// ─── schema 校验 helpers ────────────────────────────────────────────────────

function firstError(schema: Parameters<typeof Value.Errors>[0], v: unknown): string {
  const e = Value.Errors(schema, v).First()
  return e ? `${e.path}: ${e.message}` : 'schema mismatch'
}

// ─── origin 规范化(fixed-reviewed) ─────────────────────────────────────────

/** 精确 https origin+port;禁 userinfo/path/query/非https/大小写/尾点/`..`/wildcard。 */
// origin 归一化走 outboundPolicy 的**单一权威** normalizeHttpsOrigin(与 driver 逐字节一致);
// 仅把出站错误类型换成 spec 上下文的 BAD_ORIGIN(含 IP 字面量拒:audience origin 必须是 DNS 域)。
function normalizeOrigin(raw: string): string {
  try {
    return normalizeHttpsOrigin(raw)
  } catch (e) {
    throw new ConnectorSpecError('BAD_ORIGIN', e instanceof Error ? e.message : `bad origin: ${raw}`)
  }
}

function normalizeAudience(a: CredentialAudiencePolicyT): CredentialAudiencePolicyT {
  const norm = (xs: string[]): string[] => {
    // 稳定去重(保序):同 origin 只留一次,确定性。
    const seen = new Set<string>()
    const out: string[] = []
    for (const raw of xs) {
      const o = normalizeOrigin(raw)
      if (seen.has(o)) continue
      seen.add(o)
      out.push(o)
    }
    return out
  }
  return {
    authorizationOrigins: norm(a.authorizationOrigins),
    tokenOrigins: norm(a.tokenOrigins),
    apiOrigins: norm(a.apiOrigins),
    unauthenticatedUploadOrigins: norm(a.unauthenticatedUploadOrigins),
  }
}

// ─── request 校验(transform 前;pathTemplate 深层安全) ──────────────────────

/** 静态请求头:名字禁保留头(authorization/host/content-type)+ 名/值禁 CRLF/控制符。 */
const STATIC_HEADER_RESERVED: ReadonlySet<string> = new Set(['authorization', 'host', 'content-type'])
function validateStaticHeaders(headers: Record<string, string> | undefined): void {
  if (headers === undefined) return
  for (const [name, value] of Object.entries(headers)) {
    if (STATIC_HEADER_RESERVED.has(name.toLowerCase()))
      throw new ConnectorSpecError('RESERVED_HEADER', `static header '${name}' is reserved`)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: block CRLF/control in header value
    if (/[\x00-\x1f\x7f]/.test(value))
      throw new ConnectorSpecError('BAD_PLACEMENT', `static header '${name}' value has control char`)
  }
}

/** identity 的 JSON pointer(指向 probe 结果):以 / 开头、无控制符、段不得为污染键。 */
function assertResultPointer(ptr: string): void {
  if (!ptr.startsWith('/'))
    throw new ConnectorSpecError('IDENTITY_INVALID', 'result pointer must start with /')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally block CRLF/control
  if (/[\x00-\x1f\x7f]/.test(ptr))
    throw new ConnectorSpecError('IDENTITY_INVALID', 'control char in result pointer')
  for (const seg of ptr.split('/').slice(1)) {
    const unescaped = seg.replace(/~1/g, '/').replace(/~0/g, '~')
    if (POLLUTION_KEYS.has(unescaped))
      throw new ConnectorSpecError('IDENTITY_INVALID', 'pollution segment in result pointer')
  }
}

function validatePath(path: string, paramsSchema: unknown): void {
  if (!path.startsWith('/')) throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'must start with /')
  if (path.includes('//'))
    throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'no // (host injection)')
  if (path.includes('://')) throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'no scheme')
  if (path.includes('\\')) throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'no backslash')
  if (path.includes('@')) throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'no userinfo')
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally block CRLF/control
  if (/[\x00-\x1f\x7f]/.test(path))
    throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'no control chars/CRLF')
  if (/(^|\/)\.\.(\/|$)/.test(path))
    throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'no .. segment')
  // path 占位符 `{<json-pointer>}`:每个必须是 `/params/<顶层标量字段>` 且该字段在 params schema
  // 已声明(编译期拦截拼错/越权指针,driver 运行期兜底 fail-closed 前置到这里,§3 path 参数)。
  const props =
    paramsSchema !== null &&
    typeof paramsSchema === 'object' &&
    typeof (paramsSchema as { properties?: unknown }).properties === 'object'
      ? ((paramsSchema as { properties: Record<string, unknown> }).properties ?? {})
      : {}
  const declared = new Set(Object.keys(props))
  for (const m of path.matchAll(/\{([^}]*)\}/g)) {
    const ptr = m[1] ?? ''
    const mm = /^\/params\/([^/]+)$/.exec(ptr)
    if (mm === null)
      throw new ConnectorSpecError(
        'BAD_PATH_PLACEHOLDER',
        `path placeholder must be {/params/<field>}: got {${ptr}}`,
      )
    const field = decodeURIComponent(mm[1]!.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (!declared.has(field) || field === '__proto__' || field === 'constructor')
      throw new ConnectorSpecError(
        'BAD_PATH_PLACEHOLDER',
        `path placeholder /params/${field} not a declared params field`,
      )
  }
  // 花括号必须成对(防残留 `{` / `}`)
  const open = (path.match(/\{/g) ?? []).length
  const close = (path.match(/\}/g) ?? []).length
  if (open !== close)
    throw new ConnectorSpecError('BAD_PATH_TEMPLATE', 'unbalanced {} in path template')
}

// ─── placement 判别联合的跨字段校验(§3.3) ─────────────────────────────────

function validatePlacement(p: ApiCredentialPlacementT): void {
  if (p.placement === 'authorization-bearer') {
    // 唯一可写 Authorization 的类型;只能来自 access_token。
    if (p.source !== 'access_token')
      throw new ConnectorSpecError('BAD_PLACEMENT', 'authorization-bearer requires access_token')
    return
  }
  if (p.placement === 'header') {
    const lower = p.name.toLowerCase()
    if (RESERVED_HEADERS.has(lower))
      throw new ConnectorSpecError('RESERVED_HEADER', `header ${p.name} is reserved`)
    if (p.valuePrefix !== undefined && /[\r\n]/.test(p.valuePrefix))
      throw new ConnectorSpecError('BAD_PLACEMENT', 'valuePrefix contains CRLF')
    return
  }
  // query placement:无 prefix;source 已由 schema 限制(不含 client_secret/refresh_token)。
}

/** 该 connector 的 API 凭据注入点(auth 内嵌 §3.3;协议适配器无)。 */
function extractPlacements(
  authMode: ConnectorSpecT['authMode'],
  auth: unknown,
): ApiCredentialPlacementT[] {
  if (PROTOCOL_AUTH_MODES.has(authMode)) return []
  const raw = (auth as { apiCredentialPlacements?: ApiCredentialPlacementT[] })
    .apiCredentialPlacements
  const list = raw ?? []
  for (const p of list) validatePlacement(p)
  return list
}

/**
 * placement 的 `auxiliary.X` source 必须解析到**已审签的** tokenOutputs.auxiliary.X(P1-5③)。
 * 用 Set(非对象)避免原型键;无 tokenOutputs 时任何 auxiliary 引用即失败。
 */
function validateAuxiliaryResolution(
  placements: ApiCredentialPlacementT[],
  tokenOutputs: TokenOutputsT | undefined,
): void {
  const auxKeys = new Set(Object.keys(tokenOutputs?.auxiliary ?? {}))
  for (const p of placements) {
    const m = /^auxiliary\.(.+)$/.exec(p.source)
    if (m && !auxKeys.has(m[1]))
      throw new ConnectorSpecError(
        'UNKNOWN_AUXILIARY',
        `placement source auxiliary.${m[1]} not in signed tokenOutputs.auxiliary`,
      )
  }
}

// ─── credentialPipeline:唯一 id / dependsOn 存在 / 无环 / 有界深度 ───────────

function validatePipeline(pipeline: ConnectorSpecT['credentialPipeline']): void {
  const nodes = pipeline.nodes
  const byId = new Map<string, (typeof nodes)[number]>()
  for (const n of nodes) {
    if (byId.has(n.id)) throw new ConnectorSpecError('PIPELINE_INVALID', `duplicate slot ${n.id}`)
    byId.set(n.id, n)
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!byId.has(dep)) throw new ConnectorSpecError('PIPELINE_INVALID', `unknown dep ${dep}`)
      if (dep === n.id) throw new ConnectorSpecError('PIPELINE_CYCLE', `self-dep ${n.id}`)
    }
  }
  // DFS 环检测 + 最长路径深度。
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const n of nodes) color.set(n.id, WHITE)
  const depthMemo = new Map<string, number>()
  const dfs = (id: string): number => {
    color.set(id, GRAY)
    let maxChild = 0
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      const c = color.get(dep)
      if (c === GRAY) throw new ConnectorSpecError('PIPELINE_CYCLE', `cycle at ${id}->${dep}`)
      if (c === WHITE) dfs(dep)
      maxChild = Math.max(maxChild, depthMemo.get(dep) ?? 0)
    }
    color.set(id, BLACK)
    const d = maxChild + 1
    depthMemo.set(id, d)
    if (d > MAX_PIPELINE_DEPTH)
      throw new ConnectorSpecError('PIPELINE_INVALID', `pipeline depth > ${MAX_PIPELINE_DEPTH}`)
    return d
  }
  for (const n of nodes) if (color.get(n.id) === WHITE) dfs(n.id)
}

// ─── effect 决策(§4:非 GET 默认 write;safe-read-non-get 例外) ─────────────

function resolveEffect(
  method: HttpMethodValue,
  decision: { effect?: EffectValue; safeReadNonGet?: boolean } | undefined,
): EffectValue {
  const getLike = method === 'GET' || method === 'HEAD'
  if (getLike) {
    // GET/HEAD 默认 read;reviewer 可升级(write/send 非降级,安全)。
    return decision?.effect ?? 'read'
  }
  // 非 GET:默认 write。
  if (decision?.safeReadNonGet) {
    // safe-read-non-get override:DELETE/PUT/PATCH 不可授予(§1.3)。
    if (method === 'DELETE' || method === 'PUT' || method === 'PATCH')
      throw new ConnectorSpecError(
        'EFFECT_OVERRIDE_FORBIDDEN',
        `safe-read override not allowed for ${method}`,
      )
    if (decision.effect !== undefined && decision.effect !== 'read')
      throw new ConnectorSpecError(
        'EFFECT_OVERRIDE_FORBIDDEN',
        'safeReadNonGet conflicts with declared effect',
      )
    return 'read'
  }
  if (decision?.effect === 'read')
    // 非 GET 想签 read 必须走 safeReadNonGet(作者/reviewer 不能静默降级)。
    throw new ConnectorSpecError(
      'EFFECT_OVERRIDE_FORBIDDEN',
      'read effect on non-GET requires safeReadNonGet override',
    )
  return decision?.effect ?? 'write' // 'write' | 'send'
}

// ─── 编译主入口 ─────────────────────────────────────────────────────────────

export function compileSpec(rawSpec: unknown, securityDecision: unknown): CompiledContract {
  // ① schema 校验
  if (!Value.Check(ConnectorSpec, rawSpec))
    throw new ConnectorSpecError('SPEC_SCHEMA_INVALID', firstError(ConnectorSpec, rawSpec))
  const spec = rawSpec as ConnectorSpecT

  // 原型污染:schema 允许 __proto__ 作 FieldName/QueryName/AuxKey,此处递归拒(P1-6)。
  assertNoPollutionKeysDeep(rawSpec)

  if (!Value.Check(SecurityDecision, securityDecision))
    throw new ConnectorSpecError(
      'SECURITY_DECISION_INVALID',
      firstError(SecurityDecision, securityDecision),
    )
  const decision = securityDecision as SecurityDecisionT

  // auth 按 authMode 权威逐字段校验(schema 层是粗门)。
  const authSchema = AUTH_SCHEMAS[spec.authMode]
  if (!Value.Check(authSchema, spec.auth))
    throw new ConnectorSpecError('AUTH_SCHEMA_INVALID', firstError(authSchema, spec.auth))

  // originMode ↔ authMode 一致性(§1.2:user-bound 仅内置 adapter)。
  if (spec.originMode === 'user-bound-webdav' && spec.authMode !== 'webdav-basic')
    throw new ConnectorSpecError('ORIGIN_MODE_MISMATCH', 'user-bound-webdav requires webdav-basic')
  if (spec.originMode === 'user-bound-imap-smtp' && spec.authMode !== 'imap-smtp')
    throw new ConnectorSpecError('ORIGIN_MODE_MISMATCH', 'user-bound-imap-smtp requires imap-smtp')
  if (spec.originMode === 'fixed-reviewed' && PROTOCOL_AUTH_MODES.has(spec.authMode))
    throw new ConnectorSpecError('ORIGIN_MODE_MISMATCH', 'protocol adapter must be user-bound')

  // ② spec_hash
  const specHash = canonicalSha256Hex(spec)

  // ③ 受众 policy
  let audience: CredentialAudiencePolicyT
  if (spec.originMode === 'fixed-reviewed') {
    if (!decision.audience)
      throw new ConnectorSpecError('AUDIENCE_MISSING', 'fixed-reviewed requires reviewed audience')
    audience = normalizeAudience(decision.audience)
    if (audience.apiOrigins.length === 0)
      throw new ConnectorSpecError('AUDIENCE_MISSING', 'fixed-reviewed requires >=1 apiOrigin')
  } else {
    // user-bound:origin 用户 bind 时冻结,契约里为空(§1.2)。
    audience = {
      authorizationOrigins: [],
      tokenOrigins: [],
      apiOrigins: [],
      unauthenticatedUploadOrigins: [],
    }
  }

  // token-exchange:token 获取配置从 auth 提取搬进契约(引擎据此换 token);需 reviewer 给
  // tokenOrigins(交换端点受众);credentialFieldNames 值必须是引擎可注入的规范凭据 source。
  let tokenAcquisition: TokenAcquisitionT | undefined
  if (spec.authMode === 'token-exchange') {
    const auth = spec.auth as unknown as {
      exchangeRequest: TokenAcquisitionT['exchangeRequest']
      tokenResponse: TokenAcquisitionT['tokenResponse']
    }
    if (audience.tokenOrigins.length === 0)
      throw new ConnectorSpecError('AUDIENCE_MISSING', 'token-exchange requires >=1 tokenOrigin')
    // token 端点路径:静态(无占位符 → 传空 params schema,任何 {…} 即拒)+ 常规路径安全形状。
    validatePath(auth.exchangeRequest.path, { properties: {} })
    for (const src of Object.values(auth.exchangeRequest.credentialFieldNames)) {
      if (!TOKEN_EXCHANGE_SOURCES.has(src))
        throw new ConnectorSpecError(
          'AUTH_SCHEMA_INVALID',
          `exchange credential source '${src}' not injectable`,
        )
    }
    tokenAcquisition = {
      exchangeRequest: auth.exchangeRequest,
      tokenResponse: auth.tokenResponse,
    }
  }

  // pipeline
  validatePipeline(spec.credentialPipeline)
  const slotById = new Map(spec.credentialPipeline.nodes.map((n) => [n.id, n]))

  // action id 唯一(P1-5①)。
  const actionIds = new Set<string>()
  for (const a of spec.actions) {
    if (actionIds.has(a.id))
      throw new ConnectorSpecError('DUPLICATE_ACTION_ID', `duplicate action id ${a.id}`)
    actionIds.add(a.id)
  }
  // SecurityDecision 的 action key 必须指向存在的 action(P1-5①:防对着不存在的 action 签)。
  if (decision.actions) {
    for (const k of Object.keys(decision.actions)) {
      if (!actionIds.has(k))
        throw new ConnectorSpecError(
          'UNKNOWN_DECISION_ACTION',
          `decision action '${k}' has no action`,
        )
    }
  }

  // ④ placements(connector 级)+ auxiliary source 解析(P1-5③)。
  const placements = extractPlacements(spec.authMode, spec.auth)
  const tokenOutputs = (spec.auth as { tokenOutputs?: TokenOutputsT }).tokenOutputs
  validateAuxiliaryResolution(placements, tokenOutputs)

  // 逐 action
  const execActions = spec.actions.map((a) => {
    // builtin 引用一律 fail-closed(slice① 无 builtin 层)。
    for (const b of [a.requestTransform, a.operation, a.resultTransform]) {
      if (b !== undefined && !BUILTIN_ALLOWLIST.has(b))
        throw new ConnectorSpecError('BUILTIN_NOT_ALLOWED', `builtin '${b}' not in allowlist`)
    }
    validatePath(a.request.pathTemplate, a.params)
    validateStaticHeaders(a.request.staticHeaders)
    // usesSlot 必须存在 + api audience + 该 slot 的 authMode 与 connector authMode 一致(§3.4,P1-5④)。
    if (a.usesSlot !== undefined) {
      const node = slotById.get(a.usesSlot)
      if (node === undefined)
        throw new ConnectorSpecError('SLOT_UNKNOWN', `unknown slot ${a.usesSlot}`)
      if (node.audience !== 'api')
        throw new ConnectorSpecError(
          'SLOT_AUDIENCE_MISMATCH',
          `slot ${a.usesSlot} not api audience`,
        )
      if (node.authMode !== spec.authMode)
        throw new ConnectorSpecError(
          'SLOT_MODE_MISMATCH',
          `slot ${a.usesSlot} authMode ${node.authMode} != connector authMode ${spec.authMode}`,
        )
    }
    // params/result 限定安全 TypeBox 子集,签进 contract(P0-4)。
    assertSafeActionSchema(a.params, 'params')
    assertSafeActionSchema(a.result, 'result')
    const effect = resolveEffect(a.request.method, decision.actions?.[a.id])
    return {
      id: a.id,
      effect,
      request: a.request,
      params: a.params,
      result: a.result,
      apiCredentialPlacements: placements,
    }
  })

  // identity probe(可选,§bind):probeActionId 必须是已声明 read action;pointer 段拒污染/控制符
  // (schema 已保证 ^/ + 有界)。identity 随 spec 签进 contract → bind 服务单一权威。
  if (spec.identity !== undefined) {
    const probe = execActions.find((a) => a.id === spec.identity?.probeActionId)
    if (probe === undefined)
      throw new ConnectorSpecError(
        'IDENTITY_INVALID',
        `identity probeActionId '${spec.identity.probeActionId}' has no action`,
      )
    if (probe.effect !== 'read')
      throw new ConnectorSpecError(
        'IDENTITY_INVALID',
        `identity probe action '${probe.id}' must be read effect (got ${probe.effect})`,
      )
    assertResultPointer(spec.identity.accountKeyPointer)
    if (spec.identity.accountHintPointer !== undefined)
      assertResultPointer(spec.identity.accountHintPointer)
  }

  // ⑤ 组装 ExecContract + hash
  const execContract: ExecContractT = {
    spec_hash: specHash,
    auth_contract_version: decision.auth_contract_version ?? AUTH_CONTRACT_VERSION,
    authMode: spec.authMode,
    originMode: spec.originMode,
    credentialAudiencePolicy: audience,
    ...(hasTokenOutputs(spec.auth)
      ? {
          tokenOutputs: (spec.auth as { tokenOutputs: ExecContractT['tokenOutputs'] }).tokenOutputs,
        }
      : {}),
    ...(tokenAcquisition !== undefined ? { tokenAcquisition } : {}),
    credentialPipeline: spec.credentialPipeline,
    actions: execActions,
    ...(spec.identity !== undefined ? { identity: spec.identity } : {}),
  }

  // 自校验(编程错误 fail-closed)。
  if (!Value.Check(ExecContract, execContract))
    throw new ConnectorSpecError('EXEC_CONTRACT_INVALID', firstError(ExecContract, execContract))

  const execContractHash = canonicalSha256Hex(execContract)
  return { execContract, specHash, execContractHash }
}

function hasTokenOutputs(auth: unknown): boolean {
  return (
    typeof auth === 'object' &&
    auth !== null &&
    'tokenOutputs' in auth &&
    (auth as { tokenOutputs?: unknown }).tokenOutputs !== undefined
  )
}
