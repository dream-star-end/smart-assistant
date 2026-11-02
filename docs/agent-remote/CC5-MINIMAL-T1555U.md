# t1575u/t1576u: personal web to remote interactive cc5

Status (2026-11-02 10:23 CST): preparation only; no real cc5 chat or web
acceptance. CODEX-START.md 09:28 approves the existing Box prompt.submit input.
09:29 requires the real personal web frontend, not container/script-only chat.
Full QueryEngine, ports, supervisor, isolation and P3 release gates remain open.

## Acceptance path

Real personal web test account selects a cc5 model, sends a unique prompt,
actual API/WS/SessionManager/createEngine routes it to an independent interactive
Claude TUI on cc5, and the real reply returns through that backend into the web.
At least one file/command operation must occur in a new execution container.
No showroom, fake API, copied expected reply, or script-rendered chat qualifies.

Use the actual web-react build and production Gateway/master composition in an
independent test stack. The execd preparation container is not a product Gateway.
Do not reuse existing user containers or production databases, env or credentials.

## Approved and pending boundaries

- 09:12 approves the unchanged original host.py plus four plugin sources under
  the task's box home; no sudo/system packages, new cc5 ports or firewall changes.
  Only existing SSH22 and local Unix sockets; private task tmux, no cc5-login reuse.
- 09:28 approves host.stdin -> TAP -> prompt.submit(asUser:true). Do not build a
  physical typing adapter. Replies are authenticated hook events -> host stdout;
  tmux provides the actual PTY and simultaneous pane evidence, not screen parsing.
- The original five source hashes match personal live 9826fe951. Installation,
  empty-input NOT_READY attempts, scoped empty-directory native trust preparation,
  Unix echo and cleanup receipts are preparation evidence, not successful chat.
- Current cc5 public package is 2.1.197; the task's existing Box pin is 2.1.316.
  Static Mods markers differ. This is a compatibility hypothesis, not established
  NOT_READY causality. Copying a private fixed CLI is separately pending in
  CONTINUE A; no system CLI upgrade is authorized or performed.
- A default-off model in an independent real personal test frontend, private
  PG/Redis/master/Gateway, and the necessary loopback/network-only listeners are
  pending in CONTINUE B. No frontend model has been added or stack started.
- A task-only stdio MCP forwarder and trusted launch profile are pending in
  CONTINUE C. They exceed the original five-source installation scope. The old
  bridge does not enforce isolation by merely denying permission-ask requests.

## Independent web stack proposal (pending B)

Use task-labelled containers, a private network and fresh volumes. The master
serves the actual SPA and same-origin API/WS at one random 127.0.0.1 host port.
Gateway, PG5432, Redis6379, catalog/renew internal proxy and any execd endpoint
stay inside that private Docker network, with no host publish. Existing Chromium
on v5-dev can capture the page; a local browser, if needed, uses existing SSH22
and one local loopback forward. Never expose cc5 TCP or change a firewall/proxy.

Use selfhost migrations/manifest, new app/admin roles and authority keyring,
real hashPassword and a new active/verified synthetic account. Log in through
actual web /api/auth/login, not fabricated JWT/localStorage state. Only the test
instance uses its own Turnstile/cookie/JWT configuration. Add a hidden cc5 model,
default off, with an explicit grant only for that synthetic UID and the required
engine access allowlist. Preserve model authority/catalog fencing and real turns.
The master has no Docker socket/OC_RUNTIME_IMAGE; its endpoint resolver admits
only the test UID and the new Gateway. Do not contact existing Box login pools.

Pin existing cached runtime/Redis images and a separately size-checked PG digest.
Do not pull/rebuild runtime. Check v5-dev free disk before build/start; below
8,000,000,000 bytes stop and clean only task resources. TMPDIR stays in this WT.

## Interactive transport and execution isolation (pending C)

