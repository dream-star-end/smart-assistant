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

export interface VerificationDispatchIdentity {
  dispatchId: string;
  attemptNo: number;
  sessionId: string;
}

export interface AuthorityTurnDispatchBinding {
  authorityTurnId: string;
  userId: bigint;
  model: string;
  sessionId: string;
  dispatchId: string;
  attemptNo: number;
}

export type VerificationLeaseAdmission =
  | { kind: "missing" }
  | { kind: "ineligible"; dispatchIdentity: VerificationDispatchIdentity; reason: string }
  | { kind: "conflict"; reason: string }
  | {
      kind: "admitted";
      sponsorship: VerificationSponsorshipSnapshot;
      dispatchIdentity: VerificationDispatchIdentity;
    };

export class VerificationSponsorshipInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VerificationSponsorshipInvariantError";
  }
}

interface TurnDispatchAdmissionRow {
  user_id: string;
  session_id: string;
  model: string | null;
  attempt_no: number;
  status: string;
  owner_id: string | null;
  lease_epoch: string;
  lease_until: Date | null;
}

interface AuthorityTurnDispatchRow {
  authority_turn_id: string;
  user_id: string;
  dispatch_model: string | null;
  canonical_model: string;
  session_id: string;
  dispatch_id: string;
  attempt_no: number;
  dispatch_user_id?: string;
  dispatch_session_id?: string;
  row_dispatch_model?: string | null;
  dispatch_attempt_no?: number;
}

