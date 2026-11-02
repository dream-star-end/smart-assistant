# t1555u / t1576u live personal-web cc5 test slice

Plan, not completion. User 10:16 approves a live personal frontend model entry,
private CLI and fixed MCP. The steward must approve the exact release batch
before the official personal train. No independent frontend or production DB
hand edits. Full P3 libraries remain on the separate draft #1343 branch.

Base: personal 9826fe9512f6c2e2a9479d2db7faa55dd4515ac2 (reconfirmed 11/02).
New task worktree/branch: ocv5-agentremote-cc5-web-t1555u /
feat/v5-selfhost-cc5-web-t1555u. Root alone edits; session children review read-only.

## 1. Default-off server policy and exact model identity

Add a pure protocol helper for cc5-remote-t1555u and the server-selected test UID.
Require OC_SELFHOST_CC5_T1555U_ENABLED=1 and one strict positive numeric
OC_SELFHOST_CC5_T1555U_TEST_UID; empty, all, lists, zero and malformed UIDs deny.
No hardcoded user3/admin bypass. This is ANDed with catalog availability,
visibility, grants, subscription and all normal execution authority checks.

Use the same helper in catalog evaluateUse (including locked projections),
legacy pricing/authz and grants. Explicit WS hard denial after canonicalization
must occur before any slot/precheck/dispatch/usage/audit write; unknown aliases
still fail normal catalog resolution. Grant writes for another UID fail before
mutation, including staged entries. Invalid/default-off cc5 requests never fall
into Cursor routing. Non-cc5 models retain their existing paths.

Register exact cc5 model ID as the existing cursor engine family; preserve
normal authority/dispatch/external-usage accounting. Add a selfhost-only staged,
disabled, hidden catalog/pricing row and the exact external audit CHECK member.
No production grant/activation until test UID and new-container binding are
known. Do not reuse/bypass synthetic evaluation overlays or fake authority.

Test pure UID/flag rules and real catalog/legacy/WS call sites: OFF denies all;
ON allows only the configured trusted test UID plus normal grants. Ordinary
user/admin, mis-grant/public visibility, alias, direct-engine and spoofed frame
UID remain denied with zero precheck/dispatch/billing effect. No model calls.

## 2. Real Engine and credential-free remote interactive bridge

At cursor factory, identify cc5 unconditionally before CursorRoutingAdapter
construction, validate policy/target and return Cc5InteractiveAdapter. Missing
flag/UID/target/authority rejects, never falls back to Cursor/Box/login pools.
CcbAdapter retains actual stream parsing, events, summary and external costMode.

Runner gets a trusted cc5 bridge port. A separate spawn-preparation branch before
the old setup skips prepareBoxCc, provider auth, local learning/MCP prompt files,
transcript restore/relocation and official CLI print argv. It spawns only a new
Node stdio bridge with a credential-free allowlist env and a private control file.
The original preparation branch stays unchanged; both share backend.spawn and
existing stdout/session/drain/close handling. No patched runBoxCcBridge HTTP core.

Every turn requires fresh signed/verified scope admission before writing its
user frame. Reject advisor/readOnly/consult/hermetic/inline-delegate modes in
this temporary fixed-write profile. Disable automatic phantom/transient/auth
resubmit for this cc5 test model: dispatched/unknown never repeats a prompt.
Renewal must branch to the cc5 trusted port before the existing cursor Sand
check; normal master lease renewal remains, no CCB env-update frames.

The stdio bridge connects only the configured task Unix socket. It forwards
original host/mod frames verbatim, holds input until authenticated READY,
serializes sequence+hash writes and refuses conflicting replay/late generation.
Unknown delivery is a failure without resubmit. Interrupt uses the existing
control frame. EOF/SIGTERM/connection loss closes admission and invokes a
separate identity-checked remote stop; SSH EOF is not remote-exit proof.
It never generates replacement assistant/result frames.

## 3. SSH22 relay, fixed MCP and new execution environment

SSH keys stay at existing paths on the current Box. Task-only local Unix relay
uses existing SSH22 to start the original five bridge sources and private
2.1.316 CLI in an independent task tmux on cc5. Only credential-free fixed
launch config crosses the relay, no arbitrary remote command/URL. The original
bridge PID/token checks and prompt.submit(asUser:true) remain unchanged.

Approved C profile disables all builtins, ambient settings/MCP and slash
commands, exposing only one stdio MCP tool. The tool accepts only fixed
operationId; it preserves JSON-RPC id and _meta.claudecode/toolUseId separately.
The operation is bound to trusted testUID/session/turn/nativeSession/toolUseId/
operationId/full-container-ID/parameter hash. For this temporary test slice, the real fixed command runs as a child of the
bridge in the NEW personal execution container, with an actual process receipt
and terminal exit0; it does not claim to use execd. P0 execd proof remains
separate, and full P3 must still supply its formal execution-runtime ports.
This narrow substitution was independently plan-reviewed APPROVED by
research_review (round 1/3); no arbitrary command/path is accepted.
Dispatch is recorded once before effect; duplicates read a terminal receipt,
post-dispatch disconnect is unknown and never retries. No native cc5 Bash/Read.

