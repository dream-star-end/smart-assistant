/** Release-only synthetic Box executor proofs on the existing PG TEMP fixture.
 * No production/model endpoint is contacted; admission, decode, journal and
 * fallback use the candidate's real APIs loaded by the main gate. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { proveQuotaExhaustion } from "./boxQuotaExhaustionProof.js";
import type { Uid4BoxProofContext } from "../check-v5-box-incident-proofs.js";

function fail(message: string): never { throw new Error(`[uid4-box-proof] ${message}`); }

// INC-20261006-BOX-SYNTHETIC-TURN-HELD (cause of the canary's "snapshot without
// stream" rounds, found 2026-10-06 10:52Z): the Box account's five hour usage
// window was exhausted. The CLI runs without retries, so it streamed no model
// message and wrote its own synthetic assistant record ("You've hit your
// session limit") plus an error result. The decoder called that a snapshot
// violation; the row waited for the cleanup worker and the next message met
// BOX_CAPACITY_HELD. The refusal is one named code, settles unbilled at once
// and the next message is admitted. The spool is the capture from the Box.
export async function proveUpstreamRefusal(ctx: Uid4BoxProofContext): Promise<string> {
  await proveQuotaExhaustion(ctx.candidate, ctx.upstreamModel);
  const { api, db, money, prechecked, boxHost, spoolOf, cliInit, codeOf, journalRow, must } = ctx;
  const MODEL = ctx.model, CLI_MODEL = ctx.upstreamModel, FINAL_ANSWER = ctx.finalAnswer;
  const who = { uid: 900_000_321n, containerId: 321n, sessionId: "session-upstream-refusal" };
  const journal = api.journal(db);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'upstream-refusal@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const before = await money(db, who.uid);
  const turnKey = "7".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-upstream-refusal", turnKey });
  const captured = readFileSync(join(ctx.candidate,
    "packages/commercial/src/http/proxy/__fixtures__/box-cli-upstream-refusal/real-session-limit.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as unknown);
  let stops = 0;
  const host = boxHost(api, spoolOf([cliInit, ...captured]), { real: { journal, ...who,
    requestId: "box-upstream-refusal", turnKey,
    // the CLI finished by itself: its keeper proof says worker_complete
    proofReason: "worker_complete",
    stopRejectedRun: async (identity) => { stops++; return api.stopCoordinator(journal, host.target).requestStop(identity); } } });
  const rejected = await codeOf(host.round);
  if (rejected !== "BOX_CLI_UPSTREAM_RATE_LIMITED") fail(`UPSTREAM_REFUSAL_NOT_NAMED_${rejected}`);
  if (stops !== 1 || host.count.launch !== 1) fail("UPSTREAM_REFUSAL_STOP_OR_LAUNCH_COUNT");
  const row = await journalRow(db, "box-upstream-refusal");
  if (row?.state !== "aborted" || row.failure_code !== "STREAM_FAILED" || row.credits !== "0"
    || row.ctx.boxState !== "failed_stopped" || row.ctx.boxStopOutcome !== "rejected_stream") {
    fail(`UPSTREAM_REFUSAL_ROW_${row?.state}_${String(row?.ctx.boxState)}_${String(row?.ctx.boxStopOutcome)}`);
  }
  if (await money(db, who.uid) !== before) fail("UPSTREAM_REFUSAL_BILLED");
  const idle = await journal.readIdleProof({ ...who, turnKey });
  if (idle.status !== "failed" || !isDeepStrictEqual(idle.requestIds, ["box-upstream-refusal"])) fail(`UPSTREAM_REFUSAL_IDLE_${idle.status}`);
  // CCB's same-request retries (streaming again, then the non-streaming fallback) must not
  // find the settled attempt "still resolving": non-streaming fallback returns its first
  // failure read-only. Two separately admitted exact failures remain fail-closed ambiguous.
  const replayDeps = { journal, readMessage: async () => { throw new Error("NO_MESSAGE"); } };
  const lookupOf = (stream: boolean) => api.findReplay({ uid: who.uid, canonicalModel: MODEL,
    upstreamModel: CLI_MODEL, canonicalBody: { ...host.call.canonicalBody, stream } as never }, replayDeps as never);
  for (const stream of [false, true]) {
    const found = await must(`UPSTREAM_REFUSAL_REPLAY_${stream}`, lookupOf(stream));
    if (stream ? found.kind !== "missing" : found.kind !== "failed"
      || found.failure?.code !== "BOX_CLI_UPSTREAM_RATE_LIMITED") {
      fail(`UPSTREAM_REFUSAL_REPLAY_${stream}_${found.kind}`);
    }
  }
  await prechecked(api, db, { ...who, requestId: "box-upstream-refusal-2", turnKey });
  const again = boxHost(api, spoolOf([cliInit, ...captured]), { real: { journal, ...who,
    requestId: "box-upstream-refusal-2", turnKey, proofReason: "worker_complete",
    stopRejectedRun: async (identity) => api.stopCoordinator(journal, again.target).requestStop(identity) } });
  const secondCode = await codeOf(again.round);
  if (secondCode !== "BOX_CLI_UPSTREAM_RATE_LIMITED") fail(`UPSTREAM_REFUSAL_SECOND_ATTEMPT_${secondCode}`);
  if (await codeOf(() => lookupOf(false)) !== "BOX_CALL_AMBIGUOUS") {
    fail("UPSTREAM_REFUSAL_SECOND_EXACT_FAILURE_NOT_AMBIGUOUS");
  }
  if ((await lookupOf(true)).kind !== "missing") fail("UPSTREAM_REFUSAL_STREAM_REPLAY2");
  const nextKey = "8".repeat(64);
  await prechecked(api, db, { ...who, requestId: "box-upstream-refusal-next", turnKey: nextKey });
  const next = boxHost(api, spoolOf([cliInit, ...FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, requestId: "box-upstream-refusal-next", turnKey: nextKey } });
  const answered = await must("UPSTREAM_REFUSAL_NEXT_MESSAGE", next.round());
  if (answered.kind !== "final" || !next.sse().includes("done")) fail("UPSTREAM_REFUSAL_NEXT_MESSAGE_NO_ANSWER");
  if ((await journalRow(db, "box-upstream-refusal-next"))?.ctx.boxState !== "terminal") fail("UPSTREAM_REFUSAL_NEXT_MESSAGE_NOT_SETTLED");
  return "[inc-20261006-upstream-refusal] PASS — a CLI usage-limit refusal settles unbilled at once, its retries are not seen as still resolving, and the next message runs";
}

/** A 200/SSE response can already exist when decoding the first JSONL fails.
 * Destroying that private spool must not destroy the only useful error. */
