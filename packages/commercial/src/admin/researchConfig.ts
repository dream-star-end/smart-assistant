/**
 * 科研平台配置(单一权威)— admin CRUD + secret 管理。
 *
 * 单行表 research_config(id=1),见 0095 migration。设计权威:
 * docs/research-agent/IMPLEMENTATION_PLAN.md §3。
 *
 * ### 分层读
 *   - getResearchConfigPublic() —— enabled + config_json(非密)。proxy gating /
 *     prompt skill / 容器侧文案都只需这个,**不解密 secrets**(最小权限)。
 *   - getResearchSecrets() —— 解密 secrets blob。**仅** proxy 在真要调上游(S2/MinerU/
 *     embedding/Qdrant)那一刻调用;明文不离该调用点。
 *   - getResearchConfigView() —— admin 视图:config_json + 已设 secret 名单(名,无值)。
 *
 * ### secret 写入(显式 action,不走 mask 兜底字符串)
 *   setSecret(name, value) / clearSecret(name):整个 secrets JSON 重加密一次
 *   (一个 secret_ct/secret_nonce 存全部);audit 只写 {name, set} 元信息,明文永不进 audit。
 *
 * ### config_json 校验
 *   TypeBox 严格校验(additionalProperties:false 拒未知字段、enum 越界);写入前先校验。
 *
 * ### DeepXiv 并存
 *   本表是"新多源研究栈"单一权威;literature_deepxiv_config(0069)是另一独立上游,
 *   二者不治理同一件事,非权威分裂(方案 §3 / Codex #5)。
 */

