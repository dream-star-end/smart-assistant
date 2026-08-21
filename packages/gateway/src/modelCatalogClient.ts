/**
 * modelCatalogClient —— 容器侧的**模型 catalog 快照客户端**(模型权威批次 · 方案 §3 / §4)。
 *
 * 它服务的是**本地路径**:cron / synthetic(重启续写)/ delegate —— 这些 turn 不经 bridge,
 * 没有 master 签发的 authority envelope,容器必须自己回答"这个用户现在能跑哪些模型、
 * 每个模型什么执行语义"。浏览器 turn **不走这里**(判定随 inbound 的签名 descriptor 下来,
 * 见 modelAuthority.ts)—— 两条路径的判定源都是 master 的同一份 catalog,只是投递方式不同。
 *
 * ── 为什么不能有 baked 回落(R1-B1)────────────────────────────────────────────
 * 容器镜像里那张 baked 模型表正是本批次要消灭的**第二信任源**:它与 master 的 catalog
 * 必然漂移(新模型 / 换 engine / 撤销授权在两侧不同步生效),而漂移的方向恰好是"容器以为
 * 自己能跑" —— 即免费或越权执行。所以:**拿不到权威快照就拒绝新 turn**,不许"尽力跑"。
 *
 * ── 新鲜度协议(方案 §3)────────────────────────────────────────────────────
 *   · 内存快照在 TTL(30s)内 → 直接用(不打网络);
 *   · TTL 过期 / 冷启从 LKG 读盘 → **先验 epoch**(窄端点 `/model-catalog-epoch`,单行读):
 *       - epoch 相等 → 快照仍然有效(顺延 TTL)—— 安全变更必 bump epoch,epoch 没变就
 *         意味着没有任何"收窄/撤销/改价"发生;
 *       - epoch 漂移 → **强拉**全量;拉不到 → 拒;
 *       - epoch 端点也不通 → 拒(证明不了新鲜就不许用 —— 这正是 stale 授权的入口);
 *   · 冷启无 LKG 且 master 不可达 → 拒(无 baked 回落)。
 *
 * ── LKG(last-known-good)落盘 ───────────────────────────────────────────────
 * 落在容器的持久卷(`$OPENCLAUDE_HOME`),让"容器重启 + master 恰好在重启"的窗口里,cron
 * 仍能在**验过 epoch**之后继续跑。LKG **不是**离线许可证:用它之前必须联网验 epoch,
 * 所以它不能延长任何一次授权的寿命。
 *
 * ── 与 egress 的接口(§4)──────────────────────────────────────────────────
 * 本地路径的上游 `/v1/messages` 请求带 `x-oc-local-catalog` token(kind='local_catalog',
 * 携 projectionRevision + epoch)。它**不是授权凭据**(容器没有私钥,签不出 bridge authority)——
 * egress 只从中取 epoch 做 fence,授权仍走服务端权威(容器身份 → uid → grants → catalog)。
 * 故意与 bridge authority 分不同 header / 不同 kind,不允许互相伪装(R3-M6)。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { request as undiciRequest } from 'undici'
import { resolveConnectorEndpoint } from './ocConnectorsClient.js'

export const MODEL_CATALOG_PATH = '/internal/v3/model-catalog'
export const MODEL_CATALOG_EPOCH_PATH = '/internal/v3/model-catalog-epoch'

/**
 * 上游 `/v1/messages` 的凭据 header。
 *
 * **parity 契约**:验签/fence 端的同名常量在 commercial `http/proxy/modelAuthorityGate.ts`。
 * 两侧各持一份是有意的(gateway 不允许 import commercial —— 容器不该看见计费/DB 代码);
 * 漂移由 commercial 侧 `__tests__/modelAuthorityGate.test.ts` 的跨包断言守护。
 */
export const AUTHORITY_HEADER = 'x-oc-model-authority'
export const TURN_LEASE_HEADER = 'x-oc-turn-lease'
export const LOCAL_CATALOG_HEADER = 'x-oc-local-catalog'
export const LOCAL_CATALOG_KIND = 'local_catalog'

/** v3 supervisor 注入的容器出站 env(与 v3MasterSink / promptSlots 同一条通道)。 */
const ENV_MASTER_URL = 'OPENCLAUDE_V3_MASTER_BASE_URL'
const ENV_CONTAINER_TOKEN = 'OPENCLAUDE_V3_CONTAINER_TOKEN'

