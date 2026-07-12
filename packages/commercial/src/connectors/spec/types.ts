/**
 * 连接器平台 · Contract 内核 —— 声明 schema(作者可写 draft)与编译产物 ExecContract
 * (执行唯一权威)的 TypeBox schema + TS 类型。P1 切片①(不接真实网络)。
 *
 * 权威:v5-connector-platform-rfc-2026-07-11.md §1/§2/§3/§6.1/§10。
 *
 * 信任模型地基(§1):
 *   - 声明作者(社区/AI)不可信;bodyTemplate/query 结构上只能引用 `params.*`,
 *     schema 层就拿不到 `credential.*`(见 `ParamPointer` + `TemplateValue` 判别联合)。
 *   - `effect`(read|write|send)只出现在 ExecContract,由安全 reviewer 签(不在
 *     ConnectorSpec —— 作者不能自报 readOnly)。
 *   - `apiCredentialPlacements` 判别联合(§3.3):唯有 `authorization-bearer` 能写
 *     Authorization;通用 header 永禁 Authorization/Host;source 有限枚举明确排除
 *     client_secret/refresh_token。
 *   - credentialPipeline DAG 节点**无 cacheKey 字段**(§3.4:cache key 引擎派生,
 *     不可声明,否则跨用户/app/generation 复用 token)。
 *
 * 所有对象 strict(additionalProperties:false)。
 */

import { type Static, type TObject, Type } from '@sinclair/typebox'

const strict = { additionalProperties: false } as const

// ─── 基础原语 ──────────────────────────────────────────────────────────────

/** connector slug / builtin id / slot id 通用形状。 */
const Slug = Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' })
const ActionId = Type.String({ pattern: '^[a-z][a-z0-9_-]{0,63}$' })
/** JSON Pointer(RFC6901,以 / 开头)→ 指向 identity probe **结果**里的字段;运行期解析兜底。 */
const ResultPointer = Type.String({ minLength: 1, maxLength: 256, pattern: '^/' })
const SlotId = Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' })
/** 内置 transform/operation 具名 id(白名单校验在编译器)。 */
const BuiltinId = Type.String({ pattern: '^[a-z][a-z0-9-]{1,63}$' })

/** sha256 hex(小写 64 位)。 */
export const Hex64 = Type.String({ pattern: '^[0-9a-f]{64}$' })

/** HTTP 方法枚举。 */
export const HttpMethod = Type.Union([
  Type.Literal('GET'),
  Type.Literal('HEAD'),
  Type.Literal('POST'),
  Type.Literal('PUT'),
  Type.Literal('PATCH'),
  Type.Literal('DELETE'),
])
export type HttpMethodValue = Static<typeof HttpMethod>

/**
 * JSON-Pointer **只指向 params.***(结构性封堵凭据外泄:必须以 `/params/` 开头,
 * 至少一段,段字符受限,禁 CRLF / `//` / userinfo)。拿不到 `/credential/…`。
 */
const ParamPointer = Type.String({
  pattern: '^/params(/(?:[A-Za-z0-9_.-]|~[01])+)+$',
  maxLength: 512,
})

/** 响应体 JSON-Pointer(token 输出/身份探针取值用;slice① 仅承载不解析)。 */
const ResponsePointer = Type.String({
  pattern: '^(/(?:[A-Za-z0-9_.-]|~[01])+)+$',
  maxLength: 512,
})

/**
 * 请求路径模板:必须以 `/` 起头、无空白(禁 CRLF)。深层安全(禁 `//host`/
 * `://`/userinfo/`..`/反斜杠)在编译器 `validateRequest` 权威校验。
 */
const PathTemplate = Type.String({ pattern: '^/\\S{0,1024}$', maxLength: 1024 })

