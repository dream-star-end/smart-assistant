/**
 * `GET /internal/v3/model-catalog` + `GET /internal/v3/model-catalog-epoch`
 * —— 容器 → master 的 **per-uid 模型投影**下发(模型权威批次 · 方案 §3 / §6)。
 *
 * 谁在用:容器 gateway 的 catalog client(packages/gateway/src/modelCatalogClient.ts)。
 * 它服务的是**本地路径**(cron / synthetic / delegate)—— 那些 turn 没有 bridge 签发的
 * authority envelope,容器得自己知道"这个用户现在能跑哪些模型、每个模型什么执行语义"。
 * 浏览器 turn **不**走这条路(判定随 inbound 的签名 descriptor 一起下来,§2)。
 *
 * ── 三条硬约束 ──────────────────────────────────────────────────────────────
 *  1. **per-uid 严格过滤**(§6):行集 = `snapshot.listForUser({uid, role, grants})` =
 *     active ∧ (public ∨ granted)。hidden/admin 模型不在该 uid 的授权里就**不下发** ——
 *     容器里跑的是用户的 AI,下发即泄漏"平台有哪些内部模型"。
 *  2. **全局 executionRevision 不下发**(R2-M12):只给 per-uid `projectionRevision`。
 *     全局 revision 是签名 envelope 的内部字段,不做用户可观测量。
 *  3. **seed 完整性是全局断言,不是 per-uid 特权**(R2-M8):平台预设 agent 引用的模型
 *     必须在 catalog active(启动断言 + deploy 门),但**响应仍严格过滤、不强塞、不 500**——
 *     某个 uid 没被授权用 seed agent 的模型时,这条路径只是不返回它;真正的拒绝发生在
 *     执行时(bridge authority 拒签 / proxy gate 拒路由),错误码统一 MODEL_NOT_AVAILABLE。
 *
 * ── 不进 browser→container 代理 allowlist ─────────────────────────────────
 * 这两条 path 挂在**内部 listener**(18791/18443,容器→master 方向),与浏览器→master→容器
 * 的 `/api/*` 代理(gateway `bridgeApiAllowlist` + commercial `containerApiProxy`)是两条
 * 完全不同的通道。allowlist 只收 `/api/*`,结构上不可能命中 `/internal/v3/*`;
 * `__tests__/internalModelCatalog.test.ts` 有显式断言把这件事钉死(双侧 + 回归门)。
 *
 * 鉴权:`verifyContainerIdentity` 容器双因子(bearer + bound_ip),与 anthropicProxy /
 * platform-prompt-slots 同款。**uid 只从身份推导,绝不从 query/body 取**。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "../auth/containerIdentity.js";
import {
  CatalogUnknownError,
  readSecurityEpoch,
  type ModelCatalogCache,
  type ModelCatalogSnapshot,
  type UserModelScope,
} from "../billing/modelCatalog.js";
import type { UserModelAuthz, UserModelAuthzLoader } from "../auth/userModelAuthz.js";
import type { ProviderRoutingAvailability } from "../admin/providerHealthGate.js";
import { PLATFORM_SEED_AGENT_MODEL_IDS } from "../marketplace/seedPlatformAgents.js";
import {
  PLATFORM_DEFAULT_MODEL,
  PLATFORM_HIDDEN_REVIEWER_MODEL,
} from "../platformDefaults.js";
import { DEFAULT_CODEX_ENGINE_MODEL } from "@openclaude/protocol";
import { rootLogger, type Logger } from "../logging/logger.js";
import {
  REQUEST_ID_HEADER,
  ensureRequestId,
  sendError,
  sendJson,
  setSecurityHeaders,
} from "./util.js";

export const MODEL_CATALOG_PATH = "/internal/v3/model-catalog";
/** 窄端点(R2-m13:不用 HEAD body)—— LKG 使用前的 epoch 验证走它,一次单行 SELECT。 */
export const MODEL_CATALOG_EPOCH_PATH = "/internal/v3/model-catalog-epoch";

