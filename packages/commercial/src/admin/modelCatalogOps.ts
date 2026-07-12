/**
 * admin 模型 catalog 运维 —— 业务层(模型权威批次 · 方案 §7 步 5)。
 *
 * 步骤 5 = "开放 admin INSERT/状态机操作(staged 流程)"。在此之前 catalog 只能由迁移回填
 * (0135)与 model_pricing.enabled 兼容 trigger 间接改;本模块是**唯一**的显式写入口。
 *
 * ── 三层校验(缺一不可)──────────────────────────────────────────────────────
 *  1. DB(0135 trigger):状态机合法性(staged→active→disabled→{active|retired})、
 *     active 行 execution 字段不可变、retired 单向、alias 引用禁退休、epoch 自动 bump。
 *     —— 权威在 DB,任何绕过本模块的写(psql / 兼容 trigger)也逃不掉。
 *  2. 本模块(激活期语义校验):DB 管不了的**跨表/跨代码事实**——
 *       · provider_id ∈ 服务端 provider 机制集(机制集是代码事实,0135 有意不建 DB 枚举);
 *       · matchesRoute 命中(catalog 不得与 protocol 路由规则互相矛盾:hint 缺失的兼容
 *         回落路径(影子期 / 非 catalog 入口)会按 matchesRoute 走 —— 两者不一致 =
 *         同一个模型在两条路径上打到不同上游,轻则 400,重则烧 OAuth 账号池的真钱);
 *       · capability ⊆ provider 机制上限(声明 vision 而上游纯文本 = 发一个必然 400 的模型);
 *       · 有价格行(active 却无价 = 计费面 fail-closed 拒服务,等于上线一个死模型)。
 *  3. 进程(提交后同步重建快照):快照激活成功才返回 200(方案 §1.2 "admin 安全写同事务
 *     bump epoch,提交后本进程 snapshot 同步激活成功才返回成功")。
 *
 * ── 有意的保守面(登记债)────────────────────────────────────────────────────
 * 「新增一个**新 model_id**」目前仍需要一次代码发版:matchesRoute(protocol
 * staticKeyProviders)与 codex 型号白名单(CODEX_ENGINE_MODEL_IDS)是 gateway inbound 准入
 * 与容器 codex adapter 的判定源,catalog 还没有接管它们(方案 §8 债③:CCB 本地 capability
 * 表退役)。**纯 DB 可改**的是:upstream_model_id / context_window / capability_profile /
 * 状态(上下线)/ 价格 / alias —— 即"换上游、调窗口、收窄能力、上下线"这些高频动作。
 * 若某天要做到"新模型零代码",触发条件是先把 inbound 准入与 codex 白名单也 descriptor 化,
 * 那时本文件的 assertRouteParity 才能放开,而不是现在偷偷放行一个会被 gateway 拒帧、
 * 或在影子路径上打到 OAuth 池的行。
 */

import type { PoolClient } from "pg";
import {
  STATIC_KEY_PROVIDERS,
  findRouteProviderForModel,
  isCodexEngineModel,
} from "@openclaude/protocol";

import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { CODEX_PROVIDER_ID } from "./modelOps.js";
import {
  CAPABILITY_SCHEMA_VERSION,
  parseCapabilityProfile,
  type ModelCapabilityProfile,
  type ModelCatalogState,
  type ModelEngine,
} from "../billing/modelCatalog.js";
import {
  getModelCatalogCache,
  isModelAuthorityEnforced,
  peekModelCatalogCache,
} from "../billing/modelCatalogRuntime.js";
import {
  checkCapabilityWithinCeiling,
  checkSnapshotCapabilities,
  providerCapabilityCeiling,
  selectUpstreamRoute,
} from "../http/proxy/upstream.js";

// ─── provider 机制集(代码事实,0135 有意不 DB 化)────────────────────────────

/** OAuth(Anthropic 官方账号池)虚拟 provider —— 与 0135 fn_model_catalog_provider 的 'anthropic' 同源。 */
export const OAUTH_PROVIDER_ID = "anthropic";

/** engine='ccb' 合法 provider_id 集:静态 key provider(protocol 注册表)+ OAuth 虚拟条目。 */
export function ccbProviderIds(): string[] {
  return [...STATIC_KEY_PROVIDERS.map((p) => p.id), OAUTH_PROVIDER_ID];
}

