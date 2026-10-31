# OCV5-676: personal background delegations

`OC_DELEGATE_BACKGROUND=1` opts a personal deployment into background delivery.
It defaults off and also requires the existing personal engine-local-turn gate,
a managed runtime, and a configured master result sink. The master passes the
flag to containers and advertises the existing inflight-delegate surface.
Keep the flag off until acceptance; this change does not enable it in any env file.

New MCP and CLI clients advertise `resultDelivery: "background"`. Only an explicit
gateway acknowledgement releases their foreground wait. Older gateways and
flag-off deployments retain the existing aggregate waiting behavior. Reviews and
`send_to_agent` retain their existing delivery semantics.

Background jobs use `callback: "none"`. They do not enter orphaned stdout-wait
adoption, origin injection, or the Notifier's model-wakeup path. Their actual
child usage still settles through the existing billing path. Results use the
original owner turn's durable agent-group continuation, including its complete
transcript and accounting evidence; completion creates no new paid parent turn.

The same Composer control stops background work when the input is empty, and
sends a new message when it contains text. Stop captures exact background job IDs
in the existing durable control journal. Its replay cannot cancel later jobs.
The parent turn keeps its existing exact message fence. Preparation, capacity
queues, child execution, descendants, and resource cleanup share a cancellable
background scope. Protocol state remains `cancelled`; the UI says “已停止”.

Background progress does not change the parent turn's status or admission state.
While an unresolved permission or question awaits confirmation, background
results remain in durable storage and wait in the display projection. An answer
still awaiting its durable receipt also retains priority. Resolving the card
reveals the stored results without injecting another model turn.

The added wire fields are optional. Update the master schema/materializer before
enabling a new runtime to emit marked results. The default-off rollout preserves
compatibility while master and container code converge.

Acceptance must cover sending a new message during background execution; Stop
during preparation, queueing, execution, and cleanup; stale control replay;
confirmation priority across reload; fan-out with no extra parent admission; and
the existing flag-off delegation, review, and long-task regressions. An applied
Stop receipt alone is not proof that processes and leases have been reclaimed.
