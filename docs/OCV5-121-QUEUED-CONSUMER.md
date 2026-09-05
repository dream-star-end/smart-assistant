# OCV5-121 queued consumer cancellation (R1)

Selfhost-only implementation; no migration, callback rerouting, engine latch change, service action or replay.

## Diagnosis and invariants

An accepted dispatch whose exact runtime inbox is queued is waiting for its predecessor, not evidence of an engine dying without output. Do not use another dispatch's frames to give it liveness. Active queued waits below the existing 6h hard cap. At the cap, master POSTs the five-part identity to `/internal/v3/turn-cancel-if-queued`; SQLite exact queued→rejected competes with queued→running in one transaction. Every cancel response (including success, running, absent, conflict, 404, timeout and lost response) ends this candidate's destructive processing for this tick. A subsequent durable GET rejected enters existing not_accepted convergence. The existing tick order visits financial terminal-unnotified before accepted, so newly observed rejected is terminalized on tick N+1 and its waiver/reservation release is normally processed on N+2. No financial rule or scan order changes.

For a historical master-terminal/local-live-queued split, the existing recovery sweep reads dispatchStatus/outcome/producerFenced together with tape/lease/shutdown in one PG statement snapshot. Only explicit terminal authorizes the same exact cancellation CAS. Missing fields from old master are unknown. Other live states retain their skip, and boot queued without a live reference retains its old rejection.

When the original waiter later reaches running CAS, only a successful exact reread of the same five-part rejected row returns silently. The diagnostic code is `DISPATCH_QUEUED_CANCELLED_BEFORE_START` with dispatchId/attemptNo/state only. It calls no model/tools, stages no tape, sends no error frame and never assigns _currentDispatch. Other misses and database errors retain fail-closed behavior.

## Mixed-version sequence (not executed here)

Forward: master first, runtime second. New master sees old runtime cancellation 404 as unreachable and leaves queued open. Rollback: runtime first, master second. Do not roll back master first while keeping new runtime. No database repair, live-session intervention or task replay is part of this change.

## Verification boundaries

Targeted runtime/storage, full reconcile ticks, HTTP auth/body/identity, same-snapshot PG dispatch tests and all-repository typecheck are recorded in the implementation report. Running hydrate-death, dead container, first-visible persist lag and existing sink/recovery paths remain regression targets.

The current Incident ledger requires a browser/live-e2e/deploy-gate proof in addition to unit/integration. This frozen implementation does not add deployment tooling or claim an unexecuted live proof. A proofPending entry records the missing layer; it does not waive the gate. The squad lead must close that proof gap within separately authorized scope, obtain code audit PASS, and run its CI/release train before integration or deployment.
