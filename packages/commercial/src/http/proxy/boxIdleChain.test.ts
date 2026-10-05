import assert from "node:assert/strict";
import test from "node:test";
import { projectBoxIdleChain, validExpiredChainIds, withVerifiedCapsule,
  type IdleChainRow } from "./boxIdleChain.js";

const sessionId = "ccb-session";
const turnKey = "ab".repeat(32);
const capsule = { version: 1, sha256: "c".repeat(64) };

function row(id: string, extra: Record<string, unknown>, state = "committed"): IdleChainRow {
  return {
    requestId: id,
    state,
    ctx: {
      boxSessionId: sessionId,
      boxTurnKey: turnKey,
      model: "box-api-claude-opus-5-5",
      boxInvocationRecovery: "v1",
      boxState: "terminal",
      ...extra,
    },
  };
}

const leaf = row("leaf", {
  boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
  boxReplayMessage: capsule,
  boxUsage: { inputTokens: 170_000 },
  boxOwnerRequestId: "parent",
  boxParentResumeRevision: "11111111-1111-4111-8111-111111111111",
});
const parent = row("parent", {
  boxToolHandoff: { roundNo: 1 },
  boxResumeRequestId: "leaf",
  boxResumeRevision: "11111111-1111-4111-8111-111111111111",
  boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
});

test("consumed historical handoff still projects one terminal revision", () => {
  const first = projectBoxIdleChain({ sessionId, turnKey, rows: [leaf, parent] });
  const second = projectBoxIdleChain({ sessionId, turnKey, rows: [parent, leaf] });
  assert.equal(first.status, "terminal");
  assert.equal(second.status, "terminal");
  if (first.status === "terminal" && second.status === "terminal") {
    assert.equal(first.revision, second.revision);
    assert.equal(first.compactRequired, true);
    assert.equal(first.requestId, "leaf");
  }
});

test("unsettled leaf, unknown, and a second open chain stay pending", () => {
  assert.equal(projectBoxIdleChain({
    sessionId, turnKey, rows: [{ ...leaf, state: "finalizing" }, parent],
  }).status, "pending");
  assert.equal(projectBoxIdleChain({
    sessionId, turnKey,
    rows: [leaf, { ...parent, ctx: { ...parent.ctx, boxState: "unknown" } }],
  }).status, "pending");
  const open = projectBoxIdleChain({
    sessionId, turnKey, rows: [leaf, parent], otherOpenRequestIds: ["other"],
  });
  assert.equal(open.status, "pending");
  if (open.status === "pending") assert.equal(open.reason, "other_chain");
});

test("only the leaf prompt counts toward the window, and a foreign nonce stays pending", () => {
  const parentHeavy = row("parent", {
    boxToolHandoff: { roundNo: 1 },
    boxResumeRequestId: "leaf",
    boxResumeRevision: "11111111-1111-4111-8111-111111111111",
    boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
    boxUsage: { inputTokens: 200_000, cacheReadTokens: 0 },
    boxRunNonce: "a".repeat(24),
  });
  const lightLeaf = row("leaf", {
    boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
    boxReplayMessage: capsule,
    boxUsage: { inputTokens: 20, cacheReadTokens: 0 },
    boxOwnerRequestId: "parent",
    boxParentResumeRevision: "11111111-1111-4111-8111-111111111111",
    boxRunNonce: "a".repeat(24),
    boxRoundNo: 2,
  });
  const proof = projectBoxIdleChain({ sessionId, turnKey, rows: [lightLeaf, parentHeavy] });
  assert.equal(proof.status, "terminal");
  if (proof.status === "terminal") assert.equal(proof.compactRequired, false);
  const foreign = projectBoxIdleChain({ sessionId, turnKey, rows: [{
    ...lightLeaf, ctx: { ...lightLeaf.ctx, boxRunNonce: "b".repeat(24) },
  }, parentHeavy] });
  assert.equal(foreign.status, "pending");
  if (foreign.status === "pending") assert.equal(foreign.reason, "identity");
});

