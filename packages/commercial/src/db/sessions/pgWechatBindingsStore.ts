import type { Pool, PoolClient } from "pg";
import type { UpsertWechatBindingInput, WechatBinding } from "@openclaude/storage";
import type { PgSessionsCtx, PgSessionsDeps } from "./deps.js";
import { bigIntNum, bigIntNumOrNull, withTx } from "./sqlHelpers.js";

// ── wechat_bindings 行 → 领域对象(复刻 storage/wechatBindings.ts 的私有 rowToBinding;
//    storage 本批冻结,helper 未导出,故此处复制。逻辑简单稳定,已在交接清单登记)。────
const IM_WECHAT_SUFFIX = "@im.wechat";

const UPSERT_WECHAT_BINDING_SQL = `INSERT INTO wechat_bindings
   (user_id, account_id, login_user_id, bot_token, get_updates_buf, context_tokens, whitelist, status, created_at, updated_at, last_event_at)
 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
 ON CONFLICT (user_id) DO UPDATE SET
   account_id = EXCLUDED.account_id,
   login_user_id = EXCLUDED.login_user_id,
   bot_token = EXCLUDED.bot_token,
   get_updates_buf = EXCLUDED.get_updates_buf,
   context_tokens = EXCLUDED.context_tokens,
   whitelist = EXCLUDED.whitelist,
   status = EXCLUDED.status,
   updated_at = EXCLUDED.updated_at,
   last_event_at = EXCLUDED.last_event_at`;

interface WechatRow {
  user_id: string;
  account_id: string;
  login_user_id: string;
  bot_token: string;
  get_updates_buf: string;
  context_tokens: string;
  whitelist: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_event_at: string | null;
}

function stripImWechatSuffix(key: string): string {
  return key.endsWith(IM_WECHAT_SUFFIX) ? key.slice(0, -IM_WECHAT_SUFFIX.length) : key;
}

function canonicalizeContextTokens(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) out[stripImWechatSuffix(k)] = v;
  return out;
}

function parseJsonRecord(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch (err) {
    void err;
    return {};
  }
}

function parseJsonStringArray(raw: string | null | undefined): string[] {
  try {
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch (err) {
    void err;
    return [];
  }
}

function rowToBinding(r: WechatRow): WechatBinding {
  let ctx: Record<string, string> = {};
  let wl: string[] = [];
  try {
    ctx = canonicalizeContextTokens(JSON.parse(r.context_tokens || "{}"));
  } catch (err) {
    void err;
  }
  try {
    wl = JSON.parse(r.whitelist || "[]");
  } catch (err) {
    void err;
  }
  const st = r.status === "disabled" || r.status === "expired" ? r.status : "active";
  return {
    userId: r.user_id,
    accountId: r.account_id,
    loginUserId: r.login_user_id || "",
    botToken: r.bot_token,
    getUpdatesBuf: r.get_updates_buf || "",
    contextTokens: ctx,
    whitelist: wl,
    status: st,
    createdAt: bigIntNum(r.created_at, "wechat.created_at"),
    updatedAt: bigIntNum(r.updated_at, "wechat.updated_at"),
    lastEventAt: bigIntNumOrNull(r.last_event_at),
  };
}

function computeUpsertBindingPayload(
  input: UpsertWechatBindingInput,
  existing: WechatRow | undefined,
  now: number,
) {
  const identityChanged =
    !!existing && (existing.account_id !== input.accountId || existing.bot_token !== input.botToken);
  const buf = input.getUpdatesBuf ?? (identityChanged ? "" : (existing?.get_updates_buf ?? ""));
  const ctx = JSON.stringify(
    input.contextTokens ??
      (identityChanged ? {} : existing ? parseJsonRecord(existing.context_tokens) : {}),
  );
  const wl = JSON.stringify(
    input.whitelist ??
      (identityChanged
        ? []
        : existing
          ? parseJsonStringArray(existing.whitelist)
          : [input.loginUserId].filter(Boolean)),
  );
  const status = input.status ?? "active";
  const createdAt = existing ? bigIntNum(existing.created_at, "wechat.created_at") : now;
  const lastEventAt =
    input.lastEventAt ??
    (identityChanged ? null : existing ? bigIntNumOrNull(existing.last_event_at) : null);
  return { buf, ctx, wl, status, createdAt, lastEventAt };
}

async function runUpsertWechatBindingTx(
  client: PoolClient,
  input: UpsertWechatBindingInput,
  now: number,
  deps: PgSessionsDeps,
): Promise<void> {
  // 死锁面(D8):按排序后的逻辑键取 pg_advisory_xact_lock(全局定序消 ABBA),再按 account → user 行锁。
  const [firstLockKey, secondLockKey] = [
    `oc_wechat_user:${input.userId}`,
    `oc_wechat_acct:${input.accountId}`,
  ].sort();
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [firstLockKey]);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [secondLockKey]);

  const accountOwner = (
    await client.query<{ user_id: string }>(
      "SELECT user_id FROM wechat_bindings WHERE account_id = $1 FOR UPDATE",
      [input.accountId],
    )
  ).rows[0];
  if (accountOwner && accountOwner.user_id !== input.userId) {
    throw new deps.storage.WechatAccountAlreadyBoundError(input.accountId);
  }
  const existing = (
    await client.query<WechatRow>("SELECT * FROM wechat_bindings WHERE user_id = $1 FOR UPDATE", [
      input.userId,
    ])
  ).rows[0];

  const payload = computeUpsertBindingPayload(input, existing, now);
  await client.query(UPSERT_WECHAT_BINDING_SQL, [
    input.userId,
    input.accountId,
    input.loginUserId,
    input.botToken,
    payload.buf,
    payload.ctx,
    payload.wl,
    payload.status,
    payload.createdAt,
    now,
    payload.lastEventAt,
  ]);
}

