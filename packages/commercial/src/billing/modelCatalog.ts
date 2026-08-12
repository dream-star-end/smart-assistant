/**
 * 模型权威批次 · 切片 1 — ModelExecutionCatalog 快照层。
 * 方案:docs/V5_MODEL_AUTHORITY_PLAN.md §1.2 / §2 / §6。DB 层:migrations/0143_model_catalog.sql。
 *
 * 单一权威:
 *   - **可执行性(engine / provider / upstream / context / capability / 可用性)= model_catalog**。
 *     `model_pricing.enabled` 自 0143 起是 catalog 的派生镜像(为旧 master 回滚而留),
 *     本模块与 pricing.ts **一律不读镜像列**,而是直接从 catalog.state 派生 —— 镜像即使
 *     被外力写歪,v5 运行时判定也不受影响。
 *   - 价格 / visibility / default_effort 仍在 model_pricing(catalog 只管 execution)。
 *
 * revision 三件(方案 §1.2):
 *   - `executionRevision`  全局执行投影哈希。**仅** active 行的规范执行字段 ∪ 指向有效版本的
 *     alias ∪ capability schema version(R4-m5:排除 entry_id/lock_version/审计列/staged·retired
 *     历史行 —— 编辑未激活的 staged 行不抖动全局 revision)。进签名 envelope,不下发用户。
 *   - `billingRevision`    价格投影哈希(计费面对账用)。
 *   - `projectionRevision` **per-uid**(R2-M12):全局 revision 不作为用户可观测字段,
 *     容器/前端只看自己那份投影的哈希。
 *
 * epoch fence(R3-B1/B2 + R4-m3):
 *   `assertEpochFresh()` 直接单行 SELECT epoch 与快照比对,**不做时间微缓存** —— 收窄与计费
 *   变更不允许已知 stale window。签发 authority / codex preCheck·journal / egress 每个
 *   `/v1/messages` 的授权·路由前各调一次;不等 → EpochStaleError → 调用方同步重建,
 *   重建失败或 DB 不可达 → 拒(fail-closed)。
 *
 * 本切片只提供快照 + 判定 + fence 基建;签名 envelope(§2)、容器下发(§6)、egress 消费(§4)
 * 分别在切片 2/3。
 */

import { createHash } from "node:crypto";
import { Client } from "pg";
import { DEFAULT_SECONDARY_UTILITY_MODEL } from "@openclaude/gateway";
import {
  PLATFORM_REASONING_EFFORTS,
  type PlatformReasoningEffort,
} from "@openclaude/protocol";
import { loadConfig } from "../config.js";
import { query, type QueryRunner } from "../db/queries.js";
import { getPool } from "../db/index.js";
import { projectContextWindowForRole } from "./modelRolePolicy.js";
import type { ModelPricing, ModelVisibility } from "./pricing.js";

// ─────────────────────────────────────────────────────────────────────────────
// 类型
// ─────────────────────────────────────────────────────────────────────────────

export type ModelEngine = "ccb" | "codex" | "grok";
export type ModelCatalogState = "staged" | "active" | "disabled" | "retired";

/**
 * 本进程能理解的 capability_profile schema 版本上限。
 * DB 行的 capability_schema_version > 本值 = 未来版本 → 消费侧 **fail-closed**
 * (R2-m15):该行不可路由、resolve() 抛错。**新增 profile 字段必须 bump 本常量**,
 * 并同步 gateway/容器侧的消费上限(切片 2)。
 */
export const CAPABILITY_SCHEMA_VERSION = 1;

/** capability_profile(JSONB)的 v1 形状 —— 与 0143 fn_model_catalog_capability 同源。 */
export interface ModelCapabilityProfile {
  /** 上游是否原生支持图像识别。false → master proxy strip 图 + understand_image 工具兜底。 */
  supportsVision: boolean;
  reasoning: {
    /** 该模型可接受/展示的思考档位;空数组 = 不支持思考深度。 */
    supported: readonly PlatformReasoningEffort[];
    /** 仅 codex 型号有值;用户未覆盖时 runner 必须沿用它。 */
    codexModelDefault: PlatformReasoningEffort | null;
  };
  /** CCB 本地曾经 baked 的执行开关；权威化后随 descriptor 每 turn 下发。 */
  ccb: {
    capabilityZero: boolean;
    supportsThinking: boolean;
  };
}

/** catalog 一行(含历史版本)。 */
export interface ModelCatalogEntry {
  entryId: number;
  modelId: string;
  engine: ModelEngine;
  /** engine='ccb' 时必非空。虚拟条目:'codex'(OAuth ChatGPT 池)/'anthropic'(OAuth Claude 池)。 */
  providerId: string | null;
  /** null = 与 modelId 相同(转发时用 modelId)。 */
  upstreamModelId: string | null;
  contextWindow: number | null;
  capabilityProfile: ModelCapabilityProfile;
  capabilitySchemaVersion: number;
  state: ModelCatalogState;
  lockVersion: number;
}

/** catalog 侧不管价格;计费/授权面从 model_pricing 随快照一起读入。 */
export interface ModelCatalogPricing {
  modelId: string;
  displayName: string;
  inputPerMtok: bigint;
  outputPerMtok: bigint;
  cacheReadPerMtok: bigint;
  cacheWritePerMtok: bigint;
  multiplier: string;
  visibility: ModelVisibility;
  sortOrder: number;
  /** execution descriptor 的一部分(proxy 在 client 未显式带 effort 时注入)。 */
  defaultEffort: string | null;
}