/** query 参数名 / body 字段名。 */
const QueryName = Type.String({ pattern: '^[A-Za-z0-9_.-]{1,64}$' })
const FieldName = Type.String({ pattern: '^[A-Za-z0-9_.-]{1,128}$' })
/** HTTP header 名(保留头 Authorization/Host 的禁令在编译器,大小写不敏感)。 */
const HeaderName = Type.String({ pattern: '^[A-Za-z0-9-]{1,64}$' })
/** 厂商 scheme 前缀(如 `Access-Token `):可打印 ASCII,禁控制字符/CRLF。 */
const ValuePrefix = Type.String({ pattern: '^[\\x20-\\x7E]{0,32}$' })
/** 精确 https origin(+可选端口);编译器用 URL 规范化并做端口/host 校验。 */
const OriginString = Type.String({
  pattern: '^https://[a-z0-9.-]{1,253}(:[0-9]{1,5})?$',
  maxLength: 300,
})

/** JSON 标量(bodyTemplate 字面量)。 */
const JsonScalar = Type.Union([
  Type.String({ maxLength: 8192 }),
  Type.Number(),
  Type.Boolean(),
  Type.Null(),
])

/**
 * 作者提交的 params/result 是序列化后的 TypeBox(JSON Schema)对象。slice① 只承载
 * 进 spec_hash;其内部严格性(strict/allowlist)在执行期(后续切片)按其自身 schema
 * 生效。此处只保证它是个对象。
 */
const JsonSchemaObject = Type.Object({}, { additionalProperties: true })

// ─── bodyTemplate:判别联合模板(凭据外泄的结构性封堵) ──────────────────────

/**
 * 模板值:动态引用只能是 `ref: ParamPointer`(指向 params.*),字面量走 `lit`。
 * 由于不存在 "credential 引用" 的构造子,声明层拿不到凭据 —— 这是 §1.1/§2 的
 * 结构性封堵,不是运行时检查。
 */
export const TemplateValue = Type.Recursive((Self) =>
  Type.Union([
    Type.Object({ lit: JsonScalar }, strict),
    Type.Object({ ref: ParamPointer }, strict),
    Type.Object({ obj: Type.Record(FieldName, Self) }, strict),
    Type.Object({ arr: Type.Array(Self, { maxItems: 64 }) }, strict),
  ]),
)
export type TemplateValueT = Static<typeof TemplateValue>

// ─── request ───────────────────────────────────────────────────────────────

export const RequestSpec = Type.Object(
  {
    method: HttpMethod,
    pathTemplate: PathTemplate,
    query: Type.Optional(Type.Record(QueryName, ParamPointer)),
    bodyTemplate: Type.Optional(TemplateValue),
    // 静态请求头(非凭据):如 Notion-Version / Accept / X-GitHub-Api-Version。值为可打印 ASCII、
    // 无 CRLF;名字禁 Authorization/Host/Content-Type(编译器强制,凭据/SSRF/编码保留头不可被覆盖)。
    staticHeaders: Type.Optional(Type.Record(HeaderName, Type.String({ maxLength: 512 }))),
  },
  strict,
)
export type RequestSpecT = Static<typeof RequestSpec>

// ─── §3.3 类型化多凭据注入:apiCredentialPlacements 判别联合 ────────────────

/**
 * 凭据来源有限枚举 + 有界 auxiliary 输出。**明确不含** client_secret / refresh_token /
 * 任意原始 credential —— 它们永不能成为 API placement(§3.3)。
 */
const PlacementSource = Type.Union([
  Type.Literal('access_token'),
  Type.Literal('client_id'),
  Type.String({ pattern: '^auxiliary\\.[A-Za-z0-9_]{1,32}$' }),
])

export const ApiCredentialPlacement = Type.Union([
  // 唯一可写 Authorization 的普通认证类型;source 必须 access_token(编译器强制)。
  Type.Object({ source: PlacementSource, placement: Type.Literal('authorization-bearer') }, strict),
  // 通用 header:name 永禁 Authorization/Host(编译器,大小写不敏感);valuePrefix 有界无 CRLF。
  Type.Object(
    {
      source: PlacementSource,
      placement: Type.Literal('header'),
      name: HeaderName,
      valuePrefix: Type.Optional(ValuePrefix),
    },
    strict,
  ),
  // query placement:无 prefix,沿用 URL/日志脱敏。
  Type.Object(
    { source: PlacementSource, placement: Type.Literal('query'), name: QueryName },
    strict,
  ),
])
export type ApiCredentialPlacementT = Static<typeof ApiCredentialPlacement>

// ─── §3.3 tokenOutputs ──────────────────────────────────────────────────────

