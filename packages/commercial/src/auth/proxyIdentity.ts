/**
 * V3 Phase 2 — Identity strategy for anthropicProxy.
 *
 * 物理切出自 http/anthropicProxy.ts(2026-05-18 V3_ANTHROPIC_PROXY_SPLIT_PLAN §3.2)。
 * 把"身份双因子 verify + post-auth 流量计数 + 模型授权"三件事抽成 strategy 契约,
 * proxy handler 只通过 `deps.identity.resolve()` / `deps.identity.authorize()` 与之交互,
 * 不再直接 import containerIdentity / authzModels / hostReqCounter。
 *
 * 当前实现:
 *   - `makeContainerIdentityStrategy`(本文件)— 容器 token 双因子 + 容器宿主流量计数
 *   - `makeApiKeyIdentityStrategy`(`./apiKeyIdentity.ts`)— 2026-05-18 CC 外接 plan
 *     Phase 2:Bearer `oc-cc.<prefix>.<secret>` token + `containerId: null` 路径
 *
 * 两者通过 `authorizeProxyIdentity`(本文件)共享同一份模型授权业务规则,
 * 避免身份维度长出"两套 authz"。未来新增 strategy 也走同一函数。
 *
 * 行为等价性(原 anthropicProxy.ts 1124-1145 + 1152 + 1252-1277):
 *   - verify 失败 → IdentityError(code=原 ContainerIdentityError.code) → handler 401
 *   - recordHostRequest 只在 verify 成功后 fire 一次,authz deny 不影响 fire 状态
 *   - authz load throw → AuthzLoadError(cause=原 err) → handler 500
 *   - canUseModel false → AuthzDeniedError(modelId, role) → handler 403
 */

import type { IncomingMessage } from "node:http";
import {
  ContainerIdentityError,
  verifyContainerIdentity,
  type ContainerIdentityRepo,
} from "./containerIdentity.js";
import { canUseModel } from "../billing/authzModels.js";
import type { ModelPricing, PricingCache } from "../billing/pricing.js";
import { recordHostRequest as defaultRecordHostRequest } from "../compute-pool/hostReqCounter.js";

/**
 * Identity 解析结果。**只**包含下游业务逻辑要消费的最小字段。
 *
 * 不包含 hostUuid / boundIp:它们是 listener 侧 ctx 入参,由 wiring 层直传给
 * observability(log child 早已写入 hostUuid/boundIp)。Identity 是"用户/会话"
 * 维度的抽象,不该承担"物理路径"信息(plan §3.2)。
 */
export interface ProxyIdentity {
  /** users.id,后续 rate-limit / preCheck / authz / log child 全部使用 */
  uid: bigint;
  /**
   * agent_containers.id,**为 null 表示非容器 strategy**(如 ApiKeyIdentityStrategy)。
   *
   * SQL 层(`request_finalize_journal.container_id BIGINT REFERENCES agent_containers(id)
   *  ON DELETE SET NULL`,见 0015)早已 nullable;TS 这里只是把语义对齐 SQL 真实约束。
   * usage_records / credit_ledger 本就没有 container_id 列,只按 user 维度计费。
   *
   * 历史(2026-05-18 CC 外接 plan §5 决策):此前注释写 "future API key strategy
   * 这里放 api_key_id";已废弃 —— 不要把 api_key_id 塞进 containerId 字段(语义错位)。
   * 未来若需 per-key 维度审计,新增独立 `apiKeyId?: bigint` 字段贯穿至 journal。
   */
  containerId: bigint | null;
}

/**
 * Identity 层契约。
 *
 * 实现内部职责:
 *   - `resolve`:校验请求来源 + post-auth 流量记账。失败 throw IdentityError(handler 401)。
 *   - `authorize`:校验该 identity 对**已 enable-gate 过的** model 是否有权使用。
 *     失败 throw AuthzLoadError(handler 500)/ AuthzDeniedError(handler 403)。
 *
 * 关键不变量:
 *   - resolve 成功 → post-auth 副作用(recordHostRequest 等)必须已 fire,authz 失败不回滚
 *   - resolve 抛错 → 任何副作用都未 fire(verify 不通过不能算"成功的请求")
 *   - authorize 调用时机:pricing.enabled gate 之后、isDeepseekModel / preCheck / scheduler.pick 之前
 *     (fail-closed:authz 失败直接退出,不走 reservation,避免 release 复杂度)
 */
