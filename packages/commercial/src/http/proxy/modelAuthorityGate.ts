/**
 * 模型权威批次 · 切片 5/6 —— `/v1/messages` 的**每请求** authority 校验 + epoch fence。
 *
 * 方案:docs/V5_MODEL_AUTHORITY_PLAN.md §1.2(epoch fence 双进程共用)/ §4(CCB proxy 请求绑定)。
 *
 * 谁在调用:`makeAnthropicProxyHandler`(http/proxy/index.ts)。生产里那个 handler 跑在
 * **独立的 openclaude-v5-egress 进程**(egress/main.ts;master 侧同一份实现只服务非 split
 * 拓扑)。所以本文件即"egress 侧 fence" —— 改它必须 `deploy-v5.sh --egress`。
 *
 * ── 为什么 fence 要在每个 HTTP 请求上做(R3-B2 / R4-m3)────────────────────────
 * 一个 turn 会打出很多次上游 `/v1/messages`(工具循环 / compact / 团队委派)。安全变更
 * (disable 模型 / 撤 grant / 收紧 visibility / 改价)在 DB 侧**同事务 bump epoch**;若 egress
 * 只在 turn 开始时看一次 epoch,撤销后这个 turn 还能继续烧到结束 = 已知 stale window。
 * 因此:**每个独立 HTTP 请求在授权/路由前做一次单行 SELECT epoch**(不做时间微缓存),
 * 同一请求内的 settle 复用该结果(长 turn 的下一次上游请求必然感知变更)。
 *
 * ── 两类请求凭据(§4)────────────────────────────────────────────────────────
 *   1. **bridge turn**(浏览器 → bridge → 容器):master 签名的 authority envelope +
 *      turn lease。裸 header 不作数(同 uid 进程可伪造,R3-M5)—— 必须 Ed25519 验签。
 *      · authority TTL 短(只约束"开始执行"),lease TTL = 最大 turn 窗口 + grace;
 *        turn 内**后续**上游请求只带 lease 是合法的(R4-M1),两张票都在时交叉对账。
 *   2. **本地路径 turn**(cron / synthetic / delegate):容器 catalog client 自铸的
 *      `local_catalog` token(携 projectionRevision + epoch,R3-M6)。它**不是**授权凭据
 *      (容器无私钥,不可能签)——授权仍走既有的容器身份双因子 + canUseModel + catalog 判定;
 *      token 只承载 epoch,让 egress 能对本地路径做同一道 fence。故意与 bridge authority
 *      **不同 header、不同 kind**,不允许互相伪装。
 *
 * ── 失败语义(全部 fail-closed)────────────────────────────────────────────────
 *   · 快照 unknown / DB 不可达            → 503 MODEL_CATALOG_UNAVAILABLE
 *   · 模型不在 catalog active / 不可路由  → 403 MODEL_NOT_AVAILABLE(**不回显** engine/
 *                                            provider/revision —— 探测面收窄到"能不能用")
 *   · 无凭据 / 验签失败 / 绑定字段不符    → 403 MODEL_AUTHORITY_INVALID
 *   · epoch 或 executionRevision 漂移     → 409 MODEL_CONFIG_CHANGED_RETRY_TURN(R3-m12,
 *                                            前端引导重开 turn;与"安全撤销"共码但监控可按
 *                                            日志字段区分是 epoch 还是 revision 触发)
 */

import type { IncomingHttpHeaders } from "node:http";

import {
  ModelAuthorityError,
  assertLeaseMatchesAuthority,
  isModelAllowedByAuthority,
  verifyAuthority,
  verifyTurnLease,
  type AuthorityKeyring,
  type ModelAuthorityPayload,
  type TurnLease,
} from "@openclaude/protocol";

import {
  CatalogUnknownError,
  UnknownCapabilitySchemaError,
  type ModelCatalogSnapshot,
  type ModelExecutionDescriptor,
} from "../../billing/modelCatalog.js";