/** engine='codex' 合法 provider_id 集:codex 虚拟条目(ChatGPT OAuth 池 + 容器 loopback relay)。 */
export function codexProviderIds(): string[] {
  return [CODEX_PROVIDER_ID];
}

// ─── 视图类型 ────────────────────────────────────────────────────────────────

export interface CatalogEntryView {
  entry_id: string;
  model_id: string;
  engine: ModelEngine;
  provider_id: string | null;
  upstream_model_id: string | null;
  context_window: number | null;
  capability_profile: unknown;
  capability_schema_version: number;
  state: ModelCatalogState;
  lock_version: number;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
  /** 指向本行的 alias(状态机:alias 只可指向 staged/active)。 */
  aliases: string[];
  /** model_pricing 是否有对应行(active 前置:无价 = 计费面拒服务)。 */
  has_pricing: boolean;
}

export interface CatalogOverview {
  entries: CatalogEntryView[];
  security_epoch: string;
  /** 当前有效执行投影 hash(12hex 短标;来自本进程快照)。快照未就绪 → null。 */
  execution_revision: string | null;
  /** 本进程判定模式:true=catalog 强制(flag 开),false=影子期。 */
  enforced: boolean;
}

// ─── 入参与校验 ──────────────────────────────────────────────────────────────

/** 建 staged 行 / 切版本的 execution 字段入参(两者形状相同 —— 都是"一个新版本长什么样")。 */
export interface CatalogVersionInput {
  model_id: string;
  engine: ModelEngine;
  provider_id: string | null;
  upstream_model_id: string | null;
  context_window: number | null;
  /** DB 形状(snake_case JSONB),与 0135 fn_model_catalog_capability 同源。 */
  capability_profile: unknown;
  capability_schema_version?: number;
}

export interface AdminOpsCtx {
  adminId: number | string | bigint;
  ip?: string | null;
  userAgent?: string | null;
}

export class CatalogConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogConflictError";
  }
}
export class CatalogNotFoundError extends Error {
  constructor(entryId: string) {
    super(`model_catalog entry not found: ${entryId}`);
    this.name = "CatalogNotFoundError";
  }
}
/** 语义校验失败(HTTP 层 → 422:形状合法但语义上不能激活)。 */
export class CatalogValidationError extends Error {
  readonly violations: readonly string[];
  constructor(violations: readonly string[]) {
    super(`model_catalog validation failed: ${violations.join("; ")}`);
    this.name = "CatalogValidationError";
    this.violations = violations;
  }
}

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/**
 * 形状归一(纯函数)。非法 → RangeError(HTTP 层 translateRangeError → 400)。
 * 只管"字段类型/范围/枚举",跨表跨代码的语义在 validateVersionSemantics。
 */
export function normalizeVersionInput(raw: unknown): CatalogVersionInput & {
  capability: ModelCapabilityProfile;
  capability_schema_version: number;
} {
  const b = (raw ?? {}) as Record<string, unknown>;
  const modelId = b.model_id;
  if (typeof modelId !== "string" || !MODEL_ID_RE.test(modelId)) {
    throw new RangeError("invalid_model_id");
  }
  const engine = b.engine;
  if (engine !== "ccb" && engine !== "codex") throw new RangeError("invalid_engine");
  const providerRaw = b.provider_id;
  const providerId =
    providerRaw === undefined || providerRaw === null ? null : String(providerRaw);
  if (providerId !== null && !/^[a-z0-9_-]{1,32}$/.test(providerId)) {
    throw new RangeError("invalid_provider_id");
  }
  if (engine === "ccb" && providerId === null) throw new RangeError("invalid_provider_id");
  const upstreamRaw = b.upstream_model_id;
  const upstream =
    upstreamRaw === undefined || upstreamRaw === null ? null : String(upstreamRaw);
  if (upstream !== null && (upstream.length === 0 || upstream.length > 128)) {
    throw new RangeError("invalid_upstream_model_id");
  }
  const cwRaw = b.context_window;
  let contextWindow: number | null = null;
  if (cwRaw !== undefined && cwRaw !== null) {
    if (typeof cwRaw !== "number" || !Number.isInteger(cwRaw) || cwRaw <= 0) {
      throw new RangeError("invalid_context_window");
    }
    contextWindow = cwRaw;
  }
  const schemaVersion = b.capability_schema_version ?? CAPABILITY_SCHEMA_VERSION;
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    // 未来版本消费侧 fail-closed(R2-m15)—— 本进程理解不了的 schema 不许写进来
    schemaVersion > CAPABILITY_SCHEMA_VERSION
  ) {
    throw new RangeError("invalid_capability_schema_version");
  }
  // 形状校验复用 catalog 消费侧的同一 parser(单一权威:写进去的和读出来的必须同形)。
  let capability: ModelCapabilityProfile;
  try {
    capability = parseCapabilityProfile(modelId, b.capability_profile);
  } catch {
    throw new RangeError("invalid_capability_profile");
  }
  return {
    model_id: modelId,
    engine,
    provider_id: providerId,
    upstream_model_id: upstream,
    context_window: contextWindow,
    capability_profile: b.capability_profile,
    capability_schema_version: schemaVersion,
    capability,
  };
}