export interface IdentityStrategy {
  resolve(
    req: IncomingMessage,
    ctx: { hostUuid: string; boundIp: string },
  ): Promise<ProxyIdentity>;

  /**
   * 授权检查。**handler 必须先做完 pricing.enabled gate**,本方法假设 model 在
   * pricing 表里且 enabled=true,只检查 visibility / grants / role。
   *
   * @param pricing 已 resolve 的 ModelPricing(handler 已通过 pricing.get + enabled gate)。
   *   当前 container strategy 不消费此参数 —— canUseModel 内部走 PricingCache + canonicalize
   *   重新查表(canonicalize 后可能映射到不同 row,该行为继承自既有 canUseModel 契约)。
   *   参数保留是为了贴合 plan §3.2 的"授权显式依赖已选 pricing"契约,为未来 strategy
   *   收敛留口子 —— 不是死参数,是有意保留的 forward-compat。
   */
  authorize(
    identity: ProxyIdentity,
    pricing: ModelPricing,
    model: string,
  ): Promise<void>;
}

/**
 * Identity verify 失败。handler 把它映射成 401 UNAUTHORIZED + log
 * `proxy_identity_failed { errcode: <code> }` + metric `incrAnthropicProxyReject("identity")`。
 *
 * `code` 透传自原 ContainerIdentityError.code:
 *   BAD_TOKEN_FORMAT / UNKNOWN_CONTAINER_IP / CONTAINER_NOT_ACTIVE
 *   / CONTAINER_ID_MISMATCH / BAD_SECRET
 *
 * 当前实现只产 401。如果未来出现"identity verify 失败但要给 403"的需求,
 * 给 IdentityError 加 `.status` 字段,handler 按 status 分发;现在保持单一映射。
 */
export class IdentityError extends Error {
  constructor(
    /** 错误码,只进 server log,不外泄给客户端 */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "IdentityError";
  }
}

/**
 * Authz 加载失败(loadUserModelAuthz 内部 throw)。
 * handler 把它映射成 500 INTERNAL + log `proxy_authz_load_failed { err: errSummary(cause) }`。
 *
 * `cause` 是原 throw 的对象,handler 用 errSummary 序列化,与重构前等价
 * (原 handler 代码:`userLog.error("proxy_authz_load_failed", { err: errSummary(err) })`)。
 */
export class AuthzLoadError extends Error {
  constructor(readonly cause: unknown) {
    super("authz load failed");
    this.name = "AuthzLoadError";
  }
}

/**
 * 模型未授权(canUseModel 返回 false)。
 * handler 把它映射成 403 NOT_AUTHORIZED + log `proxy_unauthorized_model { model, role }`
 *  + metric `incrAnthropicProxyReject("unauthorized_model")`。
 */
export class AuthzDeniedError extends Error {
  constructor(
    readonly modelId: string,
    readonly role: "user" | "admin",
  ) {
    super("model not authorized");
    this.name = "AuthzDeniedError";
  }
}

/**
 * 共享 authz 业务规则:不论身份从哪条 strategy 来(容器双因子 / API key),
 * "uid 是否被授权使用 model" 的判定逻辑必须**完全一致**。
 *
 * 抽出独立函数(2026-05-18 CC 外接 plan Phase 2,Codex MINOR 命名采纳):
 *   - 命名不叫 `defaultAuthorize` — 这不是"默认实现",而是两种 strategy
 *     必须共享的业务规则;命名要体现这一点。
 *   - 任何 future identity strategy 接入,都应直接调本函数,确保 authz
 *     语义不分裂。这是消除"一类问题"的抽象,不是炫技。
 *
 * 行为契约:
 *   - `loadUserModelAuthz` throw → `AuthzLoadError(cause)` → handler 500
 *   - `canUseModel` false → `AuthzDeniedError(model, role)` → handler 403
 *   - 成功 → void
 *
 * 注意:`pricing` 参数当前不被 canUseModel 直接消费(它内部走 deps.pricing
 * 重新查表 + canonicalize)。保留参数贴合 IdentityStrategy.authorize 签名,
 * 让"authorize 显式收 pricing"的契约在两个 strategy 里保持一致(Phase 2
 * Codex 反馈)。
 */