test("short usage does not require another summary charge", () => {
  const small = row("only", {
    boxTerminalProof: { reason: "worker_complete" },
    boxReplayMessage: capsule,
    boxUsage: { inputTokens: 20 },
  });
  const proof = projectBoxIdleChain({ sessionId, turnKey, rows: [small] });
  assert.equal(proof.status, "terminal");
  if (proof.status === "terminal") assert.equal(proof.compactRequired, false);
});

test("verified capsule text is attached and a hash miss stays pending", async () => {
  const proof = projectBoxIdleChain({ sessionId, turnKey, rows: [leaf, parent] });
  assert.equal(proof.status, "terminal");
  if (proof.status !== "terminal") return;
  const pointer = {
    version: 1, uid: "3", requestId: "leaf", runNonce: "a".repeat(24),
    leaseEpoch: "b".repeat(32), roundNo: 1, bytes: 11, sha256: proof.capsuleSha256,
  };
  const attached = await withVerifiedCapsule(proof, pointer, async () => ({
    type: "message", role: "assistant", content: [{ type: "text", text: "kept goal" }],
  }));
  assert.equal(attached.status, "terminal");
  if (attached.status === "terminal") assert.equal(attached.summaryText, "kept goal");
  const missed = await withVerifiedCapsule(proof, { ...pointer, sha256: "d".repeat(64) },
    async () => { throw new Error("unread"); });
  assert.deepEqual(missed, { status: "pending", reason: "capsule" });
});

test("two committed roots are a ready set and not a summary", () => {
  const summary = row("sum", {
    boxTerminalProof: { reason: "worker_complete", runNonce: "a".repeat(24) },
    boxReplayMessage: capsule,
    boxUsage: { inputTokens: 200_000 },
    boxRunNonce: "a".repeat(24),
    boxAccountId: "1",
  });
  const business = row("biz", {
    boxTerminalProof: { reason: "worker_complete", runNonce: "b".repeat(24) },
    boxReplayMessage: { version: 1, sha256: "d".repeat(64) },
    boxUsage: { inputTokens: 30 },
    boxRunNonce: "b".repeat(24),
    boxAccountId: "2",
  });
  const forward = projectBoxIdleChain({ sessionId, turnKey, rows: [summary, business] });
  const reverse = projectBoxIdleChain({ sessionId, turnKey, rows: [business, summary] });
  assert.equal(forward.status, "terminal_set");
  assert.equal(reverse.status, "terminal_set");
  if (forward.status !== "terminal_set" || reverse.status !== "terminal_set") return;
  assert.equal(forward.revision, reverse.revision);
  assert.deepEqual(forward.requestIds, ["biz", "sum"]);
  assert.equal("summaryText" in forward, false);
  assert.equal("requestId" in forward, false);
  assert.equal("capsuleSha256" in forward, false);
  const changed = projectBoxIdleChain({ sessionId, turnKey, rows: [summary, {
    ...business, ctx: { ...business.ctx, boxReplayMessage: { version: 1, sha256: "e".repeat(64) } },
  }] });
  assert.equal(changed.status, "terminal_set");
  if (changed.status === "terminal_set") assert.notEqual(changed.revision, forward.revision);
  const withHandoff = projectBoxIdleChain({ sessionId, turnKey, rows: [leaf, parent, business] });
  assert.equal(withHandoff.status, "terminal_set");
  const unsettled = projectBoxIdleChain({
    sessionId, turnKey, rows: [summary, { ...business, state: "inflight" }],
  });
  assert.equal(unsettled.status, "pending");
  if (unsettled.status === "pending") assert.equal(unsettled.reason, "unsettled");
  const fork = projectBoxIdleChain({ sessionId, turnKey, rows: [
    summary,
    row("c1", { boxOwnerRequestId: "sum", boxTerminalProof: { reason: "worker_complete" }, boxReplayMessage: capsule }),
    row("c2", { boxOwnerRequestId: "sum", boxTerminalProof: { reason: "worker_complete" }, boxReplayMessage: capsule }),
  ] });
  assert.equal(fork.status, "pending");
  if (fork.status === "pending") assert.equal(fork.reason, "fork");
});

test("wrong turn is not found", () => {
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey: "ff".repeat(32), rows: [leaf, parent] }),
    { status: "not_found" });
});

