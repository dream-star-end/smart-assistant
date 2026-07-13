// sessionsStoreAuthority — master 会话权威 store 的**启动裁决**(RFC-v5-sessions-pg D1)。
//
// 权威状态机 + 启动规则矩阵是 sqlite/pg 选择的**唯一裁决源**(R2/R3 BLOCKER 消歧):驱动选择
// 权威在 composition root 一处(registerCommercial),禁止函数内 if(pg) 分支。裁决输入四元组:
//   ①env OC_SESSIONS_STORE ②PG 状态行 sessions_store_migration_state ③本地权威 manifest
//     ($OPENCLAUDE_HOME/sessions-store-authority.json)④本地灾难 nonce
//     ($OPENCLAUDE_HOME/sessions-disaster-nonce.json,backfill disaster-restore 写)。
// 输出:选 sqlite / 选 pg(带 generation)/ 抛错拒起(消息说清是矩阵哪一行拒的)。矩阵之外
// 组合**默认 fail-closed 拒起**。正常代码回滚**不能**通过删 env 退回 SQLite 重造双权威。
//
// 两个纯决策函数无 IO(env/PG/manifest/nonce 已读好),便于矩阵全组合穷举测试:
//   · decideSessionsStore            —— PG **可达**(读到状态行/42P01→null)时的启动矩阵;
//   · decideSessionsStorePgUnreachable —— PG **不可达**(连接错误)时的兜底裁决。
// resolveSessionsStoreAuthority 是读 env+PG+manifest+nonce 的 async 装配壳。

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Pool } from "pg";
import { paths } from "@openclaude/storage";
import { getPool } from "./index.js";

/** 权威 store 决策结果。 */
export type SessionsStoreDecision = { store: "sqlite" } | { store: "pg"; generation: number };

/** env OC_SESSIONS_STORE 归一化意图。 */
export type SessionsStoreEnvIntent = "unset" | "sqlite" | "pg" | "invalid";

/** PG sessions_store_migration_state 单例行(已归一化)。 */
export interface SessionsStoreStateRow {
  authority: "prepared" | "pg_authoritative" | "sqlite_disaster_recovered";
  generation: number;
  cutoverId: string;
}

/** 本地权威 manifest(PG 状态行的本地镜像;双写要求一致,见 RFC D1)。 */
export interface SessionsStoreManifest {
  authority: string;
  generation: number;
  cutoverId: string;
}

/**
 * 本地灾难 nonce($OPENCLAUDE_HOME/sessions-disaster-nonce.json)。
 * backfill disaster-restore-to-sqlite 写 {cutoverId, ts, reason};启动裁决只信 cutoverId
 * (须与 manifest/PG 状态行 cutoverId 一致才认灾难过渡态,RFC D1「sqlite + 本地灾难 nonce 匹配」)。
 */
export interface SessionsStoreDisasterNonce {
  cutoverId: string;
  ts?: number;
  reason?: string;
}

export class SessionsStoreAuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionsStoreAuthorityError";
  }
}

/** 归一化 OC_SESSIONS_STORE:未设/空 → unset;sqlite / pg 各自;其它一律 invalid(拒起)。 */
export function parseSessionsStoreEnv(raw: string | undefined | null): SessionsStoreEnvIntent {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return "unset";
  if (v === "sqlite") return "sqlite";
  if (v === "pg") return "pg";
  return "invalid";
}

/** manifest 与 PG 状态行是否一致(authority + generation)。 */
function manifestMatchesPg(manifest: SessionsStoreManifest | null, pg: SessionsStoreStateRow): boolean {
  return (
    !!manifest &&
    manifest.authority === pg.authority &&
    manifest.generation === pg.generation &&
    manifest.cutoverId === pg.cutoverId
  );
}

/**
 * **启动规则矩阵**(RFC D1 表格逐行,PG **可达**分支)。纯函数:输入已读好的四元组,输出决策或抛
 * {@link SessionsStoreAuthorityError}(消息注明拒的矩阵行)。矩阵之外默认拒起。
 */
