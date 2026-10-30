/** Real PG and production journal transitions; all records are synthetic TEMP rows.
 * No model, remote Box, public table or customer balance is accessed. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { Pool } from "pg";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { makeBoxUserStopHandler } from "./boxUserStopHandler.js";
import { abortInflightJournal } from "../../billing/proxyBilling.js";
import { compileBoxToolCatalog } from "./boxToolCatalog.js";
import { deriveBoxCallFingerprint, deriveBoxContextHash, hashBoxAssistantContent,
  hashBoxAssistantNoCallerContent } from "./boxCallFingerprint.js";
import type { ProxyBody } from "./shared.js";

const url = process.env.OCV5_289_JOURNAL_TEST_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
test("260 paid-result boundaries span three bounded generations and finish idle", { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query(`CREATE TEMP TABLE request_finalize_journal (
      request_id text PRIMARY KEY,user_id bigint NOT NULL,container_id bigint,state text NOT NULL,
      ctx jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),failure_code text,error_msg text,final_credits bigint)`);
    await client.query(`CREATE TEMP TABLE usage_records (request_id text PRIMARY KEY,user_id bigint,
      credits bigint,output_tokens bigint)`);
    await client.query("CREATE TEMP TABLE credit_ledger (request_id text PRIMARY KEY,delta bigint)");
    await client.query(`CREATE TEMP TABLE turn_dispatches (dispatch_id uuid PRIMARY KEY,user_id bigint,
      session_id text,attempt_no integer,status text)`);
    const query = client.query.bind(client);
    const journal = new BoxDurableJournal({ query,
      connect: async () => ({ query, release() {} }) } as never);
    const dispatchId = "71111111-1111-4111-8111-111111111111";
    await query("INSERT INTO turn_dispatches VALUES ($1,3,'rollover-ui',1,'accepted')", [dispatchId]);
    const turn = "a".repeat(64);
    const session = `roll-${randomBytes(5).toString("hex")}`;
    // Catalog route only; every model/tool result below is synthetic, with no upstream call.
    const model = "box-api-claude-sonnet-5-5";
    const basis = { model,boxInvocationRecovery: "v1",billingPricing: { v: 1,modelId: model,
      displayName: "synthetic",inputPerMtok: "1",outputPerMtok: "1",cacheReadPerMtok: "1",
      cacheWritePerMtok: "1",multiplier: "1" },boxBillingContext: { v: 1,sessionId: "rollover-ui",
      mode: "chat",parentSessionId: null,delegateAgentId: null,turnKey: turn,parentTurnKey: null,
      authority: null,dispatchId,attemptNo: 1,verificationSponsorship: null,apiKeyId: null } };
    let body = { model,stream: true,max_tokens: 128,messages: [{ role: "user",content: "synthetic" }],
      tools: [{ name: "Echo",description: "synthetic",input_schema: { type: "object",properties: {} } }],
      metadata: { user_id: JSON.stringify({ session_id: session,oc_turn_key: turn }) } } as ProxyBody;
    const catalogHash = compileBoxToolCatalog(body.tools).bindingSha256;
    const runner = "d".repeat(64);
    const stopGap = async (physicalPending = false) => {
      let status = 0;
      let response = "";
      const stop = makeBoxUserStopHandler({ journal,
        identity: { resolve: async () => ({ uid: 3n,containerId: 7n,apiKey: null }) } as never,
        coordinator: { requestStop: async () => {
          assert.equal(physicalPending,true,"no physical successor exists after the old proof closes");
          return "pending" as const;
        } } });
      const req = Object.assign(Readable.from([Buffer.from(JSON.stringify({ session_id: session,oc_turn_key: turn }))]),
        { method: "POST",url: "/internal/box/stop" });
      const res = { set statusCode(value: number) { status = value; },setHeader() {},
        end(value: string) { response = value; } };
      await stop(req as never,res as never,{ hostUuid: "synthetic",boundIp: "127.0.0.1" });
      assert.equal(status,200); assert.deepEqual(JSON.parse(response),{ status: physicalPending ? "pending" : "stopped" });
    };
    const admitNextUserAfterStop = async (nextId: string, nextJournal = journal) => {
      const nextTurn = "b".repeat(64);
      const nextBody = { ...body,messages: [...body.messages,{ role: "user",content: "continue from the saved result" }],
        metadata: { user_id: JSON.stringify({ session_id: session,oc_turn_key: nextTurn }) } } as ProxyBody;
      const nextBasis = { ...basis,boxBillingContext: { ...basis.boxBillingContext,turnKey: nextTurn } };
      await query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
        VALUES ($1,3,7,'inflight',$2::jsonb)`,[nextId,JSON.stringify(nextBasis)]);
      await nextJournal.admit({ requestId: nextId,uid: 3n,accountId: 20n,model,canonicalBody: nextBody,
        fingerprint: deriveBoxCallFingerprint(3n,nextBody),runNonce: "7".repeat(24),leaseEpoch: "8".repeat(32),
        invocationMode: "detached_tool",contextHash: deriveBoxContextHash(nextBody),detachedRunnerHash: runner,catalogHash });
      assert.equal((await query("SELECT ctx->>'boxState' state FROM request_finalize_journal WHERE request_id=$1",[nextId])).rows[0]!.state,"reserved");
      await query("DELETE FROM request_finalize_journal WHERE request_id=$1",[nextId]);
    };
    const abortRequest = (requestId: string) => abortInflightJournal({ query } as never,
      requestId,"synthetic HTTP disconnect","STREAM_FAILED");
    const resetGap = (requestId: string, ctx: unknown) => query(`UPDATE request_finalize_journal
      SET state='inflight',ctx=$2::jsonb,final_credits=NULL,failure_code=NULL,error_msg=NULL WHERE request_id=$1`,
      [requestId,JSON.stringify(ctx)]);
    await query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
      VALUES ('non-box-abort',3,7,'inflight','{"model":"deepseek-v4-flash"}'::jsonb)`);
    assert.equal(await abortRequest("non-box-abort"),true);
    const nonBox = (await query("SELECT state,final_credits::text credits,ctx FROM request_finalize_journal WHERE request_id='non-box-abort'")).rows[0]!;
    assert.deepEqual(nonBox,{ state: "aborted",credits: "0",ctx: { model: "deepseek-v4-flash" } },
      "ordinary non-Box abort retains its original journal result without Box metadata");
    await query("DELETE FROM request_finalize_journal WHERE request_id='non-box-abort'");
    const exerciseDisconnectedGap = async (requestId: string, ctx: unknown, count: number, tag: string) => {
      await resetGap(requestId,ctx);
      assert.equal(await abortRequest(requestId),true);
      // No Stop RPC/catch callback: the original process can disappear here.
      const restarted = new BoxDurableJournal({ query,
        connect: async () => ({ query,release() {} }) } as never);
      for (let read = 0; read < 2; read++) {
        const idle = await restarted.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn });
        assert.equal(idle.status,"failed",`${tag}: durable abort alone survives process loss`);
        if (idle.status === "failed") assert.equal(idle.requestIds.length,count);
      }
      await admitNextUserAfterStop(`${tag}-disconnect`,restarted);
      await resetGap(requestId,ctx);
    };
    const exerciseAbortStopGap = async (requestId: string, ctx: unknown, count: number, tag: string) => {
      for (const order of ["abort-before-stop","stop-before-abort"]) {
        await resetGap(requestId,ctx);
        if (order === "abort-before-stop") assert.equal(await abortRequest(requestId),true);
        await stopGap();
        if (order === "stop-before-abort") assert.equal(await abortRequest(requestId),true);
        const row = (await query("SELECT state,final_credits::text credits,ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!;
        assert.equal(row.state,"aborted"); assert.equal(row.credits,"0");
        assert.equal(row.ctx.boxState,"prestart_stopped"); assert.equal(row.ctx.boxRolloverCancelled,true);
        for (const key of ["boxTerminalProof","boxRunNonce","boxLeaseEpoch","boxLaunchPermit","boxPrelaunchControl"]) {
          assert.equal(Object.hasOwn(row.ctx,key),false,"abort/Stop ordering cannot invent physical evidence");
        }
        const idle = await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn });
        assert.equal(idle.status,"failed",`${tag}: ${order} closes idle history`);
        if (idle.status === "failed") assert.equal(idle.requestIds.length,count);
        await admitNextUserAfterStop(`${tag}-${order}`);
        await stopGap(); // Repeated authenticated Stop is idempotent after either ordering.
        assert.equal(await abortRequest(requestId),false);
      }
      await resetGap(requestId,ctx);
    };
    let nonce = randomBytes(12).toString("hex");
    let epoch = randomBytes(16).toString("hex");
    let localRound = 0;
    let generations = 0;
    let stops = 0;
    let probeArm = false;
    const launch = async (requestId: string) => {
      nonce = randomBytes(12).toString("hex"); epoch = randomBytes(16).toString("hex");
      const identity = { requestId,uid: 3n,accountId: 20n,model,canonicalBody: body,
        fingerprint: deriveBoxCallFingerprint(3n,body),runNonce: nonce,leaseEpoch: epoch,
        invocationMode: "detached_tool" as const,contextHash: deriveBoxContextHash(body),
        detachedRunnerHash: runner,catalogHash };
      await journal.admit(identity);
      const manifest = { accountId: "20",controlDev: "1",controlId: randomBytes(16).toString("hex"),
        controlIno: "2",leaseEpoch: epoch,lockDev: "1",lockIno: "3",runNonce: nonce,version: 2 as const };
      const receipt = { ...manifest,identityHash: createHash("sha256").update(JSON.stringify(manifest)).digest("hex") };
      await journal.recordPrelaunchControl({ ...identity,receipt });
      if (probeArm) {
        await query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{boxContextHash}',to_jsonb($2::text))
          WHERE request_id=$1`,[requestId,"0".repeat(64)]);
        await assert.rejects(() => journal.armGuardedLaunch({ ...identity,receipt }),/BOX_TOOL_ROLLOVER_FENCE_LOST/,
          "a changed admitted context cannot arm the new paid invocation");
        await query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{boxContextHash}',to_jsonb($2::text))
          WHERE request_id=$1`,[requestId,identity.contextHash]);
        const admitted = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx;
        for (const state of ["reserved","unknown","running"]) {
          for (const journalState of ["inflight","aborted"]) {
            await query(`UPDATE request_finalize_journal SET state=$3,final_credits=CASE WHEN $3='aborted' THEN 0 ELSE NULL END,
              ctx=jsonb_set(ctx,'{boxState}',to_jsonb($2::text))
                || CASE WHEN $2='running' THEN '{"boxLaunchPermit":true}'::jsonb ELSE '{}'::jsonb END
              WHERE request_id=$1`,[requestId,state,journalState]);
            assert.equal(await abortRequest(requestId),false,"HTTP abort cannot close a physical admission");
            assert.equal(await journal.cancelToolRollovers({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn }),journalState === "inflight");
            const cancelled = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx;
            assert.equal(cancelled.boxState,state,"even an aborted physical generation still requires cleanup proof");
            assert.equal(cancelled.boxTerminalProof,undefined);
            assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"pending");
            await assert.rejects(() => journal.armGuardedLaunch({ ...identity,receipt }),/BOX_TOOL_ROLLOVER_FENCE_LOST/);
            await resetGap(requestId,admitted);
          }
        }
        probeArm = false;
      }
      await journal.armGuardedLaunch({ ...identity,receipt });
      localRound = 1; generations++;
    };
    const pointer = (requestId: string) => ({ version: 1 as const,uid: "3",requestId,
      runNonce: nonce,leaseEpoch: epoch,roundNo: localRound,bytes: 20,sha256: "9".repeat(64) });
    for (let index = 0; index < 260; index++) {
      const requestId = `roll-request-${index}`;
      await query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
        VALUES ($1,3,7,'inflight',$2::jsonb)`, [requestId,JSON.stringify(basis)]);
      if (index === 0) await launch(requestId);
      else {
        if (index === 128) {
          // Rollover must not move the resource check ahead of identity/content validation.
          await assert.rejects(() => journal.claimToolResume({ requestId,uid: 3n,canonicalModel: model,
            canonicalBody: { ...body,system: "changed context" } }),/BOX_TOOL_CONTEXT_CHANGED/);
          await assert.rejects(() => journal.claimToolResume({ requestId,uid: 3n,canonicalModel: model,
            canonicalBody: { ...body,tools: [{ ...body.tools![0]!,description: "changed catalog" }] } }),/BOX_TOOL_CATALOG_CHANGED/);
          await query("UPDATE turn_dispatches SET status='terminal' WHERE dispatch_id=$1",[dispatchId]);
          await assert.rejects(() => journal.claimToolResume({ requestId,uid: 3n,canonicalModel: model,
            canonicalBody: body }),/BOX_TOOL_ROLLOVER_FENCE_LOST/);
          await query("UPDATE turn_dispatches SET status='accepted' WHERE dispatch_id=$1",[dispatchId]);
          for (const key of ["billingPricing","boxInvocationRecovery"]) {
            await query("UPDATE request_finalize_journal SET ctx=ctx-$2::text WHERE request_id=$1",[requestId,key]);
            await assert.rejects(() => journal.claimToolResume({ requestId,uid: 3n,canonicalModel: model,
              canonicalBody: body }),/BOX_TOOL_RESUME_JOURNAL_INVALID/);
            await query("UPDATE request_finalize_journal SET ctx=$2::jsonb WHERE request_id=$1",[requestId,JSON.stringify(basis)]);
          }
        }
        const decision = await journal.decideToolResume({ requestId,uid: 3n,canonicalModel: model,canonicalBody: body });
        if (index === 128 || index === 256) {
          assert.equal(decision.kind,"rollover_claim", "128 is a generation boundary, not a task failure");
          if (decision.kind !== "rollover_claim") throw new Error("missing rollover claim");
          const claim = decision.claim;
          const identity = { requestId: claim.ownerRequestId,uid: 3n,accountId: claim.accountId,
            runNonce: claim.runNonce,leaseEpoch: claim.leaseEpoch };
          const gap = await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn });
          assert.equal(gap.status,"pending");
          await assert.rejects(() => journal.finishToolRollover({ requestId,uid: 3n,claim }),
            "claim and a missing proof never authorize another generation");
          const beforeFinishCtx = index === 128
            ? (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx : undefined;
          if (index === 128) {
            assert.equal(await abortRequest(requestId),true);
            assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,
              "pending","a cancelled never-admitted successor cannot stand in for a missing old physical proof");
          }
          await journal.recordUserCancelIntent(identity);
          await journal.markToolChainStoppedFailure({ ...identity,
            proof: { runNonce: claim.runNonce,leaseEpoch: claim.leaseEpoch,keeperPid: 101,cliPid: 102,
              reason: "keeper_stopped",revision: 1 } });
          if (index === 128) {
            const beforeFinishIdle = await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn });
            assert.equal(beforeFinishIdle.status,"failed","128 stopped rows plus one never-launched cancelled successor close before retirement");
            if (beforeFinishIdle.status === "failed") assert.equal(beforeFinishIdle.requestIds.length,129);
            const closedGap = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx;
            const forgedRevision = `${claim.durableRevision[0] === "0" ? "1" : "0"}${claim.durableRevision.slice(1)}`;
            await query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{boxRolloverFrom,durableRevision}',to_jsonb($2::text))
              WHERE request_id=$1`,[requestId,forgedRevision]);
            assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,
              "pending","an unbound rollover receipt cannot authorize the extra idle component");
            await query("UPDATE request_finalize_journal SET ctx=$2::jsonb WHERE request_id=$1",[requestId,JSON.stringify(closedGap)]);
            await assert.rejects(() => journal.finishToolRollover({ requestId,uid: 3n,claim }),/BOX_TOOL_ROLLOVER_FENCE_LOST/);
            await admitNextUserAfterStop("roll-gap-before-finish");
            await exerciseDisconnectedGap(requestId,beforeFinishCtx,129,"before-finish");
            await exerciseAbortStopGap(requestId,beforeFinishCtx,129,"before-finish");
          }
          await journal.finishToolRollover({ requestId,uid: 3n,claim }); stops++;
          if (index === 128) {
            const otherBody = { ...body,metadata: { user_id: JSON.stringify({ session_id: "other-session",oc_turn_key: turn }) } };
            await query(`INSERT INTO request_finalize_journal(request_id,user_id,container_id,state,ctx)
              VALUES ('roll-competitor',3,7,'inflight',$1::jsonb)`,[JSON.stringify(basis)]);
            await assert.rejects(() => journal.admit({ requestId: "roll-competitor",uid: 3n,accountId: 20n,
              model,canonicalBody: otherBody,fingerprint: deriveBoxCallFingerprint(3n,otherBody),
              runNonce: "5".repeat(24),leaseEpoch: "6".repeat(32),invocationMode: "detached_tool",
              contextHash: deriveBoxContextHash(otherBody),detachedRunnerHash: runner,catalogHash }),/BOX_CAPACITY_HELD/,
            "the stopped-to-admit gap still reserves one physical account slot");
            await query("DELETE FROM request_finalize_journal WHERE request_id='roll-competitor'");
            const changedBody = { ...body,system: "different model context" };
            await assert.rejects(() => journal.admit({ requestId,uid: 3n,accountId: 20n,model,
              canonicalBody: changedBody,fingerprint: deriveBoxCallFingerprint(3n,changedBody),
              runNonce: "5".repeat(24),leaseEpoch: "6".repeat(32),invocationMode: "detached_tool",
              contextHash: deriveBoxContextHash(changedBody),detachedRunnerHash: runner,catalogHash }),/BOX_TOOL_ROLLOVER_FENCE_LOST/,
            "a receipt is bound to the exact next model context, not just the successor request id");
            assert.equal(await journal.cancelToolRollovers({ uid: 3n,containerId: 8n,sessionId: session,turnKey: turn }),false);
            const gapBeforeStop = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx;
            // PostgreSQL bounds regex repetition at 255; the session contract allows 256.
            for (const [length, closes] of [[256,true],[257,false]] as const) {
              const boundarySession = "s".repeat(length);
              await resetGap(requestId,{ ...gapBeforeStop,boxSessionId: boundarySession,
                boxRolloverFrom: { ...gapBeforeStop.boxRolloverFrom,sessionId: boundarySession } });
              assert.equal(await abortRequest(requestId),true,"session length must not make the abort SQL throw");
              const boundary = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx;
              assert.equal(boundary.boxState,closes ? "prestart_stopped" : undefined,
                `a ${length}-character session must ${closes ? "close" : "retain the unresolved receipt"}`);
              assert.equal(boundary.boxRolloverCancelled,closes ? true : undefined);
            }
            await resetGap(requestId,gapBeforeStop);
            await stopGap();
            await assert.rejects(() => launch(requestId),/BOX_TOOL_ROLLOVER_FENCE_LOST/,
              "a durable Stop in the generation gap wins over fresh admission");
            const cancelled = (await query("SELECT state,ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!;
            assert.equal(cancelled.ctx.boxState,"prestart_stopped");
            assert.equal(cancelled.ctx.boxRolloverCancelled,true);
            for (const key of ["boxTerminalProof","boxRunNonce","boxLeaseEpoch","boxLaunchPermit","boxPrelaunchControl"]) {
              assert.equal(Object.hasOwn(cancelled.ctx,key),false,"never-launched closure cannot invent physical evidence");
            }
            const stoppedIdle = await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn });
            assert.equal(stoppedIdle.status,"failed","Stop before successor admission immediately closes idle history");
            if (stoppedIdle.status === "failed") assert.deepEqual(stoppedIdle.requestIds,[requestId]);
            // A real next user turn can reserve this same session/account immediately.
            await admitNextUserAfterStop("roll-gap-continue");
            await exerciseDisconnectedGap(requestId,gapBeforeStop,1,"after-finish");
            await exerciseAbortStopGap(requestId,gapBeforeStop,1,"after-finish");
            // A row aborted by the previous deployment (without the new atomic marker) also closes on Stop.
            await query("UPDATE request_finalize_journal SET state='aborted',final_credits=0 WHERE request_id=$1",[requestId]);
            await stopGap();
            assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"failed");
            await resetGap(requestId,gapBeforeStop);
            // A finalizing/committed owner and a corrupt aborted receipt stay pending.
            for (const state of ["finalizing","committed"]) {
              await query(`UPDATE request_finalize_journal SET state=$2,final_credits=CASE WHEN $2='committed' THEN 1 ELSE NULL END
                WHERE request_id=$1`,[requestId,state]);
              assert.equal(await journal.cancelToolRollovers({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn }),false);
              assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"pending");
              assert.equal((await query("SELECT state FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.state,state);
              await resetGap(requestId,gapBeforeStop);
            }
            for (const marker of [{ boxRunNonce: "9".repeat(24) },{ boxLaunchPermit: true },
              { boxPrelaunchControl: {} },{ settlementClaimId: "11111111-1111-4111-8111-111111111111" }]) {
              await query("UPDATE request_finalize_journal SET ctx=ctx || $2::jsonb WHERE request_id=$1",[requestId,JSON.stringify(marker)]);
              assert.equal(await abortRequest(requestId),true);
              if ("settlementClaimId" in marker) await query("UPDATE request_finalize_journal SET ctx=ctx || $2::jsonb WHERE request_id=$1",[requestId,JSON.stringify(marker)]);
              assert.equal(await journal.cancelToolRollovers({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn }),false);
              assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"pending");
              await resetGap(requestId,gapBeforeStop);
            }
            await query("UPDATE request_finalize_journal SET state='aborted',final_credits=1 WHERE request_id=$1",[requestId]);
            assert.equal(await journal.cancelToolRollovers({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn }),false,
              "a contradictory charged aborted row is never silently closed");
            assert.equal((await query("SELECT final_credits::text credits FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.credits,"1");
            await resetGap(requestId,gapBeforeStop);
            for (const malformed of [null,{},"not-an-array"]) {
              await query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{boxRolloverFrom,resultHashes}',$2::jsonb)
                WHERE request_id=$1`,[requestId,JSON.stringify(malformed)]);
              assert.equal(await abortRequest(requestId),true,"malformed receipt data cannot break the ordinary abort CAS");
              assert.equal((await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx.boxState,undefined);
              assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"pending");
              await resetGap(requestId,gapBeforeStop);
            }
            await query(`UPDATE request_finalize_journal SET ctx=jsonb_set(ctx,'{boxRolloverFrom,resultHashes}','[]'::jsonb)
              WHERE request_id=$1`,[requestId]);
            assert.equal(await abortRequest(requestId),true);
            await assert.rejects(() => journal.cancelToolRollovers({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn }),/BOX_TOOL_ROLLOVER_FENCE_LOST/);
            const corrupt = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[requestId])).rows[0]!.ctx;
            assert.equal(corrupt.boxState,undefined); assert.equal(corrupt.boxRolloverCancelled,undefined);
            assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"pending");
            // Restore only synthetic negative branches; no production Stop/financial record is reversed.
            await resetGap(requestId,gapBeforeStop);
            probeArm = true;
          }
          await launch(requestId);
        } else {
          assert.equal(decision.kind,"new_claim");
          if (decision.kind !== "new_claim") throw new Error("missing resume claim");
          localRound = decision.claim.roundNo;
        }
      }
      const usage = { inputTokens: 2,outputTokens: 3,cacheReadTokens: 0,cacheWriteTokens: 0 };
      if (index === 259) {
        await journal.completeToolChain({ requestId,uid: 3n,leaseEpoch: epoch,usage,messagePointer: pointer(requestId),
          proof: { runNonce: nonce,leaseEpoch: epoch,keeperPid: 101,cliPid: 102,
            reason: "worker_complete",revision: 1 } });
      } else {
        const id = `toolu_roll_${index}`;
        const input = { step: index };
        const content = [{ type: "tool_use",id,name: "Echo",input }];
        await journal.recordToolHandoff({ requestId,uid: 3n,leaseEpoch: epoch,roundNo: localRound,
          spoolOffset: localRound * 1000,detachedRunnerHash: runner,catalogHash,
          verifiedPendingToolUseIds: [id],messagePointer: pointer(requestId),candidate: {
            messageId: `msg_roll_${index}`,toolUses: [{ id,boxName: "mcp__ocbridge__t0",clientName: "Echo",input }],
            assistantContentHash: hashBoxAssistantContent(content),
            assistantNoCallerHash: hashBoxAssistantNoCallerContent(content),...usage } });
        body = { ...body,messages: [...body.messages,{ role: "assistant",content },
          { role: "user",content: [{ type: "tool_result",tool_use_id: id,content: `result-${index}` }] }] } as ProxyBody;
      }
      // Synthetic already-settled amounts prove rollover never rewrites prior records.
      await query("UPDATE request_finalize_journal SET state='committed',final_credits=1 WHERE request_id=$1", [requestId]);
      await query("INSERT INTO usage_records VALUES ($1,3,1,3)", [requestId]);
      await query("INSERT INTO credit_ledger VALUES ($1,-1)", [requestId]);
    }
    assert.equal(generations,3); assert.equal(stops,2);
    const counts = await query(`SELECT COUNT(*)::int n,MAX(COALESCE((ctx->>'boxRoundNo')::int,1))::int max_round,
      MAX(COALESCE(jsonb_array_length(ctx->'boxPriorMessageIds'),0))::int max_prior
      FROM request_finalize_journal GROUP BY ctx->>'boxRunNonce' ORDER BY n DESC`);
    assert.deepEqual(counts.rows.map((row) => row.n),[128,128,4]);
    assert.ok(counts.rows.every((row) => row.max_round <= 128 && row.max_prior <= 127));
    const totals = await query(`SELECT (SELECT sum(credits)::int FROM usage_records) usage,
      (SELECT -sum(delta)::int FROM credit_ledger) ledger,
      (SELECT sum(final_credits)::int FROM request_finalize_journal) journal`);
    assert.deepEqual(totals.rows[0],{ usage: 260,ledger: 260,journal: 260 });
    const idle = await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn });
    assert.equal(idle.status,"terminal",JSON.stringify(idle));
    // A later recovery may replace a stopped holder. Its mutable alias must
    // not revoke the immutable receipt of an already retired physical run.
    const oldLeafId = "roll-request-127";
    const successorId = "roll-request-128";
    const oldLeaf = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[oldLeafId])).rows[0]!.ctx;
    const successor = (await query("SELECT ctx FROM request_finalize_journal WHERE request_id=$1",[successorId])).rows[0]!.ctx;
    const recoveredLeaf = { ...oldLeaf,boxRecoveredBy: "roll-later-recovery" };
    await query("UPDATE request_finalize_journal SET ctx=$2::jsonb WHERE request_id=$1",[oldLeafId,JSON.stringify(recoveredLeaf)]);
    assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"terminal",
      "a mutable recovery alias cannot reintroduce 128 retired paid rows into idle");
    assert.deepEqual((await query("SELECT ctx->'boxRolloverRetired' receipt FROM request_finalize_journal WHERE request_id=$1",[oldLeafId])).rows[0]!.receipt,
      oldLeaf.boxRolloverRetired,"the completed retirement receipt is never rewritten");
    const invalidProofs = [
      { id: successorId,ctx: { ...successor,boxRolloverFrom: undefined } },
      { id: successorId,ctx: { ...successor,boxRolloverReady: "00000000-0000-4000-8000-000000000000" } },
      { id: oldLeafId,ctx: { ...recoveredLeaf,boxTerminalProof: undefined } },
      { id: oldLeafId,ctx: { ...recoveredLeaf,boxTerminalProof: { ...oldLeaf.boxTerminalProof,reason: "worker_complete" } } },
    ];
    for (const invalid of invalidProofs) {
      await query("UPDATE request_finalize_journal SET ctx=$2::jsonb WHERE request_id=$1",[invalid.id,JSON.stringify(invalid.ctx)]);
      assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"pending",
        "the fixed successor still requires the original From, ready revision and physical stop proof");
      await query("UPDATE request_finalize_journal SET ctx=$2::jsonb WHERE request_id=$1",
        [invalid.id,JSON.stringify(invalid.id === oldLeafId ? recoveredLeaf : successor)]);
    }
    const unchangedTotals = await query(`SELECT (SELECT sum(credits)::int FROM usage_records) usage,
      (SELECT -sum(delta)::int FROM credit_ledger) ledger,
      (SELECT sum(final_credits)::int FROM request_finalize_journal) journal`);
    assert.deepEqual(unchangedTotals.rows[0],totals.rows[0],"recovery aliases do not change any settled amount");
    assert.equal((await journal.readIdleProof({ uid: 3n,containerId: 7n,sessionId: session,turnKey: turn })).status,"terminal");
  } finally { client.release(); await pool.end(); }
});