export async function proveUid4FirstFailurePreserved(ctx: Uid4BoxProofContext): Promise<string> {
  const { api, db, boxHost, prechecked, journalRow, money, must, codeOf, spoolOf, cliInit } = ctx;
  const who = { uid: 900_001_102n, containerId: 1102n, sessionId: "uid4-first-failure-proof" };
  const requestId = "uid4-first-failure-proof", turnKey = "a1".repeat(32);
  const journal = api.journal(db);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'uid4-first-failure@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const beforeMoney = await money(db, who.uid);
  await prechecked(api, db, { ...who, requestId, turnKey });
  const refusal = { type: "assistant", error: "authentication_failed", is_api_error_message: true,
    message: { model: "<synthetic>", role: "assistant",
      content: [{ type: "text", text: "synthetic private API error body" }] } };
  let stops = 0;
  const host = boxHost(api, spoolOf([cliInit, refusal]), { real: { journal, ...who, requestId, turnKey,
    proofReason: "worker_complete", stopRejectedRun: async (identity) => {
      stops++;
      const evidence = (await journalRow(db, requestId))?.ctx.boxFirstFailure as { code?: string } | undefined;
      if (evidence?.code !== "BOX_CLI_UPSTREAM_REFUSED") fail("FIRST_FAILURE_NOT_DURABLE_BEFORE_STOP");
      return api.stopCoordinator(journal, host.target).requestStop(identity);
    } } });
  const service = api.toolFetch(host.deps);
  const response = await must("FIRST_FAILURE_HEADERS", service.fetch(host.call));
  if (response.status !== 200 || !response.headers.get("content-type")?.includes("text/event-stream")) {
    fail("FIRST_FAILURE_NOT_AFTER_SSE_HEADERS");
  }
  if (await codeOf(() => response.text()) !== "BOX_CLI_UPSTREAM_REFUSED") fail("FIRST_FAILURE_STREAM_CODE");
  const row = await journalRow(db, requestId);
  const first = row?.ctx.boxFirstFailure as { code?: string; diagnostic?: Record<string, unknown> } | undefined;
  if (row?.state !== "aborted" || row.credits !== "0" || row.ctx.boxState !== "failed_stopped"
    || first?.code !== "BOX_CLI_UPSTREAM_REFUSED" || first.diagnostic?.upstreamTag !== "authentication_failed") {
    fail("FIRST_FAILURE_DURABLE_ROW");
  }
  if (JSON.stringify(first).includes("private API error body")) fail("FIRST_FAILURE_STORED_RAW_TEXT");
  host.clearSpool();
  if (host.spoolLength !== 0) fail("FIRST_FAILURE_SPOOL_NOT_CLEARED");
  const beforeLookup = JSON.stringify(row);
  // New instances have none of the request's response/decoder state. Only
  // the real PG journal is available, and no replay capsule is readable.
  const restarted = api.journal(db);
  let capsuleReads = 0;
  const deps = { journal: restarted, readMessage: async () => { capsuleReads++; throw new Error("NO_CAPSULE"); } };
  const fallback = { uid: who.uid, canonicalModel: ctx.model, upstreamModel: ctx.upstreamModel,
    canonicalBody: { ...host.call.canonicalBody, stream: false } };
  for (let i = 0; i < 2; i++) {
    const found = await must("FIRST_FAILURE_RESTART_FALLBACK", api.findReplay(fallback, deps));
    if (found.kind !== "failed" || found.failure?.code !== first.code
      || !isDeepStrictEqual(found.failure.diagnostic, first.diagnostic)) fail("FIRST_FAILURE_FALLBACK_CHANGED");
  }
  if (capsuleReads !== 0 || stops !== 1 || host.count.launch !== 1) fail("FIRST_FAILURE_FALLBACK_RELAUNCHED");
  if (await money(db, who.uid) !== beforeMoney
    || JSON.stringify(await journalRow(db, requestId)) !== beforeLookup) fail("FIRST_FAILURE_FALLBACK_WROTE_OR_BILLED");
  const streamed = await api.findReplay({ ...fallback,
    canonicalBody: { ...fallback.canonicalBody, stream: true } }, deps);
  if (streamed.kind !== "missing") fail("FIRST_FAILURE_STREAM_AUTHORITY_WIDENED");
  return "[uid4-first-failure-preserved] PASS";
}