// ── OCV5-297: proven failure is a terminal `failed`, anything else stays pending ──
const NONCE = "a".repeat(24);
const EPOCH = "b".repeat(32);
const REV = "22222222-2222-4222-8222-222222222222";
const failedProof = { reason: "worker_failed", runNonce: NONCE, leaseEpoch: EPOCH };
const failedText = row("f-text", {
  boxState: "failed_stopped", boxTerminalProof: failedProof, boxAccountId: "20",
  boxRunNonce: NONCE, boxLeaseEpoch: EPOCH,
}, "aborted");
const failedLeaf = row("f-leaf", {
  boxState: "failed_stopped", boxTerminalProof: failedProof, boxAccountId: "20",
  boxRunNonce: NONCE, boxLeaseEpoch: EPOCH, boxToolHandoff: { roundNo: 2 },
  boxOwnerRequestId: "f-parent", boxParentResumeRevision: REV,
}, "committed");
const failedParent = row("f-parent", {
  boxState: "failed_stopped", boxStopOutcome: "failed", boxAccountId: "20",
  boxRunNonce: NONCE, boxLeaseEpoch: EPOCH, boxToolHandoff: { roundNo: 1 },
  boxResumeRequestId: "f-leaf", boxResumeRevision: REV,
}, "committed");

test("a proven stopped text run and a proven stopped tool chain project failed", () => {
  const text = projectBoxIdleChain({ sessionId, turnKey, rows: [failedText] });
  assert.deepEqual(text, { status: "failed", sessionId, turnKey, requestIds: ["f-text"] });
  const chain = projectBoxIdleChain({ sessionId, turnKey, rows: [failedParent, failedLeaf] });
  assert.deepEqual(chain, { status: "failed", sessionId, turnKey, requestIds: ["f-leaf", "f-parent"] });
  const prestart = row("p", { boxState: "prestart_stopped" }, "inflight");
  assert.equal(projectBoxIdleChain({ sessionId, turnKey, rows: [prestart] }).status, "failed");
});

test("unknown, contradictory or incomplete failure shapes stay pending", () => {
  const pendingOf = (rows: IdleChainRow[], other: string[] = []) =>
    projectBoxIdleChain({ sessionId, turnKey, rows, otherOpenRequestIds: other }).status;
  // prestart after a launch permit is not a never-launched proof
  assert.equal(pendingOf([row("p", { boxState: "prestart_stopped", boxLaunchPermit: true }, "inflight")]), "pending");
  // no-handoff failure must be journal-aborted
  assert.equal(pendingOf([{ ...failedText, state: "committed" }]), "pending");
  // unknown proof reason / missing epoch / nonce mismatch
  assert.equal(pendingOf([{ ...failedText, ctx: { ...failedText.ctx,
    boxTerminalProof: { ...failedProof, reason: "worker_complete" } } }]), "pending");
  assert.equal(pendingOf([{ ...failedText, ctx: { ...failedText.ctx, boxLeaseEpoch: undefined } }]), "pending");
  assert.equal(pendingOf([failedParent, { ...failedLeaf, ctx: { ...failedLeaf.ctx, boxRunNonce: "c".repeat(24) } }]),
    "pending");
  // ancestor must be failed_stopped (not terminal) with a matching resume link
  assert.equal(pendingOf([{ ...failedParent, ctx: { ...failedParent.ctx, boxState: "terminal" } }, failedLeaf]), "pending");
  assert.equal(pendingOf([{ ...failedParent, ctx: { ...failedParent.ctx, boxResumeRevision: "x" } }, failedLeaf]), "pending");
  // missing boxState, another open chain, or a second leaf
  assert.equal(pendingOf([row("x", { boxState: undefined }, "aborted")]), "pending");
  assert.equal(pendingOf([failedText], ["elsewhere"]), "pending");
  assert.equal(pendingOf([failedText, { ...failedText, requestId: "f-text-2" }]), "pending");
});

