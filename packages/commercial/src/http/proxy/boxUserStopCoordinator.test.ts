import test from "node:test";
import assert from "node:assert/strict";
import { BoxUserStopCoordinator } from "./boxUserStopCoordinator.js";

const identity = { requestId: "box-root", uid: 3n, accountId: 20n,
  runNonce: "a".repeat(24), leaseEpoch: "b".repeat(32) };
const leaf = { ...identity, requestId: "box-linked", linked: true };
const stoppedProof = { runNonce: identity.runNonce, leaseEpoch: identity.leaseEpoch,
  keeperPid: 101, cliPid: 102, reason: "keeper_stopped" as const,
  revision: 1 as const };

test("user stop is journaled before pinned keeper signal; only proof closes current leaf", async () => {
  const calls: string[] = [];
  const coordinator = new BoxUserStopCoordinator({
    journal: { recordUserCancelIntent: async () => { calls.push("intent"); },
      getCancelLeaf: async () => { calls.push("leaf"); return leaf; },
      markFirstRoundStoppedFailure: async () => { throw new Error("wrong leaf"); },
      markToolChainStoppedFailure: async (input: { requestId: string; proof: unknown }) => {
        assert.equal(input.requestId, leaf.requestId);
        assert.deepEqual(input.proof, stoppedProof); calls.push("failure-CAS");
      } } as never,
    resolver: { resolve: async (args: { requiredAccountId: bigint }) => {
      assert.equal(args.requiredAccountId, 20n); calls.push("resolve");
      return { accountId: 20n,
        exec: { run: async (req: { args: string[] }) => {
          if (req.args.at(-1) === identity.leaseEpoch) {
            calls.push("stop"); return { stdout: "stop-requested\n", exitCode: 0 };
          }
          calls.push("proof"); return { stdout: JSON.stringify(stoppedProof) + "\n",
            exitCode: 0 };
        } }, dispose: async () => { calls.push("dispose"); } } as never;
    } } as never,
    proofWaitMs: 0,
  });
  assert.equal(await coordinator.requestStop(identity), "stopped_proven");
  assert.deepEqual(calls, ["intent", "leaf", "resolve", "stop", "proof",
    "failure-CAS", "dispose"]);
});

test("ambiguous stop response reads proof but never sends a second stop", async () => {
  let stopCalls = 0, closed = 0;
  const coordinator = new BoxUserStopCoordinator({
    journal: { recordUserCancelIntent: async () => {}, getCancelLeaf: async () => leaf,
      markFirstRoundStoppedFailure: async () => { throw new Error("wrong leaf"); },
      markToolChainStoppedFailure: async () => { closed++; } } as never,
    resolver: { resolve: async () => ({ accountId: 20n,
      exec: { run: async (req: { args: string[] }) => {
        if (req.args.at(-1) === identity.leaseEpoch) {
          stopCalls++; throw new Error("lost response after stop request");
        }
        return { stdout: JSON.stringify(stoppedProof) + "\n", exitCode: 0 };
      } }, dispose: async () => {} }) as never } as never,
    proofWaitMs: 0,
  });
  assert.equal(await coordinator.requestStop(identity), "stopped_proven");
  assert.equal(stopCalls, 1);
  assert.equal(closed, 1);
});

test("missing proof or wrong account never releases capacity", async () => {
  let remote = 0, closed = 0;
  const journal = { recordUserCancelIntent: async () => {},
    getCancelLeaf: async () => leaf,
    markFirstRoundStoppedFailure: async () => { closed++; },
    markToolChainStoppedFailure: async () => { closed++; } } as never;
  const wrong = new BoxUserStopCoordinator({ journal,
    resolver: { resolve: async () => ({ accountId: 21n,
      exec: { run: async () => { remote++; throw new Error("must not run"); } },
      dispose: async () => {} }) as never } as never,
    proofWaitMs: 0 });
  assert.equal(await wrong.requestStop(identity), "pending");
  assert.equal(remote, 0);
  const missing = new BoxUserStopCoordinator({ journal,
    resolver: { resolve: async () => ({ accountId: 20n,
      exec: { run: async () => { remote++; throw new Error("proof absent"); } },
      dispose: async () => {} }) as never } as never,
    proofWaitMs: 0 });
  assert.equal(await missing.requestStop(identity), "pending");
  assert.equal(remote, 2, "one stop and one proof read, no replay");
  assert.equal(closed, 0);
});