/** 成功拉取后的免检窗口。安全变更靠 epoch 验证兜底,不靠这个窗口短。 */
const CATALOG_TTL_MS = 30_000
/** 单次请求超时:本地路径 turn 在等它,失败要早(拒 turn 好过挂住 cron)。 */
const FETCH_TIMEOUT_MS = 5_000
const MAX_BODY_BYTES = 512 * 1024

/** 容器侧能理解的 capability schema 上限。与 master `CAPABILITY_SCHEMA_VERSION` 同值(parity)。 */
export const CLIENT_CAPABILITY_SCHEMA_VERSION = 1

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

export interface LocalCatalogModel {
  readonly modelId: string
  readonly displayName: string
  readonly engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode'
  readonly providerId: string | null
  readonly contextWindow: number | null
  readonly supportedEfforts: readonly string[]
  readonly supportsVision: boolean
  readonly capabilityZero: boolean
  readonly supportsThinking: boolean
  readonly defaultEffort: string | null
  /** Provider quota/health routing availability; old masters omit it (= true). */
  readonly available: boolean
}

/** 该 uid 的可执行模型投影(master 已按 role/grants 过滤;容器不再自己判可见性)。 */
export interface LocalCatalogView {
  readonly models: readonly LocalCatalogModel[]
  readonly projectionRevision: string
  readonly availabilityRevision: string
  readonly securityEpoch: string
  /**
   * alias → canonical model id 归一(方案 §2/§8「alias 全链归一」的本地路径一端)。
   *
   * 与 master `ModelCatalogSnapshot.aliasToCanonical` 同语义:**投影里没有这个 alias
   * 就原样返回** —— 归一不做可用性判定,随后由 `isRoutable` fail-closed 拒。
   * 归一必须先于 isRoutable/resolve/engine 三个判定,否则同一个模型经 alias 进来会
   * 被判成"不在投影里"(把可用模型误拒)或绕过 disabled(把不可用模型误放)。
   */
  canonicalize(modelIdOrAlias: string): string
  /** alias → canonical 的全量映射(LKG 落盘 / 诊断用)。 */
  aliasEntries(): readonly (readonly [string, string])[]
  /** 该 model 是否在本 uid 的投影里(= 可执行 + 可计费)。入参须为 canonical id。 */
  isRoutable(modelId: string): boolean
  /** 完整执行语义;不在投影里 → null。入参须为 canonical id。 */
  resolve(modelId: string): LocalCatalogModel | null
  /** engine 判定(codex 本地路径的真值表见方案 §3)。入参须为 canonical id。 */
  isCodexModel(modelId: string): boolean
}

/** 本地路径 token 的 wire 形状(与 commercial 侧 `LocalCatalogToken` 同构)。 */
interface LocalCatalogTokenWire {
  v: 1
  kind: typeof LOCAL_CATALOG_KIND
  projectionRevision: string
  securityEpoch: string
}

/** 快照不可用 → 本地路径**拒新 turn**(调用方不得 catch 后放行)。 */
export class ModelCatalogUnavailableError extends Error {
  /** 结构化错误码(与 LocalExecutionRejected 同一张码表,便于调用方统一映射)。 */
  readonly code = 'MODEL_CATALOG_UNAVAILABLE' as const
  constructor(readonly reason: string) {
    super(`model catalog unavailable: ${reason}`)
    this.name = 'ModelCatalogUnavailableError'
  }
}

/**
 * 本地路径(无 envelope)的**结构化拒绝**码(方案 §3 真值表 / §6)。
 *
 *  - `DELEGATE_CODEX_UNSUPPORTED`:codex delegate / provider pin 的本地 turn。现状是
 *    晚期被 CODEX_BILLING_GUARD(submit 时)拒 —— 那时 runner 已 spawn、容器已起进程;
 *    本批**产品化提前到创建 runner 之前**,给出稳定错误码而不是一句 guard 文案。
 *  - `MODEL_NOT_AVAILABLE`:模型不在本 uid 的投影里(未 active / 未授权 / 未知),
 *    或合成路径找不到可路由的非 codex 兜底。码与 master §6 统一(不回显 model/provider)。
 *  - `MODEL_CATALOG_UNAVAILABLE`:投影拉不到(见 ModelCatalogUnavailableError)。
 */