// ─────────────────────────────────────────────────────────────────────────────
// wire 契约(与容器侧 gateway/src/modelCatalogClient.ts **逐字节同值**)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * bridge turn 的完整签名 authority envelope(base64url)。
 *
 * **parity 契约**:容器侧的同名常量在 `gateway/src/modelCatalogClient.ts`;两侧各持一份是
 * 有意的(gateway 不允许 import commercial —— 容器不该看见计费/DB 代码),漂移由
 * `__tests__/modelAuthorityGate.test.ts` 的跨包一致性断言守护。
 */
export const AUTHORITY_HEADER = "x-oc-model-authority";
/** turn lease envelope(base64url)。turn 内后续上游请求的长命凭据(R4-M1)。 */
export const TURN_LEASE_HEADER = "x-oc-turn-lease";
/** 本地路径(cron/synthetic/delegate)的 container-catalog token。 */
export const LOCAL_CATALOG_HEADER = "x-oc-local-catalog";

/** local_catalog token 的 kind 字面量(不与 bridge authority 混用)。 */
export const LOCAL_CATALOG_KIND = "local_catalog";

export type AuthorityKind = "bridge_signed" | "local_catalog";

/**
 * 容器 catalog client 自铸的本地路径 token。
 *
 * **不是授权凭据**:无签名,容器可任意构造 —— 所以 egress 只从它取 epoch 做 fence,
 * 其余(这个 uid 能不能用这个模型)全部走服务端权威(容器身份 → uid → grants → catalog)。
 * 伪造一个"更新的 epoch"不会带来任何越权:epoch 必须与 **DB 当前值**相等才放行,
 * 伪造只会让自己被拒。
 */
export interface LocalCatalogToken {
  v: 1;
  kind: typeof LOCAL_CATALOG_KIND;
  /** 该 uid 投影的哈希(全局 executionRevision 不下发容器,R2-M12)。 */
  projectionRevision: string;
  /** 容器 catalog 快照的 epoch(十进制字符串;BigInt 不能直接进 JSON)。 */
  securityEpoch: string;
}