The cc5 branch must separate before Cursor credential selection/provider auth.
Use an explicit credential-free trusted target, fixed default cc5 login and own
reporter; never dummy Box tokens or cc2/cc3/cc4 fallback. Reuse the original
READY/input/permission/event core through an injected execution transport for
start/write/stop/abandon. The existing Box HTTP transport is not SSH merely
because its execUrl changed. Keep private SSH keys at their existing local paths,
never in v5-dev or test containers, and retain original Unix peer PID/token checks.

Reuse the product Box virtual-MCP launch policy: empty builtin tool set,
strict sole MCP config, empty ambient setting sources and no slash commands.
Expose only one fixed operation alias. Its stdio component accepts no arbitrary
command/URL/header/token: only the current operationId, through the separate
exec.sock. A trusted launch profile is necessary: current Route B filters drop
these flags, and existing box_virtual_mcp.py is hard-locked to /tmp. Adapt the
minimal component to task home only after C approval; do not modify original mod.
Native tools being allowed by the original CLI do not pass through an ask-only
permission check. Prompt instructions or observed absence are not isolation.

The task Unix proxy submits exactly one execd command that writes/reads a fresh
marker and returns hash/cwd/uid/pidns. Require actual command ID and terminal
execution_complete with integer exit0. A post-dispatch timeout is unknown; never
retry the effect. Completed duplicates only read the same cached receipt. Link
model tool_use_id, operationId, execd commandId and full execution container ID.
Independently inspect/exec only that task container and compare all five fields.
A local proxy invocation proves plumbing only; never replay its operation as the
real model effect. A fresh operation has no preexisting receipt or proof file.

The old cc5-smoke-environment.sh check/hold remains a previous plumbing fixture.
It publishes a loopback execd port, so it cannot implement B's network-only
execd unchanged: update publish, endpoint discovery, readiness and proxy address
together. hold expires after 30 minutes and does not independently verify its
effect; verification must occur before cleanup. Do not run it as a web backend.

## Evidence collection

Before, throughout and after the actual round collect task-identity-checked
ps(pid/tty/args), same-window task tmux pane, real web model/reply PNGs, timing,
container effect/receipt checks, request budget and cleanup. Claude must have
its tmux pts and no print/input/output-format/stream-json/SDK/headless invocation.
Stop the round on a forbidden process or account/credits menu; never answer
usage credits. Never capture the existing cc5-login pane or full env/credentials.

cc5-smoke-prepare.py snapshot is a read-only one-window collector. It verifies
owner/source/host and separate outer-shell/Claude PID/startticks with actual
ancestry and shared pts, validates the exact ps argv
being emitted, captures only that task pane, and rechecks identity. Account or
sensitive pane content fails without emitting raw output. Named native Claude
processes are sampled; this does not prove absence of arbitrary SDK processes
or continuous compliance. The caller must keep the process sampler running and
stop/mark failure on violations; one snapshot is not a success claim. It is
prepared source only and has not captured a live chat. Synthetic guard fixtures
exercise refusal/no-output behavior without SSH, TUI, model or actual process ps.

Write artifacts locally under evidence/cc5-interactive, tied to UTC/runId/build/
model/turn. The unique frontend prompt and actual reply must both appear in the
same-window TUI evidence. The steward checks all evidence before success is
reported. Preserve failed attempts as failed attempts.

## Cleanup and gates

Revalidate the task host full argv/run dir/startticks and use pidfd SIGTERM;
wait for the original host finally to stop its TUI and remove run. stdin EOF
alone is insufficient. Check task PID/session/socket absence and unchanged old
login metadata. Close only own SSH masters. After validation remove only task
installation/MCP/private CLI, labelled containers/network/volumes and synthetic
account/database/key files. Never read/delete global auth or native trust data
manually. No production release is involved in the independent stack; any
personal production change still uses official review/CI/personal train.

Existing extreme recovery work is retained and paused. Real web minimal success
is not P3 DONE: finish actual QueryEngine/ports/supervisor/full native I/O and
recovery, official review/CI/train, then t1562u real postrelease acceptance.
The expired 793c4f0b waiver remains untouched until the steward decides premerge.