const AuxKey = Type.String({ pattern: '^[A-Za-z0-9_]{1,32}$' })

export const TokenOutputs = Type.Object(
  {
    accessToken: ResponsePointer,
    refreshToken: Type.Optional(ResponsePointer),
    expiresIn: Type.Optional(ResponsePointer),
    auxiliary: Type.Optional(
      Type.Record(
        AuxKey,
        Type.Object({ pointer: ResponsePointer, type: Type.Literal('bounded-string') }, strict),
      ),
    ),
  },
  strict,
)
export type TokenOutputsT = Static<typeof TokenOutputs>

// ─── authMode(§3 七种) ─────────────────────────────────────────────────────

export const AuthMode = Type.Union([
  Type.Literal('static-token'),
  Type.Literal('oauth2-auth-code'),
  Type.Literal('token-exchange'),
  Type.Literal('hmac-signing'),
  Type.Literal('oauth1a'),
  Type.Literal('imap-smtp'),
  Type.Literal('webdav-basic'),
])
export type AuthModeValue = Static<typeof AuthMode>

// ─── §3.4 credentialPipeline(有限 DAG,节点无 cacheKey) ─────────────────────

const CredentialSubject = Type.Union([Type.Literal('app'), Type.Literal('user')])
const CredentialAudience = Type.Union([
  Type.Literal('authorization'),
  Type.Literal('token'),
  Type.Literal('api'),
  Type.Literal('upload'),
])
export type CredentialAudienceValue = Static<typeof CredentialAudience>

/** DAG 节点:**无 cacheKey 字段**(strict 保证声明层无法指定 cache key)。 */
export const CredentialPipelineNode = Type.Object(
  {
    id: SlotId,
    authMode: AuthMode,
    subject: CredentialSubject,
    audience: CredentialAudience,
    dependsOn: Type.Optional(Type.Array(SlotId, { maxItems: 8 })),
  },
  strict,
)
export const CredentialPipeline = Type.Object(
  { nodes: Type.Array(CredentialPipelineNode, { maxItems: 8 }) },
  strict,
)
export type CredentialPipelineT = Static<typeof CredentialPipeline>

// ─── originMode(§1.2) ──────────────────────────────────────────────────────

export const OriginMode = Type.Union([
  Type.Literal('fixed-reviewed'),
  Type.Literal('user-bound-webdav'),
  Type.Literal('user-bound-imap-smtp'),
])
export type OriginModeValue = Static<typeof OriginMode>

// ─── auth(按 authMode 的有限网络配置;placements/tokenOutputs 内嵌 §3.3) ─────
//
// authMode 是单一权威;auth 在 ConnectorSpec 里放宽为各变体的 Union,由编译器
// 用 AUTH_SCHEMAS[authMode] 做**权威**逐字段校验(schema 层是粗门,编译器是收口)。

const StaticTokenAuth = Type.Object(
  {
    // 静态令牌注入(Notion-internal / 语雀 / GitHub-PAT):值来自 secret,
    // placement 决定注入位置(typ. authorization-bearer 或自定义 header)。
    apiCredentialPlacements: Type.Array(ApiCredentialPlacement, { minItems: 1, maxItems: 8 }),
  },
  strict,
)

const ClientAuth = Type.Union([Type.Literal('basic'), Type.Literal('form'), Type.Literal('json')])
const Encoding = Type.Union([
  Type.Literal('query'),
  Type.Literal('json'),
  Type.Literal('form'),
  Type.Literal('basic-auth'),
])

/**
 * token 交换请求形状(**单一定义**:TokenExchangeAuth 与 ExecContract.tokenAcquisition 共用,
 * 消除漂移)。`path`=token 端点路径(作者声明,发往 reviewer 批准的 tokenOrigin;编译期校验形状);
 * credentialFieldNames:交换请求字段名 → 规范凭据 source 名(引擎注入进 body/basic-auth)。
 */