async function findActiveRun(
  client: PoolClient,
  input: { userId: bigint; model: VerificationModel; sessionId: string },
  lock: "update" | "share",
): Promise<AdmissionRow | null> {
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
      FOR ${lock === "update" ? "UPDATE" : "SHARE"} OF vr`,
    [input.userId.toString(), input.model, input.sessionId],
  );
  const row = found.rows[0];
  return row?.release_id ? row : null;
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
    const row = await findActiveRun(client, {
      userId: input.userId,
      model: input.model,
      sessionId: input.sessionId,
    }, "update");
    if (row === null) {
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

/**
 * Before a CCB frame reaches the runtime, bind its freshly minted signed turn id to the exact
 * durable dispatch row held by this bridge.  All persisted identity fields come from the locked
 * database row; caller values are only equality fences against stale or miswired bridge state.
 */
export async function bindAuthorityTurnDispatch(
  pool: Pool,
  input: {
    authorityTurnId: string;
    dispatchId: string;
    userId: bigint;
    sessionId: string;
    dispatchModel: string | null;
    canonicalModel: string;
    attemptNo: number;
    ownerId: string;
    leaseEpoch: number;
  },
): Promise<AuthorityTurnDispatchBinding> {
  if (
    !/^[0-9a-f]{32}$/.test(input.authorityTurnId) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.dispatchId) ||
    (input.dispatchModel !== null && !/^[A-Za-z0-9._-]{1,64}$/.test(input.dispatchModel)) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(input.canonicalModel) ||
    input.sessionId.length === 0 || input.sessionId.length > 256 ||
    !Number.isInteger(input.attemptNo) || input.attemptNo < 1 ||
    input.ownerId.length === 0 ||
    !Number.isSafeInteger(input.leaseEpoch) || input.leaseEpoch < 0
  ) {
    throw new VerificationSponsorshipInvariantError("invalid authority turn dispatch identity");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const dispatch = await client.query<TurnDispatchAdmissionRow>(
      `SELECT user_id::text,session_id,model,attempt_no,status,owner_id,
              lease_epoch::text,lease_until
         FROM turn_dispatches
        WHERE dispatch_id=$1
        FOR UPDATE`,
      [input.dispatchId],
    );
    const d = dispatch.rows[0];
    const dispatchMatches = d !== undefined &&
      d.user_id === input.userId.toString() &&
      d.session_id === input.sessionId &&
      d.model === input.dispatchModel &&
      d.attempt_no === input.attemptNo &&
      d.status === "admitted" &&
      d.owner_id === input.ownerId &&
      d.lease_epoch === String(input.leaseEpoch) &&
      d.lease_until !== null && d.lease_until.getTime() > Date.now();
    if (!dispatchMatches) {
      throw new VerificationSponsorshipInvariantError("authority turn dispatch identity mismatch");
    }

    await client.query(
      `INSERT INTO authority_turn_dispatches
         (authority_turn_id,user_id,dispatch_model,canonical_model,session_id,dispatch_id,attempt_no)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT DO NOTHING`,
      [
        input.authorityTurnId,
        d.user_id,
        d.model,
        input.canonicalModel,
        d.session_id,
        input.dispatchId,
        d.attempt_no,
      ],
    );
    const exact = await client.query<AuthorityTurnDispatchRow>(
      `SELECT authority_turn_id,user_id::text,dispatch_model,canonical_model,session_id,
              dispatch_id::text,attempt_no
         FROM authority_turn_dispatches
        WHERE authority_turn_id=$1 OR (dispatch_id=$2 AND attempt_no=$3)
        ORDER BY authority_turn_id`,
      [input.authorityTurnId, input.dispatchId, d.attempt_no],
    );
    const admitted = exact.rows[0];
    const exactMatch = exact.rows.length === 1 && admitted !== undefined &&
      admitted.authority_turn_id === input.authorityTurnId &&
      admitted.user_id === d.user_id &&
      admitted.dispatch_model === d.model &&
      admitted.canonical_model === input.canonicalModel &&
      admitted.session_id === d.session_id &&
      admitted.dispatch_id === input.dispatchId &&
      admitted.attempt_no === d.attempt_no;
    if (!exactMatch) {
      throw new VerificationSponsorshipInvariantError("authority turn dispatch mapping conflict");
    }

    await client.query("COMMIT");
    return {
      authorityTurnId: input.authorityTurnId,
      userId: BigInt(d.user_id),
      model: input.canonicalModel,
      sessionId: d.session_id,
      dispatchId: input.dispatchId,
      attemptNo: d.attempt_no,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resolve a verified lease-only upstream request through the immutable turn mapping.  Every
 * mapped CCB request recovers its durable dispatch identity; only the fixed validation models in
 * a currently active release run additionally receive verification sponsorship.
 */
export async function resolveAuthorityTurnDispatchSponsorship(
  pool: Pool,
  input: {
    requestId: string;
    userId: bigint;
    model: string;
    canonicalModel: string;
    authorityTurnId: string;
  },
): Promise<VerificationLeaseAdmission> {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(input.requestId) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(input.model) ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(input.canonicalModel) ||
    !/^[0-9a-f]{32}$/.test(input.authorityTurnId)
  ) return { kind: "missing" };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const mapped = await client.query<AuthorityTurnDispatchRow>(
      `SELECT atd.authority_turn_id,atd.user_id::text,atd.dispatch_model,
              atd.canonical_model,atd.session_id,
              atd.dispatch_id::text,atd.attempt_no,d.user_id::text AS dispatch_user_id,
              d.session_id AS dispatch_session_id,d.model AS row_dispatch_model,
              d.attempt_no AS dispatch_attempt_no
         FROM authority_turn_dispatches atd
         JOIN turn_dispatches d ON d.dispatch_id=atd.dispatch_id
        WHERE atd.authority_turn_id=$1
        FOR SHARE OF atd,d`,
      [input.authorityTurnId],
    );
    const turn = mapped.rows[0];
    if (turn === undefined) {
      await client.query("ROLLBACK");
      return { kind: "missing" };
    }
    const identityMatches = turn.user_id === input.userId.toString() &&
      turn.canonical_model === input.canonicalModel &&
      turn.dispatch_user_id === turn.user_id &&
      turn.dispatch_session_id === turn.session_id &&
      turn.row_dispatch_model === turn.dispatch_model &&
      turn.dispatch_attempt_no === turn.attempt_no;
    if (!identityMatches) {
      await client.query("ROLLBACK");
      return { kind: "conflict", reason: "authority turn dispatch identity mismatch" };
    }
    const dispatchIdentity = {
      dispatchId: turn.dispatch_id,
      attemptNo: turn.attempt_no,
      sessionId: turn.session_id,
    };

    // The authority gate separately proves canonical/aux allowlisting.  Sponsorship is narrower:
    // it applies only when the actual request is the fixed validation model and is also the
    // durable turn's canonical model, so a Pro turn cannot sponsor a Flash auxiliary request.
    if (!isVerificationModel(input.model) || turn.canonical_model !== input.model) {
      await client.query("ROLLBACK");
      return { kind: "ineligible", dispatchIdentity, reason: "request is not a canonical verification model" };
    }

    const run = await findActiveRun(client, {
      userId: BigInt(turn.user_id),
      model: input.model,
      sessionId: turn.session_id,
    }, "share");
    if (run === null) {
      await client.query("ROLLBACK");
      return { kind: "ineligible", dispatchIdentity, reason: "verification run is not active" };
    }

    await client.query(
      `INSERT INTO verification_sponsored_requests
         (request_id,run_id,user_id,model,session_id,release_id,generation)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (request_id) DO NOTHING`,
      [
        input.requestId,
        run.run_id,
        turn.user_id,
        input.model,
        turn.session_id,
        run.release_id,
        run.generation,
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
    const request = exact.rows[0];
    const requestMatches = request !== undefined &&
      request.run_id === run.run_id &&
      request.user_id === turn.user_id &&
      request.model === input.model &&
      request.session_id === turn.session_id &&
      request.release_id === run.release_id &&
      request.generation === run.generation;
    if (!requestMatches) {
      await client.query("ROLLBACK");
      return { kind: "conflict", reason: "verification request mapping conflict" };
    }

    await client.query("COMMIT");
    return {
      kind: "admitted",
      dispatchIdentity,
      sponsorship: {
        requestId: input.requestId,
        runId: run.run_id,
        userId: BigInt(turn.user_id),
        model: input.model,
        sessionId: turn.session_id,
        releaseId: run.release_id,
        generation: BigInt(run.generation),
      },
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