async function upsertWechatBindingImpl(
  pool: Pool,
  deps: PgSessionsDeps,
  input: UpsertWechatBindingInput,
): Promise<void> {
  // D8:RMW(读 owner→继承字段→UPSERT),单事务 + 锁 account/user 行(固定 account→user 序防死锁)。
  // 23505 唯一冲突(account_id 唯一索引)转 WechatAccountAlreadyBoundError(不依赖错误文本)。
  const now = Date.now();
  try {
    await withTx(pool, (client) => runUpsertWechatBindingTx(client, input, now, deps));
  } catch (err) {
    if (err instanceof deps.storage.WechatAccountAlreadyBoundError) throw err;
    const code = (err as { code?: string })?.code;
    const constraint = (err as { constraint?: string })?.constraint;
    if (code === "23505" && (constraint === "idx_wechat_bindings_account" || constraint === undefined)) {
      throw new deps.storage.WechatAccountAlreadyBoundError(input.accountId);
    }
    throw err;
  }
}

async function updateWechatBindingCursorImpl(
  pool: Pool,
  userId: string,
  getUpdatesBuf: string,
  contextTokens?: Record<string, string>,
): Promise<void> {
  const now = Date.now();
  if (contextTokens) {
    await pool.query(
      "UPDATE wechat_bindings SET get_updates_buf = $1, context_tokens = $2, last_event_at = $3, updated_at = $4 WHERE user_id = $5",
      [getUpdatesBuf, JSON.stringify(contextTokens), now, now, userId],
    );
  } else {
    await pool.query(
      "UPDATE wechat_bindings SET get_updates_buf = $1, updated_at = $2 WHERE user_id = $3",
      [getUpdatesBuf, now, userId],
    );
  }
}

export function createPgWechatBindingsStore(ctx: PgSessionsCtx) {
  const { pool, deps } = ctx;
  return {
    async listActiveWechatBindings(): Promise<WechatBinding[]> {
      const rows = (
        await pool.query<WechatRow>("SELECT * FROM wechat_bindings WHERE status = $1", ["active"])
      ).rows;
      return rows.map(rowToBinding);
    },
    async listAllWechatBindings(): Promise<WechatBinding[]> {
      const rows = (await pool.query<WechatRow>("SELECT * FROM wechat_bindings")).rows;
      return rows.map(rowToBinding);
    },
    async getWechatBindingByUserId(userId: string): Promise<WechatBinding | null> {
      const row = (
        await pool.query<WechatRow>("SELECT * FROM wechat_bindings WHERE user_id = $1", [userId])
      ).rows[0];
      return row ? rowToBinding(row) : null;
    },
    async getWechatBindingByAccountId(accountId: string): Promise<WechatBinding | null> {
      const row = (
        await pool.query<WechatRow>("SELECT * FROM wechat_bindings WHERE account_id = $1", [
          accountId,
        ])
      ).rows[0];
      return row ? rowToBinding(row) : null;
    },
    upsertWechatBinding: (input: UpsertWechatBindingInput) =>
      upsertWechatBindingImpl(pool, deps, input),
    updateWechatBindingCursor: (
      userId: string,
      getUpdatesBuf: string,
      contextTokens?: Record<string, string>,
    ) => updateWechatBindingCursorImpl(pool, userId, getUpdatesBuf, contextTokens),
    async updateWechatBindingStatus(
      userId: string,
      status: WechatBinding["status"],
    ): Promise<void> {
      const now = Date.now();
      await pool.query(
        "UPDATE wechat_bindings SET status = $1, updated_at = $2 WHERE user_id = $3",
        [status, now, userId],
      );
    },
    async deleteWechatBinding(userId: string): Promise<void> {
      await pool.query("DELETE FROM wechat_bindings WHERE user_id = $1", [userId]);
    },
  };
}