test("OCV5-300 a locally rejected first-round stream projects failed, not a wedge", () => {
  const completeProof = { ...failedProof, reason: "worker_complete" };
  const rejected = { ...failedText, ctx: { ...failedText.ctx,
    boxTerminalProof: completeProof, boxStopOutcome: "rejected_stream" } };
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [rejected] }),
    { status: "failed", sessionId, turnKey, requestIds: ["f-text"] });
  const pendingOf = (rows: IdleChainRow[]) =>
    projectBoxIdleChain({ sessionId, turnKey, rows }).status;
  // the worker_complete exemption needs the explicit rejected_stream outcome,
  // a journal-aborted single row, and no published tool handoff
  assert.equal(pendingOf([{ ...rejected, ctx: { ...rejected.ctx, boxStopOutcome: "failed" } }]), "pending");
  assert.equal(pendingOf([{ ...rejected, state: "committed" }]), "pending");
  assert.equal(pendingOf([{ ...rejected, ctx: { ...rejected.ctx, boxToolHandoff: { roundNo: 1 } } }]), "pending");
  assert.equal(pendingOf([{ ...rejected, ctx: { ...rejected.ctx,
    boxTerminalProof: { ...completeProof, reason: "something_else" } } }]), "pending");
});

test("OCV5-306 a rejected-stream leaf releases a linked chain; its ancestors must still be stopped", () => {
  const completeProof = { ...failedProof, reason: "worker_complete" };
  const cutLeaf = row("f-leaf", { boxState: "failed_stopped", boxTerminalProof: completeProof,
    boxStopOutcome: "rejected_stream", boxAccountId: "20", boxRunNonce: NONCE, boxLeaseEpoch: EPOCH,
    boxOwnerRequestId: "f-parent", boxParentResumeRevision: REV }, "aborted");
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [failedParent, cutLeaf] }),
    { status: "failed", sessionId, turnKey, requestIds: ["f-leaf", "f-parent"] });
  const pendingOf = (rows: IdleChainRow[]) => projectBoxIdleChain({ sessionId, turnKey, rows }).status;
  assert.equal(pendingOf([{ ...failedParent, ctx: { ...failedParent.ctx, boxState: "resuming" } }, cutLeaf]), "pending");
  assert.equal(pendingOf([failedParent, { ...cutLeaf, ctx: { ...cutLeaf.ctx, boxStopOutcome: "failed" } }]), "pending");
  assert.equal(pendingOf([failedParent, { ...cutLeaf, state: "inflight" }]), "pending");
});

// ── OCV5-313: a run closed as expired_unproven ended without a model result ──
const CATALOG = "c".repeat(64), RUNNER = "d".repeat(64);
const XREV = "33333333-3333-4333-8333-333333333333";
const expiredMarker = { v: 1, atMs: 1791096241420, priorBoxState: "unknown",
  cause: "BOX_ACCOUNT_UNAVAILABLE" };
const storedHandoff = (roundNo: number, extra: Record<string, unknown> = {}) => ({ version: 1,
  roundNo, messageId: `msg_${roundNo}`, assistantContentHash: "e".repeat(64), spoolOffset: 8,
  detachedRunnerHash: RUNNER, catalogHash: CATALOG,
  toolUses: [{ id: `toolu_x${roundNo}`, boxName: "mcp__ocbridge__t0", clientName: "Note",
    inputHash: "f".repeat(64) }], verifiedPendingToolUseIds: [`toolu_x${roundNo}`],
  usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, ...extra });
const expiredIdentity = { boxAccountId: "20", boxRunNonce: NONCE, boxLeaseEpoch: EPOCH,
  boxInvocationMode: "detached_tool", boxCatalogHash: CATALOG, boxDetachedRunnerHash: RUNNER };
const aborted = { state: "aborted", finalCredits: "0", failureCode: "STREAM_FAILED" };
const expiredLeaf: IdleChainRow = { ...row("x-leaf", { ...expiredIdentity,
  boxState: "expired_unproven", boxExpiredClose: expiredMarker, boxOwnerRequestId: "x-parent",
  boxRoundNo: 2, boxParentResumeRevision: XREV }), ...aborted };
const expiredParent: IdleChainRow = { ...row("x-parent", { ...expiredIdentity,
  boxState: "expired_unproven", boxToolHandoff: storedHandoff(1), boxLaunchPermit: true,
  boxHandoffRevision: "55555555-5555-4555-8555-555555555555", boxResumeRequestId: "x-leaf",
  boxResumeRevision: XREV }), finalCredits: "8", failureCode: null };