/**
 * 激活期语义校验(纯函数;**staged 落库时也跑一遍**——早报错好过等到 activate 才发现)。
 *
 * 返回违规说明数组(空 = 通过)。四条:机制集 / matchesRoute 命中 / capability ⊆ 上限 / 有价格行。
 * `hasPricing=undefined` → 跳过价格行校验(建 staged 时价格可以后补,activate 时必须有)。
 */
export function validateVersionSemantics(
  v: CatalogVersionInput & { capability: ModelCapabilityProfile },
  hasPricing?: boolean,
): string[] {
  const out: string[] = [];
  const { model_id: modelId, engine, provider_id: providerId, capability } = v;

  // ① engine ↔ 型号白名单(codex adapter 的判定源仍在 protocol,见文件头"保守面")
  if (engine === "codex" && !isCodexEngineModel(modelId)) {
    out.push(
      `engine='codex' but ${modelId} ∉ protocol CODEX_ENGINE_MODEL_IDS —— 容器 codex adapter 起不来`,
    );
  }
  if (engine === "ccb" && isCodexEngineModel(modelId)) {
    out.push(`${modelId} 是 protocol 声明的 codex 型号,engine 不能是 'ccb'`);
  }

  // ② provider_id ∈ 机制集
  const allowed = engine === "codex" ? codexProviderIds() : ccbProviderIds();
  if (providerId === null || !allowed.includes(providerId)) {
    out.push(
      `provider_id='${providerId ?? "null"}' ∉ engine='${engine}' 的服务端机制集 [${allowed.join(",")}]`,
    );
  }

  // ③ matchesRoute 命中(catalog 与 protocol 路由规则不得互相矛盾)
  if (engine === "ccb" && providerId !== null) {
    const routed = findRouteProviderForModel(modelId)?.id ?? OAUTH_PROVIDER_ID;
    if (routed !== providerId) {
      out.push(
        `matchesRoute(${modelId}) → '${routed}',与 provider_id='${providerId}' 不符 —— ` +
          "hint 缺失的兼容回落路径会打到另一个上游(双路由源分叉)",
      );
    }
  }

  // ④ capability ⊆ provider 机制上限(codex engine 不走 anthropic proxy 机制,跳过)
  if (engine === "ccb" && providerId !== null && allowed.includes(providerId)) {
    try {
      const route = selectUpstreamRoute(modelId, {
        providerId,
        upstreamModelId: v.upstream_model_id ?? modelId,
      });
      const violation = checkCapabilityWithinCeiling(
        {
          supportsVision: capability.supportsVision,
          supportedEfforts: capability.reasoning.supported,
        },
        providerCapabilityCeiling(route),
      );
      if (violation) out.push(violation);
    } catch (err) {
      out.push(`upstream 路由不可解析: ${(err as Error).message}`);
    }
    if (capability.reasoning.codexModelDefault !== null) {
      out.push("engine='ccb' 不得声明 codex_model_default(该字段只对 codex 型号有意义)");
    }
  }
  if (engine === "codex") {
    const def = capability.reasoning.codexModelDefault;
    if (def !== null && !capability.reasoning.supported.includes(def)) {
      out.push(`codex_model_default='${def}' ∉ reasoning.supported`);
    }
  }

  // ⑤ 有价格行(activate 前置)
  if (hasPricing === false) {
    out.push(`model_pricing 无 '${modelId}' 行 —— active 却无价 = 计费面 fail-closed 拒服务`);
  }
  return out;
}