export function encodeLocalCatalogToken(token: LocalCatalogToken): string {
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/** 解析(fail-closed:任何形状不符 → 抛 GateReject,不做"尽力解析")。 */
export function parseLocalCatalogToken(raw: string): LocalCatalogToken {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ModelGateReject("authority_invalid", "local catalog token undecodable");
  }
  const o = parsed as Partial<LocalCatalogToken> | null;
  if (
    !o ||
    typeof o !== "object" ||
    o.v !== 1 ||
    o.kind !== LOCAL_CATALOG_KIND ||
    typeof o.projectionRevision !== "string" ||
    o.projectionRevision === "" ||
    typeof o.securityEpoch !== "string" ||
    !/^\d+$/.test(o.securityEpoch)
  ) {
    throw new ModelGateReject("authority_invalid", "local catalog token shape invalid");
  }
  return {
    v: 1,
    kind: LOCAL_CATALOG_KIND,
    projectionRevision: o.projectionRevision,
    securityEpoch: o.securityEpoch,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 拒绝语义
// ─────────────────────────────────────────────────────────────────────────────

export type GateRejectKind =
  /** 模型不在 catalog active / 无价 / capability schema 未来版本 / engine 不该走本代理。 */
  | "not_available"
  /** 无凭据 / 验签失败 / 绑定字段(uid/containerId/model)不符。 */
  | "authority_invalid"
  /** epoch 或 executionRevision 漂移 —— 安全或计费配置在 turn 中途变了。 */
  | "config_changed"
  /** 本进程快照 unknown(NOTIFY 后重建未成 / DB 不可达)。 */
  | "catalog_unavailable";

/** 客户端可见的错误码(**不含** model/engine/provider/revision —— 不给探测面)。 */
const REJECT_CODE: Record<GateRejectKind, string> = {
  not_available: "MODEL_NOT_AVAILABLE",
  authority_invalid: "MODEL_AUTHORITY_INVALID",
  config_changed: "MODEL_CONFIG_CHANGED_RETRY_TURN",
  catalog_unavailable: "MODEL_CATALOG_UNAVAILABLE",
};

const REJECT_STATUS: Record<GateRejectKind, number> = {
  not_available: 403,
  authority_invalid: 403,
  config_changed: 409,
  catalog_unavailable: 503,
};

/** 客户端可见 message(通用文案;真实原因只进服务端日志的 `detail`)。 */
const REJECT_MESSAGE: Record<GateRejectKind, string> = {
  not_available: "model not available",
  authority_invalid: "model authority missing or invalid",
  config_changed: "model configuration changed, please retry in a new turn",
  catalog_unavailable: "model catalog unavailable",
};

export class ModelGateReject extends Error {
  readonly kind: GateRejectKind;
  /** 只进日志,不出网。 */
  readonly detail: string;

  constructor(kind: GateRejectKind, detail: string) {
    super(`${REJECT_CODE[kind]}: ${detail}`);
    this.name = "ModelGateReject";
    this.kind = kind;
    this.detail = detail;
  }

  get code(): string {
    return REJECT_CODE[this.kind];
  }
  get status(): number {
    return REJECT_STATUS[this.kind];
  }
  get clientMessage(): string {
    return REJECT_MESSAGE[this.kind];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 判定结果
// ─────────────────────────────────────────────────────────────────────────────

export interface ModelAuthorityDecision {
  /** 本请求线性化到的快照(路由 / 能力 / 清洗 / settle 全部消费它,单一权威)。 */
  snapshot: ModelCatalogSnapshot;
  /** alias 归一后的 canonical model id。 */
  canonicalModel: string;
  /** catalog 派生的完整执行语义(engine / provider / upstream / capability / context / effort)。 */
  descriptor: ModelExecutionDescriptor;
  authorityKind: AuthorityKind;
  /** 落 usage_records.execution_revision(全局执行投影哈希;**不下发**用户)。 */
  executionRevision: string;
  /** 落 usage_records.projection_revision;bridge 路径无此概念 → null。 */
  projectionRevision: string | null;
  /** 落 usage_records.security_epoch。 */
  securityEpoch: bigint;
  /** bridge 路径的 turn 标识(日志/对账用;本地路径 null)。 */
  authorityTurnId: string | null;
}

/**
 * 快照来源的窄接口(生产 = `ModelCatalogCache`,结构满足)。
 * gate 只需要"一份已 fence 过的快照";单测据此不必拉 PG。
 */
export interface CatalogSource {
  assertFresh(): Promise<ModelCatalogSnapshot>;
}

export interface EnforceArgs {
  catalog: CatalogSource;
  /**
   * 公钥 keyring(master 私钥的对应公钥;egress 与 master 同机读同一份 keyring 文件)。
   * null = 未装配 → 任何 bridge 凭据一律拒(fail-closed,不退化成"信裸 header")。
   */
  keyring: AuthorityKeyring | null;
  headers: IncomingHttpHeaders;
  uid: bigint;
  /** 容器身份(非容器 strategy 如外接 API key = null → bridge 凭据不适用)。 */
  containerId: bigint | null;
  /** 客户端请求里的 body.model(可能是 alias)。 */
  model: string;
  /** 测试注入。 */
  now?: number;
}

/**
 * 每请求 fence + authority 校验。**必须在授权 / 路由 / preCheck 之前**调用。
 *
 * 顺序不可换:
 *   ① 先 fence(assertFresh = 单行 SELECT epoch + 漂移则同步重建)—— 拿到与 DB 线性化的快照;
 *   ② 再判模型可路由性(用①的快照);
 *   ③ 最后验凭据并把凭据里的 epoch/revision 与①对齐。
 * 反过来(先验票再 fence)会让"票是旧 epoch 签的、但本进程快照恰好也旧"的双旧场景蒙混过关。
 */
export async function enforceModelAuthority(args: EnforceArgs): Promise<ModelAuthorityDecision> {
  const now = args.now ?? Date.now();

  // ① epoch fence(单行 SELECT;漂移 → 同步重建;重建失败/DB 不可达 → 拒)
  let snapshot: ModelCatalogSnapshot;
  try {
    snapshot = await args.catalog.assertFresh();
  } catch (err) {
    if (err instanceof CatalogUnknownError) {
      throw new ModelGateReject("catalog_unavailable", "catalog snapshot unknown");
    }
    throw new ModelGateReject(
      "catalog_unavailable",
      `catalog fence failed: ${(err as Error)?.message ?? String(err)}`,
    );
  }

  // ② 可路由性(active + 有价 + capability schema 可理解)
  const canonicalModel = snapshot.aliasToCanonical(args.model);
  let descriptor: ModelExecutionDescriptor | null;
  try {
    descriptor = snapshot.resolve(canonicalModel);
  } catch (err) {
    if (err instanceof UnknownCapabilitySchemaError) {
      // 配置事故(DB 里有本进程不认识的 schema 版本)→ 对用户仍是"不可用",但日志要响亮。
      throw new ModelGateReject("not_available", `unknown capability schema: ${err.message}`);
    }
    throw err;
  }
  if (!descriptor) {
    throw new ModelGateReject("not_available", `model '${canonicalModel}' not routable`);
  }
  if (descriptor.engine !== "ccb") {
    // codex 走 /internal/v3/codex-relay,不该出现在 anthropic proxy。
    throw new ModelGateReject(
      "not_available",
      `engine '${descriptor.engine}' is not served by the anthropic proxy`,
    );
  }

  // ③ 凭据
  const authorityRaw = readHeader(args.headers, AUTHORITY_HEADER);
  const leaseRaw = readHeader(args.headers, TURN_LEASE_HEADER);
  const localRaw = readHeader(args.headers, LOCAL_CATALOG_HEADER);

  if (authorityRaw || leaseRaw) {
    return verifyBridgeAuthority({
      authorityRaw,
      leaseRaw,
      keyring: args.keyring,
      now,
      uid: args.uid,
      containerId: args.containerId,
      canonicalModel,
      descriptor,
      snapshot,
    });
  }

  if (localRaw) {
    const token = parseLocalCatalogToken(localRaw);
    assertEpochMatches(BigInt(token.securityEpoch), snapshot.securityEpoch, "local_catalog");
    return {
      snapshot,
      canonicalModel,
      descriptor,
      authorityKind: "local_catalog",
      executionRevision: snapshot.executionRevision,
      projectionRevision: token.projectionRevision,
      securityEpoch: snapshot.securityEpoch,
      authorityTurnId: null,
    };
  }

  throw new ModelGateReject("authority_invalid", "request carries no model authority");
}

function verifyBridgeAuthority(a: {
  authorityRaw: string | null;
  leaseRaw: string | null;
  keyring: AuthorityKeyring | null;
  now: number;
  uid: bigint;
  containerId: bigint | null;
  canonicalModel: string;
  descriptor: ModelExecutionDescriptor;
  snapshot: ModelCatalogSnapshot;
}): ModelAuthorityDecision {
  if (!a.keyring || a.keyring.size === 0) {
    throw new ModelGateReject("authority_invalid", "no authority keyring configured");
  }
  if (a.containerId === null) {
    // 非容器 strategy(外接 API key)不可能持有 bridge 签名票据。
    throw new ModelGateReject("authority_invalid", "bridge authority on a non-container identity");
  }

  let authority: ModelAuthorityPayload | null = null;
  let lease: TurnLease | null = null;
  try {
    if (a.authorityRaw) authority = verifyAuthority(a.authorityRaw, a.keyring, a.now);
    if (a.leaseRaw) lease = verifyTurnLease(a.leaseRaw, a.keyring, a.now);
    // 两张票都在 → 必须属于同一个 turn(R4-M1:只验签不对账 = 跨 turn 降级攻击面)。
    if (authority && lease) assertLeaseMatchesAuthority(lease, authority);
  } catch (err) {
    if (err instanceof ModelAuthorityError) {
      throw new ModelGateReject("authority_invalid", `${err.code}: ${err.message}`);
    }
    throw err;
  }

  // turn 内后续请求只带 lease 是合法的(authority 的短 TTL 只约束"开始执行")。
  const principal = authority ?? lease;
  if (!principal) {
    throw new ModelGateReject("authority_invalid", "no verifiable authority credential");
  }

  // 绑定字段:票据必须是**为这个容器、这个用户、这个模型**签的。
  if (BigInt(principal.uid) !== a.uid) {
    throw new ModelGateReject("authority_invalid", "authority uid mismatch");
  }
  if (BigInt(principal.containerId) !== a.containerId) {
    throw new ModelGateReject("authority_invalid", "authority containerId mismatch");
  }
  // 放行集合 = {canonicalModel} ∪ auxModels(判定单点收口在 protocol isModelAllowedByAuthority)。
  //
  // 为什么不是"principal.canonicalModel === body.model"的硬相等:CCB 在一个 turn 里除了主模型,
  // 还会用**次级模型**打上游(WebFetch queryHaiku / WebSearch useHaiku / awaySummary /
  // toolUseSummary / claudeAiLimits,全经 ANTHROPIC_SMALL_FAST_MODEL = deepseek-v4-flash)。
  // 硬相等 = 这些隐藏调用在 flag 开启当天全部 403(取证 2026-07-12,BLOCKER)。
  //
  // 仍然显式 + fail-closed:集合由 **master 签发**(容器改不了,改 = 验签失败),集合外一律拒。
  // **计费不因此松动**:结算走的是 a.descriptor(= 本进程快照按 body.model 解析出来的那一行),
  // 次级模型有自己的定价行,按自己的价结算;epoch fence 每请求照跑。
  if (!isModelAllowedByAuthority(principal, a.canonicalModel)) {
    // descriptor 说 A(且 aux 也不含 B)、请求跑 B = 计费与执行分裂(P0 形状)。
    throw new ModelGateReject("authority_invalid", "authority model mismatch");
  }

  assertEpochMatches(BigInt(principal.securityEpoch), a.snapshot.securityEpoch, "bridge_signed");

  // executionRevision 只在完整 envelope 里有。相等 epoch 下它必然相等(execution 字段变更
  // 一定 bump epoch,0135 trigger 保证)—— 不等 = 签发方与本进程有一方快照陈旧(R4-m6:
  // "master 新 / egress 旧" 必须拒),按配置漂移处理。
  if (authority && authority.executionRevision !== a.snapshot.executionRevision) {
    throw new ModelGateReject(
      "config_changed",
      `execution revision drift: authority=${authority.executionRevision.slice(0, 12)} ` +
        `snapshot=${a.snapshot.executionRevision.slice(0, 12)}`,
    );
  }

  return {
    snapshot: a.snapshot,
    canonicalModel: a.canonicalModel,
    descriptor: a.descriptor,
    authorityKind: "bridge_signed",
    executionRevision: a.snapshot.executionRevision,
    // 全局 executionRevision 不下发用户;bridge 路径也不产出 per-uid projectionRevision。
    projectionRevision: null,
    securityEpoch: a.snapshot.securityEpoch,
    authorityTurnId: principal.authorityTurnId,
  };
}

function assertEpochMatches(tokenEpoch: bigint, snapshotEpoch: bigint, kind: AuthorityKind): void {
  if (tokenEpoch !== snapshotEpoch) {
    throw new ModelGateReject(
      "config_changed",
      `epoch drift (${kind}): token=${tokenEpoch} snapshot=${snapshotEpoch}`,
    );
  }
}

function readHeader(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name];
  if (typeof v === "string" && v.trim() !== "") return v.trim();
  // 同名 header 出现多次(数组)= 请求可疑,不做"取第一个"的宽容解析。
  if (Array.isArray(v) && v.length > 0) {
    throw new ModelGateReject("authority_invalid", `duplicate ${name} header`);
  }
  return null;
}