export const ExchangeRequestSpec = Type.Object(
  {
    method: HttpMethod,
    path: Type.String({ minLength: 1, maxLength: 1024, pattern: '^/' }),
    encoding: Encoding,
    credentialFieldNames: Type.Record(QueryName, Type.String({ minLength: 1, maxLength: 64 })),
    staticFields: Type.Optional(Type.Record(QueryName, Type.String({ maxLength: 512 }))),
    grantValue: Type.Optional(Type.String({ maxLength: 128 })),
  },
  strict,
)
export const TokenResponseSpec = Type.Object(
  {
    successPredicate: Type.Optional(ResponsePointer),
    // token/expires 指针的**唯一权威** = tokenOutputs(不在此重复,P1-5②)。
    providerErrorCodePointer: Type.Optional(ResponsePointer),
  },
  strict,
)

/**
 * oauth2 授权码流的**网络配置字段**(非凭据):authorize/token/refresh 端点 + scope/pkce/refresh 语义。
 * **单一定义**:作者声明 Oauth2Auth = 这些 config 字段 + tokenOutputs + apiCredentialPlacements;
 * 而 ExecContract.oauth2 只承载 config 字段(tokenOutputs/placements 在 ExecContract 上另有权威:
 * tokenOutputs=ExecContract.tokenOutputs;placements 经 extractPlacements 进 action)。两处共用这份
 * props 消除漂移。
 */
/**
 * OAuth client 凭据的**供给模式**(作者声明,签进契约 —— 运行期不可配、不可被请求覆盖)。
 *
 *   'byoa'     用户自带 OAuth App:用户去 provider 后台注册应用,把 client_id/client_secret
 *              填进授权表单 → 进加密 pending draft → 回调用它换 token。
 *   'platform' 平台注册 OAuth App:凭据存平台表(connector_platform_oauth_apps,0136),
 *              用户点一下就授权,什么都不填。
 *
 * **为什么 'platform' 不构成提权**(安全推理,必须理解后再改):
 *   作者(可能是任意市场发布者)在自己的 spec 里写 'platform',**并不能凭空获得任何平台凭据** ——
 *   platform 模式下的 client 凭据**只有 admin 显式 provision(admin API 往 0136 表写一行)才存在**。
 *   没 provision 的 slug 走 platform 分支一律 fail-closed:oauth/start 返 503 OAUTH_NOT_CONFIGURED,
 *   catalog 甚至不展示该连接器。也就是说:**admin provisioning 本身就是那道信任闸**,
 *   声明 'platform' 至多是"向 admin 表达一个诉求",授权与否 100% 由 admin 决定。
 *   另一侧的对称保证:platform 模式的 client_secret **绝不复制进用户连接袋**
 *   (storedBagSources 只留 access_token/refresh_token),secret 只活在平台表 + 发往 token origin
 *   的那一次交换请求里。
 */
const ClientProvisioning = Type.Union([Type.Literal('byoa'), Type.Literal('platform')])
export type ClientProvisioningT = Static<typeof ClientProvisioning>

const Oauth2ConfigProps = {
  authorizeEndpoint: Type.String({ minLength: 1, maxLength: 1024 }),
  tokenEndpoint: Type.String({ minLength: 1, maxLength: 1024 }),
  refreshEndpoint: Type.Optional(Type.String({ maxLength: 1024 })),
  revokeEndpoint: Type.Optional(Type.String({ maxLength: 1024 })),
  /** client 凭据供给模式(**必填**,strict:作者必须显式表态,不给隐式默认值)。 */
  clientProvisioning: ClientProvisioning,
  clientAuth: ClientAuth,
  scopeSeparator: Type.String({ minLength: 1, maxLength: 4 }),
  scopes: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { maxItems: 64 })),
  fixedExtraParams: Type.Optional(Type.Record(QueryName, Type.String({ maxLength: 512 }))),
  // token/refresh/expires 指针的**唯一权威** = tokenOutputs(不在此重复声明,P1-5②)。
  providerErrorCodePointer: Type.Optional(ResponsePointer),
  refreshRotation: Type.Boolean(),
  refreshEncoding: Type.Union([Type.Literal('form'), Type.Literal('json')]),
  refreshFieldNames: Type.Optional(Type.Record(QueryName, Type.String({ maxLength: 64 }))),
  pkce: Type.Union([Type.Literal('required'), Type.Literal('optional')]),
} as const