// ─── 读 ──────────────────────────────────────────────────────────────────────

interface RawRow {
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
  created_at: Date;
  updated_at: Date;
  updated_by: string | null;
  aliases: string[] | null;
  has_pricing: boolean;
}

export async function listCatalog(): Promise<CatalogOverview> {
  const rows = await query<RawRow>(
    `SELECT c.entry_id::text AS entry_id, c.model_id, c.engine, c.provider_id,
            c.upstream_model_id, c.context_window, c.capability_profile,
            c.capability_schema_version, c.state, c.lock_version,
            c.created_at, c.updated_at, c.updated_by::text AS updated_by,
            COALESCE(
              (SELECT array_agg(a.alias ORDER BY a.alias) FROM model_aliases a WHERE a.entry_id = c.entry_id),
              ARRAY[]::text[]
            ) AS aliases,
            EXISTS (SELECT 1 FROM model_pricing p WHERE p.model_id = c.model_id) AS has_pricing
       FROM model_catalog c
      ORDER BY c.model_id ASC, c.entry_id DESC`,
  );
  const epoch = await query<{ epoch: string }>(
    "SELECT epoch::text AS epoch FROM model_security_epoch WHERE id",
  );
  // 快照是**进程内**观测(不代表 DB 权威),只作诊断展示:未就绪 → null,不因此拒服务
  // (peek 不抛;列表页在 catalog unknown 时也应当能打开,否则运维连"为什么 unknown"都看不到)。
  const snap = peekModelCatalogCache()?.peek() ?? null;
  return {
    entries: rows.rows.map((r) => ({
      entry_id: r.entry_id,
      model_id: r.model_id,
      engine: r.engine as ModelEngine,
      provider_id: r.provider_id,
      upstream_model_id: r.upstream_model_id,
      context_window: r.context_window,
      capability_profile: r.capability_profile,
      capability_schema_version: r.capability_schema_version,
      state: r.state as ModelCatalogState,
      lock_version: r.lock_version,
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
      updated_by: r.updated_by,
      aliases: r.aliases ?? [],
      has_pricing: r.has_pricing,
    })),
    security_epoch: epoch.rows[0]?.epoch ?? "0",
    execution_revision: snap ? snap.executionRevision.slice(0, 12) : null,
    enforced: isModelAuthorityEnforced(),
  };
}

// ─── 写(全部经状态机 + 同事务审计 + 提交后同步激活快照)──────────────────────

/**
 * 提交后同步激活本进程快照(方案 §1.2)。重建失败 → 抛:
 * 写已提交(DB 是权威,epoch 已 bump,其它进程会经 NOTIFY 收敛),但**本进程**处于 unknown
 * (fail-closed 拒新请求),不能对 admin 谎报"已生效"。
 */
async function activateSnapshotOrThrow(): Promise<void> {
  const cache = await getModelCatalogCache();
  const snap = await cache.rebuild();
  const violations = checkSnapshotCapabilities(snap);
  if (violations.length > 0) {
    // 单行校验已挡住绝大多数;能到这里说明**存量行**有问题(如 provider spec 改窄了上限)。
    // 不回滚(写已提交、且可能正是修复动作),但必须响亮。
    // eslint-disable-next-line no-console
    console.error("[admin/modelCatalog] snapshot capability violations:", violations);
  }
}

async function loadHasPricing(client: PoolClient, modelId: string): Promise<boolean> {
  const r = await client.query<{ ok: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM model_pricing WHERE model_id = $1) AS ok",
    [modelId],
  );
  return r.rows[0]?.ok === true;
}