import { type Static, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { PoolClient } from "pg";
import { query, tx } from "../db/queries.js";
import { writeAdminAudit } from "./audit.js";
import { encrypt, decryptToBuffer } from "../crypto/aead.js";
import { loadKmsKey, zeroBuffer } from "../crypto/keys.js";

// ─── config_json schema(严格) ───────────────────────────────────────

export const ResearchConfigJson = Type.Object(
  {
    litSources: Type.Object(
      {
        openalexMailto: Type.Optional(Type.String()),
        crossrefMailto: Type.Optional(Type.String()),
        unpaywallEmail: Type.Optional(Type.String()),
        ncpssdEnabled: Type.Optional(Type.Boolean()),
        s2Enabled: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ),
    ingest: Type.Object(
      {
        engine: Type.Union([
          Type.Literal("auto"),
          Type.Literal("local"),
          Type.Literal("mineru"),
          Type.Literal("mistral"),
        ]),
        mineruEndpoint: Type.Optional(Type.String()),
        grobidEndpoint: Type.Optional(Type.String()),
        mistralEndpoint: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    litrag: Type.Object(
      {
        embedBackend: Type.Union([Type.Literal("local"), Type.Literal("http")]),
        embedEndpoint: Type.Optional(Type.String()),
        vectorBackend: Type.Union([Type.Literal("inproc"), Type.Literal("qdrant")]),
        qdrantUrl: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    cite: Type.Object(
      {
        retraction: Type.Union([Type.Literal("crossref"), Type.Literal("off")]),
        strictDomains: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    ),
    limits: Type.Object(
      {
        dailyCap: Type.Optional(Type.Integer()),
        perContainerPerMin: Type.Optional(Type.Integer()),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
export type ResearchConfigJson = Static<typeof ResearchConfigJson>

/** 缺省配置:全部走免费公开 API + 进程内 fallback,不依赖任何 secret/外部 infra。 */
export const DEFAULT_RESEARCH_CONFIG: ResearchConfigJson = {
  litSources: { ncpssdEnabled: false, s2Enabled: false },
  ingest: { engine: "auto" },
  litrag: { embedBackend: "local", vectorBackend: "inproc" },
  cite: { retraction: "crossref", strictDomains: ["bio", "clinical", "policy"] },
  limits: {},
};

// ─── secrets ─────────────────────────────────────────────────────────

/** 允许的 secret 名(白名单;拒任意名防注入垃圾键)。 */
export const RESEARCH_SECRET_NAMES = [
  "s2ApiKey",
  "mineruApiKey",
  "mistralApiKey",
  "embedApiKey",
  "qdrantApiKey",
] as const;
export type ResearchSecretName = (typeof RESEARCH_SECRET_NAMES)[number]

export type ResearchSecrets = Partial<Record<ResearchSecretName, string>>

function isSecretName(n: string): n is ResearchSecretName {
  return (RESEARCH_SECRET_NAMES as readonly string[]).includes(n);
}

// ─── DB row ──────────────────────────────────────────────────────────

interface ConfigDbRow {
  id: 1;
  enabled: boolean;
  config_version: number;
  config_json: unknown;
  secret_ct: Buffer | null;
  secret_nonce: Buffer | null;
  updated_at: Date;
  updated_by: string | null;
}

const COLS =
  "id, enabled, config_version, config_json, secret_ct, secret_nonce, updated_at, updated_by";

/** 把 DB 的 config_json 归一成强类型(缺字段用默认填补,容旧版本)。 */
function coerceConfigJson(raw: unknown): ResearchConfigJson {
  if (raw && typeof raw === "object") {
    const merged = mergeWithDefault(raw as Record<string, unknown>);
    if (Value.Check(ResearchConfigJson, merged)) return merged;
  }
  return DEFAULT_RESEARCH_CONFIG;
}

/** 浅合并默认(每个子对象级)。仅用于读路径容错,不用于 patch 校验。 */
function mergeWithDefault(raw: Record<string, unknown>): ResearchConfigJson {
  const d = DEFAULT_RESEARCH_CONFIG;
  const sub = (k: keyof ResearchConfigJson) => ({
    ...(d[k] as object),
    ...((raw[k] as object) ?? {}),
  });
  return {
    litSources: sub("litSources"),
    ingest: sub("ingest"),
    litrag: sub("litrag"),
    cite: sub("cite"),
    limits: sub("limits"),
  } as ResearchConfigJson;
}

async function readRow(): Promise<ConfigDbRow> {
  const r = await query<ConfigDbRow>(`SELECT ${COLS} FROM research_config WHERE id = 1`);
  if (r.rows.length > 0) return r.rows[0];
  // 0095 已 seed,理论永不到此;fail-closed 返 disabled 默认。
  return {
    id: 1,
    enabled: false,
    config_version: 1,
    config_json: DEFAULT_RESEARCH_CONFIG,
    secret_ct: null,
    secret_nonce: null,
    updated_at: new Date(0),
    updated_by: null,
  };
}

// ─── 公共读(不解密) ─────────────────────────────────────────────────

export interface ResearchConfigPublic {
  enabled: boolean;
  config: ResearchConfigJson;
}

export async function getResearchConfigPublic(): Promise<ResearchConfigPublic> {
  const row = await readRow();
  return { enabled: row.enabled, config: coerceConfigJson(row.config_json) };
}

// ─── secret 读(解密;仅 proxy 调用) ──────────────────────────────────

function decryptSecrets(ct: Buffer | null, nonce: Buffer | null): ResearchSecrets {
  if (ct === null || nonce === null) return {};
  const key = loadKmsKey();
  try {
    const pt = decryptToBuffer(ct, nonce, key);
    try {
      const obj = JSON.parse(pt.toString("utf8")) as Record<string, unknown>;
      const out: ResearchSecrets = {};
      for (const [k, v] of Object.entries(obj)) {
        if (isSecretName(k) && typeof v === "string" && v.length > 0) out[k] = v;
      }
      return out;
    } finally {
      zeroBuffer(pt);
    }
  } finally {
    zeroBuffer(key);
  }
}

/** 解密 secrets。**仅** proxy 真要调上游时调用;明文不应离开调用点。 */
export async function getResearchSecrets(): Promise<ResearchSecrets> {
  const row = await readRow();
  return decryptSecrets(row.secret_ct, row.secret_nonce);
}

// ─── admin 视图 ──────────────────────────────────────────────────────

export interface ResearchConfigView {
  enabled: boolean;
  config_version: number;
  config: ResearchConfigJson;
  /** 已设置的 secret 名(仅名,无值)。 */
  secretsSet: ResearchSecretName[];
  updated_at: string;
  updated_by: string | null;
}

export async function getResearchConfigView(): Promise<ResearchConfigView> {
  const row = await readRow();
  let secretsSet: ResearchSecretName[] = [];
  try {
    secretsSet = Object.keys(decryptSecrets(row.secret_ct, row.secret_nonce)).filter(
      isSecretName,
    );
  } catch {
    secretsSet = []; // 解密失败 fail-soft:admin 仍能看 config + 重设 secret
  }
  return {
    enabled: row.enabled,
    config_version: row.config_version,
    config: coerceConfigJson(row.config_json),
    secretsSet,
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}

// ─── PATCH(config_json + enabled) ───────────────────────────────────

export interface PatchResearchConfigCtx {
  adminId: bigint | number | string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface PatchResearchConfigInput {
  enabled?: boolean;
  /** 完整 config(严格校验);部分更新由前端先读后合并再提交完整对象。 */
  config?: ResearchConfigJson;
}

export class ResearchConfigValidationError extends Error {
  constructor(public readonly detail: string) {
    super(`invalid_research_config: ${detail}`);
    this.name = "ResearchConfigValidationError";
  }
}

/** 校验并归一 config(严格 schema)。抛 ResearchConfigValidationError。 */
export function validateResearchConfig(input: unknown): ResearchConfigJson {
  if (!Value.Check(ResearchConfigJson, input)) {
    const first = [...Value.Errors(ResearchConfigJson, input)][0];
    throw new ResearchConfigValidationError(
      first ? `${first.path}: ${first.message}` : "schema mismatch",
    );
  }
  return input;
}

export async function patchResearchConfig(
  patch: PatchResearchConfigInput,
  ctx: PatchResearchConfigCtx,
): Promise<ResearchConfigView> {
  if (patch.enabled === undefined && patch.config === undefined) {
    return getResearchConfigView();
  }
  let normalizedConfig: ResearchConfigJson | undefined;
  if (patch.config !== undefined) {
    normalizedConfig = validateResearchConfig(patch.config);
  }
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    throw new ResearchConfigValidationError("enabled must be boolean");
  }

  return tx(async (client: PoolClient) => {
    const before = await client.query<ConfigDbRow>(
      `SELECT ${COLS} FROM research_config WHERE id = 1 FOR UPDATE`,
    );
    if (before.rows.length === 0) {
      await client.query(
        "INSERT INTO research_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING",
      );
    }
    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (col: string, val: unknown): void => {
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.enabled !== undefined) push("enabled", patch.enabled);
    if (normalizedConfig !== undefined) {
      params.push(JSON.stringify(normalizedConfig));
      sets.push(`config_json = $${params.length}::jsonb`);
    }
    sets.push("updated_at = NOW()");
    params.push(String(ctx.adminId));
    sets.push(`updated_by = $${params.length}`);

    await client.query(
      `UPDATE research_config SET ${sets.join(", ")} WHERE id = 1`,
      params,
    );

    const b = before.rows[0];
    await writeAdminAudit(client, {
      adminId: ctx.adminId,
      action: "research_config.patch",
      target: "research_config:1",
      before: {
        enabled: b?.enabled,
        config: b ? coerceConfigJson(b.config_json) : undefined,
      },
      after: { enabled: patch.enabled, config: normalizedConfig },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });

    return getResearchConfigViewTx(client);
  });
}

// ─── secret set / clear ──────────────────────────────────────────────

export interface SecretPatchCtx extends PatchResearchConfigCtx {}

/** 设置一个 secret(整 blob 重加密)。audit 只写 {name, set:true}。 */
export async function setResearchSecret(
  name: string,
  value: string,
  ctx: SecretPatchCtx,
): Promise<ResearchConfigView> {
  if (!isSecretName(name)) throw new ResearchConfigValidationError(`unknown secret: ${name}`);
  const v = value.trim();
  if (v.length === 0 || v.length > 4096) {
    throw new ResearchConfigValidationError("secret value empty or too long");
  }
  return mutateSecrets(
    (secrets) => {
      secrets[name] = v;
    },
    { adminId: ctx.adminId, ip: ctx.ip, userAgent: ctx.userAgent, name, set: true },
  );
}

/** 清除一个 secret。audit 只写 {name, set:false}。 */
export async function clearResearchSecret(
  name: string,
  ctx: SecretPatchCtx,
): Promise<ResearchConfigView> {
  if (!isSecretName(name)) throw new ResearchConfigValidationError(`unknown secret: ${name}`);
  return mutateSecrets(
    (secrets) => {
      delete secrets[name];
    },
    { adminId: ctx.adminId, ip: ctx.ip, userAgent: ctx.userAgent, name, set: false },
  );
}

async function mutateSecrets(
  apply: (secrets: ResearchSecrets) => void,
  auditMeta: {
    adminId: bigint | number | string;
    ip?: string | null;
    userAgent?: string | null;
    name: string;
    set: boolean;
  },
): Promise<ResearchConfigView> {
  return tx(async (client: PoolClient) => {
    const before = await client.query<ConfigDbRow>(
      `SELECT ${COLS} FROM research_config WHERE id = 1 FOR UPDATE`,
    );
    if (before.rows.length === 0) {
      await client.query("INSERT INTO research_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING");
    }
    const b = before.rows[0];
    // 容错:旧密文损坏 / KMS key 轮换导致解密失败时,不阻塞 admin 修复 —— 从空
    // secrets 起算(其它无法解密的旧 secret 会一并丢弃,但它们本就读不出,
    // 让 admin 能重设/清除是正确取舍)。priorDecryptFailed 进 audit 供观测。
    let secrets: ResearchSecrets = {};
    let priorDecryptFailed = false;
    if (b) {
      try {
        secrets = decryptSecrets(b.secret_ct, b.secret_nonce);
      } catch {
        priorDecryptFailed = true;
      }
    }
    apply(secrets);

    const hasAny = Object.keys(secrets).length > 0;
    if (!hasAny) {
      await client.query(
        `UPDATE research_config
            SET secret_ct = NULL, secret_nonce = NULL, updated_at = NOW(), updated_by = $1
          WHERE id = 1`,
        [String(auditMeta.adminId)],
      );
    } else {
      const key = loadKmsKey();
      try {
        const { ciphertext, nonce } = encrypt(JSON.stringify(secrets), key);
        await client.query(
          `UPDATE research_config
              SET secret_ct = $1, secret_nonce = $2, updated_at = NOW(), updated_by = $3
            WHERE id = 1`,
          [ciphertext, nonce, String(auditMeta.adminId)],
        );
      } finally {
        zeroBuffer(key);
      }
    }

    await writeAdminAudit(client, {
      adminId: auditMeta.adminId,
      action: "research_config.secret",
      target: "research_config:1",
      // 只写元信息,绝不写 secret 明文
      before: priorDecryptFailed ? { priorDecryptFailed: true } : undefined,
      after: { name: auditMeta.name, set: auditMeta.set },
      ip: auditMeta.ip ?? null,
      userAgent: auditMeta.userAgent ?? null,
    });

    return getResearchConfigViewTx(client);
  });
}

/** 事务内重读视图(供 patch/secret 返回最新)。 */
async function getResearchConfigViewTx(client: PoolClient): Promise<ResearchConfigView> {
  const r = await client.query<ConfigDbRow>(`SELECT ${COLS} FROM research_config WHERE id = 1`);
  const row = r.rows[0];
  let secretsSet: ResearchSecretName[] = [];
  try {
    secretsSet = Object.keys(decryptSecrets(row.secret_ct, row.secret_nonce)).filter(isSecretName);
  } catch {
    secretsSet = [];
  }
  return {
    enabled: row.enabled,
    config_version: row.config_version,
    config: coerceConfigJson(row.config_json),
    secretsSet,
    updated_at: row.updated_at.toISOString(),
    updated_by: row.updated_by,
  };
}
