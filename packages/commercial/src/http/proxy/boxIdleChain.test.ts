import assert from "node:assert/strict";
import test from "node:test";
import { projectBoxIdleChain, withVerifiedCapsule, type IdleChainRow } from "./boxIdleChain.js";

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
const expiredMarker = { v: 1, atMs: 1791096241420, priorBoxState: "unknown",
  cause: "BOX_ACCOUNT_UNAVAILABLE" };
const expiredIdentity = { boxAccountId: "20", boxRunNonce: NONCE, boxLeaseEpoch: EPOCH };
const expiredLeaf = row("x-leaf", { ...expiredIdentity, boxState: "expired_unproven",
  boxExpiredClose: expiredMarker, boxOwnerRequestId: "x-parent",
  boxParentResumeRevision: "33333333-3333-4333-8333-333333333333" }, "aborted");
const expiredParent = row("x-parent", { ...expiredIdentity, boxState: "expired_unproven",
  boxToolHandoff: { roundNo: 1 }, boxResumeRequestId: "x-leaf",
  boxResumeRevision: "33333333-3333-4333-8333-333333333333" });

test("OCV5-313 an expired unproven chain projects failed in each shape the journal writes", () => {
  const failed = (ids: string[]) => ({ status: "failed", sessionId, turnKey, requestIds: ids });
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [expiredParent, expiredLeaf] }),
    failed(["x-leaf", "x-parent"]));
  // unbilled first round (tool or detached text): one aborted row
  const first = row("x-first", { ...expiredIdentity, boxState: "expired_unproven",
    boxExpiredClose: { ...expiredMarker, priorBoxState: "running" } }, "aborted");
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [first] }), failed(["x-first"]));
  // billed handoff nobody answered: the leaf keeps its settlement
  const handoff = row("x-handoff", { ...expiredIdentity, boxState: "expired_unproven",
    boxExpiredClose: { ...expiredMarker, priorBoxState: "handoff" },
    boxToolHandoff: { roundNo: 1 } });
  assert.deepEqual(projectBoxIdleChain({ sessionId, turnKey, rows: [handoff] }), failed(["x-handoff"]));
});

test("OCV5-313 a malformed, contradictory or half-closed expired chain stays pending", () => {
  const pending = (rows: IdleChainRow[], other?: string[]) => assert.equal(projectBoxIdleChain({
    sessionId, turnKey, rows, ...(other ? { otherOpenRequestIds: other } : {}) }).status, "pending");
  const leafWith = (extra: Record<string, unknown>, state = "aborted") =>
    ({ ...expiredLeaf, state, ctx: { ...expiredLeaf.ctx, ...extra } });
  pending([expiredParent, leafWith({ boxExpiredClose: undefined })]);
  pending([expiredParent, leafWith({ boxExpiredClose: { ...expiredMarker, extra: 1 } })]);
  pending([expiredParent, leafWith({ boxExpiredClose: { ...expiredMarker, priorBoxState: "terminal" } })]);
  pending([expiredParent, leafWith({ boxExpiredClose: { ...expiredMarker, atMs: 12 } })]);
  pending([expiredParent, leafWith({ boxExpiredClose: { ...expiredMarker, cause: "free text!" } })]);
  pending([expiredParent, leafWith({}, "inflight")]);                 // unbilled leaf not aborted
  pending([expiredParent, leafWith({ boxTerminalProof: failedProof })]); // proof contradicts unproven
  pending([expiredParent, leafWith({ boxRunNonce: "9".repeat(24) })]);
  pending([{ ...expiredParent, ctx: { ...expiredParent.ctx, boxState: "resuming" } }, expiredLeaf]);
  pending([{ ...expiredParent, ctx: { ...expiredParent.ctx, boxAccountId: "25" } }, expiredLeaf]);
  pending([{ ...expiredParent, ctx: { ...expiredParent.ctx,
    boxResumeRevision: "44444444-4444-4444-8444-444444444444" } }, expiredLeaf]);
  pending([expiredParent, expiredLeaf], ["another-open-chain"]);
  // The operator's OCV5-312 close is not a failure shape for its own turn.
  pending([row("op-leaf", { ...expiredIdentity, boxState: "operator_unreachable_closed",
    boxOperatorUnreachableClose: { v: 1, ticket: "OCV5-312", atMs: 1791096241420,
      priorBoxState: "unknown", accountStatus: "disabled", terminalProof: false,
      remoteCleanup: false } }, "inflight")]);
});