async function loadEntryForUpdate(client: PoolClient, entryId: string): Promise<RawRow> {
  const r = await client.query<RawRow>(
    `SELECT entry_id::text AS entry_id, model_id, engine, provider_id, upstream_model_id,
            context_window, capability_profile, capability_schema_version, state, lock_version,
            created_at, updated_at, updated_by::text AS updated_by,
            NULL::text[] AS aliases, FALSE AS has_pricing
       FROM model_catalog WHERE entry_id = $1::bigint FOR UPDATE`,
    [entryId],
  );
  const row = r.rows[0];
  if (!row) throw new CatalogNotFoundError(entryId);
  return row;
}

/** 建 staged 行(engine 变更请用 switchVersion —— 同 model_id 的 live 行唯一)。 */
export async function createStaged(
  input: unknown,
  ctx: AdminOpsCtx,
): Promise<{ entry_id: string }> {
  const v = normalizeVersionInput(input);
  // staged 期不强制价格行(可后补),其余三条现在就拦 —— 让配错在落库时就响亮。
  const violations = validateVersionSemantics(v);
  if (violations.length > 0) throw new CatalogValidationError(violations);

  const entryId = await tx(async (client: PoolClient) => {
    const r = await client.query<{ entry_id: string }>(
      `INSERT INTO model_catalog
         (model_id, engine, provider_id, upstream_model_id, context_window,
          capability_profile, capability_schema_version, state, updated_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'staged', $8::bigint)
       RETURNING entry_id::text AS entry_id`,
      [
        v.model_id,
        v.engine,
        v.provider_id,
        v.upstream_model_id,
        v.context_window,
        JSON.stringify(v.capability_profile),
        v.capability_schema_version,
        String(ctx.adminId),
      ],
    );
    const id = r.rows[0]!.entry_id;
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "model_catalog.stage",
      target: `model_catalog:${id}`,
      before: null,
      after: {
        model_id: v.model_id,
        engine: v.engine,
        provider_id: v.provider_id,
        upstream_model_id: v.upstream_model_id,
        context_window: v.context_window,
        capability_profile: v.capability_profile,
        capability_schema_version: v.capability_schema_version,
        state: "staged",
      },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return id;
  });
  // staged 行不进执行投影(executionRevision 只含 active 行),但 catalog 变更仍要让本进程
  // 快照与 DB 对齐(后续 activate 会读它)。
  await activateSnapshotOrThrow();
  return { entry_id: entryId };
}

/** staged|disabled → active。四条语义校验 + lock_version 乐观并发。 */
export async function activateEntry(
  entryId: string,
  expectedLockVersion: number,
  ctx: AdminOpsCtx,
): Promise<void> {
  await tx(async (client: PoolClient) => {
    const row = await loadEntryForUpdate(client, entryId);
    if (row.state !== "staged" && row.state !== "disabled") {
      throw new CatalogConflictError(
        `entry ${entryId} state='${row.state}' —— 只有 staged / disabled 可以 activate`,
      );
    }
    if (row.lock_version !== expectedLockVersion) {
      throw new CatalogConflictError(
        `lock_version 不符(期望 ${expectedLockVersion},当前 ${row.lock_version})—— 有人先改了`,
      );
    }
    const v = normalizeVersionInput({
      model_id: row.model_id,
      engine: row.engine,
      provider_id: row.provider_id,
      upstream_model_id: row.upstream_model_id,
      context_window: row.context_window,
      capability_profile: row.capability_profile,
      capability_schema_version: row.capability_schema_version,
    });
    const hasPricing = await loadHasPricing(client, row.model_id);
    const violations = validateVersionSemantics(v, hasPricing);
    if (violations.length > 0) throw new CatalogValidationError(violations);

    const upd = await client.query(
      `UPDATE model_catalog SET state = 'active', updated_by = $2::bigint
        WHERE entry_id = $1::bigint AND lock_version = $3`,
      [entryId, String(ctx.adminId), expectedLockVersion],
    );
    if (upd.rowCount !== 1) {
      throw new CatalogConflictError(`entry ${entryId} 并发修改,activate 未生效`);
    }
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "model_catalog.activate",
      target: `model_catalog:${entryId}`,
      before: { state: row.state, lock_version: row.lock_version },
      after: { state: "active", model_id: row.model_id },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  });
  await activateSnapshotOrThrow();
}