/** 两个端点都带的响应头(容器可复用拉取响应头做 epoch 验证,免二次请求)。 */
export const SECURITY_EPOCH_HEADER = "x-openclaude-security-epoch";

/**
 * 模型不可用的**统一**错误码(§6)。不回显 model/engine/provider/revision —— 任何一项
 * 都会把"平台有哪些模型、谁归哪个 provider"变成可探测面。
 */
export const MODEL_NOT_AVAILABLE = "MODEL_NOT_AVAILABLE";

/**
 * catalog 快照来源的**窄接口**。生产实现 = `ModelCatalogCache`(结构上满足);
 * 窄化的意义:本 handler 只需要"给我一份已 fence 过的快照",不需要认识 NOTIFY/重建/
 * 生命周期 —— 也让单测不必拉起 PG。
 */
export interface CatalogSource {
  assertFresh(): Promise<ModelCatalogSnapshot>;
  /**
   * 展示面专用的 fence 微缓存变体(方案 §1.2)。**仅**匿名不限流的展示端点可用
   * (/api/public/models);安全/计费面(签发/preCheck/journal/egress)必须用 assertFresh()。
   * 可选:测试 double 与非 cache 实现可不提供。
   */
  assertFreshCached?(ttlMs: number): Promise<ModelCatalogSnapshot>;
}

export interface ModelCatalogHandlerDeps {
  identityRepo: ContainerIdentityRepo;
  catalog: CatalogSource;
  /** role + grants 的权威加载器(auth/userModelAuthz.makeLoadUserModelAuthz)。 */
  loadUserModelAuthz: UserModelAuthzLoader;
  /** DB 当前 epoch(单行读)。默认 readSecurityEpoch;测试 seam。 */
  readEpoch?: () => Promise<bigint>;
  /** Provider quota/health routing view. Production injects providerHealthGate. */
  loadRoutingAvailability?: () => Promise<ProviderRoutingAvailability>;
  /**
   * 全表 `agent_cost_overrides`(agent_id → cost_multiplier)。
   * 成功则写入响应(空表 = {});失败则省略该字段,让 gateway 补价 fail-closed,
   * 而不是把「查失败」伪装成「全 1.000」。旧 gateway 见到未知字段必须无害。
   */
  loadAgentCostOverrides?: () => Promise<Record<string, string>>;
  logger?: Logger;
}

export interface ModelCatalogCtx {
  hostUuid: string;
  boundIp: string;
}

export type ModelCatalogHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: ModelCatalogCtx,
) => Promise<void>;

/** 下发给容器的单行(= ModelProjectionRow 的 wire 形态;**无** upstream_model_id / revision)。 */
export interface WireModelRow {
  model_id: string;
  display_name: string;
  engine: "ccb" | "codex" | "grok" | "cursor" | "zcode";
  provider_id: string | null;
  context_window: number | null;
  supported_efforts: readonly string[];
  supports_vision: boolean;
  capability_zero: boolean;
  supports_thinking: boolean;
  default_effort: string | null;
  /** Missing on an old master means available=true to rolling-upgrade clients. */
  available?: boolean;
  /** model_pricing 四维 + multiplier。旧 master 可缺席。 */
  input_per_mtok?: string;
  output_per_mtok?: string;
  cache_read_per_mtok?: string;
  cache_write_per_mtok?: string;
  multiplier?: string;
}

export interface WireCatalogResponse {
  models: WireModelRow[];
  projection_revision: string;
  availability_revision?: string;
  security_epoch: string;
  aliases: Record<string, string>;
  /**
   * agent_id → cost_multiplier。新增可选字段:旧 gateway 忽略即可。
   * 出现(含空字典)="master 明确说了当前 override 集";缺席=旧 master / 加载失败。
   */
  agent_cost_overrides?: Record<string, string>;
}

