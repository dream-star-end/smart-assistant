/** Pure durable rollover identity. No journal, billing or runtime imports. */
import { BOX_API_MODELS } from "@openclaude/protocol";
import { BOX_TOOL_MAX_ROUNDS } from "./boxToolLimits.js";
type Hash = { modelToolUseId: string; contentHash: string; isError: boolean };
export interface BoxToolRolloverReceipt {
  v: 1; requestId: string; ownerRequestId: string; accountId: string; runNonce: string;
  leaseEpoch: string; durableRevision: string; reason: "rounds"|"wall"|"spool";
  sessionId: string; turnKey: string; model: string; nextContextHash: string;
  resultHashes: readonly Hash[]; roundNo: number; catalogHash: string; detachedRunnerHash: string;
}
export interface BoxToolRolloverClaim extends Omit<BoxToolRolloverReceipt,"accountId"> { accountId: bigint }
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const HEX64 = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECEIPT_KEYS = ["accountId","catalogHash","detachedRunnerHash","durableRevision","leaseEpoch",
  "model","nextContextHash","ownerRequestId","reason","requestId","resultHashes","roundNo",
  "runNonce","sessionId","turnKey","v"] as const;
const STRING_KEYS = RECEIPT_KEYS.filter((key) => !["v","roundNo","resultHashes"].includes(key));
export function parseToolRollover(raw: unknown): BoxToolRolloverReceipt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as BoxToolRolloverReceipt;
  if (Object.keys(r).sort().join(",") !== RECEIPT_KEYS.join(",")
    || STRING_KEYS.some((key) => typeof r[key] !== "string")
    || r.v !== 1 || !ID.test(r.requestId) || !ID.test(r.ownerRequestId)
    || !/^[1-9][0-9]{0,19}$/.test(r.accountId) || !/^[a-f0-9]{24}$/.test(r.runNonce)
    || !/^[a-f0-9]{32}$/.test(r.leaseEpoch) || !UUID.test(r.durableRevision)
    || !["rounds","wall","spool"].includes(r.reason)
    || !/^[A-Za-z0-9._:-]{1,256}$/.test(r.sessionId) || !HEX64.test(r.turnKey)
    || typeof r.model !== "string" || !HEX64.test(r.nextContextHash)
    || !HEX64.test(r.catalogHash) || !HEX64.test(r.detachedRunnerHash)
    || !Number.isSafeInteger(r.roundNo) || r.roundNo < 1 || r.roundNo > BOX_TOOL_MAX_ROUNDS
    || !Array.isArray(r.resultHashes) || r.resultHashes.length < 1 || r.resultHashes.length > 32
    || Array.from({ length: r.resultHashes.length },(_,i) => i).some((i) => !Object.hasOwn(r.resultHashes,i))
    || r.resultHashes.some((h) => !h || Object.keys(h).sort().join(",") !== "contentHash,isError,modelToolUseId"
      || typeof h.modelToolUseId !== "string" || typeof h.contentHash !== "string"
      || !/^toolu_[A-Za-z0-9_-]{1,120}$/.test(h.modelToolUseId) || !HEX64.test(h.contentHash)
      || typeof h.isError !== "boolean")
    || new Set(r.resultHashes.map((h) => h.modelToolUseId)).size !== r.resultHashes.length) return null;
  return r;
}
export const UNADMITTED_KEYS = ["boxRunNonce","boxLeaseEpoch","boxAccountId","boxInvocationMode",
  "boxLaunchPermit","boxPrelaunchControl","boxTerminalProof","boxOwnerRequestId",
  "boxResumeRequestId","boxReplayMessage","boxUsage","settlementClaimId"] as const;
/** Exact durable identity of a successor that never crossed admission. */
export function unadmittedToolRollover(ctx: Record<string,unknown>, requestId: string): BoxToolRolloverReceipt | null {
  const receipt = parseToolRollover(ctx.boxRolloverFrom);
  return receipt && receipt.requestId === requestId && ctx.boxInvocationRecovery === "v1"
    && receipt.model === ctx.model && receipt.sessionId === ctx.boxSessionId && receipt.turnKey === ctx.boxTurnKey
    && (ctx.boxState === undefined || ctx.boxState === "prestart_stopped" && ctx.boxRolloverCancelled === true)
    && !UNADMITTED_KEYS.some((key) => Object.hasOwn(ctx,key)) ? receipt : null;
}