/** active → disabled(下线:epoch bump → 全链失效,在飞请求下一次 fence 即被拒)。 */
export async function disableEntry(
  entryId: string,
  expectedLockVersion: number,
  ctx: AdminOpsCtx,
): Promise<void> {
  await tx(async (client: PoolClient) => {
    const row = await loadEntryForUpdate(client, entryId);
    if (row.state !== "active") {
      throw new CatalogConflictError(
        `entry ${entryId} state='${row.state}' —— 只有 active 可以 disable`,
      );
    }
    if (row.lock_version !== expectedLockVersion) {
      throw new CatalogConflictError(
        `lock_version 不符(期望 ${expectedLockVersion},当前 ${row.lock_version})`,
      );
    }
    const upd = await client.query(
      `UPDATE model_catalog SET state = 'disabled', updated_by = $2::bigint
        WHERE entry_id = $1::bigint AND lock_version = $3`,
      [entryId, String(ctx.adminId), expectedLockVersion],
    );
    if (upd.rowCount !== 1) {
      throw new CatalogConflictError(`entry ${entryId} 并发修改,disable 未生效`);
    }
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "model_catalog.disable",
      target: `model_catalog:${entryId}`,
      before: { state: "active", lock_version: row.lock_version },
      after: { state: "disabled", model_id: row.model_id },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  });
  await activateSnapshotOrThrow();
}

/**
 * 版本切换(engine / execution 字段变更)—— 单事务存储过程 fn_model_switch_version:
 * 旧 active→disabled → 建新 staged → alias 重指 → 旧→retired → 新→active(仅当旧是 active)。
 *
 * **校验必须在调用存储过程之前**:旧行是 active 时,新行会在同一事务里直接 active —— 没有
 * 中间人再拦一道。故这里跑的是**完整激活校验**(含价格行),而不是 staged 的宽松版。
 */
export async function switchVersion(
  input: unknown,
  expectedLockVersion: number,
  ctx: AdminOpsCtx,
): Promise<{ entry_id: string }> {
  const v = normalizeVersionInput(input);
  const entryId = await tx(async (client: PoolClient) => {
    // 锁住当前 live 行(staged/active/disabled),乐观并发按它的 lock_version 判。
    const cur = await client.query<{ entry_id: string; state: string; lock_version: number }>(
      `SELECT entry_id::text AS entry_id, state, lock_version
         FROM model_catalog
        WHERE model_id = $1 AND state IN ('staged','active','disabled')
        ORDER BY (state = 'active') DESC, (state = 'staged') DESC, entry_id DESC
        LIMIT 1 FOR UPDATE`,
      [v.model_id],
    );
    const live = cur.rows[0];
    if (!live) {
      throw new CatalogConflictError(
        `model '${v.model_id}' 没有 live 行(staged/active/disabled)—— 新模型请用 POST /model-catalog 建 staged`,
      );
    }
    if (live.lock_version !== expectedLockVersion) {
      throw new CatalogConflictError(
        `lock_version 不符(期望 ${expectedLockVersion},当前 ${live.lock_version})`,
      );
    }
    const hasPricing = await loadHasPricing(client, v.model_id);
    // 完整激活校验:存储过程可能把新行直接推到 active。
    const violations = validateVersionSemantics(v, hasPricing);
    if (violations.length > 0) throw new CatalogValidationError(violations);

    const r = await client.query<{ entry_id: string }>(
      `SELECT fn_model_switch_version($1, $2, $3, $4, $5, $6::jsonb, $7, $8::bigint)::text AS entry_id`,
      [
        v.model_id,
        v.engine,
        v.provider_id,
        v.upstream_model_id,
        v.context_window,
        JSON.stringify(v.capability_profile),
        v.capability_schema_version,
        String(ctx.adminId),
      ],
    );
    const newId = r.rows[0]!.entry_id;
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "model_catalog.switch",
      target: `model_catalog:${newId}`,
      before: { entry_id: live.entry_id, state: live.state, lock_version: live.lock_version },
      after: {
        entry_id: newId,
        model_id: v.model_id,
        engine: v.engine,
        provider_id: v.provider_id,
        upstream_model_id: v.upstream_model_id,
        context_window: v.context_window,
        capability_profile: v.capability_profile,
        capability_schema_version: v.capability_schema_version,
      },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
    return newId;
  });
  await activateSnapshotOrThrow();
  return { entry_id: entryId };
}