export function makeModelCatalogHandler(deps: ModelCatalogHandlerDeps): ModelCatalogHandler {
  const log = (deps.logger ?? rootLogger).child({ subsys: "internalModelCatalog" });
  const readEpoch = deps.readEpoch ?? (() => readSecurityEpoch());
  const loadRoutingAvailability = deps.loadRoutingAvailability ?? (async () => ({
    unavailableProviderIds: new Set<string>(),
    revision: "legacy",
  }));

  return async function handle(req, res, ctx) {
    setSecurityHeaders(res);
    const requestId = ensureRequestId(req);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    if (req.method !== "GET") {
      sendError(res, 405, "METHOD_NOT_ALLOWED", "GET required", requestId);
      return;
    }

    // 1) 容器身份 → uid(绝不从 query/body 取)
    let identity;
    try {
      identity = await verifyContainerIdentity(deps.identityRepo, ctx, req.headers.authorization);
    } catch (err) {
      if (err instanceof ContainerIdentityError) {
        sendError(res, 401, "UNAUTHORIZED", "container identity verification failed", requestId);
        return;
      }
      throw err;
    }
    const uid = BigInt(identity.userId);
    const path = (req.url ?? "/").split("?")[0];

    // 2) 窄 epoch 端点:**直接单行 SELECT DB**(不读本进程快照)。
    //    容器用它判断"我手里的 LKG 还能不能用" —— 必须是 DB 的当前真值,而不是 master
    //    进程可能陈旧的内存态;后者会让容器与 DB 一起陈旧(双旧共谋)。
    if (path === MODEL_CATALOG_EPOCH_PATH) {
      let epoch: bigint;
      let availability: ProviderRoutingAvailability;
      try {
        [epoch, availability] = await Promise.all([readEpoch(), loadRoutingAvailability()]);
      } catch (err) {
        log.error("epoch_read_failed", { uid: identity.userId, err: errMsg(err) });
        sendError(res, 503, "MODEL_CATALOG_UNAVAILABLE", "model catalog unavailable", requestId);
        return;
      }
      sendJson(
        res,
        200,
        { epoch: epoch.toString(), availability_revision: availability.revision },
        { [REQUEST_ID_HEADER]: requestId, [SECURITY_EPOCH_HEADER]: epoch.toString() },
      );
      return;
    }

    // 3) 全量投影端点。fence 后取快照(assertFresh:单行 SELECT + 漂移则同步重建;
    //    重建失败 → 拒。容器宁可拿不到也不能拿到陈旧投影 —— 它会据此判定本地路径的 turn)。
    let snapshot: ModelCatalogSnapshot;
    try {
      snapshot = await deps.catalog.assertFresh();
    } catch (err) {
      const unknown = err instanceof CatalogUnknownError;
      log.error("catalog_unavailable", {
        uid: identity.userId,
        unknown,
        err: errMsg(err),
      });
      sendError(res, 503, "MODEL_CATALOG_UNAVAILABLE", "model catalog unavailable", requestId);
      return;
    }

    // 4) role + grants → per-uid 投影(与 pricing.listForUser / canUseModel 同源规则)
    let authz: UserModelAuthz;
    try {
      authz = await deps.loadUserModelAuthz(uid, snapshot.securityEpoch);
    } catch (err) {
      // fail-closed:授权信息读不到 → 不能"按 public 兜底"下发(那会把 grants 撤销
      // 变成"下次缓存过期前照旧可用")。
      log.error("authz_load_failed", { uid: identity.userId, err: errMsg(err) });
      sendError(res, 503, "MODEL_CATALOG_UNAVAILABLE", "model catalog unavailable", requestId);
      return;
    }

    const scope: UserModelScope = {
      uid: identity.userId,
      role: authz.role,
      grantedModelIds: authz.grantedModelIds,
      deniedModelIds: authz.deniedModelIds,
      userPlanTier: authz.userPlanTier ?? null,
      orgPlanCode: authz.orgPlanCode ?? null,
    };
    const availability = await loadRoutingAvailability();
    // agent 倍率与单价走同一条 catalog 下发。加载失败故意省略字段:
    // gateway 把「没拿到字段」当 fail-closed,不能把空表/查失败伪装成全 1.000。
    let agentCostOverrides: Record<string, string> | undefined;
    if (deps.loadAgentCostOverrides) {
      try {
        agentCostOverrides = await deps.loadAgentCostOverrides();
      } catch (err) {
        log.error("agent_cost_overrides_load_failed", {
          uid: identity.userId,
          err: errMsg(err),
        });
      }
    }
    const body: WireCatalogResponse = {
      models: snapshot.listForUser(scope).map((r) => {
        const p = snapshot.billingPricingFor(r.modelId);
        return {
          model_id: r.modelId,
          display_name: r.displayName,
          engine: r.engine,
          provider_id: r.providerId,
          context_window: r.contextWindow,
          supported_efforts: r.supportedEfforts,
          supports_vision: r.supportsVision,
          capability_zero: r.capabilityZero,
          supports_thinking: r.supportsThinking,
          default_effort: r.defaultEffort,
          available:
            r.providerId === null || !availability.unavailableProviderIds.has(r.providerId),
          ...(p
            ? {
                input_per_mtok: p.input_per_mtok.toString(),
                output_per_mtok: p.output_per_mtok.toString(),
                cache_read_per_mtok: p.cache_read_per_mtok.toString(),
                cache_write_per_mtok: p.cache_write_per_mtok.toString(),
                multiplier: p.multiplier,
              }
            : {}),
        };
      }),
      // per-uid 投影哈希(全局 executionRevision **不下发**,R2-M12)。
      projection_revision: snapshot.projectionRevisionFor(scope),
      availability_revision: availability.revision,
      security_epoch: snapshot.securityEpoch.toString(),
      aliases: snapshot.aliasesForUser(scope),
      ...(agentCostOverrides !== undefined
        ? { agent_cost_overrides: agentCostOverrides }
        : {}),
    };

    sendJson(res, 200, body, {
      [REQUEST_ID_HEADER]: requestId,
      [SECURITY_EPOCH_HEADER]: body.security_epoch,
    });
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// seed 完整性(全局断言;§5 / R2-M8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 平台 seed / 预设引用的全部模型 id(去重)。
 *
 * 单一权威 = 各自模块的既有常量(不在这里另抄一份清单):
 *   - `PLATFORM_DEFAULT_MODEL` / `PLATFORM_HIDDEN_REVIEWER_MODEL`(platformDefaults.ts)
 *   - `DEFAULT_CODEX_ENGINE_MODEL`(protocol engineModels —— 内置 codex 队长)
 *   - `PLATFORM_SEED_AGENT_MODEL_IDS`(seedPlatformAgents 的预设 agent manifest 派生)
 */
export const PLATFORM_SEED_MODEL_IDS: readonly string[] = [
  ...new Set<string>([
    PLATFORM_DEFAULT_MODEL,
    PLATFORM_HIDDEN_REVIEWER_MODEL,
    DEFAULT_CODEX_ENGINE_MODEL,
    ...PLATFORM_SEED_AGENT_MODEL_IDS,
  ]),
];

/**
 * 断言 seed 引用的模型全部在 catalog **active**(启动断言 + deploy 门都调它)。
 *
 * 为什么必须是**启动就抛**而不是"运行期发现再报":seed agent 是平台自带的门面,
 * 它引用的模型如果不在 catalog active,用户点开预设助手的第一句话就会被 gate 拒 ——
 * 这类事故必须在部署时被拦下,而不是让用户来当探针。
 *
 * 注意它与 per-uid 下发的关系(R2-M8):**这里全局要求存在且 active;下发仍严格按 uid
 * 过滤**。二者不矛盾 —— seed 模型可以是 visibility='admin'(普通用户投影里没有它),
 * 那种 agent 本就不该被普通用户执行,拒绝发生在执行时而不是靠"强塞进投影"。
 */
export function assertSeedModelsActive(snapshot: ModelCatalogSnapshot): void {
  const active = new Set(snapshot.activeModelIds());
  const missing = PLATFORM_SEED_MODEL_IDS.filter(
    (id) => !active.has(snapshot.aliasToCanonical(id)),
  );
  if (missing.length > 0) {
    throw new Error(
      `[model-catalog] seed models missing from catalog (or not active): ${missing.join(", ")} — ` +
        "平台预设 agent 会在第一条消息就被拒。修 catalog(staged→active)后再启动。",
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