export type LocalExecutionRejectCode =
  | 'DELEGATE_CODEX_UNSUPPORTED'
  | 'MODEL_NOT_AVAILABLE'
  | 'MODEL_CATALOG_UNAVAILABLE'

/** 本地路径判定拒绝(**在创建 runner 之前**抛)。调用方按 code 映射用户面错误。 */
export class LocalExecutionRejected extends Error {
  constructor(
    readonly code: LocalExecutionRejectCode,
    message: string,
  ) {
    super(message)
    this.name = 'LocalExecutionRejected'
  }
}

/** 统一取结构化码(两类拒绝共用一张码表;非本体系错误 → undefined)。 */
export function localExecutionRejectCode(err: unknown): LocalExecutionRejectCode | undefined {
  if (err instanceof LocalExecutionRejected) return err.code
  if (err instanceof ModelCatalogUnavailableError) return err.code
  return undefined
}

interface Snapshot {
  view: LocalCatalogView
  /** 最近一次"被证明新鲜"的时刻(全量拉取成功,或 epoch 验证通过)。 */
  verifiedAt: number
}

export interface ModelCatalogClientDeps {
  env?: NodeJS.ProcessEnv
  fetcher?: typeof undiciRequest
  now?: () => number
  /** LKG 落盘路径覆盖(测试)。生产 = `$OPENCLAUDE_HOME/model-catalog-lkg.json`。 */
  lkgPath?: string
  ttlMs?: number
  timeoutMs?: number
  log?: (event: string, fields: Record<string, unknown>) => void
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export class ModelCatalogClient {
  private snapshot: Snapshot | null = null
  private inflight: Promise<LocalCatalogView> | null = null
  private routingInflight: Promise<LocalCatalogView> | null = null
  private lkgLoaded = false

  private readonly env: NodeJS.ProcessEnv
  private readonly fetcher: typeof undiciRequest
  private readonly now: () => number
  private readonly lkgPath: string
  private readonly ttlMs: number
  private readonly timeoutMs: number
  private readonly log: (event: string, fields: Record<string, unknown>) => void

  constructor(deps: ModelCatalogClientDeps = {}) {
    const sourceEnv = deps.env ?? process.env
    let resolvedEnv = sourceEnv
    try {
      const endpoint = resolveConnectorEndpoint(sourceEnv)
      resolvedEnv = {
        ...sourceEnv,
        [ENV_MASTER_URL]: endpoint.masterBaseUrl,
        [ENV_CONTAINER_TOKEN]: endpoint.containerToken,
      }
    } catch {
      // Personal/non-container paths intentionally remain unconfigured. The caller
      // still fails closed through `configured`/ModelCatalogUnavailableError.
    }
    this.env = resolvedEnv
    this.fetcher = deps.fetcher ?? undiciRequest
    this.now = deps.now ?? Date.now
    this.lkgPath = deps.lkgPath ?? defaultLkgPath(this.env)
    this.ttlMs = deps.ttlMs ?? CATALOG_TTL_MS
    this.timeoutMs = deps.timeoutMs ?? FETCH_TIMEOUT_MS
    this.log =
      deps.log ??
      ((event, fields) => {
        // eslint-disable-next-line no-console
        console.warn(`[modelCatalog] ${event}`, JSON.stringify(fields))
      })
  }

  /** 装配就绪?(env 不齐 = 个人版 / 非托管容器 → 调用方走本地既有判定,不经本客户端。) */
  get configured(): boolean {
    return Boolean(this.env[ENV_MASTER_URL] && this.env[ENV_CONTAINER_TOKEN])
  }

  /**
   * 取当前**已被证明新鲜**的投影。失败 → 抛 ModelCatalogUnavailableError(拒新 turn)。
   * 单飞:并发调用合并成一次网络往返。
   */
  async getView(): Promise<LocalCatalogView> {
    if (!this.configured) {
      throw new ModelCatalogUnavailableError('master base url / container token not injected')
    }
    if (this.routingInflight) return this.routingInflight
    const snap = this.snapshot
    if (snap && this.now() - snap.verifiedAt < this.ttlMs) return snap.view

    if (this.inflight) return this.inflight
    this.inflight = this.ensureFresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * Team/local routing must also observe provider availability, whose revision is
   * independent from the security epoch. Concurrent delegates still share one
   * narrow check through the same singleflight.
   */
  async getRoutingView(): Promise<LocalCatalogView> {
    if (!this.configured) {
      throw new ModelCatalogUnavailableError('master base url / container token not injected')
    }
    if (this.routingInflight) return this.routingInflight
    this.routingInflight = (async () => {
      if (this.inflight) await this.inflight
      return this.ensureFresh(true)
    })().finally(() => {
      this.routingInflight = null
    })
    return this.routingInflight
  }

  /**
   * 本地路径请求带给 egress 的 token(§4)。**每次现取** —— 它必须携带当前 epoch,
   * 缓存下来会在安全变更后带着旧 epoch 去撞 fence(拒),等于自找 5xx。
   */
  async getToken(): Promise<string> {
    const view = await this.getView()
    const token: LocalCatalogTokenWire = {
      v: 1,
      kind: LOCAL_CATALOG_KIND,
      projectionRevision: view.projectionRevision,
      securityEpoch: view.securityEpoch,
    }
    return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url')
  }

  /** 测试用:清空内存态(不动 LKG 文件)。 */
  _resetForTests(): void {
    this.snapshot = null
    this.inflight = null
    this.routingInflight = null
    this.lkgLoaded = false
  }

  // -- 内部 -----------------------------------------------------------------

  /**
   * 新鲜度协议(方案 §3):有快照(内存或 LKG)→ 先验 epoch;无快照 → 直接全量拉。
   *
   * 顺序不可换:先验 epoch 再决定要不要全量拉,是为了让"什么都没变"的常态只花一次单行读;
   * 但**任何一步验不出新鲜,一律拒** —— 不存在"验不了就先用着"的分支。
   */
  private async ensureFresh(checkAvailability = false): Promise<LocalCatalogView> {
    const cached = this.snapshot ?? this.loadLkg()
    if (cached) {
      let state: { epoch: string; availabilityRevision: string }
      try {
        state = await this.fetchCatalogState()
      } catch (err) {
        // 证明不了新鲜 → 拒。这里**不能**回落到"用旧快照":旧快照可能是撤销授权之前的。
        throw new ModelCatalogUnavailableError(
          `epoch verification failed: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
      if (
        state.epoch === cached.view.securityEpoch &&
        (!checkAvailability ||
          state.availabilityRevision === cached.view.availabilityRevision)
      ) {
        this.snapshot = { view: cached.view, verifiedAt: this.now() }
        return cached.view
      }
      this.log('epoch_drift_force_refetch', {
        cached: cached.view.securityEpoch,
        db: state.epoch,
        cachedAvailability: cached.view.availabilityRevision,
        dbAvailability: state.availabilityRevision,
      })
      // 漂移 → 强拉。拉不到 → 拒(下面 fetchCatalog 抛)。
    }
    return this.fetchCatalog()
  }

  private async fetchCatalog(): Promise<LocalCatalogView> {
    const body = await this.getJson(MODEL_CATALOG_PATH)
    const view = parseCatalogResponse(body)
    this.snapshot = { view, verifiedAt: this.now() }
    this.persistLkg(view)
    return view
  }

  private async fetchCatalogState(): Promise<{
    epoch: string
    availabilityRevision: string
  }> {
    const body = await this.getJson(MODEL_CATALOG_EPOCH_PATH)
    const epoch = (body as { epoch?: unknown }).epoch
    if (typeof epoch !== 'string' || !/^\d+$/.test(epoch)) {
      throw new Error('epoch endpoint returned malformed body')
    }
    const availability = (body as { availability_revision?: unknown }).availability_revision
    return {
      epoch,
      availabilityRevision:
        typeof availability === 'string' && availability !== '' ? availability : 'legacy',
    }
  }

  private async getJson(path: string): Promise<unknown> {
    const base = (this.env[ENV_MASTER_URL] ?? '').replace(/\/+$/, '')
    const bearer = this.env[ENV_CONTAINER_TOKEN] ?? ''
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await this.fetcher(`${base}${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${bearer}` },
        signal: controller.signal,
      })
      const text = await readBoundedText(res.body, MAX_BODY_BYTES)
      if (res.statusCode !== 200) {
        throw new ModelCatalogUnavailableError(`master returned ${res.statusCode}`)
      }
      return JSON.parse(text) as unknown
    } catch (err) {
      if (err instanceof ModelCatalogUnavailableError) throw err
      throw new ModelCatalogUnavailableError(
        `fetch ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    } finally {
      clearTimeout(timer)
    }
  }

  /** 冷启读盘一次(读失败/损坏 → 当作没有 LKG,不抛)。 */
  private loadLkg(): Snapshot | null {
    if (this.lkgLoaded) return null
    this.lkgLoaded = true
    try {
      const raw = readFileSync(this.lkgPath, 'utf8')
      const view = parseCatalogResponse(JSON.parse(raw) as unknown)
      // verifiedAt=0:LKG 一律**未被证明新鲜** → 使用前必过 epoch 验证。
      return { view, verifiedAt: 0 }
    } catch {
      return null
    }
  }

  private persistLkg(view: LocalCatalogView): void {
    try {
      mkdirSync(dirname(this.lkgPath), { recursive: true })
      const tmp = `${this.lkgPath}.tmp`
      writeFileSync(tmp, `${JSON.stringify(toWire(view))}\n`, { mode: 0o600 })
      renameSync(tmp, this.lkgPath) // 原子替换:半写文件 = 下次冷启把它当损坏丢掉
    } catch (err) {
      // LKG 写失败不影响本次 turn(内存快照已就位),只是下次冷启少一层缓冲。
      this.log('lkg_persist_failed', { err: err instanceof Error ? err.message : String(err) })
    }
  }
}

// ---------------------------------------------------------------------------
// 进程级单例(容器内只该有一份快照 + 一条单飞)
// ---------------------------------------------------------------------------

let singleton: ModelCatalogClient | null = null

export function getModelCatalogClient(): ModelCatalogClient {
  if (!singleton) singleton = new ModelCatalogClient()
  return singleton
}

/** 测试用:替换/清空单例。 */
export function _setModelCatalogClientForTests(client: ModelCatalogClient | null): void {
  singleton = client
}

/**
 * 本地路径判定入口(cron / synthetic / delegate 在创建 runner 前调它)。
 * 抛 ModelCatalogUnavailableError → **拒新 turn**(方案 §3:无 baked 回落)。
 */
export function getLocalCatalogView(): Promise<LocalCatalogView> {
  return getModelCatalogClient().getRoutingView()
}

/** 本地路径上游请求要带的 `x-oc-local-catalog` header 值(§4)。 */
export function getLocalCatalogToken(): Promise<string> {
  return getModelCatalogClient().getToken()
}

// ---------------------------------------------------------------------------
// 解析 / 序列化
// ---------------------------------------------------------------------------

interface WireRow {
  model_id: string
  display_name: string
  engine: 'ccb' | 'codex' | 'grok' | 'cursor' | 'zcode'
  provider_id: string | null
  context_window: number | null
  supported_efforts: string[]
  supports_vision: boolean
  capability_zero: boolean
  supports_thinking: boolean
  default_effort: string | null
  available?: boolean
}

interface WireResponse {
  models: WireRow[]
  projection_revision: string
  availability_revision?: string
  security_epoch: string
  /** alias → canonical model_id；旧 master 兼容期可缺席，缺席 = 空 map。 */
  aliases?: Record<string, string>
}

function toWire(view: LocalCatalogView): WireResponse {
  // LKG 落盘必须**保留 alias 映射** —— 否则冷启用 LKG 的那一轮会丢掉归一能力,
  // 同一个 alias 在"有网"和"用 LKG"两种路径下判定不同(误拒)。
  const aliasEntries = view.aliasEntries()
  const aliases: Record<string, string> = {}
  for (const [alias, canonical] of aliasEntries) aliases[alias] = canonical
  return {
    models: view.models.map((m) => ({
      model_id: m.modelId,
      display_name: m.displayName,
      engine: m.engine,
      provider_id: m.providerId,
      context_window: m.contextWindow,
      supported_efforts: [...m.supportedEfforts],
      supports_vision: m.supportsVision,
      capability_zero: m.capabilityZero,
      supports_thinking: m.supportsThinking,
      default_effort: m.defaultEffort,
      available: m.available,
    })),
    projection_revision: view.projectionRevision,
    availability_revision: view.availabilityRevision,
    security_epoch: view.securityEpoch,
    ...(aliasEntries.length > 0 ? { aliases } : {}),
  }
}

/** fail-closed 解析:任何形状不符 → 抛(宁可拒 turn,也不要拿半个投影去判定)。 */
export function parseCatalogResponse(raw: unknown): LocalCatalogView {
  const o = raw as Partial<WireResponse> | null
  if (!o || typeof o !== 'object' || !Array.isArray(o.models)) {
    throw new ModelCatalogUnavailableError('catalog response is not an object with models[]')
  }
  if (typeof o.projection_revision !== 'string' || o.projection_revision === '') {
    throw new ModelCatalogUnavailableError('catalog response missing projection_revision')
  }
  if (typeof o.security_epoch !== 'string' || !/^\d+$/.test(o.security_epoch)) {
    throw new ModelCatalogUnavailableError('catalog response missing security_epoch')
  }

  const models: LocalCatalogModel[] = o.models.map((r) => {
    if (
      !r ||
      typeof r.model_id !== 'string' ||
      (r.engine !== 'ccb' && r.engine !== 'codex' && r.engine !== 'grok' && r.engine !== 'cursor' && r.engine !== 'zcode') ||
      typeof r.supports_vision !== 'boolean' ||
      typeof r.capability_zero !== 'boolean' ||
      typeof r.supports_thinking !== 'boolean' ||
      !Array.isArray(r.supported_efforts)
    ) {
      throw new ModelCatalogUnavailableError('catalog row shape invalid')
    }
    return {
      modelId: r.model_id,
      displayName: typeof r.display_name === 'string' ? r.display_name : r.model_id,
      engine: r.engine,
      providerId: typeof r.provider_id === 'string' ? r.provider_id : null,
      contextWindow: typeof r.context_window === 'number' ? r.context_window : null,
      supportedEfforts: r.supported_efforts.filter((e): e is string => typeof e === 'string'),
      supportsVision: r.supports_vision,
      capabilityZero: r.capability_zero,
      supportsThinking: r.supports_thinking,
      defaultEffort: typeof r.default_effort === 'string' ? r.default_effort : null,
      available: r.available !== false,
    }
  })

  // alias 解析:缺席 = 空 map(**不放宽**);形状不符 = 抛(宁可拒 turn,也不要拿半份
  // 归一表去判定 —— 半份归一表会让某些 alias 静默落到"原样不可路由"分支)。
  const aliases = new Map<string, string>()
  if (o.aliases !== undefined) {
    if (o.aliases === null || typeof o.aliases !== 'object' || Array.isArray(o.aliases)) {
      throw new ModelCatalogUnavailableError('catalog response aliases is not an object')
    }
    for (const [alias, canonical] of Object.entries(o.aliases)) {
      if (
        typeof alias !== 'string' ||
        alias === '' ||
        typeof canonical !== 'string' ||
        canonical === ''
      ) {
        throw new ModelCatalogUnavailableError('catalog response alias entry invalid')
      }
      aliases.set(alias, canonical)
    }
  }

  const byId = new Map(models.map((m) => [m.modelId, m]))
  const canonicalize = (modelIdOrAlias: string): string =>
    aliases.get(modelIdOrAlias) ?? modelIdOrAlias
  return {
    models,
    projectionRevision: o.projection_revision,
    availabilityRevision:
      typeof o.availability_revision === 'string' && o.availability_revision !== ''
        ? o.availability_revision
        : 'legacy',
    securityEpoch: o.security_epoch,
    canonicalize,
    aliasEntries: () => [...aliases.entries()],
    isRoutable: (modelId) => byId.get(modelId)?.available === true,
    resolve: (modelId) => byId.get(modelId) ?? null,
    isCodexModel: (modelId) => byId.get(modelId)?.engine === 'codex',
  }
}

function defaultLkgPath(env: NodeJS.ProcessEnv): string {
  const home = env.OPENCLAUDE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.openclaude')
  return join(home, 'model-catalog-lkg.json')
}

async function readBoundedText(
  body: { on: (ev: string, cb: (chunk: unknown) => void) => void } | AsyncIterable<Uint8Array>,
  maxBytes: number,
): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buf = Buffer.from(chunk)
    total += buf.length
    if (total > maxBytes) throw new Error('catalog response too large')
    chunks.push(buf)
  }
  return Buffer.concat(chunks).toString('utf8')
}