/**
 * §3 oauth2 授权码流配置载体(签进 ExecContract.oauth2)。引擎 `buildAuthorizeUrl` /
 * `exchangeAuthCode` 据此组授权 URL / 换 token(凭据 code/client_secret/code_verifier 经 body /
 * basic-auth 头注入,绝不进声明模板、绝不进 authorize URL)。
 */
export const Oauth2Config = Type.Object(Oauth2ConfigProps, strict)
export type Oauth2ConfigT = Static<typeof Oauth2Config>

const Oauth2Auth = Type.Object(
  {
    ...Oauth2ConfigProps,
    tokenOutputs: TokenOutputs,
    apiCredentialPlacements: Type.Array(ApiCredentialPlacement, { minItems: 1, maxItems: 8 }),
  },
  strict,
)

const TokenExchangeAuth = Type.Object(
  {
    exchangeRequest: ExchangeRequestSpec,
    tokenResponse: TokenResponseSpec,
    tokenOutputs: TokenOutputs,
    apiCredentialPlacements: Type.Array(ApiCredentialPlacement, { minItems: 1, maxItems: 8 }),
  },
  strict,
)

const HmacAuth = Type.Object(
  {
    subAlgorithm: Type.Union([
      Type.Literal('aliyun-acs3'),
      Type.Literal('tencent-tc3'),
      Type.Literal('wps-3'),
      Type.Literal('wps-2'),
      Type.Literal('ynote-hmac'),
    ]),
    service: Type.Optional(Type.String({ maxLength: 64 })),
    region: Type.Optional(Type.String({ maxLength: 64 })),
    endpoint: Type.Optional(Type.String({ maxLength: 1024 })),
    signatureHeaderScheme: Type.Optional(Type.String({ maxLength: 64 })),
    apiCredentialPlacements: Type.Optional(Type.Array(ApiCredentialPlacement, { maxItems: 8 })),
  },
  strict,
)

const Oauth1aAuth = Type.Object(
  {
    requestTokenEndpoint: Type.Optional(Type.String({ maxLength: 1024 })),
    authorizeEndpoint: Type.String({ minLength: 1, maxLength: 1024 }),
    accessTokenEndpoint: Type.String({ minLength: 1, maxLength: 1024 }),
    signatureMethod: Type.Union([Type.Literal('HMAC-SHA1')]),
    apiCredentialPlacements: Type.Optional(Type.Array(ApiCredentialPlacement, { maxItems: 8 })),
  },
  strict,
)

/** 协议适配器:origin/host 用户 bind 时冻结(§1.2 user-bound);无 HTTP placement。 */
const ImapSmtpAuth = Type.Object({}, strict)
const WebdavBasicAuth = Type.Object({}, strict)

/**
 * §5 token 获取执行配置(签进 ExecContract):token-exchange / oauth2 refresh 用。作者声明的
 * exchangeRequest/tokenResponse 是网络配置(非凭据),编译器从 spec.auth 提取搬进契约,引擎据此
 * 向 **token 受众** origin 换取 access_token(凭据在 body/basic-auth 里,绝不进声明模板)。
 * credentialFieldNames:交换请求字段名 → 凭据 source 名(如 grant_type/refresh_token→refresh_token)。
 */
export const TokenAcquisition = Type.Object(
  {
    exchangeRequest: ExchangeRequestSpec,
    tokenResponse: TokenResponseSpec,
  },
  strict,
)
export type TokenAcquisitionT = Static<typeof TokenAcquisition>

/** authMode → 该模式权威 auth schema(编译器逐字段校验用)。 */
export const AUTH_SCHEMAS: Record<AuthModeValue, TObject> = {
  'static-token': StaticTokenAuth,
  'oauth2-auth-code': Oauth2Auth,
  'token-exchange': TokenExchangeAuth,
  'hmac-signing': HmacAuth,
  oauth1a: Oauth1aAuth,
  'imap-smtp': ImapSmtpAuth,
  'webdav-basic': WebdavBasicAuth,
}

/** 协议适配器模式(仅内置 adapter 可用,§1.2)。 */
export const PROTOCOL_AUTH_MODES: ReadonlySet<AuthModeValue> = new Set<AuthModeValue>([
  'imap-smtp',
  'webdav-basic',
])

