// OCV5-762 Box incident proof, kept out of scripts/check-v5-box-incident-proofs.ts to keep it inside the
// file-size ratchet (same split as scripts/lib/boxCapacityHeldProof.ts). The poller reads through the
// candidate's real BoxExecTransport; the turn runs through the real BoxToolFetch, journal and stop
// coordinator on the gate's isolated PostgreSQL tables and Box exec emulator. No paid model traffic.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function fail(message: string): never {
  throw new Error(`[box-incident-proofs] ${message}`);
}

function frame(value: unknown, flag = 0): Buffer {
  const raw = Buffer.from(JSON.stringify(value));
  const out = Buffer.alloc(5 + raw.length);
  out[0] = flag;
  out.writeUInt32BE(raw.length, 1);
  raw.copy(out, 5);
  return out;
}

// the gate passes its own untyped fixture helpers (same as ReadPdfKit)
type Any = any;
export type Exec417Kit = {
  api: Any; db: Any;
  boxTurn: (...args: Any[]) => Any;
  boxHost: (...args: Any[]) => Any;
  prechecked: (api: Any, db: Any, row: Record<string, unknown>) => Promise<unknown>;
  journalRow: (db: Any, requestId: string) => Promise<Any>;
  must: <T>(label: string, pending: Promise<T>) => Promise<T>;
  codeOf: (run: () => Promise<unknown>) => Promise<string>;
  spoolOf: (records: unknown[]) => Buffer;
  cliInit: unknown;
  FINAL_ANSWER: unknown[];
  BRIDGE_CALL: unknown[];
};

const STALE = { execUrl: "https://box1.ocv5-762.test/agent.v1.ControlService/Exec",
  execToken: "proof-stale-exec-token", networkToken: "proof-stale-network-token" };
const FRESH = { execUrl: "https://box2.ocv5-762.test/agent.v1.ControlService/Exec",
  execToken: "proof-fresh-exec-token", networkToken: "proof-fresh-network-token" };

/** INC-20261112-BOX-EXEC-417-WEDGE (commercial uid 4, account 79 / account4-pool, session webmwdheg4p7lfe68):
 * 14 tool rounds of one turn succeeded, then at 19:53:39 CST (journal 4f46065f) Cursor's Exec gateway answered
 * one spool read of the continuation with HTTP 417 and the turn ended. The run kept the session's Box slot:
 * the retry got 409 BOX_CAPACITY_HELD, a new message ran 5.5 minutes and hit 417 again (20:03:40, journal
 * 5bc4629d, first round), and its retry got BOX_RESUME_IN_PROGRESS. Now one 417 is read again on a refreshed
 * descriptor, and a round still refused after that is stopped at once so the next message runs. */
