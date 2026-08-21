# Visible precommit and single terminal authority

## Incident contract

A completed turn must satisfy this user-visible invariant even when multipart
upload, materialization, a rolling runtime, or reconnect fails:

1. Master PG publishes the final visible text and terminal dispatch first.
2. `GET /api/sessions/:id` contains the answer immediately after that commit.
3. Only Master may emit an authoritative `turn_completed`/`interrupted`
   reconcile for commercial/V5 sessions.
4. Multipart bytes remain durably queued until verified and materialized, but
   their failure cannot revoke the already-published answer.

## Wire sequence

The v2 tape protocol gains a compact `action: "visible"` envelope carrying the
immutable tape header, dispatch identity, and compact settlement/visible head:

```text
fsync local retry entry
  -> POST visible             (small transaction, answer becomes refresh-visible)
  -> POST part 0..N           (lossless immutable bytes)
  -> POST finalize            (enqueue/complete Phase B and release settlement)
```

The visible transaction creates the tape header when no part exists, publishes
`visible_at`/`visible_head`, appends the session anchor, and converges the
dispatch. It does not enqueue materialization until a later finalize proves all
parts are present.

## Finality authority

The container recent-terminal ring is only engine-lifecycle evidence. In a
Master-backed runtime it may no longer synthesize a completed final. Reconnects
receive `turn_state_unknown` from the container and the host bridge resolves the
exact dispatch from PG. Master broadcasts an exact-id final reconcile after the
first visible commit.

## Rolling compatibility

One released v2 writer accidentally copied finalize-only `settlement` onto each
part. Master temporarily strips exactly that known field before applying the
otherwise strict part schema. Unknown fields remain rejected. This lets stale
containers drain while the fixed runtime release rolls, avoiding a control
plane/runtime flag day.

## Locked failure cases

- visible commit succeeds before any part exists;
- first/any part fails after visibility, but refresh still shows the answer;
- materialization job is absent before parts and enqueued after parts;
- stale writer part containing only legacy `settlement` is accepted;
- arbitrary unknown part fields are rejected;
- commercial container ring cannot declare completion without Master PG;
- terminal reconciler nudges use `isFinal: true` and exact client message id.
