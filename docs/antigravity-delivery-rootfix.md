# Antigravity terminal delivery and relay recovery

Scope: selfhost transport and adapter delivery; no model rerun, tool replay,
pricing changes, historical re-billing, or native CLI patch.

## Proven failure chain

A relay connection reset caused context reconstruction. Separately, CLI 1.4.0
reported SUCCESS with empty stdout/result even though its native trajectory
contained a completed planner answer. HTTP 200 and CLI SUCCESS are not proof of
user-visible delivery. Updating source files without replacing the running
gateway process does not activate a fix.

## Runtime contract

- Relay body admission settles aborted/destroyed/incomplete streams once.
  Oversized chunked uploads receive 413 + Connection: close without waiting
  for the upload to finish; cancelling the local fetch iterator must not destroy
  the downstream socket before that response.
- Disconnected downstreams retain the existing egress upstream-drain/accounting
  contract. Diagnostic logs contain identifiers/stages/counts, never payloads,
  credentials, full URLs or arbitrary transport error text.
- Terminal response text uses the existing appendText/segment/summary path.
  Only an empty model body or an exact prefix can be reconciled. Platform
  attachment-omission notices are not part of the model prefix.
- Resume stdout is filtered against a read-only pre-spawn MAX(idx), then the
  current USER_INPUT boundary. A missing resume watermark fails before spawning;
  a fresh launch can still consume legacy unindexed events.
- Native fallback requires original SUCCESS, real close/exit 0, matching
  requested/init/result identity, no cancellation/current failure/denial,
  pinned binary/schema and exact serialized stdin message.content hash.
  An unanchored resumed terminal response also needs matching native evidence.
- Native data is read-only. The module validates the current USER_INPUT and final
  DONE planner response, normal stop reason, closed tool calls and non-conflicting
  answer fields. Thinking is never promoted to an answer. Unknown formats fail
  closed. The descriptor/binary provenance is recorded alongside the schema.
- The result timer cannot declare EMPTY_RUN while a qualifying CLI is still
  closing. Recovery is single-settle; cancellation/end during async IO cannot
  deliver late text or a success settlement. Recovery never spawns a process.
- Existing runner persistence acknowledgement gates remain unchanged.
  Terminal billing currently precedes persistence; this change does not claim
  ACK-before-charge or change global billing order.

## Regression layers

- antigravityRelay.test.ts / v5AntigravityRelay.test.ts: real two-hop HTTP,
  delayed authentication disconnect, 32 MiB + 1 early 413, subsequent small
  request, downstream draining, listener cleanup and diagnostic privacy.
- antigravityAdapter.test.ts: terminal-only/prefix delivery, old-step isolation,
  close barrier, cancellation, late end, nonzero exit, identity mismatch,
  pre-spawn missing-baseline refusal and one terminal settlement.
- antigravityNativeTrajectory.test.ts: real read-only SQLite + descriptor-based
  protobuf decoding, input/identity/baseline/schema/stop/tool refusal cases.
- antigravityDeliveryPersistence.test.ts: actual fake CLI process, one actual
  file side effect, real adapter and SessionManager, durable local SQLite append,
  closed/reopened public readback, duplicate terminal frames, exactly one body
  and settlement event. Only fake-binary trust is injected for native recovery.
  This is not a production PG or real-wallet-debit test.

Use the repository test-mutex admission; do not bypass a release-priority refusal.
The counterfactual uses an isolated overlay with the old adapter and current
tests; never overwrite the task tree to obtain a red run.

## Release evidence required

Master/egress and the user-container runtime are separate activation surfaces.
Release through the official selfhost lease path, then verify the running
process/release tuple and the local relay's Connection: close behaviour.
Source presence, a master-only release or a 200 health endpoint alone is not
completion. Container replacement must respect in-flight sessions and user
approval where a forced interruption would otherwise be required.