/**
 * 签名 envelope 里下发给容器的完整执行语义(方案 §2 executionDescriptor)。
 * **自包含**:容器该 turn 的 engine/capability/context/effort/vision 全部取自这里,
 * 不查本地 catalog → master/容器对该 turn 物理同快照。
 */
export interface ModelExecutionDescriptor {
  canonicalModel: string;
  engine: ModelEngine;
  providerId: string | null;
  /** 已解析:catalog 的 upstream_model_id ?? canonicalModel。 */
  upstreamModelId: string;
  contextWindow: number | null;
  capabilityProfile: ModelCapabilityProfile;
  capabilitySchemaVersion: number;
  /** model_pricing.default_effort(null = 不注入)。 */
  defaultEffort: string | null;
}

/** per-uid 投影的一行(/internal/v3/model-catalog + /api/public/models 的服务端投影底稿)。 */
export interface ModelProjectionRow {
  modelId: string;
  displayName: string;
  engine: ModelEngine;
  providerId: string | null;
  contextWindow: number | null;
  supportedEfforts: readonly string[];
  supportsVision: boolean;
  capabilityZero: boolean;
  supportsThinking: boolean;
  defaultEffort: string | null;
  sortOrder: number;
}

export interface UserModelScope {
  uid: number | string | bigint;
  role: "user" | "admin";
  grantedModelIds: ReadonlySet<string>;
  deniedModelIds?: ReadonlySet<string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 错误
// ─────────────────────────────────────────────────────────────────────────────

/** epoch fence 失败:DB epoch 与快照 epoch 不等 → 调用方必须同步重建,重建失败 → 拒。 */
export class EpochStaleError extends Error {
  constructor(
    readonly snapshotEpoch: bigint,
    readonly dbEpoch: bigint,
  ) {
    super(`model security epoch is stale: snapshot=${snapshotEpoch} db=${dbEpoch}`);
    this.name = "EpochStaleError";
  }
}

/** 快照处于 unknown(收到 epoch NOTIFY 但尚未重建成功)→ 拒新请求(fail-closed)。 */
export class CatalogUnknownError extends Error {
  constructor(readonly cause?: unknown) {
    super("model catalog snapshot is unknown (rebuild pending or failed)");
    this.name = "CatalogUnknownError";
  }
}

/** capability_schema_version 超出本进程理解范围 → 该模型不可执行(fail-closed)。 */
export class UnknownCapabilitySchemaError extends Error {
  constructor(
    readonly modelId: string,
    readonly version: number,
  ) {
    super(
      `model ${modelId} declares capability_schema_version=${version} > supported ${CAPABILITY_SCHEMA_VERSION}`,
    );
    this.name = "UnknownCapabilitySchemaError";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 规范化 JSON + sha256(revision 的确定性基础)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * JCS 风格的规范化 JSON:对象键按 code unit 升序、数组保序、无空白、undefined 丢弃。
 * revision 的稳定性完全依赖它 —— 同一份逻辑内容在任何进程/任何字段书写顺序下必须产出
 * 同一字节串(master 与 egress 两进程要算出同一个 executionRevision)。
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported value type ${typeof value}`);
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** revision 的日志短形(12 hex)。**wire 上永远传全长** —— 短形只用于日志/指标。 */
export function shortRevision(revision: string): string {
  return revision.slice(0, 12);
}

// ─────────────────────────────────────────────────────────────────────────────
// 行 → 领域对象
// ─────────────────────────────────────────────────────────────────────────────

type CatalogRow = {
  entry_id: string;
  model_id: string;
  engine: string;
  provider_id: string | null;
  upstream_model_id: string | null;
  context_window: number | null;
  capability_profile: unknown;
  capability_schema_version: number;
  state: string;
  lock_version: number;
};

type AliasRow = { alias: string; entry_id: string };

type PricingRow = {
  model_id: string;
  display_name: string;
  input_per_mtok: string;
  output_per_mtok: string;
  cache_read_per_mtok: string;
  cache_write_per_mtok: string;
  multiplier: string;
  visibility: string;
  sort_order: number;
  default_effort: string | null;
};

const EFFORT_SET: ReadonlySet<string> = new Set(PLATFORM_REASONING_EFFORTS);

/**
 * capability_profile 解析。DB 有 CHECK(jsonb object) 但没有 schema 校验 —— 形状校验在这里
 * fail-closed:任何缺字段/类型不符 → 抛错(载入期发现,而不是把畸形 descriptor 签进 envelope)。
 */
export function parseCapabilityProfile(modelId: string, raw: unknown): ModelCapabilityProfile {
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError(`model ${modelId}: capability_profile must be an object`);
  }
  const vision = obj.supports_vision;
  const reasoning = obj.reasoning as Record<string, unknown> | undefined;
  if (typeof vision !== "boolean") {
    throw new TypeError(`model ${modelId}: capability_profile.supports_vision must be boolean`);
  }
  if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
    throw new TypeError(`model ${modelId}: capability_profile.reasoning must be an object`);
  }
  const supportedRaw = reasoning.supported;
  if (!Array.isArray(supportedRaw)) {
    throw new TypeError(`model ${modelId}: capability_profile.reasoning.supported must be an array`);
  }
  const supported: PlatformReasoningEffort[] = [];
  for (const e of supportedRaw) {
    if (typeof e !== "string" || !EFFORT_SET.has(e)) {
      throw new TypeError(`model ${modelId}: unknown reasoning effort ${String(e)}`);
    }
    supported.push(e as PlatformReasoningEffort);
  }
  const def = reasoning.codex_model_default;
  if (def !== null && (typeof def !== "string" || !EFFORT_SET.has(def))) {
    throw new TypeError(`model ${modelId}: invalid codex_model_default ${String(def)}`);
  }
  const ccb = obj.ccb as Record<string, unknown> | undefined;
  if (
    !ccb ||
    typeof ccb !== "object" ||
    Array.isArray(ccb) ||
    typeof ccb.capability_zero !== "boolean" ||
    typeof ccb.supports_thinking !== "boolean"
  ) {
    throw new TypeError(`model ${modelId}: capability_profile.ccb must declare capability_zero/supports_thinking`);
  }
  return {
    supportsVision: vision,
    reasoning: {
      supported,
      codexModelDefault: (def as PlatformReasoningEffort | null) ?? null,
    },
    ccb: {
      capabilityZero: ccb.capability_zero,
      supportsThinking: ccb.supports_thinking,
    },
  };
}

function rowToEntry(r: CatalogRow): ModelCatalogEntry {
  return {
    entryId: Number(r.entry_id),
    modelId: r.model_id,
    engine: r.engine as ModelEngine,
    providerId: r.provider_id,
    upstreamModelId: r.upstream_model_id,
    contextWindow: r.context_window,
    capabilityProfile: parseCapabilityProfile(r.model_id, r.capability_profile),
    capabilitySchemaVersion: r.capability_schema_version,
    state: r.state as ModelCatalogState,
    lockVersion: r.lock_version,
  };
}

function rowToPricing(r: PricingRow): ModelCatalogPricing {
  return {
    modelId: r.model_id,
    displayName: r.display_name,
    inputPerMtok: BigInt(r.input_per_mtok),
    outputPerMtok: BigInt(r.output_per_mtok),
    cacheReadPerMtok: BigInt(r.cache_read_per_mtok),
    cacheWritePerMtok: BigInt(r.cache_write_per_mtok),
    multiplier: r.multiplier,
    visibility: r.visibility as ModelVisibility,
    sortOrder: r.sort_order,
    defaultEffort: r.default_effort,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 快照
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一致性快照(catalog + aliases + pricing + epoch 一次事务读)。**不可变**。
 * 判定 API 全部是纯函数:同一快照对同一入参恒定,master/egress/容器可复现。
 */
export class ModelCatalogSnapshot {
  readonly entries: readonly ModelCatalogEntry[];
  readonly aliases: ReadonlyMap<string, number>;
  readonly pricing: ReadonlyMap<string, ModelCatalogPricing>;
  readonly securityEpoch: bigint;
  readonly executionRevision: string;
  readonly billingRevision: string;
  readonly loadedAt: Date;

  /** model_id → active 行(部分唯一索引保证至多一条)。 */
  private readonly activeByModel: ReadonlyMap<string, ModelCatalogEntry>;
  private readonly byEntryId: ReadonlyMap<number, ModelCatalogEntry>;

  constructor(args: {
    entries: readonly ModelCatalogEntry[];
    aliases: ReadonlyMap<string, number>;
    pricing: ReadonlyMap<string, ModelCatalogPricing>;
    securityEpoch: bigint;
    loadedAt?: Date;
  }) {
    this.entries = args.entries;
    this.aliases = args.aliases;
    this.pricing = args.pricing;
    this.securityEpoch = args.securityEpoch;
    this.loadedAt = args.loadedAt ?? new Date();

    const active = new Map<string, ModelCatalogEntry>();
    const byId = new Map<number, ModelCatalogEntry>();
    for (const e of args.entries) {
      byId.set(e.entryId, e);
      if (e.state === "active") active.set(e.modelId, e);
    }
    this.activeByModel = active;
    this.byEntryId = byId;

    this.executionRevision = sha256Hex(canonicalJson(this.executionProjection()));
    this.billingRevision = sha256Hex(canonicalJson(this.billingProjection()));
  }

  // ── revision 的规范投影 ────────────────────────────────────────────────
  /**
   * R4-m5:仅 active 行的规范执行字段 ∪ 指向**有效版本(= active 行)**的 alias ∪
   * capability schema version。排除 entry_id / lock_version / 审计列 / staged·retired 行。
   * default_effort 属于 execution descriptor(方案 §2 明列 effort),故入 revision;
   * 价格 / visibility / display_name / sort_order **不入**(它们进 billing / projection revision)。
   */
  private executionProjection(): unknown {
    const models = [...this.activeByModel.values()]
      .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0))
      .map((e) => ({
        modelId: e.modelId,
        engine: e.engine,
        providerId: e.providerId,
        upstreamModelId: e.upstreamModelId ?? e.modelId,
        contextWindow: e.contextWindow,
        capabilityProfile: e.capabilityProfile,
        capabilitySchemaVersion: e.capabilitySchemaVersion,
        defaultEffort: this.pricing.get(e.modelId)?.defaultEffort ?? null,
      }));

    const aliases = [...this.aliases.entries()]
      .map(([alias, entryId]) => ({ alias, entry: this.byEntryId.get(entryId) }))
      .filter((a): a is { alias: string; entry: ModelCatalogEntry } =>
        a.entry !== undefined && a.entry.state === "active",
      )
      .map((a) => ({ alias: a.alias, canonicalModel: a.entry.modelId }))
      .sort((a, b) => (a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0));

    return { v: 1, models, aliases };
  }

  private billingProjection(): unknown {
    return {
      v: 1,
      models: [...this.pricing.values()]
        .sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0))
        .map((p) => ({
          modelId: p.modelId,
          inputPerMtok: p.inputPerMtok.toString(),
          outputPerMtok: p.outputPerMtok.toString(),
          cacheReadPerMtok: p.cacheReadPerMtok.toString(),
          cacheWritePerMtok: p.cacheWritePerMtok.toString(),
          multiplier: p.multiplier,
        })),
    };
  }

  // ── 视图 API(纯函数) ────────────────────────────────────────────────
  /** 该 model id 是否由 codex engine 承接(以 catalog active 行为准;未知/不可路由 → false)。 */
  isCodexModel(modelId: string): boolean {
    return this.activeByModel.get(this.aliasToCanonical(modelId))?.engine === "codex";
  }

  isEngineReportedModel(modelId: string): boolean {
    const engine = this.activeByModel.get(this.aliasToCanonical(modelId))?.engine;
    return engine === "codex" || engine === "grok";
  }

  /**
   * 是否可路由(可执行 + 可计费)。三个条件缺一不可:
   *   ① catalog 有 active 行;② capability schema 本进程能理解(未来版本 fail-closed);
   *   ③ **有价格行** —— active 但无价 = 免费旁路,拒(计费与可用性不允许分裂)。
   */
  isRoutable(modelId: string): boolean {
    const canonical = this.aliasToCanonical(modelId);
    const e = this.activeByModel.get(canonical);
    if (!e) return false;
    if (e.capabilitySchemaVersion > CAPABILITY_SCHEMA_VERSION) return false;
    return this.pricing.has(canonical);
  }

  /**
   * 把**本次 fenced catalog 快照**里的价格投影成既有计费器消费的形状。
   *
   * 模型权威开启后,授权、执行描述符与价格必须来自同一个 snapshot generation；调用方
   * 不得在 gate 通过后再回读异步 `PricingCache`，否则改价 NOTIFY 延迟时会出现“新授权、
   * 旧价格”的跨 generation 结算。返回新对象，避免计费侧改写快照里的不可变投影。
   */
  billingPricingFor(modelIdOrAlias: string): ModelPricing | null {
    const canonical = this.aliasToCanonical(modelIdOrAlias);
    if (!this.isRoutable(canonical)) return null;
    const p = this.pricing.get(canonical);
    if (!p) return null;
    return {
      model_id: p.modelId,
      display_name: p.displayName,
      input_per_mtok: p.inputPerMtok,
      output_per_mtok: p.outputPerMtok,
      cache_read_per_mtok: p.cacheReadPerMtok,
      cache_write_per_mtok: p.cacheWritePerMtok,
      multiplier: p.multiplier,
      enabled: true,
      sort_order: p.sortOrder,
      visibility: p.visibility,
      // 这两个字段不参与金额计算；仍给出完整 ModelPricing 形状，避免另造计费 DTO。
      extra_system_prompt: null,
      default_effort: p.defaultEffort,
      updated_at: this.loadedAt,
    };
  }

  /**
   * canonical id → 完整 execution descriptor(签名 envelope 的载荷)。
   * 不可路由 → null;capability schema 未来版本 → 抛 UnknownCapabilitySchemaError(fail-closed,
   * 与"未知模型 → null"区分开:前者是配置事故,必须响亮)。
   */
  resolve(canonicalId: string): ModelExecutionDescriptor | null {
    const canonical = this.aliasToCanonical(canonicalId);
    const e = this.activeByModel.get(canonical);
    if (!e) return null;
    if (e.capabilitySchemaVersion > CAPABILITY_SCHEMA_VERSION) {
      throw new UnknownCapabilitySchemaError(e.modelId, e.capabilitySchemaVersion);
    }
    if (!this.pricing.has(canonical)) return null;
    return {
      canonicalModel: e.modelId,
      engine: e.engine,
      providerId: e.providerId,
      upstreamModelId: e.upstreamModelId ?? e.modelId,
      contextWindow: e.contextWindow,
      capabilityProfile: e.capabilityProfile,
      capabilitySchemaVersion: e.capabilitySchemaVersion,
      defaultEffort: this.pricing.get(canonical)?.defaultEffort ?? null,
    };
  }

  /**
   * alias 归一。alias 表未命中 → 原样返回(**不**在这里做 legacy 的前缀/大小写归一:
   * 那套仍由 pricing.canonicalizeModelId 承接,切片 2 收口时再合并,避免两套归一并行漂移)。
   * 指向非 active 行的 alias 仍会被归一到其 canonical model —— 随后由 isRoutable 拒。
   */
  aliasToCanonical(modelIdOrAlias: string): string {
    const entryId = this.aliases.get(modelIdOrAlias);
    if (entryId === undefined) return modelIdOrAlias;
    return this.byEntryId.get(entryId)?.modelId ?? modelIdOrAlias;
  }

  /**
   * fenced 快照内的最终模型授权判定。visibility 与 role/grants 必须和 securityEpoch
   * 来自同一次安全版本；执行面不能再回读异步 PricingCache，否则 public→hidden 时会
   * 在 pricing reload 失败后无限沿用旧 public 结论。
   */
  canUseModel(scope: UserModelScope, modelIdOrAlias: string): boolean {
    const canonical = this.aliasToCanonical(modelIdOrAlias);
    if (!this.isRoutable(canonical)) return false;
    // Grok is initially a platform-admin tool. A stale or malicious grant must
    // not turn the UI visibility setting into an execution bypass.
    if (this.activeByModel.get(canonical)?.engine === "grok" && scope.role !== "admin") return false;
    if (scope.deniedModelIds?.has(canonical)) return false;
    const p = this.pricing.get(canonical);
    if (!p) return false;
    return (
      p.visibility === "public" ||
      (p.visibility === "admin" &&
        (scope.role === "admin" || scope.grantedModelIds.has(canonical))) ||
      (p.visibility === "hidden" && scope.grantedModelIds.has(canonical))
    );
  }

  /**
   * per-uid 可见模型投影(§6:active && (public ∨ granted))。
   * 语义与 pricing.listForUser / authzModels.canUseModel 同源:visibility 的默认范围 OR 显式 grants。
   * 不可路由(无价 / capability 未来版本)的行**不出现**在投影里(fail-closed,不给用户看到选不了的模型)。
   */
  listForUser(scope: UserModelScope): ModelProjectionRow[] {
    const rows: ModelProjectionRow[] = [];
    for (const e of this.activeByModel.values()) {
      if (!this.isRoutable(e.modelId)) continue;
      const p = this.pricing.get(e.modelId);
      if (!p) continue;
      if (!this.canUseModel(scope, e.modelId)) continue;
      rows.push({
        modelId: e.modelId,
        displayName: p.displayName,
        engine: e.engine,
        providerId: e.providerId,
        // 角色分档投影(modelRolePolicy):同一模型 admin 与普通用户可见/可用不同窗口。
        // 本方法同时是 projectionRevisionFor 的底稿 —— master 下发与 egress 每请求重算
        // 都经这里,策略进哈希,双端天然一致。
        contextWindow: projectContextWindowForRole(e.modelId, e.contextWindow, scope.role),
        supportedEfforts: e.capabilityProfile.reasoning.supported,
        supportsVision: e.capabilityProfile.supportsVision,
        capabilityZero: e.capabilityProfile.ccb.capabilityZero,
        supportsThinking: e.capabilityProfile.ccb.supportsThinking,
        defaultEffort: p.defaultEffort,
        sortOrder: p.sortOrder,
      });
    }
    return rows.sort((a, b) => a.sortOrder - b.sortOrder || (a.modelId < b.modelId ? -1 : 1));
  }

  /**
   * per-uid projectionRevision(R2-M12)= hash(uid ∪ 该 uid 的投影内容)。
   * 全局 executionRevision **不下发**用户;容器/前端只见自己这份。
   * uid 入哈希 → 换 uid 必换 revision(防跨用户复用 token)。epoch **不入**哈希
   * (它是 envelope 的独立字段,§6 明确二者分开传)。
   */
  projectionRevisionFor(scope: UserModelScope): string {
    const rows = this.listForUser(scope).map((r) => ({
      modelId: r.modelId,
      engine: r.engine,
      providerId: r.providerId,
      contextWindow: r.contextWindow,
      supportedEfforts: [...r.supportedEfforts],
      supportsVision: r.supportsVision,
      capabilityZero: r.capabilityZero,
      supportsThinking: r.supportsThinking,
      defaultEffort: r.defaultEffort,
    }));
    return sha256Hex(canonicalJson({ v: 1, uid: String(scope.uid), models: rows }));
  }

  /** 全部 active 行(用于 seed 校验 / admin 视图)。 */
  activeModelIds(): string[] {
    return [...this.activeByModel.keys()].sort();
  }

  /** 只下发指向该 uid 可见投影行的 alias，避免通过别名泄露 hidden 型号。 */
  aliasesForUser(scope: UserModelScope): Record<string, string> {
    const visible = new Set(this.listForUser(scope).map((row) => row.modelId));
    const out: Record<string, string> = {};
    for (const [alias, entryId] of this.aliases) {
      const canonical = this.byEntryId.get(entryId)?.modelId;
      if (canonical && visible.has(canonical)) out[alias] = canonical;
    }
    return out;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 平台次级模型(platform aux models)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * **权威源取证结论(2026-07-12)**:容器里 CCB 的隐藏调用(WebFetch `queryHaiku`、
 * WebSearch `useHaiku` 分支、awaySummary、toolUseSummary、claudeAiLimits)全部经
 * `getSmallFastModel()` 读 `ANTHROPIC_SMALL_FAST_MODEL`;该 env 的**唯一写入方**是容器内
 * gateway 的 `_buildSecondaryUtilityModelEnv()`:
 *
 *     ANTHROPIC_SMALL_FAST_MODEL = process.env.OPENCLAUDE_SECONDARY_MODEL
 *                                  || DEFAULT_SECONDARY_UTILITY_MODEL   // 'deepseek-v4-flash'
 *
 * 全仓 grep:`OPENCLAUDE_SECONDARY_MODEL` **没有任何注入方**(master/supervisor/镜像/env 文件
 * 都不写它)→ v5 容器的实际生效值恒 = gateway 常量 `DEFAULT_SECONDARY_UTILITY_MODEL`。
 * 且只有 `routing==='settings-default'` 分支注入(v5 容器恒走此分支;host-static / oauth-direct
 * 是个人版路径,不经本代理的 authority gate)。
 *
 * 因此 **gateway 常量就是既存的唯一权威**,master 直接 import 它 —— 不在 catalog 里另立标记、
 * 也不在 master config 里另抄一份字面量(那才是造第二权威源:DB/config 说 A、容器发 B,
 * 漂移无人发现)。catalog 的角色是**校验**而非声明:`platformAuxModels()` 断言这些 id 在
 * 快照里可路由(active + 有价 + capability schema 可理解),不满足 → fail-closed 抛。
 */
export const PLATFORM_AUX_MODEL_IDS: readonly string[] = [DEFAULT_SECONDARY_UTILITY_MODEL];

/** 平台次级模型不可路由(被 disable / 无价 / capability schema 未来版本)→ 签发期拒。 */
export class PlatformAuxModelUnavailableError extends Error {
  constructor(
    readonly modelId: string,
    readonly reason: string,
  ) {
    super(`platform aux model '${modelId}' is not routable: ${reason}`);
    this.name = "PlatformAuxModelUnavailableError";
  }
}

/**
 * 该快照下的平台次级模型集合(canonical id,去重排序)。
 *
 * fail-closed:任一声明的 aux 模型不可路由 → 抛 `PlatformAuxModelUnavailableError`
 * (方案 §2 的一贯语义:签发方不许签一份"签了也用不了"的授权 —— 那只会把故障推迟到
 * egress 的 403,现场丢失。签发期抛 = 事故在 master 日志里响亮暴露)。
 *
 * aux 必须是 **ccb engine**:codex 型号根本不经 anthropic proxy,把它放进 aux 集合等于
 * 在放行集合里塞一个永远用不上、却扩大了签名授权面的 id。
 */
export function platformAuxModels(snapshot: ModelCatalogSnapshot): string[] {
  const out = new Set<string>();
  for (const declared of PLATFORM_AUX_MODEL_IDS) {
    const canonical = snapshot.aliasToCanonical(declared);
    // resolve() 对 capability schema 未来版本抛 UnknownCapabilitySchemaError —— 同样 fail-closed,
    // 原样冒泡(配置事故要响亮,不吞成"aux 集合空")。
    const descriptor = snapshot.resolve(canonical);
    if (descriptor === null) {
      throw new PlatformAuxModelUnavailableError(
        declared,
        "no active catalog row / no pricing row",
      );
    }
    if (descriptor.engine !== "ccb") {
      throw new PlatformAuxModelUnavailableError(
        declared,
        `engine '${descriptor.engine}' is not served by the anthropic proxy`,
      );
    }
    out.add(descriptor.canonicalModel);
  }
  return [...out].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// 加载 + epoch fence
// ─────────────────────────────────────────────────────────────────────────────

const SELECT_EPOCH = "SELECT epoch::text AS epoch FROM model_security_epoch WHERE id";

/**
 * 一致性读:catalog + aliases + pricing + epoch 必须来自**同一个快照点**,否则
 * revision/epoch 会对不上一个真实的 DB 状态。用 REPEATABLE READ 事务保证。
 */
export async function loadCatalogSnapshot(pool = getPool()): Promise<ModelCatalogSnapshot> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const epochRes = await client.query<{ epoch: string }>(SELECT_EPOCH);
    if (epochRes.rows.length !== 1) {
      throw new Error("model_security_epoch: expected exactly one row");
    }
    const catalog = await client.query<CatalogRow>(
      `SELECT entry_id::text AS entry_id, model_id, engine, provider_id, upstream_model_id,
              context_window, capability_profile, capability_schema_version, state, lock_version
         FROM model_catalog`,
    );
    const aliases = await client.query<AliasRow>(
      "SELECT alias, entry_id::text AS entry_id FROM model_aliases",
    );
    const pricing = await client.query<PricingRow>(
      `SELECT model_id, display_name,
              input_per_mtok::text       AS input_per_mtok,
              output_per_mtok::text      AS output_per_mtok,
              cache_read_per_mtok::text  AS cache_read_per_mtok,
              cache_write_per_mtok::text AS cache_write_per_mtok,
              multiplier::text           AS multiplier,
              visibility, sort_order, default_effort
         FROM model_pricing`,
    );
    await client.query("COMMIT");

    return new ModelCatalogSnapshot({
      entries: catalog.rows.map(rowToEntry),
      aliases: new Map(aliases.rows.map((r) => [r.alias, Number(r.entry_id)])),
      pricing: new Map(pricing.rows.map((r) => [r.model_id, rowToPricing(r)])),
      securityEpoch: BigInt(epochRes.rows[0].epoch),
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* 原错优先 */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** DB 当前 epoch(单行索引读;**无时间缓存** —— R4-m3)。 */
export async function readSecurityEpoch(runner?: QueryRunner): Promise<bigint> {
  const r = await query<{ epoch: string }>(SELECT_EPOCH, [], runner ?? (getPool() as unknown as QueryRunner));
  if (r.rows.length !== 1) throw new Error("model_security_epoch: expected exactly one row");
  return BigInt(r.rows[0].epoch);
}

/**
 * epoch fence(R3-B1/B2)。签发 authority / codex preCheck·journal / egress 每个
 * `/v1/messages` 授权·路由前各调一次。
 *
 * 不等 → EpochStaleError(调用方负责同步重建快照并重试一次;重建失败或 DB 不可达 → 拒)。
 * **本函数不自愈、不缓存** —— 把"重建成功才放行"的责任显式留在调用方,避免 fence 内部
 * 悄悄放行一个未收敛的快照。
 */
export async function assertEpochFresh(
  snapshot: ModelCatalogSnapshot,
  runner?: QueryRunner,
): Promise<void> {
  const dbEpoch = await readSecurityEpoch(runner);
  if (dbEpoch !== snapshot.securityEpoch) {
    throw new EpochStaleError(snapshot.securityEpoch, dbEpoch);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 进程级缓存 + NOTIFY(复用 pricing.ts 的 LISTEN 基建形状)
// ─────────────────────────────────────────────────────────────────────────────

/** epoch 变更通道(payload = 新 epoch 的十进制文本)。0143 trigger 发。 */
export const EPOCH_CHANNEL = "model_security_epoch";
/** catalog/alias/价格任何变更(payload 空)。 */
export const CATALOG_CHANNEL = "model_catalog_changed";

/**
 * master / egress 进程各持一份。
 *
 * fail-closed 语义(R3-B1):收到 epoch NOTIFY → **立刻标 unknown** → 重建;
 * unknown 期间 current() 抛 CatalogUnknownError → 调用方拒新请求。重建成功才恢复。
 * (纯展示面若要容忍 unknown,自己 catch;执行/计费面一律不许 catch 后放行。)
 */
export class ModelCatalogCache {
  private snapshot: ModelCatalogSnapshot | null = null;
  /** 展示面 fence 微缓存的上次 fence 时刻(仅 assertFreshCached 用;epoch NOTIFY 会清 snapshot,故失效自动生效)。 */
  private displayFenceAt: number | null = null;
  private lastError: unknown = null;
  private listener: Client | null = null;
  private rebuildInFlight: Promise<void> | null = null;
  /** 在已有后台重建期间又收到 NOTIFY 时，完成后必须再跑一轮，不能把通知吞掉。 */
  private rebuildQueued = false;
  /**
   * rebuild() 刻意不做单飞，但完成顺序可能与启动顺序相反：例如 staged 的 NOTIFY
   * 重建先启动，activate 提交后的同步重建后启动却先完成。旧重建绝不能随后把新快照
   * 覆盖回去，所以只允许最后启动的一次提交结果（失败同理，旧失败不能打掉新快照）。
   */
  private rebuildGeneration = 0;

  onError: (err: unknown) => void = (e) => {
    // eslint-disable-next-line no-console
    console.error("[commercial/modelCatalog]", e);
  };
  onRebuild: (snapshot: ModelCatalogSnapshot) => void = () => {};

  /** 已加载的快照;unknown → 抛(执行/计费面必须 fail-closed)。 */
  current(): ModelCatalogSnapshot {
    if (!this.snapshot) throw new CatalogUnknownError(this.lastError);
    return this.snapshot;
  }

  /** 不抛版本(仅供展示/诊断面)。 */
  peek(): ModelCatalogSnapshot | null {
    return this.snapshot;
  }

  /** 同步重建。失败 → 保持/进入 unknown 并抛(admin 写后"激活成功才返回成功"靠它)。 */
  async rebuild(): Promise<ModelCatalogSnapshot> {
    const generation = ++this.rebuildGeneration;
    try {
      const next = await loadCatalogSnapshot();
      if (generation === this.rebuildGeneration) {
        this.snapshot = next;
        this.lastError = null;
        this.onRebuild(next);
      }
      return next;
    } catch (err) {
      if (generation === this.rebuildGeneration) {
        this.snapshot = null; // fail-closed:最新重建失败 = unknown,拒新请求
        this.lastError = err;
      }
      throw err;
    }
  }

  /** 合并并发重建;失败只记不抛(NOTIFY 驱动的后台路径)。 */
  private scheduleRebuild(): void {
    if (this.rebuildInFlight) {
      this.rebuildQueued = true;
      return;
    }
    this.rebuildInFlight = this.rebuild()
      .then(() => undefined)
      .catch((err) => {
        this.onError(err);
      })
      .finally(() => {
        this.rebuildInFlight = null;
        if (this.rebuildQueued) {
          this.rebuildQueued = false;
          this.scheduleRebuild();
        }
      });
  }

  /**
   * unknown 时**等在飞重建**(而不是立刻抛)。
   *
   * 为什么(0144):自「grant 写也 bump epoch」起,每一次 admin 授权/撤权都会让 master 与
   * egress 的快照瞬间进入 unknown → 若执行面直接拒帧,一次后台点击就会给正在聊天的用户
   * 抛一个 MODEL_AUTHORITY_UNAVAILABLE。等待在飞重建的语义与 fail-closed **完全不冲突**:
   * 期间绝不使用旧快照(零 stale),只是把「重建完成」这几十毫秒等掉;重建失败 → 照抛。
   *
   * 没有在飞重建(冷启/上次失败后无人再触发)→ 自己同步发起一次。
   */
  private async ensureSnapshot(): Promise<ModelCatalogSnapshot> {
    if (this.snapshot) return this.snapshot;
    const inflight = this.rebuildInFlight;
    if (inflight) {
      await inflight; // scheduleRebuild 内部已 catch,不会抛
      if (this.snapshot) return this.snapshot;
      throw new CatalogUnknownError(this.lastError);
    }
    return await this.rebuild(); // 失败 → 抛(fail-closed)
  }

  /**
   * fence + 自愈一次:epoch 漂移 → 同步重建后返回新快照;重建失败 → 抛(拒)。
   * 执行/计费入口应当调它而不是裸 current()。
   *
   * 注意 rebuild() **故意不做单飞合并**:admin 安全写在提交后调它,要求「本进程快照
   * 确实前进到了该写之后」——若合并到一个更早启动的在飞重建上,就可能拿到写之前的快照
   * 并向 admin 报成功。ensureSnapshot() 里可以搭在飞的车,是因为那班车必然由 epoch NOTIFY
   * (= 提交之后)触发,且随后的 assertEpochFresh 还会再 fence 一次。
   */
  async assertFresh(): Promise<ModelCatalogSnapshot> {
    const snap = await this.ensureSnapshot();
    try {
      await assertEpochFresh(snap);
      return snap;
    } catch (err) {
      if (!(err instanceof EpochStaleError)) throw err;
      return await this.rebuild();
    }
  }

  /**
   * **展示面专用**的 fence 微缓存变体(方案 §1.2 明许:安全/计费面禁缓存,纯展示面许)。
   *
   * 唯一合法调用者 = 匿名不限流的展示端点(如 /api/public/models)。它们以前零 DB 查询,
   * 逐请求直读 epoch 会把匿名路径变成可被放大的 DB 打点。展示面晚 ≤ttlMs 看到 disable
   * **无金钱/授权后果** —— 真正的执行闸在 bridge 签发与 egress 每请求 fence,前端就算把
   * 已 disable 的模型画出来、点了也跑不了。
   *
   * **禁止**用于:authority 签发 / codex preCheck / journal / egress /v1/messages 授权与
   * 路由 —— 那些面必须 assertFresh()(零 stale 窗口是它们的安全前提,R3-B2)。
   */
  async assertFreshCached(ttlMs: number): Promise<ModelCatalogSnapshot> {
    const now = Date.now();
    if (this.displayFenceAt !== null && now - this.displayFenceAt < ttlMs) {
      const snap = this.snapshot;
      if (snap) return snap;
    }
    const snap = await this.assertFresh();
    this.displayFenceAt = Date.now();
    return snap;
  }

  async startListener(connectionString?: string): Promise<void> {
    if (this.listener) return;
    const cs = connectionString ?? loadConfig().DATABASE_URL;
    const c = new Client({
      connectionString: cs,
      application_name: "openclaude-commercial-model-catalog",
    });
    c.on("notification", (msg) => {
      if (msg.channel === EPOCH_CHANNEL) {
        // 安全变更:新 epoch 才先失效再重建 —— unknown 窗口内一律拒,零 stale window。
        // admin 写提交后会同步 rebuild；该提交的 NOTIFY 可能随后才送达。若 payload epoch
        // 已被当前快照覆盖，不能反过来把已激活的新快照打成 unknown（否则后台旧 rebuild
        // 又因 generation supersede 不提交时会永久空窗）。仍 schedule 一轮吸收同 tx 的
        // catalog 通知；真正更大的/畸形 epoch 一律先失效，fail-closed。
        const payload = msg.payload ?? "";
        const payloadEpoch = /^\d+$/.test(payload) ? BigInt(payload) : null;
        if (
          this.snapshot === null ||
          payloadEpoch === null ||
          this.snapshot.securityEpoch < payloadEpoch
        ) {
          this.snapshot = null;
        }
        this.scheduleRebuild();
      } else if (msg.channel === CATALOG_CHANNEL) {
        this.scheduleRebuild();
      }
    });
    c.on("error", (err) => this.onError(err));
    await c.connect();
    await c.query(`LISTEN ${EPOCH_CHANNEL}`);
    await c.query(`LISTEN ${CATALOG_CHANNEL}`);
    this.listener = c;
  }

  async stopListener(): Promise<void> {
    if (!this.listener) return;
    const c = this.listener;
    this.listener = null;
    try {
      await c.end();
    } catch {
      /* ignore */
    }
  }

  async shutdown(): Promise<void> {
    await this.stopListener();
    this.snapshot = null;
  }

  /** 测试用:直接注入快照(跳过 DB)。 */
  _setForTests(snapshot: ModelCatalogSnapshot | null): void {
    this.snapshot = snapshot;
  }
}