// ─── ConnectorSpec(作者可写 draft) ─────────────────────────────────────────

export const ConnectorActionSpec = Type.Object(
  {
    id: ActionId,
    description: Type.String({ maxLength: 2000 }),
    request: RequestSpec,
    requestTransform: Type.Optional(BuiltinId),
    operation: Type.Optional(BuiltinId),
    resultTransform: Type.Optional(BuiltinId),
    params: JsonSchemaObject,
    result: JsonSchemaObject,
    usesSlot: Type.Optional(SlotId),
  },
  strict,
)
export type ConnectorActionSpecT = Static<typeof ConnectorActionSpec>

/**
 * identity probe 声明(bind 时验证凭据有效 + 派生账号身份)。account 身份是**签进 contract**
 * 的作者声明(单一权威):bind 服务执行 probeActionId 这个 read action → 从结果按
 * accountKeyPointer 取稳定账号标识(computeAccountKey 输入,唯一索引/重绑依赖它),
 * 按 accountHintPointer(可选)取展示 hint。probeActionId 必须是已声明的 read action。
 */
export const ConnectorIdentity = Type.Object(
  {
    probeActionId: ActionId,
    accountKeyPointer: ResultPointer,
    accountHintPointer: Type.Optional(ResultPointer),
  },
  strict,
)
export type ConnectorIdentityT = Static<typeof ConnectorIdentity>

export const ConnectorSpec = Type.Object(
  {
    id: Slug,
    label: Type.String({ minLength: 1, maxLength: 120 }),
    description: Type.String({ minLength: 0, maxLength: 2000 }),
    authMode: AuthMode,
    // 放宽为 Union;权威校验 = 编译器 AUTH_SCHEMAS[authMode]。
    auth: Type.Union([
      StaticTokenAuth,
      Oauth2Auth,
      TokenExchangeAuth,
      HmacAuth,
      Oauth1aAuth,
      ImapSmtpAuth,
      WebdavBasicAuth,
    ]),
    originMode: OriginMode,
    credentialPipeline: CredentialPipeline,
    actions: Type.Array(ConnectorActionSpec, { minItems: 1, maxItems: 64 }),
    identity: Type.Optional(ConnectorIdentity),
  },
  strict,
)
export type ConnectorSpecT = Static<typeof ConnectorSpec>

// ─── 编译产物 ExecContract(执行唯一权威) ───────────────────────────────────

export const Effect = Type.Union([
  Type.Literal('read'),
  Type.Literal('write'),
  Type.Literal('send'),
])
export type EffectValue = Static<typeof Effect>

export const CredentialAudiencePolicy = Type.Object(
  {
    authorizationOrigins: Type.Array(OriginString, { maxItems: 16 }),
    tokenOrigins: Type.Array(OriginString, { maxItems: 16 }),
    apiOrigins: Type.Array(OriginString, { maxItems: 16 }),
    unauthenticatedUploadOrigins: Type.Array(OriginString, { maxItems: 16 }),
  },
  strict,
)
export type CredentialAudiencePolicyT = Static<typeof CredentialAudiencePolicy>

export const ExecAction = Type.Object(
  {
    id: ActionId,
    /** 审签结论(作者不可自报);dry-run/execute 都以它为准。 */
    effect: Effect,
    request: RequestSpec,
    /**
     * 编译器校验过的 params(strict)/result(allowlist)schema —— **签进 contract hash**
     * (P0-4)。执行/dry-run 只认 exec contract 里这份,不回读 raw artifact。
     * 编译器限定 TypeBox 安全子集:禁远程 $ref/$id/$anchor 等,params 顶层 strict。
     */
    params: JsonSchemaObject,
    result: JsonSchemaObject,
    apiCredentialPlacements: Type.Array(ApiCredentialPlacement, { maxItems: 8 }),
  },
  strict,
)
export type ExecActionT = Static<typeof ExecAction>

