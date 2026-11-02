# CC5 native backend for the personal web chat

This is the current contract for the narrow agent-remote web milestone. Earlier
new-account/new-model checkpoints are superseded by the existing-account route
below. This milestone does not complete the separate full P3 Worker/ToolHost split.

## Account, model and scope

Use the owner's existing account through its normal login, including the personal
UID3 account. Do not create another test identity, query credentials to impersonate
login, or add a catalog model, price or grant. The selected model remains the active
`box-claude-sonnet-5` canonical model with engine `ccb` and its existing price.
The former `cc5-remote-t1555u` task-model entry is retired even when old flags or
explicit grants exist.

One new chat is selected by a signed `executionBackend` scope, not by its visible
model name. The master binds the exact session, operation, runtime run, UID,
container database ID and full Docker ID in the v2 root-owned binding. Normal
model authority, leases, grants, plan limits and billing admission still apply.
Other chats continue through their existing Sonnet/CCB path. Private account,
email, session and operation identifiers belong only in private deployment metadata
and evidence, never this public document.

The two existing master environment keys remain default OFF when absent:

- `OC_SELFHOST_CC5_T1555U_ENABLED`
- `OC_SELFHOST_CC5_T1555U_TEST_UID`

A configured UID is only an exact deployment restriction; it does not authorize a
new identity or payment. The activation carrier uses an optional root-private
request bound to the digest and scope of the existing v2 deployment metadata.
Unconfigured instances make no two-key configuration writes. The real official
publisher must own FD8; a caller-provided “lock held” flag is not proof. The carrier
records the two keys' original presence/value before replacing the env atomically,
preserves unrelated bytes, and selectively restores only a proven matching state.
An uncertain write or failed restore holds before any old-master restart. A normal
successful cutover closes its receipt using the existing saga/history evidence;
it must not falsely block later ordinary releases. A killed publisher does not
magically confer successor mutation authority on the survivor.

## Implemented adapter and execution boundaries

The concrete `Cc5SshHost`, privileged relay, Node stdio bridge, native CCB backend
projection, runner/session integration, fixed MCP tool pump and v2 supervisor
binding are implemented. They use pinned SSH22 exec stdio, not new TCP listeners,
SSH forwarding permissions or a generic remote-command API. The original host/mod
frame bytes are preserved. The helper must be ready before the native host starts.
SSH EOF is a transport failure, not proof that the remote task stopped.

The separate native CCB factory avoids an import cycle and retains the normal
Sonnet model identity. The dedicated bridge path skips the ordinary Box host,
provider-login preparation and local transcript probing. Retry, reuse, stop and
idle behavior are isolated by the signed backend. Unknown input/result delivery
never resubmits a prompt or repeats a tool effect. A persisted native-session
prefix prevents an automatic same-chat fallback after a master restart or flag
rollback; use a new ordinary chat for a deliberate return to the normal backend.

The fixed C profile permits only its pinned MCP operation; it disables ambient
settings, builtins and slash commands. The real fixed command runs in the personal
execution container and returns a process receipt. No arbitrary command/path is
accepted. This narrow proof does not substitute for the full P3 execution-runtime
ports or claim normal Box file/browser/background/multimodal capabilities.

Financial admission precedes host start because native startup can itself cause
upstream effects. A dispatch is durably recorded before input reaches the host.
Terminal delivery requires the actual native receipt, matching scope/digest and
four safe token counters to be proven against the existing fenced Sonnet pricing.
Unknown financial or transport acknowledgement remains pending and is not replayed.
No new pricing or account pool is introduced by the backend.

## Existing container, drain and retained data

A new binding is created during provision, after the real database row is assigned
and before Docker create, then activated only after the guarded database commit.
An existing container cannot obtain this binding merely because master env changes.
There is no policy requiring a new user: the existing user's container can be
recreated through the normal lifecycle.

After an official new runtime tuple, normal `ensureRunning` detects stale
image/release/boot hash, performs the authenticated drain and rebuilds when safe.
Busy or failed drain defers the rebuild. If only configuration changed and the
tuple is unchanged, the existing authenticated administrator restart endpoint can
request the same normal drain/rebuild after its current generation is checked.
Do not replace this with a manual `docker rm` or create a token for the operation.

The five persistent volumes are retained and reused:
`oc-v5-data-u<uid>`, `oc-v5-proj-u<uid>`, `oc-v5-codex-u<uid>`,
`oc-v5-userlocal-u<uid>` and `oc-v5-userconfig-u<uid>`. No Docker socket, private
SSH key or new public port enters the execution container. The read-only per-
container control bind carries the protected capability and authority public ring.
Missing, revoked, expired or foreign-generation bindings fail closed.

## Release and acceptance status

Feature preparation, code review and offline tests do not prove a web rollout.
Use the personal official lease/train, source/digest/CI gates, normal idle/drain
boundary and official rollback. Follow the parent's actual batch order; a draft
PR or prepared metadata does not authorize an early main merge or live activation.
No commercial release is part of this personal milestone.

For the first opt-in, register the official lease/train with
`--release-policy user-impact-only`. Its guarded installation and reader drain
must finish before the carrier may replace either key. A legacy publisher that
has not prepared the guarded watch holds; use the controlled policy path rather
than treating a registration example without this policy as activation-ready.

Before enabling the backend, verify the exact private request/metadata/profile,
current official publisher, two-key receipt/recovery state and current container
identity. Normal failure and official rollback must restore the matching key state
before restarting the previous stack. An unresolved receipt blocks survivor or
manual restore success; a successor must obtain real official ownership before
reconciling it. Never restore an unrelated whole env backup or erase accounting.

Acceptance still requires the normal personal web login and exact scoped new chat,
original native host/tool evidence, actual container command receipt, proved
billing attribution and independent remote-stop proof. Preserve UTC, source/build,
request and run evidence privately. A direct native TUI result is a separate
milestone; it does not prove the complete web chain or mark the full P3 work DONE.

## Superseded checkpoints

The earlier test slice proposed a fresh account, a hidden Cursor-family model and
new pricing rows, and described the SSH adapter/supervisor as unfinished. Those
requirements are superseded by this contract and are not deployment instructions.
Their historical fixture results remain evidence of the old checkpoint only.
The pinned-controller, original-frame, once-only-effect and independent-stop
invariants remain applicable to the implemented native backend.