export function decideSessionsStore(
  env: SessionsStoreEnvIntent,
  pg: SessionsStoreStateRow | null,
  manifest: SessionsStoreManifest | null,
  nonce: SessionsStoreDisasterNonce | null,
): SessionsStoreDecision {
  // 非法 env 值一律拒起(先于一切)。
  if (env === "invalid") {
    throw new SessionsStoreAuthorityError(
      "[sessions-store] 非法 OC_SESSIONS_STORE 值(仅接受 unset / 'sqlite' / 'pg'),fail-closed 拒起。",
    );
  }

  // ── 无状态行:仅当 manifest 也为 null 才是真·首次基建先行期 ──
  // manifest≠null 证明"曾经割接到 PG"(PG↔manifest 双写)。此刻 PG 无状态行 = 连错库 / PG 状态行被删。
  // 绝不能静默退回 SQLite(会重造双权威),fail-closed 拒起须人工裁决;真·首次基建期 manifest 亦应为 null。
  if (!pg) {
    if (manifest) {
      throw new SessionsStoreAuthorityError(
        `[sessions-store] 矩阵[无状态行 × 有 manifest]:PG 无 sessions_store_migration_state 状态行,` +
          `但本地 manifest 表明曾割接到 PG(authority=${manifest.authority}, generation=${manifest.generation}, ` +
          `cutover=${manifest.cutoverId})=连错库 / PG 状态行被删。绝不静默退回 SQLite 重造双权威,` +
          `fail-closed 拒起,须人工裁决(核对 DATABASE_URL 指向、状态行是否被误删)。`,
      );
    }
    if (env === "pg") {
      throw new SessionsStoreAuthorityError(
        "[sessions-store] 矩阵[无状态行 × 无 manifest × env=pg]:尚未割接(sessions_store_migration_state 无行),fail-closed 拒起。",
      );
    }
    // 仅 pg===null && manifest===null && env∈{unset,sqlite} → SQLite 启动(真·首次基建先行期)。
    return { store: "sqlite" };
  }

  switch (pg.authority) {
    // ── prepared:迁移进行中,任意 env/manifest 组合都拒起 ──
    case "prepared":
      throw new SessionsStoreAuthorityError(
        `[sessions-store] 矩阵[authority=prepared × 任意]:迁移进行中(generation=${pg.generation}, cutover=${pg.cutoverId}),master 不许起,fail-closed 拒起。`,
      );

    // ── pg_authoritative:唯一合法 env=pg,且 manifest 须与 PG 一致 ──
    case "pg_authoritative": {
      if (env !== "pg") {
        throw new SessionsStoreAuthorityError(
          "[sessions-store] 矩阵[authority=pg_authoritative × env≠pg]:env 同步遗漏不得静默退回 SQLite 重造双权威,fail-closed 拒起(请设 OC_SESSIONS_STORE=pg)。",
        );
      }
      if (!manifest) {
        throw new SessionsStoreAuthorityError(
          "[sessions-store] 矩阵[authority=pg_authoritative × env=pg]:本地权威 manifest 缺失(PG↔manifest 双写要求一致),fail-closed 拒起(运行 repair-manifest 收敛到已验证的 PG generation)。",
        );
      }
      if (!manifestMatchesPg(manifest, pg)) {
        throw new SessionsStoreAuthorityError(
          `[sessions-store] 矩阵[authority=pg_authoritative × env=pg]:manifest 与 PG 状态不一致` +
            `(manifest={authority:${manifest.authority},generation:${manifest.generation},cutover:${manifest.cutoverId}} ` +
            `PG={authority:${pg.authority},generation:${pg.generation},cutover:${pg.cutoverId}}),fail-closed 拒起` +
            `(repair-manifest 只能把 manifest 收敛到 PG,永不提升 authority)。`,
        );
      }
      return { store: "pg", generation: pg.generation };
    }

    // ── sqlite_disaster_recovered:灾难过渡态,仅 env=sqlite + 本地 manifest 匹配 + 本地 nonce cutover 匹配 ──
    case "sqlite_disaster_recovered": {
      if (env !== "sqlite") {
        throw new SessionsStoreAuthorityError(
          "[sessions-store] 矩阵[authority=sqlite_disaster_recovered × env≠sqlite]:灾难过渡态只接受 sqlite,fail-closed 拒起。",
        );
      }
      // 灾难态按本地 manifest + nonce(cutoverId)裁决:manifest 须存在且与 PG 状态行完全匹配。
      if (!manifestMatchesPg(manifest, pg)) {
        throw new SessionsStoreAuthorityError(
          "[sessions-store] 矩阵[authority=sqlite_disaster_recovered × env=sqlite]:manifest 与 PG 状态不匹配,fail-closed 拒起。",
        );
      }
      // RFC D1 原文「sqlite + 本地灾难 nonce 匹配」:nonce 文件须存在且 cutoverId 与 PG(=manifest)一致。
      // 仅 manifest 匹配不足以放行 —— 灾难 nonce 是 backfill disaster-restore 铸造的过渡态凭证,缺失/不匹配即拒起。
      if (!nonce || nonce.cutoverId !== pg.cutoverId) {
        throw new SessionsStoreAuthorityError(
          `[sessions-store] 矩阵[authority=sqlite_disaster_recovered × env=sqlite]:本地灾难 nonce ` +
            `${nonce ? `cutover=${nonce.cutoverId} 与 PG cutover=${pg.cutoverId} 不匹配` : "缺失"},fail-closed 拒起。`,
        );
      }
      return { store: "sqlite" };
    }

    // ── 所有未列出组合 → 默认 fail-closed ──
    default:
      throw new SessionsStoreAuthorityError(
        `[sessions-store] 矩阵之外组合(未知 authority=${String((pg as SessionsStoreStateRow).authority)}),默认 fail-closed 拒起。`,
      );
  }
}