export async function proveExec417Released(kit: Exec417Kit, candidate: string): Promise<string> {
  const load = (rel: string) => import(pathToFileURL(join(candidate, rel)).href);
  const { BoxExecTransport } = await load("packages/commercial/src/http/proxy/boxExecTransport.ts");
  const { pollBoxSpoolLines } = await load("packages/commercial/src/http/proxy/boxSpoolPoller.ts");
  const { makeBoxDetachedRunAccess } = await load("packages/commercial/src/http/proxy/boxDetachedRunAccess.ts");
  const line = Buffer.from('{"type":"assistant"}\n', "utf8");
  const refusal = JSON.stringify({ code: "failed_precondition", message: "exec expectation failed",
    detail: `Bearer ${STALE.execToken} ${STALE.networkToken}` });

  // 1. the spool read itself, through the real transport: one 417, then the fresh descriptor
  const reader = (answer: (post: number, auth: string) => "refuse" | "read", refresh: () => Promise<unknown>) => {
    const seen = { posts: 0, refreshes: 0, offsets: [] as number[], auth: [] as string[], excerpts: [] as string[] };
    const exec = new BoxExecTransport(STALE, async (_url: string, init: RequestInit) => {
      const auth = String((init.headers as Record<string, string>).authorization);
      const request = JSON.parse(Buffer.from(init.body as Uint8Array).subarray(5).toString("utf8")) as { args: string[] };
      const offset = Number(request.args[7]);
      seen.posts++; seen.offsets.push(offset); seen.auth.push(auth);
      if (answer(seen.posts, auth) === "refuse") return new Response(refusal, { status: 417 });
      const bytes = offset === 7 ? line : Buffer.alloc(0);
      const stdout = JSON.stringify({ data: bytes.toString("base64"), offset: offset + bytes.length });
      return new Response(Buffer.concat([frame({ stdoutEvent: { data: stdout } }), frame({ exitEvent: {} }),
        frame({}, 2)]), { status: 200 });
    }, async () => {}, { refreshTarget: async () => { seen.refreshes++; return refresh(); },
      onRejected: (rejection: { excerpt: string }) => { seen.excerpts.push(rejection.excerpt); } });
    const lines = pollBoxSpoolLines({ exec, access: makeBoxDetachedRunAccess({ runNonce: "a".repeat(24),
      detachedRunnerHash: "b".repeat(64) }), startOffset: 7, deadlineMs: 5000, pollIntervalMs: 1, retryDelaysMs: [1, 1] });
    return { seen, lines };
  };
  const once = reader((post) => post === 1 ? "refuse" : "read", async () => FRESH);
  const first = await once.lines.next().catch((error: unknown) =>
    fail(`EXEC417_READ_ENDED_TURN_${String((error as { code?: unknown }).code ?? "THREW")}`));
  await once.lines.return(undefined);
  if (first.value?.text !== line.toString("utf8")) fail("EXEC417_LINE_LOST");
  if (once.seen.posts !== 2 || once.seen.offsets.join() !== "7,7") fail(`EXEC417_REREAD_${once.seen.offsets.join("_")}`);
  if (once.seen.refreshes !== 1 || once.seen.auth[1] !== `Bearer ${FRESH.execToken}`) {
    fail(`EXEC417_NOT_REFRESHED_${once.seen.refreshes}`);
  }
  const excerpt = once.seen.excerpts[0] ?? "";
  if (!excerpt.includes("exec expectation failed") || excerpt.includes(STALE.execToken)
    || excerpt.includes(STALE.networkToken)) fail("EXEC417_REJECTION_NOT_REDACTED");
  // a second refusal on the fresh descriptor, or a refresh that fails, ends the read after exactly one retry
  const twice = reader(() => "refuse", async () => FRESH);
  const twiceCode = await kit.codeOf(async () => { await twice.lines.next(); });
  if (twiceCode !== "BOX_EXEC_HTTP_417" || twice.seen.posts !== 2 || twice.seen.refreshes !== 1) {
    fail(`EXEC417_RETRY_UNBOUNDED_${twiceCode}_${twice.seen.posts}`);
  }
  const gone = reader(() => "refuse", async () => { throw new Error("BOX_NOT_RUNNING"); });
  const goneCode = await kit.codeOf(async () => { await gone.lines.next(); });
  if (goneCode !== "BOX_EXEC_REFRESH_FAILED" || gone.seen.posts !== 1) fail(`EXEC417_REFRESH_FAILURE_${goneCode}_${gone.seen.posts}`);

  // 2. the 19:53 shape: a continuation whose reads stay refused is stopped now and the session continues
  const { api, db } = kit;
  const journal = api.journal(db);
  const who = { uid: 900_000_762n, containerId: 762n, sessionId: "session-exec-417" };
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,$2,'unused',10000)",
    [who.uid.toString(), "exec-417@test.invalid"]);
  const turn = kit.boxTurn(api, db, journal, who, "box-exec-417", "a".repeat(64), undefined,
    { parked: "until-stopped", stopRejected: true });
  await turn.first();
  turn.cut.code = "BOX_EXEC_HTTP_417";
  turn.cut.active = true;
  const before = turn.host.count.spoolRead;
  const code = await kit.codeOf(async () => (await turn.next("box-exec-417-2")).text());
  turn.cut.active = false;
  const leaf = await kit.journalRow(db, "box-exec-417-2");
  const proof = leaf?.ctx.boxTerminalProof as { reason?: string } | undefined;
  if (code !== "BOX_EXEC_HTTP_417" || turn.host.count.spoolRead - before !== 2) {
    fail(`EXEC417_CONTINUATION_${code}_${turn.host.count.spoolRead - before}`);
  }
  if (turn.host.count.stop !== 1 || leaf?.ctx.boxUnknownPhase !== "continuation_exec_rejected"
    || leaf?.ctx.boxState === "unknown" || proof?.reason !== "keeper_stopped") {
    fail(`EXEC417_RUN_NOT_STOPPED_${turn.host.count.stop}_${String(leaf?.ctx.boxState)}_${String(leaf?.ctx.boxUnknownPhase)}`);
  }
  const idle = await journal.readIdleProof({ ...who, turnKey: "a".repeat(64) });
  if (idle.status !== "failed") fail(`EXEC417_IDLE_${idle.status}`);
  await kit.prechecked(api, db, { ...who, requestId: "box-exec-417-next", turnKey: "d".repeat(64) });
  const next = kit.boxHost(api, kit.spoolOf([kit.cliInit, ...kit.FINAL_ANSWER]), { capacityWaitMs: 500,
    real: { journal, ...who, accountId: who.containerId, requestId: "box-exec-417-next", turnKey: "d".repeat(64) } });
  if ((await kit.must("EXEC417_NEXT_MESSAGE", next.round())).kind !== "final" || !next.sse().includes("done")) {
    fail("EXEC417_NEXT_MESSAGE_NO_ANSWER");
  }

  // 3. the 20:03 shape: a first round whose reads stay refused is named and stopped the same way
  const fr = { uid: 900_000_763n, containerId: 763n, sessionId: "session-exec-417-first" };
  await db.query("INSERT INTO users(id,email,password_hash,credits) VALUES ($1,$2,'unused',10000)",
    [fr.uid.toString(), "exec-417-first@test.invalid"]);
  await kit.prechecked(api, db, { ...fr, requestId: "box-exec-417-first", turnKey: "e".repeat(64) });
  let host: Any;
  host = kit.boxHost(api, kit.spoolOf([kit.cliInit, ...kit.BRIDGE_CALL]), {
    spoolRead: () => { throw api.transportError("BOX_EXEC_HTTP_417"); },
    real: { journal, ...fr, accountId: fr.containerId, requestId: "box-exec-417-first", turnKey: "e".repeat(64),
      stopRejectedRun: (identity: unknown) => api.stopCoordinator(journal, host.target).requestStop(identity) } });
  const firstCode = await kit.codeOf(() => host.round());
  const firstLeaf = await kit.journalRow(db, "box-exec-417-first");
  if (firstCode !== "BOX_EXEC_HTTP_417" || host.count.spoolRead !== 2 || host.count.stop !== 1
    || firstLeaf?.ctx.boxUnknownPhase !== "first_round_exec_rejected" || firstLeaf?.ctx.boxState === "unknown") {
    fail(`EXEC417_FIRST_ROUND_${firstCode}_${host.count.spoolRead}_${host.count.stop}_${String(firstLeaf?.ctx.boxState)}`);
  }
  if ((await journal.readIdleProof({ ...fr, turnKey: "e".repeat(64) })).status !== "failed") fail("EXEC417_FIRST_ROUND_IDLE");
  return "[ocv5-762-exec-417-wedge] PASS — one Exec 417 is read again on a refreshed descriptor, and a round still refused is stopped at once so the session's next message runs";
}