/** Constant SQL expressions supplied only by the journal/abort implementation. */
export function unadmittedToolRolloverFieldsSql(ctx = "ctx"): string {
  return `NOT (${ctx} ?| ARRAY[${UNADMITTED_KEYS.map((key) => `'${key}'`).join(",")}])`;
}
/** Same complete receipt/never-admit shape as the JS validator. CASE bounds
 * array work and rejects malformed JSON without throwing from an abort CAS. */
export function unadmittedToolRolloverSql(ctx = "ctx", requestId = "request_id"): string {
  const r = `(${ctx}->'boxRolloverFrom')`;
  const hashes = `(${r}->'resultHashes')`;
  const keys = RECEIPT_KEYS.map((key) => `'${key}'`).join(",");
  const strings = STRING_KEYS.map((key) => `jsonb_typeof(${r}->'${key}')='string'`).join(" AND ");
  const models = BOX_API_MODELS.map((model) => `'${model.id}'`).join(",");
  return `(CASE WHEN jsonb_typeof(${r})='object' AND jsonb_typeof(${hashes})='array'
    THEN CASE WHEN jsonb_array_length(${hashes}) BETWEEN 1 AND 32 THEN COALESCE((
      ${r} ?& ARRAY[${keys}] AND ${r}-ARRAY[${keys}]='{}'::jsonb AND ${strings}
      AND ${r}->'v'='1'::jsonb AND jsonb_typeof(${r}->'roundNo')='number'
      AND CASE WHEN ${r}->>'roundNo' ~ '^[0-9]{1,3}$'
        THEN (${r}->>'roundNo')::int BETWEEN 1 AND ${BOX_TOOL_MAX_ROUNDS} ELSE false END
      AND ${r}->>'requestId' ~ '^[A-Za-z0-9_-]{1,64}$'
      AND ${r}->>'ownerRequestId' ~ '^[A-Za-z0-9_-]{1,64}$'
      AND ${r}->>'accountId' ~ '^[1-9][0-9]{0,19}$'
      AND ${r}->>'runNonce' ~ '^[a-f0-9]{24}$' AND ${r}->>'leaseEpoch' ~ '^[a-f0-9]{32}$'
      AND ${r}->>'durableRevision' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      AND ${r}->>'reason' IN ('rounds','wall','spool')
      AND ${r}->>'sessionId' ~ '^[A-Za-z0-9._:-]+$'
      AND char_length(${r}->>'sessionId') BETWEEN 1 AND 256
      AND ${["turnKey","nextContextHash","catalogHash","detachedRunnerHash"].map((key) => `${r}->>'${key}' ~ '^[a-f0-9]{64}$'`).join(" AND ")}
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(${hashes}) entry(value)
        WHERE NOT (CASE WHEN jsonb_typeof(entry.value)='object' THEN COALESCE((
          entry.value ?& ARRAY['modelToolUseId','contentHash','isError']
          AND entry.value-ARRAY['modelToolUseId','contentHash','isError']='{}'::jsonb
          AND jsonb_typeof(entry.value->'modelToolUseId')='string'
          AND jsonb_typeof(entry.value->'contentHash')='string'
          AND jsonb_typeof(entry.value->'isError')='boolean'
          AND entry.value->>'modelToolUseId' ~ '^toolu_[A-Za-z0-9_-]{1,120}$'
          AND entry.value->>'contentHash' ~ '^[a-f0-9]{64}$'),false) ELSE false END))
      AND (SELECT COUNT(DISTINCT entry.value->>'modelToolUseId') FROM jsonb_array_elements(${hashes}) entry(value))=jsonb_array_length(${hashes})
      AND ${ctx}->>'boxInvocationRecovery'='v1' AND ${ctx}->>'model' IN (${models})
      AND ${r}->>'requestId'=${requestId} AND ${r}->>'model'=${ctx}->>'model'
      AND ${r}->>'sessionId'=${ctx}->>'boxSessionId' AND ${r}->>'turnKey'=${ctx}->>'boxTurnKey'
      AND (NOT (${ctx} ? 'boxState') OR (${ctx}->>'boxState'='prestart_stopped'
        AND ${ctx}->'boxRolloverCancelled'='true'::jsonb))
      AND ${unadmittedToolRolloverFieldsSql(ctx)}),false) ELSE false END ELSE false END)`;
}