Attach only a fresh test account's NEW Gateway container to the task relay
through a narrow typed supervisor port after Tx1 assigned row.id, before local
Docker create. Admit selfhost/local/exactUID/fresh row only; do not mutate or
rebuild an existing container. A private per-container nonce directory (not
shared per-UID SSH dirs) binds read-only to /run/oc/cc5-remote-t1555u. Opaque
capability is a protected file, not env/log/model input. Root-owned 0750 directory
and only the task socket 1000:1000/0600 allow Gateway access. No Docker socket,
private SSH key or new public port enters the container. Missing/revoked/expired
binding rejects; creation failure cleans only that prepared task binding.
Include sensitive path in existing gateway file policy/security fixtures.

A dedicated test UID is not yet known. Existing official canary source references
an account but does not prove numeric UID or a fresh task-owned container.
Do not borrow user3, reuse old canary containers or infer identity from frame JSON.
Record the steward-approved dedicated test UID before activation/real requests.

## 4. Validation, release and rollback

Use fake stdio child and fixed in-process transport for meaningful READY,
fragmented frame transparency, replay/unknown/late result, permission, stop and
cleanup tests; Cursor selector/provider-auth traps must remain untouched by
cc5. Real tiny MCP fixtures verify IDs/scope and once-only effects. No fake web
API/reply and no real model before real chain is available. Run appropriate
type/lint and required hosted CI, keeping unrelated/expired gates intact.

Before train, CONTINUE must name exact PR/SHA, migration/activation scope, test
UID/fresh container binding, disabled-by-default policy, UX limitations and
last complete release rollback. Steward approval is the last release step.
Rollback first disables the new catalog entry/route through official operations,
then uses the official previous-release personal workflow; retain additive
staged/disabled rows and audit/migration records, never hand-delete accounting.
No commercial release, queue, host or branch changes.

After official release, real personal web login/select/send/reply screenshots,
same-window cc5 ps/pts/args and task tmux prompt+reply, actual execution container
marker/hash/cwd/uid/pidns verification and cleanup are all mandatory. Save under
evidence/cc5-interactive with UTC/runId/build/model/turn. The temporary one-tool
profile lacks normal Box files/skills/browser/background/multimodal capabilities;
record latency/behavior honestly, never call it full P3 or equivalent final UX.
Full P3 must restore capabilities and pass real t1562u postrelease acceptance.

## Child tool wiring checkpoint (11/02)

The Node stdio child's production entry reads a separate root-owned RO
`authority-public.json` from the same supervisor bind; no inherited environment
or RPC field selects its signing keys. READY starts one `/tool/next` pump.
Original stdout buffers are validated by the complete-tool observer, then
forwarded unchanged. The pump verifies the signed delivery against its trusted
admission, waits for that original tool_use, and executes the fixed command in
this child's execution container. A single `/tool/result` returns the real
terminal receipt; unknown result delivery never repeats the effect. The fixed
persistent root is `/home/agent/.openclaude/.cc5-t1555u`, covered by the download
blocklist. Direct raw transport fixtures may omit tools; the production main
always loads the protected keyring and supplies the pump. This is not a model
or browser acceptance result. Plan approved by this-session research_review.

## Approved C profile controller (11/02)

`cc5-host-controller.py` starts from the task-only controller already reviewed
on P3 commit 24294c82b. Its original five installed sources remain byte-for-byte
unchanged; this minimal branch carries the controller so it has no runtime
source dependency on the unmerged P3 libraries. The fixed MCP source hash is
pinned in this controller. A stopped task alone may atomically install the
separate private cprofile; launch and evidence collection revalidate its exact
files, owner, modes and hashes. Only private CLI 2.1.316 and the previously
approved trusted work directory can launch. All builtins/settings/slash commands
are disabled, strict MCP permits only the fixed roundtrip. Exact `/proc` argv
preserves both empty arguments; ps text alone cannot prove them. The unrelated
cc5-login remains under the original narrow metadata checks and is never
captured. Sending TERM is not exit proof: the independent prove-stopped action
requires the recorded host/Claude/observed descendant identities, run directory
and both task tmux sessions to be absent. It never marks SSH EOF as stopped.
No new TUI startup or real conversation has occurred for these fixtures.
Plan and copy adjustment approved by this-session engine_inventory.

## Steward 12:52 connection update: preserve restrict + from

Generate a new task-only ed25519 key on v5-dev; only its public key is delivered
to the steward. Connect directly from v5-dev to the steward-provided dedicated
cc5 account. No old key, Box hop, OS Login/IAM, new TCP listener, firewall change
or sshd mutation is used. Dedicated user/HOME/login/binary metadata is still
pending. The current approved controller and original host contain /home/box
constraints; do not deploy them under an unconfirmed identity or borrow login
files. Freeze the confirmed profile and update candidate digests before install.

To retain `restrict,from=...`, use ordinary SSH `-T` exec stdio rather than SSH
-R/-L/-D. One channel transports the original host's bytes. A separate pinned
virtual-MCP helper listens only on its own cc5 AF_UNIX tool.sock and frames the
one request/response over its SSH stdin/stdout. Its READY must precede launching
the original host. Only v5's fixed local toolServer endpoint receives the RPC;
no model operation executes in the helper. It preserves raw request/receipt
bytes and typed RPC/native IDs, persists attempt before dispatch and never
retries unknown delivery. The helper records its own PID/startTicks durably;
independent stop proof also requires that process to have exited. The profile
pins both Python sources. Socket cleanup checks its original inode and UID.
This-session research_review approved this connection adjustment. Existing
restrict allows normal exec; no forwarding permission exception is requested.
Python fixture counts describe local transport only, never actual SSH or chat.
