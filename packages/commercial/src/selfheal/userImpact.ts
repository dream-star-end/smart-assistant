/**
 * 用户真实影响证据。只在一个相同 condition 的 active incident 已存在时落库；
 * 没有事故投影就 fail closed，绝不靠“可能受影响”推导收件人。
 */
import { query as realQuery } from "../db/queries.js";
import { redactOpsPayload } from "./redact.js";

interface ImpactFenceState { epoch: number; pending: number }
const impactFences = new Map<string, ImpactFenceState>();
function fenceKey(conditionKey: string, target: string): string { return `${conditionKey}\0${target}`; }
function stateFor(conditionKey: string, target: string): ImpactFenceState {
  const key=fenceKey(conditionKey,target);
  let state=impactFences.get(key);
  if(!state){state={epoch:0,pending:0};impactFences.set(key,state);}
  return state;
}

/** null means an impact INSERT is currently in flight; otherwise the token fences later starts. */
export function captureUserImpactFence(conditionKey: string,target: string): number|null {
  const state=stateFor(conditionKey,target);
  return state.pending===0 ? state.epoch : null;
}
export function isUserImpactFenceCurrent(conditionKey: string,target: string,token: number): boolean {
  const state=stateFor(conditionKey,target);
  return state.pending===0 && state.epoch===token;
}

export interface UserImpactInput {
  conditionKey: string;
  userId: bigint;
  requestId: string;
  target: string;
  failureCode: string;
  detail?: Record<string, unknown>;
}

export async function recordUserImpact(
  input: UserImpactInput,
  query: typeof realQuery = realQuery,
): Promise<boolean> {
  const fence=stateFor(input.conditionKey,input.target);
  fence.pending++;
  fence.epoch++;
  try {
    const result = await query(
    `INSERT INTO selfheal_user_impact_evidence
       (incident_id, policy_id, condition_key, user_id, request_id, target, failure_code, detail)
     SELECT i.id, i.policy_id, i.condition_key, $2::bigint, $3, $4, $5, $6::jsonb
       FROM incidents i
       JOIN incident_policies p ON p.id = i.policy_id
      WHERE i.condition_key = $1
        AND i.status IN ('open','repairing')
        AND p.user_notice_enabled = TRUE
      ORDER BY i.id DESC
      LIMIT 1
     ON CONFLICT (incident_id, user_id, request_id) DO NOTHING`,
    [
      input.conditionKey,
      input.userId.toString(),
      input.requestId.slice(0, 200),
      input.target.slice(0, 200),
      input.failureCode.slice(0, 100),
      JSON.stringify(redactOpsPayload(input.detail ?? {})),
    ],
    );
    return (result.rowCount ?? 0) > 0;
  } finally {
    fence.pending--;
  }
}

/** User responses must never wait for evidence persistence. */
export function recordUserImpactBestEffort(input: UserImpactInput): void {
  void recordUserImpact(input).catch(() => {});
}