const expiredFirst: IdleChainRow = { ...row("x-first", { ...expiredIdentity,
  boxState: "expired_unproven",
  boxExpiredClose: { ...expiredMarker, priorBoxState: "running" } }), ...aborted };
const expiredHandoff: IdleChainRow = { ...row("x-handoff", { ...expiredIdentity,
  boxState: "expired_unproven", boxExpiredClose: { ...expiredMarker, priorBoxState: "handoff" },
  boxToolHandoff: storedHandoff(1),
  boxHandoffRevision: "66666666-6666-4666-8666-666666666666" }), finalCredits: "8",
  failureCode: null };
const withCtx = (base: IdleChainRow, extra: Record<string, unknown>,
  columns: Partial<IdleChainRow> = {}): IdleChainRow =>
  ({ ...base, ...columns, ctx: { ...base.ctx, ...extra } });

test("OCV5-313 an expired unproven chain projects failed in each shape the journal writes", () => {
  const failed = (ids: string[]) => ({ status: "failed", sessionId, turnKey, requestIds: ids });
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [expiredParent, expiredLeaf] }),
    failed(["x-leaf", "x-parent"]));
  // unbilled first round (tool, or the armed detached text lane): one aborted row
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [expiredFirst] }),
    failed(["x-first"]));
  const text = withCtx(expiredFirst, { boxInvocationMode: "text", boxLaunchPermit: true,
    boxUpstreamModel: "claude-opus-5-5", boxCatalogHash: undefined });
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [text] }), failed(["x-first"]));
  // billed handoff nobody answered: the leaf keeps its settlement
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [expiredHandoff] }),
    failed(["x-handoff"]));
});

