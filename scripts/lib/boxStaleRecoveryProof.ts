/** INC-20261030-BOX-STALE-RECOVERY-CLAIM: an admitted recovery failed before
 * delivering new tools, yet its old orphan claim blocked every later turn.
 * Run the real journal and BoxToolFetch over the gate's isolated PostgreSQL
 * tables and Box exec emulator; no production or paid model traffic. */
import type { ReadPdfKit } from "./boxReadPdfProof.js";

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

export async function proveStoppedRecoveryClaim(kit: ReadPdfKit): Promise<string> {
  const { api, db } = kit;
  const journal = api.journal(db);
  const scenarios = ["failed", "unknown", "complete"] as const;
  for (const [index, scenario] of scenarios.entries()) {
    const uid = 900_000_680n + BigInt(index);
    const who = { uid, containerId: 680n + BigInt(index), sessionId: `stale-recovery-${scenario}` };
    const ended = `11111111-1111-4111-8111-${uid.toString().padStart(12, "0")}`;
    const active = `22222222-2222-4222-8222-${uid.toString().padStart(12, "0")}`;
    await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,$2,'unused',10000)",
      [uid.toString(), `${scenario}-stale-recovery@test.invalid`]);
    await db.query("INSERT INTO turn_dispatches VALUES ($1,$3,'terminal'),($2,$3,'running')",
      [ended, active, uid.toString()]);
    const name = `box-stale-admitted-${scenario}`;
    const parked = kit.boxTurn(api, db, journal, who, name, "a".repeat(64), undefined,
      { dispatchId: ended, nextSpool: kit.spoolOf([kit.cliInit, ...kit.FINAL_ANSWER]) });
    await parked.first();
    const parent = `${name}-1`, holder = `${name}-2`, next = `${name}-3`;
    const stopped = await api.stopCoordinator(journal, parked.host.target).requestStop({
      requestId: parent, uid, accountId: who.containerId,
      runNonce: parked.host.runNonce, leaseEpoch: parked.host.leaseEpoch });
    if (stopped !== "stopped_proven") fail(`STALE_RECOVERY_SETUP_STOP_${scenario}`);
    await kit.prechecked(api, db, { ...who, requestId: holder, turnKey: "b".repeat(64), dispatchId: ended });
    if (!await journal.claimOrphanRecovery({ requestId: parent, uid, by: holder })) {
      fail(`STALE_RECOVERY_SETUP_CLAIM_${scenario}`);
    }
    const nonce = String(index + 1).repeat(24), epoch = String(index + 4).repeat(32);
    const proof = scenario === "complete"
      ? { runNonce: nonce, leaseEpoch: epoch, keeperPid: 101, cliPid: 102, reason: "worker_complete", revision: 1 }
      : { runNonce: nonce, leaseEpoch: epoch, keeperPid: 101, cliPid: 102,
        reason: "worker_failed", revision: 2, workerExitCode: 143 };
    await db.query(`UPDATE request_finalize_journal SET state='aborted', ctx=ctx || $2::jsonb
      WHERE request_id=$1`, [holder, JSON.stringify({
        boxSessionId: who.sessionId, boxTurnKey: "b".repeat(64), boxAccountId: who.containerId.toString(),
        boxInvocationMode: "detached_tool",
        boxState: scenario === "unknown" ? "unknown" : "failed_stopped", boxStopOutcome: "failed",
        boxRunNonce: nonce, boxLeaseEpoch: epoch, boxTerminalProof: proof,
        // A fresh history rebuild has a different native CLI UUID from its parent.
        boxNativeSessionId: "11111111-1111-4111-8111-111111111111" })]);
    if (scenario !== "failed") {
      let code = "";
      try { await (await parked.next(next, "c".repeat(64), active)).text(); }
      catch (error) { code = error instanceof Error ? error.message : String(error); }
      if (!code.includes("BOX_RESUME_IN_PROGRESS") || parked.host.count.launch !== 1) {
        fail(`STALE_RECOVERY_UNPROVEN_LAUNCHED_${scenario}_${code}`);
      }
      continue;
    }
    const answer = await kit.must("STALE_RECOVERY_HISTORY_REBUILD",
      parked.next(next, "c".repeat(64), active).then((response: Response) => response.text()));
    if (!answer.includes("done") || parked.host.count.launch !== 2 || parked.host.count.stop !== 1) {
      fail("STALE_RECOVERY_NO_FRESH_ANSWER");
    }
    const original = await kit.journalRow(db, parent), fresh = await kit.journalRow(db, next);
    if (original?.ctx.boxRecoveredBy !== next || fresh?.ctx.boxState !== "terminal") {
      fail("STALE_RECOVERY_CLAIM_NOT_REPLACED");
    }
    const run = `/tmp/ocv5-289-run-${String(fresh.ctx.boxRunNonce)}`;
    const stdin = parked.host.files.get(`${run}/stdin.jsonl`)?.toString("utf8") ?? "";
    const history = ([...parked.host.files] as Array<[string, Buffer]>)
      .filter(([path]) => path.endsWith(".jsonl") && !path.startsWith(run))
      .map(([, raw]) => raw.toString("utf8")).join("\n");
    if (!stdin.includes("Continue from where you left off.") || stdin.includes("toolu_good_1")
      || !history.includes('"tool_use"') || !history.includes('"tool_result"')) {
      fail("STALE_RECOVERY_HISTORY_NOT_PRESERVED");
    }
    let duplicate = "";
    try { await (await parked.next(`${name}-4`, "d".repeat(64), active)).text(); }
    catch (error) { duplicate = error instanceof Error ? error.message : String(error); }
    if (!duplicate.includes("BOX_RESUME_IN_PROGRESS") || parked.host.count.launch !== 2) {
      fail("STALE_RECOVERY_SUCCESS_REPEATED");
    }
  }
  return "[box-stopped-recovery-claim] PASS — a proven stopped recovery yields its claim to one history rebuild; unknown and complete holders stay fenced";
}