export const ExecContract = Type.Object(
  {
    spec_hash: Hex64,
    auth_contract_version: Type.Integer({ minimum: 1 }),
    authMode: AuthMode,
    originMode: OriginMode,
    credentialAudiencePolicy: CredentialAudiencePolicy,
    tokenOutputs: Type.Optional(TokenOutputs),
    tokenAcquisition: Type.Optional(TokenAcquisition),
    // oauth2 授权码流配置(仅 authMode='oauth2-auth-code' 时存在);随整个 canonical
    // exec_contract 进 exec_contract_hash → 自动被签名覆盖(signer 无需改)。
    oauth2: Type.Optional(Oauth2Config),
    credentialPipeline: CredentialPipeline,
    actions: Type.Array(ExecAction, { minItems: 1 }),
    identity: Type.Optional(ConnectorIdentity),
  },
  strict,
)
export type ExecContractT = Static<typeof ExecContract>

// ─── securityDecision(reviewer 签的编译输入,不是作者声明) ───────────────────

export const SecurityDecisionAction = Type.Object(
  {
    /** reviewer 显式签的 effect;非 GET 想签 read 必须配 safeReadNonGet(§4)。 */
    effect: Type.Optional(Effect),
    /** safe-read-non-get override(§1.3):仅 POST 类可,DELETE/PUT/PATCH 不可。 */
    safeReadNonGet: Type.Optional(Type.Boolean()),
  },
  strict,
)

export const SecurityDecision = Type.Object(
  {
    auth_contract_version: Type.Optional(Type.Integer({ minimum: 1 })),
    /** fixed-reviewed 的四受众 origin(审核生成,精确 origin+port)。 */
    audience: Type.Optional(CredentialAudiencePolicy),
    /** per-action effect 决策(键=action id)。 */
    actions: Type.Optional(Type.Record(ActionId, SecurityDecisionAction)),
  },
  strict,
)
export type SecurityDecisionT = Static<typeof SecurityDecision>

// ─── 统一错误(编译/签名/审核/载入 fail-closed) ─────────────────────────────

export type ConnectorSpecErrorCode =
  // 编译期
  | 'SPEC_SCHEMA_INVALID'
  | 'AUTH_SCHEMA_INVALID'
  | 'AUTH_MODE_MISMATCH'
  | 'ORIGIN_MODE_MISMATCH'
  | 'BAD_ORIGIN'
  | 'AUDIENCE_MISSING'
  | 'BAD_PATH_TEMPLATE'
  | 'BAD_PATH_PLACEHOLDER'
  | 'IDENTITY_INVALID'
  | 'RESERVED_HEADER'
  | 'BAD_PLACEMENT'
  | 'BUILTIN_NOT_ALLOWED'
  | 'PIPELINE_INVALID'
  | 'PIPELINE_CYCLE'
  | 'SLOT_UNKNOWN'
  | 'SLOT_AUDIENCE_MISMATCH'
  | 'SLOT_MODE_MISMATCH'
  | 'EFFECT_OVERRIDE_FORBIDDEN'
  | 'SECURITY_DECISION_INVALID'
  | 'EXEC_CONTRACT_INVALID'
  | 'DUPLICATE_ACTION_ID'
  | 'UNKNOWN_DECISION_ACTION'
  | 'UNKNOWN_AUXILIARY'
  | 'UNSAFE_SCHEMA'
  | 'POLLUTION_KEY'
  | 'SPEC_ID_MISMATCH'
  // 审核状态机 / 载入即验
  | 'VERSION_NOT_FOUND'
  | 'NOT_DRAFT'
  | 'REVIEWER_IS_AUTHOR'
  | 'REVIEWER_NOT_ADMIN'
  | 'WRONG_ARTIFACT_KIND'
  | 'ARTIFACT_HASH_MISMATCH'
  | 'SPEC_HASH_MISMATCH'
  | 'CAS_CONFLICT'
  | 'INVALID_STATE'
  | 'CONTRACT_MISSING'
  | 'NOT_SECURITY_APPROVED'
  | 'EXEC_REVOKED'
  | 'POLICY_STALE'
  | 'SIGNATURE_INVALID'
  | 'HASH_MISMATCH'
  | 'INTERNAL'

export class ConnectorSpecError extends Error {
  readonly code: ConnectorSpecErrorCode
  constructor(code: ConnectorSpecErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'ConnectorSpecError'
    this.code = code
  }
}
