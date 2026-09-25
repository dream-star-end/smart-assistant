/** Operator-only synthetic two-HTTP Box tool probe. Uses a pinned PostgreSQL
 * TEMP journal: no migration, no live billing row, no user content. A paid or
 * side-effecting operation is never replayed on an ambiguous result. */
import { randomBytes } from "node:crypto";
import { constants, closeSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { Pool } from "pg";
import { BoxDurableJournal } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import type { BoxJournalAdmission } from
  "../../packages/commercial/src/http/proxy/boxDurableJournal.js";
import { BoxToolFetch } from
  "../../packages/commercial/src/http/proxy/boxToolFetch.js";
import { recoverBoxBillingRequest } from
  "../../packages/commercial/src/billing/boxBillingRecovery.js";
import { createProductionBoxAccountResolver } from
  "../../packages/commercial/src/http/proxy/boxAccountResolver.js";
import { BOX_INTERNAL_ENDPOINT } from
  "../../packages/commercial/src/http/proxy/upstream.js";
import { getRuntimeChannel } from "../../packages/commercial/src/runtimeChannel.js";
import type { ProxyBody } from
  "../../packages/commercial/src/http/proxy/shared.js";

const UID = 3n, ACCOUNT_ID = 20n;
const MODEL = "box-api-claude-opus-5-5", UPSTREAM = "claude-opus-5-5";
const EVIDENCE_PARENT = "/var/lib/openclaude";
const EVIDENCE_DIR = `${EVIDENCE_PARENT}/ocv5-289-box-operator`;
const EVIDENCE_PATH = `${EVIDENCE_DIR}/account-20.json`;
const OPERATOR_MUTEX = `${EVIDENCE_DIR}/account-20.mutex`;
type Event = { event: string; data: Record<string, unknown> };
function assertion(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
async function readEvents(response: Response): Promise<Event[]> {
  assertion(response.status === 200 && response.body, "BOX_TOOL_PROBE_HTTP_INVALID");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "", ended = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) { ended = true; break; }
      raw += decoder.decode(next.value, { stream: true });
      assertion(Buffer.byteLength(raw) <= 2 * 1024 * 1024, "BOX_TOOL_PROBE_SSE_TOO_LARGE");
    }
  } finally { if (!ended) await reader.cancel().catch(() => {}); }
  raw += decoder.decode();
  const events = [...raw.matchAll(/^event: ([a-z_]+)\ndata: ([^\n]+)$/gm)]
    .map((match) => ({ event: match[1]!,
      data: JSON.parse(match[2]!) as Record<string, unknown> }));
  assertion(events.length > 0 && events.some((item) => item.event === "message_stop"),
    "BOX_TOOL_PROBE_SSE_INCOMPLETE");
  return events;
}
function assistantContent(events: Event[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const partial = new Map<number, string>();
  for (const { event, data } of events) {
    if (event === "content_block_start") {
      const index = data.index;
      const block = data.content_block;
      assertion(Number.isSafeInteger(index) && Number(index) >= 0
        && block && typeof block === "object" && !Array.isArray(block),
      "BOX_TOOL_PROBE_BLOCK_INVALID");
      blocks[index as number] = { ...block as Record<string, unknown> };
    } else if (event === "content_block_delta") {
      const index = data.index;
      const delta = data.delta as Record<string, unknown> | undefined;
      assertion(Number.isSafeInteger(index) && !!blocks[index as number] && !!delta,
        "BOX_TOOL_PROBE_DELTA_INVALID");
      const block = blocks[index as number]!;
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        block.text = String(block.text ?? "") + delta.text;
      } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
        block.thinking = String(block.thinking ?? "") + delta.thinking;
      } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
        block.signature = delta.signature;
      } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        partial.set(index as number, (partial.get(index as number) ?? "") + delta.partial_json);
      } else throw new Error("BOX_TOOL_PROBE_DELTA_UNSUPPORTED");
    } else if (event === "content_block_stop") {
      const index = data.index;
      assertion(Number.isSafeInteger(index) && !!blocks[index as number],
        "BOX_TOOL_PROBE_BLOCK_STOP_INVALID");
      const input = partial.get(index as number);
      if (input !== undefined) blocks[index as number]!.input = JSON.parse(input);
    }
  }
  assertion(blocks.length > 0 && blocks.length <= 64
    && Array.from({ length: blocks.length }, (_, index) => index)
      .every((index) => Object.hasOwn(blocks, index) && !!blocks[index]),
    "BOX_TOOL_PROBE_CONTENT_INVALID");
  return blocks;
}

