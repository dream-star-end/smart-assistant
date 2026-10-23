/** UNWIRED DRAFT — OCV5-614 awaits the unavailable-estimate product decision.
 * The history fallback below is not a valid native-context measurement and
 * must be replaced before this reader is connected to admission or quoting. */
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { estimateModelHistoryTokens, modelHistorySemanticText } from '@openclaude/protocol';
import { getEngineContextMessages } from '@openclaude/storage';

export interface SwitchContext {
  revision: number;
  fingerprint: string;
  sourceModel: string | null;
  sourceAgent: string;
  tokens: number;
  source: 'last-call' | 'history-estimate' | 'empty';
  warmRatio: number;
  outputs: number[];
  calls: number;
  ownAdmitted: boolean;
  lastOutputTokens: number;
  callStatsIncomplete: boolean;
}
export class ModelSwitchCostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ModelSwitchCostError'; }
}
const unavailable = () => new ModelSwitchCostError('MODEL_SWITCH_ESTIMATE_UNAVAILABLE', '暂时无法可靠预估该会话费用，请重试或新建会话');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const count = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Reads small metadata and bounded immutable records; never hydrates a complete tape. */
export async function readSwitchContext(pool: Pool, uid: string, sessionId: string, requestId: string,
  history: { engine: string; contextWindow: number; text: string; targetModel: string },
): Promise<SwitchContext> {
  const owner = `c:${uid}`;
  const row = (await pool.query<{ history_revision: string; timeline_generation: string; has_content: boolean }>(
    `SELECT history_revision::text, timeline_generation::text, messages <> '[]' AS has_content
       FROM client_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, [sessionId, owner])).rows[0];
  const empty: SwitchContext = { revision: 0, fingerprint: digest(['empty', sessionId]), sourceModel: null,
    sourceAgent: 'main', tokens: 0, source: 'empty', warmRatio: 0, outputs: [], calls: 1, ownAdmitted: false, lastOutputTokens:0, callStatsIncomplete:false };
  if (!row) return empty;
  const revision = Number(row.history_revision);
  const tapes = (await pool.query<{ tape_id: string; tape_sha256: string; agent_id: string; status: string; usage: Record<string,unknown> }>(
    `SELECT tape_id,tape_sha256,agent_id,status,usage FROM client_session_turn_tapes
      WHERE session_id=$1 AND user_id=$2 AND finalized_at IS NOT NULL
        AND parent_turn_key IS NULL AND continuation_of_turn_key IS NULL
      ORDER BY created_at DESC,tape_id DESC LIMIT 6`, [sessionId,owner])).rows;
  const root = tapes.find(t => typeof t.usage?.model === 'string');
  if (!root) {
    if (!row.has_content) return { ...empty, revision };
    throw unavailable();
  }
  if (root.usage.model === history.targetModel) return {...empty,revision,sourceModel:root.usage.model as string,sourceAgent:root.agent_id};
  const active = (await pool.query<{ client_message_id: string }>(
    `SELECT client_message_id FROM turn_dispatches WHERE user_id=$1::bigint AND session_id=$2
      AND status <> 'terminal' ORDER BY admitted_at DESC LIMIT 2`, [uid,sessionId])).rows;
  if (active.some(r => r.client_message_id !== requestId)) {
    throw new ModelSwitchCostError('MODEL_SWITCH_BUSY', '请等待当前回合结束后再切换模型');
  }
  const records = (await pool.query<{ ordinal: number; size: string; payload: Buffer | null }>(
    `WITH tail AS (
       SELECT ordinal,payload FROM client_session_turn_tape_records
       WHERE session_id=$1 AND user_id=$2 AND tape_id=$3
         AND role IN ('assistant','thinking','tool','plan','goal')
       ORDER BY ordinal DESC LIMIT 16
     ), sized AS (
       SELECT ordinal,payload,octet_length(payload) AS size,
         sum(octet_length(payload)) OVER (ORDER BY ordinal DESC) AS running FROM tail
     ) SELECT ordinal,size::text,
       CASE WHEN size <= 1048576 AND running <= 8388608 THEN payload ELSE NULL END AS payload
       FROM sized ORDER BY ordinal DESC`, [sessionId,owner,root.tape_id])).rows;
  let tokens: number | null = null, latestId: string | null = null, warmRatio = 0, lastOutputTokens=0;
  const callIds = new Set<string>();
  for (const record of records) {
    if (record.payload === null) { if (tokens === null) break; continue; }
    let message: Record<string,unknown>;
    try { message = JSON.parse(record.payload.toString('utf8')); } catch { throw unavailable(); }
    const call = message._callUsage as { callId?: unknown; usage?: Record<string,unknown> } | undefined;
    if (!call || typeof call.callId !== 'string' || !call.usage) continue;
    const input = count(call.usage.inputTokens), read = count(call.usage.cacheReadTokens ?? 0), write = count(call.usage.cacheCreationTokens ?? 0);
    if (input === null || read === null || write === null) continue;
    callIds.add(call.callId);
    if (tokens === null) {
      tokens = input + read + write;
      if (!Number.isSafeInteger(tokens)) throw unavailable();
      latestId = call.callId;
      lastOutputTokens=count(call.usage.outputTokens) ?? 0;
      warmRatio = tokens ? (read + write) / tokens : 0;
    }
  }
  let source: SwitchContext['source'] = 'last-call';
  if (tokens === null) {
    // This existing reader may backfill old tapes. Only its ready sidecars are
    // eligible here; quote must never start legacy hydration or a migration.
    const incomplete = (await pool.query<{ missing: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM client_session_turn_tape_records r
         WHERE r.session_id=$1 AND r.user_id=$2 AND NOT r.model_sidecar_complete
           AND r.role IN ('assistant','tool','plan','goal','agent-group','error')
       ) OR EXISTS (
         SELECT 1 FROM client_session_user_payloads u WHERE u.session_id=$1 AND u.user_id=$2
           AND u.model_token_estimate IS NULL
       ) AS missing`, [sessionId,owner])).rows[0];
    if (incomplete?.missing || !Number.isSafeInteger(history.contextWindow) || history.contextWindow <= 0) throw unavailable();
    const messages = await getEngineContextMessages(sessionId, owner, { contextWindow: history.contextWindow,
      engine: history.engine, currentUserText: history.text, excludeClientMessageId: requestId });
    if (!messages) throw unavailable();
    tokens = messages.reduce((sum,m) => sum + estimateModelHistoryTokens(modelHistorySemanticText(m)), 0);
    source = 'history-estimate';
  }
  if (!Number.isSafeInteger(tokens) || tokens <= 0) throw unavailable();
  return { revision, sourceModel: root.usage.model as string, sourceAgent: root.agent_id, tokens, source, warmRatio,
    fingerprint: digest([row.timeline_generation,root.tape_id,root.tape_sha256,latestId,tokens]),
    outputs: tapes.filter(t => t.status === 'completed').map(t => count(t.usage.outputTokens)).filter((n): n is number => n !== null).slice(0,5),
    calls: Math.max(1,callIds.size), lastOutputTokens,
    callStatsIncomplete: records.length>=16 || records.some(r=>r.payload===null) || callIds.size===0,
    ownAdmitted: active.some(r => r.client_message_id === requestId) };
}