/** The old byte cursor is ahead of the now-empty spool. A strictly matching
 * worker_failed proof must end that read, not start another Stop/unknown run. */
export async function proveUid4StoppedWorkerConverges(ctx: Uid4BoxProofContext): Promise<string> {
  const { api, db, boxHost, prechecked, journalRow, money, must, spoolOf, cliInit } = ctx;
  const who = { uid: 900_001_103n, containerId: 1103n, sessionId: "uid4-worker-terminal-proof" };
  const requestId = "uid4-worker-terminal-proof", turnKey = "a2".repeat(32), journal = api.journal(db);
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,'uid4-worker-terminal@test.invalid','unused',10000)",
    [who.uid.toString()]);
  const beforeMoney = await money(db, who.uid);
  await prechecked(api, db, { ...who, requestId, turnKey });
  let stops = 0, unknowns = 0;
  const host = boxHost(api, spoolOf([cliInit]), {
    spoolRead: (call) => { if (call === 2) host.clearSpool(); },
    proofRead: () => {},
    real: { journal, ...who, requestId, turnKey, proofReason: "worker_failed", workerExitCode: 17, cleanupSpool: true,
      stopRejectedRun: async () => { stops++; fail("STOPPED_WORKER_SENT_ANOTHER_STOP"); } } });
  const service = api.toolFetch({ ...host.deps, onUnknown: async () => { unknowns++; } });
  const started = Date.now();
  const response = await must("STOPPED_WORKER_HEADERS", service.fetch(host.call));
  if (!response.headers.get("content-type")?.includes("text/event-stream")) fail("STOPPED_WORKER_NO_HEADERS");
  let caught: unknown;
  try { await response.text(); } catch (error) { caught = error; }
  if (!api.isSpoolTerminalError(caught)) fail("STOPPED_WORKER_NOT_TYPED_TERMINAL");
  const terminal = caught as { code: string; accountId: bigint;
    proof: { revision: number; reason: string; workerExitCode: number; runNonce: string; leaseEpoch: string } };
  if (terminal.code !== "BOX_SPOOL_WORKER_FAILED" || terminal.accountId !== host.target.accountId
    || terminal.proof.reason !== "worker_failed" || terminal.proof.revision !== 2
    || terminal.proof.workerExitCode !== 17 || terminal.proof.runNonce !== host.runNonce
    || terminal.proof.leaseEpoch !== host.leaseEpoch) fail("STOPPED_WORKER_TERMINAL_IDENTITY");
  const offsets = host.spoolOffsets;
  const observed = { offsets, proofReads: host.count.proofRead, cleanupCalls: host.count.cleanup,
    elapsedMs: Date.now() - started };
  process.stdout.write(`[uid4-stopped-worker-observed] ${JSON.stringify(observed)}\n`);
  if (offsets.length !== 3 || offsets[0] !== 0 || offsets[1]! <= 0 || offsets[2] !== offsets[1]
    || host.count.proofRead !== 1 || host.count.cleanup !== 1 || observed.elapsedMs >= 5_000) {
    fail(`STOPPED_WORKER_EMPTY_CURSOR_DID_NOT_CONVERGE_${JSON.stringify(observed)}`);
  }
  const row = await journalRow(db, requestId);
  const first = row?.ctx.boxFirstFailure as { code?: string } | undefined;
  if (first?.code !== "BOX_SPOOL_WORKER_FAILED" || row?.ctx.boxState !== "failed_stopped" || row.state !== "aborted"
    || row.credits !== "0" || row.ctx.boxRemoteCleanup !== "done" || !host.disposed
    || stops !== 0 || unknowns !== 0 || host.count.stop !== 0 || host.count.launch !== 1 || host.count.pendingRead !== 0
    || host.sequence.some((item) => item.startsWith("unknown:"))) fail("STOPPED_WORKER_RESTOPPED_OR_UNKNOWN");
  if (await money(db, who.uid) !== beforeMoney) fail("STOPPED_WORKER_BILLED");
  return "[uid4-stopped-worker-stream-converges] PASS";
}