/**
 * **PG 不可达兜底裁决**(RFC D1:PG 读不到 marker→本地 manifest+nonce 裁决)。纯函数。
 * PG 连接错误(非 42P01)时不得静默走 SQLite;放行 SQLite 只有两种,其余一切 fail-closed:
 *   ① 真·基建先行期:无 manifest + env=unset(PG 尚未 provision,连不上本就正常);
 *   ② 灾难过渡态:env=sqlite + manifest.authority=sqlite_disaster_recovered + 本地 nonce 存在且
 *      cutoverId 与 manifest 一致(RFC「sqlite + 本地灾难 nonce 匹配」)。
 * 含 manifest 其他 authority / env 其他值 / nonce 缺失损坏不匹配,一律拒起。
 */
export function decideSessionsStorePgUnreachable(
  env: SessionsStoreEnvIntent,
  manifest: SessionsStoreManifest | null,
  nonce: SessionsStoreDisasterNonce | null,
): SessionsStoreDecision {
  // 非法 env 值一律拒起(先于一切)。
  if (env === "invalid") {
    throw new SessionsStoreAuthorityError(
      "[sessions-store] PG 不可达兜底:非法 OC_SESSIONS_STORE 值(仅接受 unset / 'sqlite' / 'pg'),fail-closed 拒起。",
    );
  }
  // ① 真·基建先行期:无 manifest + env=unset → SQLite。
  if (manifest === null && env === "unset") {
    return { store: "sqlite" };
  }
  // ② 灾难过渡态:env=sqlite + manifest=灾难态 + 本地 nonce cutover 与 manifest 一致 → SQLite。
  if (
    env === "sqlite" &&
    manifest !== null &&
    manifest.authority === "sqlite_disaster_recovered" &&
    nonce !== null &&
    nonce.cutoverId === manifest.cutoverId
  ) {
    return { store: "sqlite" };
  }
  // 其余一切 fail-closed(须人工介入核对 DATABASE_URL / PG 可达性 / 灾难 nonce)。
  throw new SessionsStoreAuthorityError(
    `[sessions-store] PG 不可达兜底:仅[无 manifest × env=unset(基建先行期)]或` +
      `[env=sqlite × manifest.authority=sqlite_disaster_recovered × 本地 nonce cutover 与 manifest 一致(灾难过渡态)]放行 SQLite;` +
      `当前(env=${env}, manifest=${manifest ? `authority=${manifest.authority},cutover=${manifest.cutoverId}` : "无"}, ` +
      `nonce=${nonce ? `cutover=${nonce.cutoverId}` : "无"})不满足,fail-closed 拒起。`,
  );
}

