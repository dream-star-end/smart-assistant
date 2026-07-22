// Fixed live matrix proof: the selected engine must finish a real durable turn, persist the exact
// model, finalize its tape/dispatch, and settle through the release-bound v5-evals sponsorship.

import { expect, test } from '../fixtures';
import { config, mintSessionId } from '../lib/env';
import { queryScalar } from '../lib/pg';
import { pollUntil } from '../lib/poll';
import { driveTurn } from '../lib/ws';

type Evidence = {
  request_id: string;
  model: string;
  usage_session_id: string;
  dispatch_id: string;
  attempt_no: number;
  cost: string;
  nominal: string;
  run_id: string;
  dispatch_status: string;
  outcome: string;
  finalized: boolean;
  remaining_parts: number;
};

function sqlText(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

test('@release-gate fixed model route + durable terminal + sponsored billing evidence', async ({
  api,
  token,
  track,
}) => {
  const cfg = config();
  const sid = mintSessionId('billing');
  const userId = await api.currentUserId(token);
  track(sid);

  const put = await api.putSession(token, sid, {
    title: `e2e-billing-${cfg.model}-${Date.now().toString(36)}`,
    model: cfg.model,
  });
  expect(put.ok, `putSession failed: ${put.status} ${put.text.slice(0, 160)}`).toBeTruthy();
  const usageIdBefore = queryScalar(
    `SELECT COALESCE(max(id),0)::text FROM usage_records WHERE user_id=${userId}`,
  );

  track(sid, { expectTurn: true });
  const turn = await driveTurn({
    token,
    sessionId: sid,
    model: cfg.model,
    text: `verification-${Date.now().toString(36)} reply exactly OK`,
  });
  expect(turn.errors, `turn errors: ${turn.errors.join(' | ')}`).toHaveLength(0);
  expect(turn.sawFinal, `turn did not finalize (endedBy=${turn.endedBy})`).toBeTruthy();
  expect(turn.sawText, 'turn must contain a real assistant response').toBeTruthy();

  const evidence = await pollUntil<Evidence>(
    async () => {
      const raw = queryScalar(`
        SELECT COALESCE((
          SELECT json_build_object(
            'request_id',ur.request_id,
            'model',ur.model,
            'usage_session_id',ur.session_id,
            'dispatch_id',ur.dispatch_id::text,
            'attempt_no',ur.attempt_no,
            'cost',ur.cost_credits::text,
            'nominal',ur.would_have_cost_credits::text,
            'run_id',ur.verification_run_id::text,
            'dispatch_status',d.status,
            'outcome',d.outcome,
            'finalized',(t.finalized_at IS NOT NULL),
            'remaining_parts',(SELECT count(*) FROM client_session_turn_tape_parts p
                                WHERE p.session_id=t.session_id AND p.user_id=t.user_id AND p.tape_id=t.tape_id)
          )::text
          FROM usage_records ur
          JOIN turn_dispatches d ON d.dispatch_id=ur.dispatch_id
          JOIN client_session_turn_tapes t ON t.dispatch_id=d.dispatch_id AND t.attempt_no=d.attempt_no
          WHERE ur.user_id=${userId} AND d.session_id=${sqlText(sid)}
            AND ur.model=${sqlText(cfg.model)} AND ur.verification_run_id IS NOT NULL
          ORDER BY ur.id DESC LIMIT 1
        ),'')
      `);
      return raw ? (JSON.parse(raw) as Evidence) : null;
    },
    { timeoutMs: 30_000, intervalMs: 500, label: 'sponsored usage + durable tape evidence' },
  );

  expect(evidence.model).toBe(cfg.model);
  expect(evidence.request_id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  expect(evidence.usage_session_id).toBe(sid);
  expect(evidence.dispatch_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(evidence.attempt_no).toBeGreaterThanOrEqual(1);
  expect(evidence.cost).toBe('0');
  expect(BigInt(evidence.nominal), 'nominal cost must remain auditable').toBeGreaterThan(0n);
  expect(evidence.run_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(evidence.dispatch_status).toBe('terminal');
  expect(evidence.outcome).toBe('completed');
  expect(evidence.finalized).toBeTruthy();
  expect(evidence.remaining_parts).toBe(0);
  const unbound = queryScalar(`
    SELECT count(*)::text FROM usage_records
     WHERE id>${usageIdBefore} AND user_id=${userId} AND model=${sqlText(cfg.model)}
       AND (verification_run_id IS NULL OR dispatch_id IS NULL OR attempt_no IS NULL)
  `);
  expect(unbound, '本轮之后不得出现未赞助或未绑定 dispatch 的固定模型 usage').toBe('0');
});