export interface SharedAuthorizeDeps {
  pricing: PricingCache;
  loadUserModelAuthz: (
    uid: bigint,
  ) => Promise<{
    role: "user" | "admin";
    grantedModelIds: ReadonlySet<string>;
  }>;
}

export async function authorizeProxyIdentity(
  deps: SharedAuthorizeDeps,
  identity: ProxyIdentity,
  model: string,
): Promise<void> {
  let authz;
  try {
    authz = await deps.loadUserModelAuthz(identity.uid);
  } catch (err) {
    throw new AuthzLoadError(err);
  }
  const ok = canUseModel(
    { pricing: deps.pricing },
    {
      role: authz.role,
      grantedModelIds: authz.grantedModelIds,
      modelId: model,
    },
  );
  if (!ok) {
    throw new AuthzDeniedError(model, authz.role);
  }
}

export interface ContainerIdentityStrategyDeps {
  /** 容器身份双因子查询入口(默认 createPgIdentityRepo()) */
  repo: ContainerIdentityRepo;
  /** 模型价格 / visibility 表(canUseModel 内部用) */
  pricing: PricingCache;
  /** 服务端权威源 role + grants 查询(失败 fail-closed) */
  loadUserModelAuthz: (
    uid: bigint,
  ) => Promise<{
    role: "user" | "admin";
    grantedModelIds: ReadonlySet<string>;
  }>;
  /**
   * Post-auth 流量计数 hook —— **test seam,production 不传**。
   *
   * Production wiring 必须**不**注入该字段,strategy 走默认实现
   * `../compute-pool/hostReqCounter.recordHostRequest`(模块级全局 map),
   * 该 map 直接驱动 admin "5min req" dashboard(0045)。
   *
   * 显式注入只在 integ test 场景:用 no-op 或计数 spy 替代默认实现,避免
   * 测试间共享 counter 状态泄漏 / 干扰 dashboard 仪表。Production code 注入
   * 一个非 default 实现会**悄悄掏空 admin dashboard**,review 时务必拦截。
   */
  recordHostRequest?: (hostUuid: string) => void;
}

/**
 * 默认 strategy —— V3 self-host(plaintext 18791)与 remote-host(mTLS 18443)共用。
 *
 * 实现细节:
 *   - resolve:verifyContainerIdentity 成功 → recordHostRequest(ctx.hostUuid) → return
 *     `{ uid: BigInt(userId), containerId: BigInt(containerId) }`。
 *     verify 抛 ContainerIdentityError → 转抛 IdentityError(保留 code);其他 error 透传(handler throw)。
 *   - authorize:loadUserModelAuthz 失败 → AuthzLoadError(cause);canUseModel false →
 *     AuthzDeniedError(model, role)。pricing 参数当前未消费(canUseModel 内部走 PricingCache)。
 */
export function makeContainerIdentityStrategy(
  deps: ContainerIdentityStrategyDeps,
): IdentityStrategy {
  const rec = deps.recordHostRequest ?? defaultRecordHostRequest;
  return {
    async resolve(req, ctx) {
      let identity;
      try {
        identity = await verifyContainerIdentity(
          deps.repo,
          ctx,
          req.headers.authorization,
        );
      } catch (err) {
        if (err instanceof ContainerIdentityError) {
          throw new IdentityError(err.code, err.message);
        }
        throw err;
      }
      // 0045 — admin "5min req" 计数器 hook 点。**仅**统计身份双因子通过的
      // /v1/messages,排除 health probe / WS / 后台任务,反映真实 LLM 流量。
      // (authz deny 不回滚 — 见 IdentityStrategy.resolve 不变量注释)
      rec(ctx.hostUuid);
      return {
        uid: BigInt(identity.userId),
        containerId: BigInt(identity.containerId),
      };
    },
    async authorize(identity, _pricing, model) {
      // 共享 authz 业务规则(2026-05-18 CC 外接 plan Phase 2):任何 strategy
      // 都走同一份 loadUserModelAuthz + canUseModel,避免身份维度的 authz 分裂。
      await authorizeProxyIdentity(
        { pricing: deps.pricing, loadUserModelAuthz: deps.loadUserModelAuthz },
        identity,
        model,
      );
    },
  };
}
