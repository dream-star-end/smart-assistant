/** OCV5-378: the Box model route serves box-api-* (claude -p) and box-claude-* (interactive runner). Every
 * fence that names the route's models accepts both; the routing itself stays on the signed catalog.
 * Run: npx tsx --test packages/commercial/src/http/proxy/boxRouteModelFences.test.ts */
import test from "node:test";
import assert from "node:assert/strict";
import { BOX_API_MODELS } from "@openclaude/protocol";
import { BoxDurableJournal } from "./boxDurableJournal.js";
import { isBoxRouteModelName, selectUpstreamRoute, UnroutableProviderError } from "./upstream.js";

/** A pool that marks the first database touch: reaching it means the identity checks passed. */
const reached = { query: async () => { throw new Error("REACHED_DB"); },
  connect: async () => { throw new Error("REACHED_DB"); } } as never;

const admission = (model: string) => ({ requestId: "req-fence-1", uid: 3n, accountId: 25n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32), model,
  fingerprint: { replayFingerprint: "c".repeat(64), requestHash: "d".repeat(64), turnKey: "e".repeat(64),
    sessionId: "session-fence" } }) as never;

test("the durable journal admits every route model, canonical or upstream, and nothing else", async () => {
  const journal = new BoxDurableJournal(reached);
  for (const m of BOX_API_MODELS) {
    for (const model of [m.id, m.upstreamModel]) {
      await assert.rejects(journal.admit(admission(model)), /REACHED_DB/, model);
      await assert.rejects(journal.findNativeCandidate({ uid: 3n, sessionId: "session-fence",
        currentRequestId: "req-fence-2", canonicalModel: model }), /REACHED_DB/, model);
    }
  }
  for (const model of ["box-cursor-claude-x", "cursor-auto", "box-claudex", "gpt-6"]) {
    await assert.rejects(journal.admit(admission(model)), /BOX_JOURNAL_IDENTITY_INVALID/, model);
    assert.equal(await journal.findNativeCandidate({ uid: 3n, sessionId: "session-fence",
      currentRequestId: "req-fence-2", canonicalModel: model }), null, model);
  }
});

test("the pre-catalog fences treat both route prefixes alike", () => {
  for (const m of BOX_API_MODELS) {
    assert.equal(isBoxRouteModelName(m.id), true, m.id);
    assert.throws(() => selectUpstreamRoute(m.id),
      (error: unknown) => error instanceof UnroutableProviderError && error.providerId === "box_cli_authority_required");
  }
  for (const model of ["claude-haiku-5-5", "cursor-auto", "gpt-6.1-sol", "boxed-claude"]) {
    assert.equal(isBoxRouteModelName(model), false, model);
  }
});
