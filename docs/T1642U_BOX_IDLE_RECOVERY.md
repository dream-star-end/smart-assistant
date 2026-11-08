# t1642u: Box failure and idle source recovery

Status: commercial draft; no merge or release authorized. Approval reference:
2026-11-08 10:25 Asia/Taipei, t1642s9418. Release needs new user approval.

## Evidence and diagnosis

The supplied incident evidence records uid4 / webmw5q71izrmgbs8 / main:
Box turn 3b3de145-779f-4b7f-8165-b3e1d921b159 at 09:17, request
51dbcd92562bb49cf3f5e721540dba2d / trace a332e05dd399e49462dcc64545d23d6a,
HTTP 417 with continuation_unknown at 09:25, then BOX_REPLAY_PENDING at 09:30.
Three later submissions failed IDLE_HISTORY_PENDING / DISPATCH_NOT_ACCEPTED,
including after selecting gpt-6-astra. Times are Asia/Taipei.

The operator recovery log at 10:27:36 establishes a durable idle candidate,
no pending compact operation, and a newly requested reset marker. It does not
establish that a possibly live Box operation stopped. This coding session
performed no production reads or writes and did not consume that marker.

`submit` checks the source candidate before model reconfiguration. Therefore a
candidate whose proof stays pending blocks both models. A bare candidate only
polled proof; the gateway stop path covered pending compact operations, while
egress' idle parked-stop selector only covered handoff leaves. Unknown
continuations depended on the separate egress recovery worker. Candidate age
previously cleared the fence without proof; legacy candidates lacking createdAt
could not even enter that path. These are reproduced code paths, not a claim
that the incident candidate lacked a timestamp. Its raw body, full journal
snapshot, the cause of HTTP 417 and the remote keeper outcome were not supplied.

## Recovery contract

- Keep the existing 15 minute threshold. Age triggers a recovery attempt, never
  permission to discard unknown work. Legacy file mtime supplies scheduling age.
- Persist that a source proof was pending before requesting recovery. A later
  missing row, including after gateway restart, cannot mean not executed.
- Under the session lock, await bounded local shutdown and output drain. Only
  then request the existing authenticated stop for the exact source identity.
  Egress still owns account/run nonce/lease epoch checks and settlement.
- Re-read authoritative proof. Only proved failure releases the failed source;
  successful terminal proofs follow normal compaction. Stop ACK, missing proof,
  unavailable configuration and ambiguous results retain the durable fence.
- Operator reset checks every unfinished source/idle turn before replacing the
  native resume identity. Unsafe reset keeps its marker and state for retry;
  successful reset rebuilds context from existing history. No history, journal,
  wallet or native transcript is deleted. Missing proof for a durable identity
  is conservatively blocked even with an operator marker.

Prepared native compact apply/rollback remains the separate concern in draft
selfhost PR #1379. Its changes are not imported here. The two paths overlap in
sessionSubmit and should be reconciled explicitly when coordinating parity.

## Regression and proof

`boxIdleCandidateRecovery.test.ts` drives real SessionManager submit and idle
recovery with a neutral engine and local proof endpoint: failed Box turn,
protected pending submit, fresh manager recovery, same/different model, legacy
candidate, missing proof, failed shutdown, and operator reset. It asserts no
extra engine call or persisted final during a blocked submission, exactly one
subsequent turn/final, and preservation of existing history. This is not a live
Box or PG wallet billing E2E. Existing remote cleanup / stop coordinator tests
continue to cover nonce/epoch settlement and unknown/live run protection.

The pinned Box deployment proof invokes the same business fixture in a fresh
process through `scripts/lib/boxIdleCandidateProof.ts`; it is wired into the
existing gate without relaxing its deadline or proof requirements. Red/green
runs, independent review and hosted CI links are recorded in the task handoff.

Two prior expectations are intentionally updated: missing proof configuration
cannot clear a source candidate (OCV5-297), and candidate age cannot clear an
unknown source (OCV5-620). Prepared-op settlement remains separately covered.

## Parity and release surfaces

Both canonical branches share the affected source behavior. Recommend a
coordinated selfhost follow-up after commercial review, reconciling #1379's
prepared-apply work; no personal branch, PR or train is changed here.

Runtime source release is required for gateway changes; docs accompany master.
Proof script and incident ledger changes require normal manual gate review.
There is no dependency, Dockerfile, toolchain, database or egress implementation
change, so no runtime image rebuild is required. This PR stops before release.
