import type { Pool, PoolClient } from "pg";

export const VERIFICATION_MODELS = ["deepseek-v4-flash", "gpt-5.6-luna"] as const;
export type VerificationModel = (typeof VERIFICATION_MODELS)[number];

export interface VerificationSponsorshipSnapshot {
  requestId: string;
  runId: string;
  userId: bigint;
  model: VerificationModel;
  sessionId: string;
  releaseId: string;
  generation: bigint;
}

export function isVerificationModel(model: string): model is VerificationModel {
  return (VERIFICATION_MODELS as readonly string[]).includes(model);
}

export function parseVerificationSponsorshipSnapshot(
  value: unknown,
): VerificationSponsorshipSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (
    typeof o.requestId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(o.requestId) ||
    typeof o.runId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(o.runId) ||
    typeof o.userId !== "string" || !/^[1-9][0-9]{0,19}$/.test(o.userId) ||
    typeof o.model !== "string" || !isVerificationModel(o.model) ||
    typeof o.sessionId !== "string" || o.sessionId.length === 0 || o.sessionId.length > 256 ||
    typeof o.releaseId !== "string" || o.releaseId.length === 0 || o.releaseId.length > 512 ||
    typeof o.generation !== "string" || !/^[1-9][0-9]*$/.test(o.generation)
  ) return null;
  return {
    requestId: o.requestId,
    runId: o.runId,
    userId: BigInt(o.userId),
    model: o.model,
    sessionId: o.sessionId,
    releaseId: o.releaseId,
    generation: BigInt(o.generation),
  };
}

export function serializeVerificationSponsorshipSnapshot(
  snapshot: VerificationSponsorshipSnapshot,
): Record<string, string> {
  return {
    requestId: snapshot.requestId,
    runId: snapshot.runId,
    userId: snapshot.userId.toString(),
    model: snapshot.model,
    sessionId: snapshot.sessionId,
    releaseId: snapshot.releaseId,
    generation: snapshot.generation.toString(),
  };
}

interface AdmissionRow {
  run_id: string;
  release_id: string;
  generation: string;
  session_prefix: string;
}

/**
 * Persist an immutable sponsorship decision before any provider work starts.
 * Absence/mismatch means ordinary billing. Database errors propagate: inability
 * to prove sponsorship must never be converted into a free request.
 */
export async function admitVerificationSponsorship(
  pool: Pool,
  input: {
    requestId: string;
    userId: bigint;
    model: string;
    sessionId: string | null;
  },
): Promise<VerificationSponsorshipSnapshot | null> {
  if (
    !isVerificationModel(input.model) ||
    input.sessionId === null ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId)
  ) return null;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<AdmissionRow>(
      `SELECT vr.id::text AS run_id,
              CASE
                WHEN ds.phase IN ('canary','finalizing') AND ds.candidate_release=vr.expected_release
                  THEN ds.candidate_release
                WHEN ds.active_release=vr.expected_release THEN ds.active_release
                ELSE NULL
              END AS release_id,
              ds.generation::text AS generation,
              vr.session_prefix
         FROM verification_runs vr
         CROSS JOIN deploy_state ds
        WHERE ds.singleton=true
          AND vr.status='active'
          AND vr.expires_at > NOW()
          AND vr.user_id=$1
          AND $2 = ANY(vr.allowed_models)
          AND $3 LIKE vr.session_prefix || '%'
          AND vr.token_hash=encode(public.digest(convert_to(vr.session_prefix,'UTF8'),'sha256'),'hex')
          AND vr.expected_generation=ds.generation
          AND vr.expected_release = CASE
                WHEN ds.phase IN ('canary','finalizing') AND ds.candidate_release=vr.expected_release
                  THEN ds.candidate_release
                WHEN ds.active_release=vr.expected_release THEN ds.active_release
                ELSE NULL
              END
        ORDER BY vr.expires_at DESC
        LIMIT 1
        FOR UPDATE OF vr`,
      [input.userId.toString(), input.model, input.sessionId],
    );
    const row = found.rows[0];
    if (!row?.release_id) {
      await client.query("ROLLBACK");
      return null;
    }

    await client.query(
      `INSERT INTO verification_sponsored_requests
         (request_id,run_id,user_id,model,session_id,release_id,generation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        input.requestId,
        row.run_id,
        input.userId.toString(),
        input.model,
        input.sessionId,
        row.release_id,
        row.generation,
      ],
    );
    const exact = await client.query<{
      run_id: string; user_id: string; model: string; session_id: string; release_id: string; generation: string;
    }>(
      `SELECT run_id::text,user_id::text,model,session_id,release_id,generation::text
         FROM verification_sponsored_requests
        WHERE request_id=$1`,
      [input.requestId],
    );
    const admitted = exact.rows[0];
    const matches = admitted !== undefined &&
      admitted.run_id === row.run_id &&
      admitted.user_id === input.userId.toString() &&
      admitted.model === input.model &&
      admitted.session_id === input.sessionId &&
      admitted.release_id === row.release_id &&
      admitted.generation === row.generation;
    if (!matches) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("COMMIT");
    return {
      requestId: input.requestId,
      runId: row.run_id,
      userId: input.userId,
      model: input.model,
      sessionId: input.sessionId,
      releaseId: row.release_id,
      generation: BigInt(row.generation),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Re-check the immutable admission row inside the usage/ledger transaction. */
export async function verifySponsorshipForSettlement(
  client: PoolClient,
  snapshot: VerificationSponsorshipSnapshot | null | undefined,
): Promise<boolean> {
  if (!snapshot) return false;
  const row = await client.query(
    `SELECT 1
       FROM verification_sponsored_requests
      WHERE request_id=$1 AND run_id=$2 AND user_id=$3 AND model=$4
        AND session_id=$5 AND release_id=$6 AND generation=$7
      FOR SHARE`,
    [
      snapshot.requestId,
      snapshot.runId,
      snapshot.userId.toString(),
      snapshot.model,
      snapshot.sessionId,
      snapshot.releaseId,
      snapshot.generation.toString(),
    ],
  );
  return (row.rowCount ?? 0) === 1;
}