async function main(): Promise<void> {
  if (process.env.OCV5_289_ACK_ACCOUNT_ID !== String(ACCOUNT_ID)
    || process.env.OCV5_289_ACK_USER_ID !== String(UID)
    || process.env.OCV5_289_TOOL_FETCH_ACK !== "1"
    || getRuntimeChannel() !== "v5") throw new Error("BOX_TOOL_FETCH_ACK_REQUIRED");
  const databaseUrl = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL;
  assertion(!!databaseUrl, "BOX_TOOL_TEMP_DB_REQUIRED");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const nonce = randomBytes(12).toString("hex");
  const sessionId = `ocv5-289-live-${nonce}`;
  const turnKey = randomBytes(32).toString("hex");
  const firstId = `box-live-a-${nonce}`, secondId = `box-live-b-${nonce}`;
  const challenge = `probe-${randomBytes(8).toString("hex")}`;
  const localResult = `ocv5-289-local-${randomBytes(12).toString("hex")}`;
  let localExecutions = 0, unknownPhase: string | null = null;
  let terminal = false;
  let identityPersisted = false;
  let lockHeld = false;
  let tempReady = false;
  const syncDirectory = (path = EVIDENCE_DIR): void => {
    const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY
      | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  };
  const writeDurable = (path: string, raw: string): void => {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT
      | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(raw);
      for (let offset = 0; offset < bytes.length;) {
        const written = writeSync(fd, bytes, offset, bytes.length - offset);
        assertion(written > 0, "BOX_TOOL_EVIDENCE_WRITE_FAILED");
        offset += written;
      }
      fsyncSync(fd);
    } finally { closeSync(fd); }
  };
  const withOperatorMutex = (action: () => void): void => {
    try {
      writeDurable(OPERATOR_MUTEX, JSON.stringify({ pid: process.pid,
        createdAt: new Date().toISOString() }) + "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("BOX_TOOL_OPERATOR_BUSY");
      }
      throw error;
    }
    syncDirectory();
    try { action(); }
    finally { unlinkSync(OPERATOR_MUTEX); syncDirectory(); }
  };
  const persistIdentity = (input: BoxJournalAdmission): void => {
    assertion(lockHeld && !identityPersisted && input.requestId === firstId && input.uid === UID
      && input.accountId === ACCOUNT_ID, "BOX_TOOL_ATTEMPT_IDENTITY_INVALID");
    const raw = JSON.stringify({ v: 1, pid: process.pid,
      accountId: String(ACCOUNT_ID), uid: String(UID),
      firstId, secondId, sessionId, runNonce: input.runNonce,
      leaseEpoch: input.leaseEpoch, state: "unresolved",
      createdAt: new Date().toISOString() }) + "\n";
    const staged = `${EVIDENCE_PATH}.${nonce}.part`;
    writeDurable(staged, raw);
    renameSync(staged, EVIDENCE_PATH);
    syncDirectory();
    identityPersisted = true;
  };
  try {
    const parent = lstatSync(EVIDENCE_PARENT);
    assertion(parent.isDirectory() && !parent.isSymbolicLink()
      && parent.uid === process.getuid()
      && (parent.mode & 0o777) === 0o700,
    "BOX_TOOL_EVIDENCE_PARENT_INVALID");
    try { mkdirSync(EVIDENCE_DIR, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Persist the newly-created child directory entry as well as files in it.
    syncDirectory(EVIDENCE_PARENT);
    const directory = lstatSync(EVIDENCE_DIR);
    assertion(directory.isDirectory() && !directory.isSymbolicLink()
      && directory.uid === process.getuid()
      && (directory.mode & 0o777) === 0o700,
    "BOX_TOOL_EVIDENCE_DIR_INVALID");
    withOperatorMutex(() => {
      try {
        writeDurable(EVIDENCE_PATH, JSON.stringify({ v: 1, pid: process.pid,
          accountId: String(ACCOUNT_ID), uid: String(UID), firstId, secondId,
          state: "preparing", createdAt: new Date().toISOString() }) + "\n");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error("BOX_TOOL_PRIOR_UNKNOWN_REQUIRES_RECONCILIATION");
        }
        throw error;
      }
      syncDirectory(); lockHeld = true;
    });
    // Shadow every financial relation on this one pinned connection. Nothing
    // below may read or mutate a persistent wallet, subscription, or ledger.
    await client.query("CREATE TEMP TABLE request_finalize_journal (LIKE public.request_finalize_journal INCLUDING ALL)");
    await client.query("CREATE TEMP SEQUENCE box_live_usage_id_seq");
    await client.query("CREATE TEMP TABLE usage_records (LIKE public.usage_records INCLUDING ALL)");
    await client.query("ALTER TABLE pg_temp.usage_records ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_live_usage_id_seq'::regclass)");
    await client.query("CREATE TEMP TABLE pending_usage_patches (LIKE public.pending_usage_patches INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE users (LIKE public.users INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE user_subscriptions (LIKE public.user_subscriptions INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE org_memberships (LIKE public.org_memberships INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE orgs (LIKE public.orgs INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE org_subscriptions (LIKE public.org_subscriptions INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE turn_waivers (LIKE public.turn_waivers INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE client_sessions (LIKE public.client_sessions INCLUDING ALL)");
    await client.query("CREATE TEMP TABLE chat_projects (LIKE public.chat_projects INCLUDING ALL)");
    await client.query("CREATE TEMP SEQUENCE box_live_ledger_id_seq");
    await client.query("CREATE TEMP TABLE credit_ledger (LIKE public.credit_ledger INCLUDING ALL)");
    await client.query("ALTER TABLE pg_temp.credit_ledger ALTER COLUMN id SET DEFAULT nextval('pg_temp.box_live_ledger_id_seq'::regclass)");
    const shadow = await client.query<{ only_temp: boolean }>(`SELECT
      'request_finalize_journal'::regclass = 'pg_temp.request_finalize_journal'::regclass
      AND 'usage_records'::regclass = 'pg_temp.usage_records'::regclass
      AND 'pending_usage_patches'::regclass = 'pg_temp.pending_usage_patches'::regclass
      AND 'users'::regclass = 'pg_temp.users'::regclass
      AND 'user_subscriptions'::regclass = 'pg_temp.user_subscriptions'::regclass
      AND 'org_memberships'::regclass = 'pg_temp.org_memberships'::regclass
      AND 'orgs'::regclass = 'pg_temp.orgs'::regclass
      AND 'org_subscriptions'::regclass = 'pg_temp.org_subscriptions'::regclass
      AND 'turn_waivers'::regclass = 'pg_temp.turn_waivers'::regclass
      AND 'client_sessions'::regclass = 'pg_temp.client_sessions'::regclass
      AND 'chat_projects'::regclass = 'pg_temp.chat_projects'::regclass
      AND 'credit_ledger'::regclass = 'pg_temp.credit_ledger'::regclass AS only_temp`);
    assertion(shadow.rows[0]?.only_temp, "BOX_TOOL_FINANCE_SHADOW_INVALID");
    const initialCredits = 100_000_000n;
    await client.query(`INSERT INTO users(id,email,password_hash,credits)
      VALUES ($1,$2,'operator-temp-only',$3)`,
    [UID.toString(), `${sessionId}@example.invalid`, initialCredits.toString()]);
    tempReady = true;
    const query = async (sql: string, params: unknown[] = []) => {
      assertion(!JSON.stringify(params).includes(localResult), "BOX_TOOL_PRIVATE_SQL_LEAK");
      return client.query(sql, params);
    };
    const sameConnection = { connect: async () => ({ query, release: () => {} }),
      query } as never;
    const baseJournal = new BoxDurableJournal(sameConnection);
    const journal = new Proxy(baseJournal, { get(target, key) {
      if (key === "admit") return async (input: BoxJournalAdmission) => {
        // This durable, private file is fsynced before the TEMP admission and
        // therefore before any paid CLI launch. A crash cannot erase identity.
        persistIdentity(input);
        return target.admit(input);
      };
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const basis = { model: MODEL, boxInvocationRecovery: "v1",
      // Deliberately synthetic high credits/token so a real low-token Box
      // response still proves a debit. This is NOT a launch price assertion.
      billingPricing: { v: 1, modelId: MODEL, displayName: "Opus synthetic",
        inputPerMtok: "100000000", outputPerMtok: "100000000",
        cacheReadPerMtok: "100000000", cacheWritePerMtok: "100000000",
        multiplier: "1" },
      boxBillingContext: { v: 1, sessionId, mode: "chat", parentSessionId: null,
        delegateAgentId: null, turnKey, parentTurnKey: null, authority: null,
        dispatchId: null, attemptNo: null, verificationSponsorship: null,
        apiKeyId: null } };
    const seed = async (requestId: string) => client.query(
      `INSERT INTO request_finalize_journal(request_id,user_id,state,ctx,precheck_credits)
       VALUES ($1,$2,'inflight',$3::jsonb,0)`,
      [requestId, UID.toString(), JSON.stringify(basis)]);
    const ageTerminalEvidence = async (requestId: string, state: "handoff" | "terminal") => {
      // Recovery intentionally protects fresh live finalizers for five minutes.
      // Only this verified TEMP row may be aged to exercise the recovery path;
      // never shorten the production protection period or mutate public rows.
      const changed = await client.query(`UPDATE pg_temp.request_finalize_journal
        SET updated_at=NOW()-INTERVAL '10 minutes'
        WHERE request_id=$1 AND user_id=$2 AND state='inflight'
          AND ctx->>'boxInvocationRecovery'='v1' AND ctx->>'boxState'=$3`,
      [requestId, UID.toString(), state]);
      assertion(changed.rowCount === 1, "BOX_TOOL_TEMP_EVIDENCE_NOT_READY");
    };
    const resolver = createProductionBoxAccountResolver();
    const service = new BoxToolFetch({
      supervisorAsset: readFileSync(new URL("./box_supervisor.py", import.meta.url)),
      keeperAsset: readFileSync(new URL("./box_keeper.py", import.meta.url)),
      virtualMcpAsset: readFileSync(new URL("./box_virtual_mcp.py", import.meta.url)),
      detachedRunnerAsset: readFileSync(new URL("./box_detached_runner.py", import.meta.url)),
      journal, maxOutputTokensForModel: (model) => model === MODEL ? 128_000 : null,
      resolveTarget: (args) => resolver.resolve({ ...args, requiredAccountId: ACCOUNT_ID }),
      onUnknown: async ({ phase }) => { unknownPhase ??= phase; },
    });
    const tools = [{ name: "local_echo", description: "Synthetic OpenClaude-local tool",
      input_schema: { type: "object", properties: { value: { type: "string" } },
        required: ["value"] } }];
    // Opus 5.5 adaptive thinking can consume a 128-token ceiling before it
    // reaches tool_use; use the actual CCB-scale request budget for this probe.
    const first: ProxyBody = { model: MODEL, max_tokens: 8192, stream: true,
      system: "Synthetic OpenClaude tool verification. No real user content.",
      metadata: { user_id: JSON.stringify({ oc_turn_key: turnKey, session_id: sessionId }) },
      messages: [{ role: "user", content:
        `Call local_echo exactly once with value ${challenge}. Then answer with exactly its result text.` }],
      tools, tool_choice: { type: "auto" } };
    await seed(firstId);
    const firstResponse = await service.fetch({ uid: UID, sessionId, requestId: firstId,
      canonicalModel: MODEL, canonicalBody: first, upstreamModel: UPSTREAM,
      url: BOX_INTERNAL_ENDPOINT,
      init: { method: "POST", body: JSON.stringify({ ...first, model: UPSTREAM }) } });
    const firstEvents = await readEvents(firstResponse);
    const content = assistantContent(firstEvents);
    const toolUse = content.filter((block) => block.type === "tool_use");
    assertion(toolUse.length === 1 && toolUse[0]?.name === "local_echo"
      && typeof toolUse[0]?.id === "string"
      && JSON.stringify(toolUse[0]?.input) === JSON.stringify({ value: challenge }),
    "BOX_TOOL_PROBE_TOOL_USE_INVALID");
    assertion(firstEvents.some((item) => item.event === "message_delta"
      && (item.data.delta as { stop_reason?: unknown } | undefined)?.stop_reason === "tool_use"),
    "BOX_TOOL_PROBE_HANDOFF_INVALID");
    await ageTerminalEvidence(firstId, "handoff");
    assertion(await recoverBoxBillingRequest(sameConnection, firstId, UID) === "settled",
      "BOX_TOOL_HANDOFF_BILLING_NOT_SETTLED");
    // The only tool implementation is here in OpenClaude's operator process;
    // Box receives only schema/pending/result via the virtual MCP.
    localExecutions++;
    const second: ProxyBody = { ...first, messages: [
      ...first.messages, { role: "assistant", content },
      { role: "user", content: [{ type: "tool_result",
        tool_use_id: toolUse[0]!.id, content: localResult }] },
    ] };
    await seed(secondId);
    const secondResponse = await service.fetch({ uid: UID, sessionId, requestId: secondId,
      canonicalModel: MODEL, canonicalBody: second, upstreamModel: UPSTREAM,
      url: BOX_INTERNAL_ENDPOINT,
      init: { method: "POST", body: JSON.stringify({ ...second, model: UPSTREAM }) } });
    const secondEvents = await readEvents(secondResponse);
    const answer = assistantContent(secondEvents)
      .filter((block) => block.type === "text").map((block) => block.text).join("");
    assertion(answer.trim() === localResult && localExecutions === 1
      && unknownPhase === null, "BOX_TOOL_PROBE_FINAL_INVALID");
    const rows = await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
      `SELECT request_id,ctx FROM request_finalize_journal
       WHERE request_id IN ($1,$2) ORDER BY request_id`, [firstId, secondId]);
    const ownerRow = rows.rows.find((row) => row.request_id === firstId);
    const finalRow = rows.rows.find((row) => row.request_id === secondId);
    assertion(rows.rows.length === 2 && rows.rows.every((row) => row.ctx.boxState === "terminal")
      && !!ownerRow?.ctx.boxToolHandoff && !ownerRow.ctx.boxTerminalProof
      && (finalRow?.ctx.boxTerminalProof as { reason?: unknown } | undefined)?.reason
        === "worker_complete",
    "BOX_TOOL_PROBE_JOURNAL_NOT_TERMINAL");
    await ageTerminalEvidence(secondId, "terminal");
    assertion(await recoverBoxBillingRequest(sameConnection, secondId, UID) === "settled",
      "BOX_TOOL_FINAL_BILLING_NOT_SETTLED");
    assertion(await recoverBoxBillingRequest(sameConnection, firstId, UID) === "already_committed"
      && await recoverBoxBillingRequest(sameConnection, secondId, UID) === "already_committed",
    "BOX_TOOL_BILLING_REPLAY_NOT_CLOSED");
    const finance = await client.query<{ count: string; sum: string }>(
      `SELECT count(*)::text AS count, coalesce(sum(cost_credits),0)::text AS sum
       FROM usage_records WHERE request_id IN ($1,$2)`, [firstId, secondId]);
    const ledger = await client.query<{ count: string; sum: string }>(
      `SELECT count(*)::text AS count, coalesce(sum(delta),0)::text AS sum
       FROM credit_ledger WHERE user_id=$1`, [UID.toString()]);
    const balance = await client.query<{ credits: string }>(
      `SELECT credits::text FROM users WHERE id=$1`, [UID.toString()]);
    const debited = initialCredits - BigInt(balance.rows[0]?.credits ?? "0");
    assertion(finance.rows[0]?.count === "2" && ledger.rows[0]?.count === "2"
      && BigInt(finance.rows[0]?.sum ?? "0") > 0n
      && debited === BigInt(finance.rows[0]?.sum ?? "0")
      && BigInt(ledger.rows[0]?.sum ?? "0") === -debited,
    "BOX_TOOL_REAL_USAGE_LEDGER_MISMATCH");
    terminal = true;
    const pendingCleanup = await service.retryTerminalCleanup();
    const cleanupRow = await client.query<{ cleanup: string | null }>(
      `SELECT ctx->>'boxRemoteCleanup' AS cleanup FROM request_finalize_journal
       WHERE request_id=$1`, [secondId]);
    assertion(pendingCleanup === 0 && cleanupRow.rows[0]?.cleanup === "done",
      "BOX_TOOL_PROBE_CLEANUP_UNPROVEN");
    assertion(identityPersisted, "BOX_TOOL_PROBE_IDENTITY_NOT_DURABLE");
    withOperatorMutex(() => {
      unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
    });
    process.stdout.write(JSON.stringify({ accountId: String(ACCOUNT_ID),
      modelId: UPSTREAM, detachedAcrossHttp: true,
      localToolExecutions: localExecutions,
      exactFinal: true, terminalRows: rows.rows.length,
      tempUsageRows: 2, tempLedgerRows: 2, syntheticPriceOnly: true,
      debitedCredits: debited.toString(),
      firstEventCount: firstEvents.length, secondEventCount: secondEvents.length,
      remoteCleanupDone: true, unknown: false, tempOnly: true }) + "\n");
  } catch (error) {
    if (lockHeld && !identityPersisted) {
      // The durable admission wrapper has not run, so no paid CLI can have
      // started. Release this prelaunch-only reservation, still fail the probe.
      try { withOperatorMutex(() => {
        unlinkSync(EVIDENCE_PATH); syncDirectory(); lockHeld = false;
      }); }
      catch { /* Keep a conservative unknown lock on cleanup failure. */ }
    }
    const observed = tempReady
      ? await client.query<{ request_id: string; ctx: Record<string, unknown> }>(
        `SELECT request_id,ctx FROM request_finalize_journal
         WHERE request_id IN ($1,$2)`, [firstId, secondId]).catch(() => ({ rows: [] }))
      : { rows: [] as Array<{ request_id: string; ctx: Record<string, unknown> }> };
    const evidence = observed.rows.map((row) => ({ requestId: row.request_id,
      state: row.ctx.boxState, runNonce: row.ctx.boxRunNonce,
      leaseEpoch: row.ctx.boxLeaseEpoch }));
    process.stderr.write(JSON.stringify({ code: error instanceof Error
      && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message) ? error.message : "BOX_TOOL_PROBE_FAILED",
      terminal, unknownPhase, evidencePath: lockHeld ? EVIDENCE_PATH : null,
      evidence }) + "\n");
    throw error;
  } finally {
    await client.query("DROP TABLE IF EXISTS pg_temp.request_finalize_journal").catch(() => {});
    client.release(); await pool.end();
  }
}
void main().then(() => process.exit(0), (error: unknown) => {
  const code = error instanceof Error && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.message)
    ? error.message : "BOX_TOOL_PROBE_FAILED";
  process.stderr.write(code + "\n"); process.exit(1);
});
