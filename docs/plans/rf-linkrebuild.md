# ContainerLink startup and transport recovery

`OC_CONTAINER_LINK` controls both browser links and recovery. The verified selfhost default remains on; `0` disables both. No additional rollout flag or billing path is introduced.

After composition, `rebuildContainerLinks()` scans PG open dispatch carriers in pages of 100, scoped to the runtime channel and live owned sessions. A serial queue spaces initial restores by 100 ms. Endpoint lookup requires the exact active `(uid, containerId)` and never calls `ensureRunning`, provisions, or recycles a container.

A restored receive-only handle binds unowned dispatch routes, invokes the existing bridge consumer, detaches the inert subscriber, then activates and sends hello. It occupies no browser quota, never refreshes browser activity, and cannot execute inbound, recovery, cron, or prompt queue turns. Browser attachment shares the physical connection and existing routes. Restored `admitted` requests are observed without lease renewal: a crash before dispatch send must still expire into the existing reconciler. Only PG-confirmed `accepted` requests receive the ordinary attempt/epoch-fenced lease renewal.

Physical error, close, or heartbeat expiry follows the existing error-before-close cleanup. Recovery waits for stopped-link work and outbound persistence before reading the cursor and starting a fresh consumer. This preserves ordinary cross-bridge journal settlement and fresh connection attestation. The coordinator has one queued attempt per carrier; retries wait 1, 2, 4, 8, then 16 seconds. The five-attempt budget is per carrier per process and does not reset on TCP success. Exhaustion or a vanished carrier leaves dispatch adjudication to the existing reconciler. A user can still explicitly reconnect. Async dial and socket-open waits are bounded by the bridge connect timeout. Shutdown aborts delays, stops links and drains pending recovery; late factories terminate their returned sockets.

Hello replay uses `readContainerLinkReplay` and only actual persisted frame sequences. `outbound.resume_failed` writes the first gap into `client_session_live_streams.provenance.containerLinkGap` for each exact open dispatch attempt. The stream can have zero frames. No frame or sequence is synthesized. Both HTTP and WS snapshots expose this evidence using the existing `sequence_gap` or `cursor_reset` contract; `beforeSeq=to+1` describes the unproven replay interval, not a promise that all missing sequence numbers were content. Completed tape projection retains its existing `tape` gap. A marker never advances the replay cursor, and failure to persist it tears down the transport for bounded recovery.

Metrics are exposed through the existing admin Prometheus renderer:

- `container_link_rebuilt_total`: newly established recovery connections whose hello was sent.
- `container_link_reconnect_total{outcome}`: attempt, success, error, vanished, exhausted.
- `container_link_gap_total`: first durable gap markers (duplicate replay failures do not increment).

Local evidence lives in the task handoff, including the mandatory `containerLink.integ.test.ts` run. The integration fixture uses temporary PG tables and local WebSockets; no paid turn or production database is used.
