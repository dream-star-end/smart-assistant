# t1575u: first real cc5 interactive round

Status: preparation only. The six-file ToolHost checkpoint is 07b4371ba.
No cc5 model request, plugin installation, new TUI, or forwarding has run.
Full QueryEngine, ports, supervisor, product isolation, and P3 gates remain open.

The first proof uses the personal task's disposable execd container, one fixed
operation, and the existing Box interactive host/mod core. It does not claim
that the native tool pool or the existing Box HTTP exec transport is migrated.

## Approval boundary

CODEX-START.md 08:33 requires steward approval before cc5 installation or a
new listener. CONTINUE.md's first section requests the task-only plugin/tap
files and a reverse Unix socket, with exact cleanup scope. Do not execute that
part until the steward replies. Existing SSH22 access has been verified with
existing key and strict existing host-key verification; no SSH metadata changed.
No new TCP listener or GCP firewall change is proposed on cc5.

## Data path

1. A unique prompt originates in the disposable test container. Record the
   actual container ID and exact bytes before transport, not just a host string.
2. Existing SSH connections carry it to `host.py` on cc5. Preserve the original
   mod digest, token, Unix peer PID/descendant checks, and permission protocol.
   Start an independent task tmux PTY and keep `cc5-login` intact.
3. Input is `host stdin -> TAP -> $.prompt.submit(asUser:true)` in the actual
   interactive UI. Replies are hook events over authenticated `bridge.sock`,
   then host stdout. This is the existing Box TUI/mod core. The surrounding SSH
   transport differs from the current Box HTTP exec transport. It is not
   `tmux send-keys` or screen scraping; disclose that distinction to the steward
   because 08:35's parenthesis says PTY/tmux typing. Do not fabricate equivalence.
4. Allow only the exact task Bash request. It uses Python stdlib to POST only
   `{operationId}` over the separate task `exec.sock`. Deny any other permission
   request. The model gets no execd token, arbitrary shell proxy, or credential.
5. Two SSH22 Unix forwards keep the existing keys on this Box:
   Box `-L BoxTask.sock:V5DevProxy.sock`; Box `-R Cc5TaskExec.sock:BoxTask.sock`.
   Do not forward the original bridge socket or weaken its local PID check.
6. The v5-dev private Unix proxy submits one canned execd `/command`: write/read
   a fresh marker, then hash/cwd/uid/PID namespace. It requires command ID,
   actual terminal event, and exit code zero. Timeout after dispatch is unknown;
   no second execution. A completed duplicate only reads the cached receipt.
7. Link the original tool hook tool_use_id and exact Bash/operationId to the
   proxy receipt and execd command ID. Independently inspect/exec only the full
   task container ID and compare marker, SHA256, absolute cwd, uid, and pidns.
   A direct local proxy request is plumbing evidence, never model-tool evidence.
8. Return the real reply to the test container. Record it there and verify its
   provenance against the original hook/result, not a copied expected string.

## Interactive evidence and cleanup

Before, throughout, and after the round, record timed `ps -o pid,tty,args`
samples for Claude and check the flags and terminal. No print, output/input
format, SDK, or headless Claude invocation is permitted. Stop on a forbidden
process or trust/login/credits menu; do not answer account menus. Keep same-window
ps and `tmux capture-pane` evidence showing the container prompt and actual reply.
Only capture the new task TUI, never existing login chats. Filter host stderr:
NOT_READY can contain raw pane tails, so unknown stderr must not enter logs.
Evidence goes to local `evidence/cc5-interactive/`; no credentials or full env.

After the result and evidence, SIGTERM only the task host with PID/argv identity
checked, then await its task Claude/tmux exit. Closing stdin alone does not stop
interactive host mode. Close both SSH forwards and remove only the task socket,
plugin runtime directory, proxy, labelled container/network, and synthetic token.
The existing login session, authentication directory, and user containers remain.

## v5-dev plumbing check, no model

`OC_AGENT_REMOTE_CC5_SMOKE=1 bash scripts/agent-remote/cc5-smoke-environment.sh check`

This command is restricted to the task worktree and fixed execd digest. It creates
a constrained nobody container, read-only root, no capabilities or privilege
gain, private task bridge network, and loopback-only execd. The Unix proxy directory
is private under `/run/oc-v5-agentremote-t1555u-<operationId>` because the worktree
path exceeds Unix socket limits. TMPDIR stays in the task worktree. The check
rejects caller-supplied command fields, gets a real execd terminal receipt,
checks the independent container result, then cleans its resources. `hold` keeps
the fixture at most 30 minutes for the approved real round. Neither mode connects
to cc5, starts Claude, or supplies a product production entrypoint.

The real round must use a fresh `hold` operation, never the `check` operation:
the proxy can return a cached completed receipt. Before the prompt, assert no
proxy receipt/proof file exists. Before stopping `hold`, explicitly perform the
same full-container-ID independent verification; `hold` itself only keeps the
fixture alive and does not execute `check`'s trailing verification. The current
scripts provide the container half, not a completed cc5 controller/acceptance.

## Steward 09:12: installation and READY-only approved

The original host plus four original plugin sources exactly match personal live
9826fe951. Install these five sources in the task's private `install` directory;
the unmodified host generates the four runtime plugin copies and tap.py in `run`.
This replaces the earlier in-memory host bootstrap plan and keeps protocol fd0
untouched. No additional plugin/client/system package is installed. The helper
`cc5-smoke-prepare.py` packages, validates, launches and stops through SSH22;
its source stays in the v5-dev task tree, executed over SSH without installing
another helper on cc5. All task paths are under box's home, no sudo.

READY-only uses a separate task tmux socket via TMUX_TMPDIR, an empty open input
pipe and no prompt/resume/continue or permission-response frames. The controller
must count the bytes it actually writes; the remote inspector does not invent
that count. Unknown stderr/pane tails are discarded. Record task PTY/argv and
stop only a revalidated host identity through pidfd, then check original login
pane metadata and task runtime removal. Keep the fixed installation for the
approved real round; after that, helper cleanup removes only this task root,
refusing a live runtime/session. READY-only is not real-chat acceptance and does
not prove the CLI made zero startup/background model requests.

The prompt.submit evidence question is still pending. Do not send the real user
frame until the steward conveys that answer. The expired incident waiver stays
unchanged; the steward will decide before P3 merge.