/** 本地权威 manifest 路径；双 slot 可用 env 覆盖为同一份 A-slot 权威文件。 */
export function defaultManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OC_SESSIONS_MANIFEST_PATH?.trim();
  if (override) return override;
  return join(paths.home, "sessions-store-authority.json");
}

/** 本地灾难 nonce 默认路径($OPENCLAUDE_HOME/sessions-disaster-nonce.json;与 manifest 同目录)。 */
export function defaultNoncePath(): string {
  return join(paths.home, "sessions-disaster-nonce.json");
}

/** 读 PG 状态行;表不存在(0134 未 apply,基建先行期)视为无行。其它错误透传(fail-closed)。 */
async function readPgStateRow(pool: Pool): Promise<SessionsStoreStateRow | null> {
  try {
    const r = await pool.query<{ authority: string; generation: string; cutover_id: string }>(
      "SELECT authority, generation, cutover_id FROM sessions_store_migration_state WHERE singleton = true",
    );
    const row = r.rows[0];
    if (!row) return null;
    const generation = Number(row.generation);
    if (!Number.isFinite(generation) || Math.abs(generation) > Number.MAX_SAFE_INTEGER) {
      throw new SessionsStoreAuthorityError(`[sessions-store] PG generation 越界: ${row.generation}`);
    }
    return {
      authority: row.authority as SessionsStoreStateRow["authority"],
      generation,
      cutoverId: row.cutover_id,
    };
  } catch (err) {
    // 42P01 = undefined_table:0134 尚未 apply → 等价"无状态行"(基建先行期)。
    if ((err as { code?: string })?.code === "42P01") return null;
    throw err;
  }
}

