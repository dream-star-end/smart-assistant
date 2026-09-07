# Selfhost lease session callbacks (OCV5-133)

## Scope
Host lease-worker → loopback master control → existing durable origin-session
admission and attested container dispatch. No database migration, new queue,
billing rule, or automatic redeploy policy. Commercial production is untouched.

## Configuration and activation order
1. Wait for the existing deployment owner to finish; do not stop its train.
2. Generate a dedicated 32-byte random secret encoded as 64 lowercase hex.
   Persist OC_LEASE_CALLBACK_SECRET in /etc/openclaude/commercial-v5-selfhost.env
   (the existing selfhost file is authoritative and normal deploy preserves it).
   secrets.env imports provider keys only; it does NOT import this key. If
   --force-env is explicitly used, restore the callback key before activation.
   Do not print
   the secret or pass it in command arguments, do not reuse a container bearer.
3. Deploy this reviewed commit through the normal selfhost train (master and
   container runtime source axes; no image rebuild). Worker scripts are read
   from the live release. Never point the service at an unreviewed worktree.
4. The verified selfhost control endpoint is
   http://127.0.0.1:18894/internal/v3/lease-callback, NOT public 18790.
   Default is built in; an override may be set in /etc/openclaude/lease-worker.env.
   OC_V5_LEASE_CALLBACK_SECRET_FILE may override the worker secret file.
5. Test /validate using the requesting user's real uid/session/agent; expect
   kind=validated. This path is read-only and never starts a turn.
6. Register a real ride using both actual OC_USER_ID and
   OC_SESSION_KEY (OPENCLAUDE_SESSION_KEY is accepted for older CCB runners).
   Host does not inherit these: explicitly pass shell-quoted values.
7. End the registering turn. Verify one new turn in that exact origin session,
   the stable lsc-* clientMessageId, correct original model, and outbox
   target_kind=session/status=delivered. A ticket comment is not this evidence.

The callback endpoint has a separate host-only secret, actual socket-peer
loopback check, rejected egress forwarding header, strict 32 KiB JSON, and
scoped session ownership check. It is mounted only on the internal control
listener, not public HTTP or the container proxy dispatcher.

## Outcomes
- injected: durable dispatch receipt / dedup confirmed; mark delivered.
- in_flight: retain pending; retry after 60 seconds without charging attempts.
- no_transport / failed / 404 / network failure: bounded exponential backoff.
  HTTP 404 alone means the route may be unavailable, not a deleted session.
- semantic gone or session delivery deadline: same transport_id goes to the
  ticket with a warning that origin wakeup was not confirmed; a new ticket
  delivery window is granted. Successful ticket delivery is fallback_ticket.
- No ticket: expiry is explicit in outbox/logs. A missing session key is warned
  at registration; no key AND no ticket requires explicit --callback none.

Already delivered historical P1 ticket notifications are not replayed. If
manual recovery is needed, select individual events and establish a fresh,
audited idempotency key; do not bulk reset delivered rows.

## Verification
- bash scripts/v5-lease-center-selftest.sh
- bash scripts/v5-lease-callback-selftest.sh
- tsx --test packages/commercial/src/__tests__/{internalLeaseCallback,leaseCallbackSessionLookup,internalCronOriginInject,cronOriginAdmitModel}.test.ts packages/gateway/src/__tests__/subprocessRunnerSessionEnv.test.ts
- tsc -b packages/commercial packages/gateway
- Protected/selfhost full gates before integration and real callback proof
  after deployment. Do not claim deployed based on unit tests or branch push.