test("OCV5-313 any shape the journal's expiry cannot have written stays pending", () => {
  const pending = (name: string, rows: IdleChainRow[], other?: string[]) => {
    assert.equal(projectBoxIdleChain({ sessionId, turnKey, rows,
      ...(other ? { otherOpenRequestIds: other } : {}) }).status, "pending", name);
    assert.deepEqual([...validExpiredChainIds(rows)], [], `${name}: releases nothing`);
  };
  const leaf = (name: string, extra: Record<string, unknown>, columns: Partial<IdleChainRow> = {}) =>
    pending(name, [expiredParent, withCtx(expiredLeaf, extra, columns)]);
  const parent = (name: string, extra: Record<string, unknown>, columns: Partial<IdleChainRow> = {}) =>
    pending(name, [withCtx(expiredParent, extra, columns), expiredLeaf]);
  // marker
  leaf("marker missing", { boxExpiredClose: undefined });
  leaf("marker extra key", { boxExpiredClose: { ...expiredMarker, extra: 1 } });
  leaf("marker prior terminal", { boxExpiredClose: { ...expiredMarker, priorBoxState: "terminal" } });
  leaf("marker prior of another round type",
    { boxExpiredClose: { ...expiredMarker, priorBoxState: "running" } });
  leaf("marker time", { boxExpiredClose: { ...expiredMarker, atMs: 12 } });
  leaf("marker cause", { boxExpiredClose: { ...expiredMarker, cause: "free text!" } });
  // settlement of the unbilled leaf
  leaf("leaf not aborted", {}, { state: "inflight" });
  leaf("credits missing", {}, { finalCredits: null });
  leaf("credits charged", {}, { finalCredits: "3" });
  leaf("failure code missing", {}, { failureCode: null });
  leaf("failure code other", {}, { failureCode: "USER_CANCELLED" });
  leaf("settlement claim", { settlementClaimId: "claim-1" });
  // contradicting evidence
  leaf("proof on the leaf", { boxTerminalProof: failedProof });
  leaf("leaf resumed", { boxResumeRequestId: "someone" });
  parent("proof on an ancestor", { boxTerminalProof: failedProof });
  // identity and chain binding
  leaf("other nonce", { boxRunNonce: "9".repeat(24) });
  leaf("malformed nonce", { boxRunNonce: "short" });
  leaf("round number", { boxRoundNo: 3 });
  leaf("round number missing", { boxRoundNo: undefined });
  leaf("catalog hash malformed", { boxCatalogHash: "nope" });
  leaf("runner hash missing", { boxDetachedRunnerHash: undefined });
  leaf("recovery version", { boxInvocationRecovery: "v0" });
  leaf("text mode in a linked chain", { boxInvocationMode: "text", boxLaunchPermit: true,
    boxUpstreamModel: "claude-opus-5-5" });
  leaf("revision mismatch", { boxParentResumeRevision: "44444444-4444-4444-8444-444444444444" });
  parent("ancestor still waiting", { boxState: "resuming" });
  parent("ancestor account", { boxAccountId: "25" });
  parent("ancestor handoff malformed", { boxToolHandoff: { roundNo: 1 } });
  parent("ancestor handoff round", { boxToolHandoff: storedHandoff(2) });
  parent("ancestor catalog", { boxToolHandoff: storedHandoff(1, { catalogHash: "a".repeat(64) }) });
  parent("ancestor runner", { boxToolHandoff: storedHandoff(1, { detachedRunnerHash: "a".repeat(64) }) });
  parent("ancestor aborted", {}, { state: "aborted" });
  parent("ancestor resumes another child", { boxResumeRequestId: "another" });
  pending("revision not a uuid", [withCtx(expiredParent, { boxResumeRevision: "rev-1" }),
    withCtx(expiredLeaf, { boxParentResumeRevision: "rev-1" })]);
  // first-round and handoff shapes
  pending("first round with a linked prior state", [withCtx(expiredFirst,
    { boxExpiredClose: { ...expiredMarker, priorBoxState: "linked" } })]);
  pending("unarmed text row", [withCtx(expiredFirst, { boxInvocationMode: "text" })]);
  pending("handoff revision", [withCtx(expiredHandoff, { boxHandoffRevision: "rev-1" })]);
  pending("handoff round", [withCtx(expiredHandoff, { boxToolHandoff: storedHandoff(2) })]);
  pending("handoff leaf aborted", [{ ...expiredHandoff, state: "aborted" }]);
  pending("handoff with an unbilled prior state", [withCtx(expiredHandoff,
    { boxExpiredClose: { ...expiredMarker, priorBoxState: "running" } })]);
  assert.equal(projectBoxIdleChain({ sessionId, turnKey, rows: [expiredParent, expiredLeaf],
    otherOpenRequestIds: ["another-open-chain"] }).status, "pending");
  // The operator's OCV5-312 close is not a failure shape for its own turn.
  pending("operator close", [{ ...row("op-leaf", { ...expiredIdentity,
    boxState: "operator_unreachable_closed",
    boxOperatorUnreachableClose: { v: 1, ticket: "OCV5-312", atMs: 1791096241420,
      priorBoxState: "unknown", accountStatus: "disabled", terminalProof: false,
      remoteCleanup: false } }), state: "inflight" }]);
});

test("OCV5-313 only a complete valid expired chain stops counting as another open chain", () => {
  const ids = (rows: IdleChainRow[]) => [...validExpiredChainIds(rows)].sort();
  assert.deepEqual(ids([expiredParent, expiredLeaf]), ["x-leaf", "x-parent"]);
  assert.deepEqual(ids([expiredFirst]), ["x-first"]);
  assert.deepEqual(ids([expiredHandoff]), ["x-handoff"]);
  const stray: IdleChainRow = { ...row("stray", { ...expiredIdentity,
    boxState: "expired_unproven" }), ...aborted };
  assert.deepEqual(ids([expiredParent, expiredLeaf, stray]), ["x-leaf", "x-parent"],
    "a row with the state but no marker stays open");
  assert.deepEqual(ids([expiredLeaf]), [], "a leaf whose ancestor is not closed releases nothing");
  assert.deepEqual(ids([expiredParent]), [], "an ancestor without its closed leaf releases nothing");
  // Another turn's valid chain is judged on its own.
  const otherTurn = withCtx({ ...expiredFirst, requestId: "y-first" },
    { boxTurnKey: "ef".repeat(32) });
  assert.deepEqual(ids([expiredLeaf, otherTurn]), ["y-first"]);
  assert.deepEqual(ids([row("live", { boxState: "unknown" }, "inflight")]), []);
});