/** 读本地权威 manifest;文件缺失 → null;损坏 → 抛(fail-closed)。 */
async function readManifest(path: string): Promise<SessionsStoreManifest | null> {
  let raw: string;
  try {
    raw = await readFile(path, { encoding: "utf8" });
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionsStoreAuthorityError(`[sessions-store] 本地 manifest 损坏(非合法 JSON): ${path}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SessionsStoreAuthorityError(`[sessions-store] 本地 manifest 结构非法: ${path}`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.authority !== "string" || typeof o.generation !== "number" || typeof o.cutoverId !== "string") {
    throw new SessionsStoreAuthorityError(
      `[sessions-store] 本地 manifest 字段缺失/类型错(需 {authority:string, generation:number, cutoverId:string}): ${path}`,
    );
  }
  return { authority: o.authority, generation: o.generation, cutoverId: o.cutoverId };
}

/** 读本地灾难 nonce;文件缺失 → null;损坏 / 缺 cutoverId → 抛(fail-closed)。 */
async function readDisasterNonce(path: string): Promise<SessionsStoreDisasterNonce | null> {
  let raw: string;
  try {
    raw = await readFile(path, { encoding: "utf8" });
  } catch (err) {
    if ((err as { code?: string })?.code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SessionsStoreAuthorityError(`[sessions-store] 本地灾难 nonce 损坏(非合法 JSON): ${path}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SessionsStoreAuthorityError(`[sessions-store] 本地灾难 nonce 结构非法: ${path}`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.cutoverId !== "string" || o.cutoverId === "") {
    throw new SessionsStoreAuthorityError(
      `[sessions-store] 本地灾难 nonce 缺 cutoverId(需 {cutoverId:string, ts?, reason?}): ${path}`,
    );
  }
  return {
    cutoverId: o.cutoverId,
    ts: typeof o.ts === "number" ? o.ts : undefined,
    reason: typeof o.reason === "string" ? o.reason : undefined,
  };
}

export interface ResolveSessionsStoreOptions {
  pool?: Pool;
  manifestPath?: string;
  /** 灾难 nonce 路径;缺省 = 与 manifest 同目录的 sessions-disaster-nonce.json。 */
  noncePath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * 装配壳:读 env + PG 状态行 + 本地 manifest → 调 {@link decideSessionsStore} 裁决。抛
 * {@link SessionsStoreAuthorityError} 即 master 拒起(composition root 不 catch,直接冒泡)。
 */
export async function resolveSessionsStoreAuthority(
  opts: ResolveSessionsStoreOptions = {},
): Promise<SessionsStoreDecision> {
  const effectiveEnv = opts.env ?? process.env;
  const env = parseSessionsStoreEnv(effectiveEnv.OC_SESSIONS_STORE);
  const pool = opts.pool ?? getPool();
  const manifestPath = opts.manifestPath ?? defaultManifestPath(effectiveEnv);
  // 灾难 nonce 与 manifest 同目录(backfill disaster-restore 写在 dirname(manifest) 下)。
  const noncePath = opts.noncePath ?? join(dirname(manifestPath), "sessions-disaster-nonce.json");

  // PG 状态读取区分两种"读不到":
  //   ① 42P01(表不存在=0134 未 apply,基建先行期):readPgStateRow 内部吞成 null(pgReadFailed=false)。
  //   ② 连接错误等(连不上/超时):readPgStateRow 透传抛出 → 此处捕获为 pgReadFailed=true。
  // 例外:readPgStateRow 主动抛的 SessionsStoreAuthorityError(如 generation 越界)是**已判定的 fail-closed**,
  // 不是连接失败,直接冒泡拒起,绝不降级为静默 sqlite。
  let pgState: SessionsStoreStateRow | null = null;
  let pgReadError: Error | null = null;
  try {
    pgState = await readPgStateRow(pool);
  } catch (err) {
    if (err instanceof SessionsStoreAuthorityError) throw err;
    pgReadError = err instanceof Error ? err : new Error(String(err));
  }

  const manifest = await readManifest(manifestPath);
  // 灾难 nonce 读取的**损坏**(非合法 JSON/缺 cutoverId)是已判定 fail-closed,直接冒泡;
  // 文件缺失 → null(下游 decide 视缺失为不满足灾难过渡态条件)。
  const nonce = await readDisasterNonce(noncePath);

  if (pgReadError) {
    // PG 状态读取失败(连接错误):**不得静默走 sqlite**,由 manifest + nonce + env 兜底裁决
    // (放行 SQLite 仅"真·基建先行期"或"灾难过渡态",见 decideSessionsStorePgUnreachable)。
    try {
      return decideSessionsStorePgUnreachable(env, manifest, nonce);
    } catch (err) {
      if (err instanceof SessionsStoreAuthorityError) {
        // 补挂原始连接错误上下文,便于运维定位(核对 DATABASE_URL / PG 可达性)。
        throw new SessionsStoreAuthorityError(`${err.message} 原始 PG 错误: ${pgReadError.message.slice(0, 200)}`);
      }
      throw err;
    }
  }

  // 正常读到(含 42P01→null)→ 走启动规则矩阵纯函数裁决。
  return decideSessionsStore(env, pgState, manifest, nonce);
}
