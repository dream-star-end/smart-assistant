# cc5 test-account bootstrap configuration

This prepares a fixed configuration carrier for the test-account endpoint in
PR1345. It is personal-server only. The versioned default is OFF; this change
does not create an account, enable a model, install SSH credentials or deploy.

The policy in the sealed candidate is
`deploy/v5-selfhost/cc5-bootstrap.json`, containing exactly one boolean key,
`adminCreateEnabled`. An approved bootstrap batch can change it to `true` in a
new reviewed commit. The candidate source SHA, ordinary CI, official train and
idle window must all match that batch. Do not edit a live policy or env file.

The actor is the existing `deploy-v5-selfhost.sh` personal train process. In
`cmd_cutover` STEP 8, before joint tuple activation/restart, it executes the
candidate's `scripts/lib/v5-selfhost-cc5-bootstrap.py`. Previous candidates with
no policy retain their behavior. A present policy with a missing helper fails.
The helper verifies `.complete.sourceCommit` against the exact cutover source;
it never consults a moving HEAD or accepts arbitrary env keys, values or commands.

When OFF, it does not inspect or write the production env. When ON, it requires
`v3-dev-sg`, root ownership, the fixed personal release root, the inherited fd8
for `/run/openclaude-v5-selfhost/deploy.lock`, actual exclusive flock evidence,
and an ancestor holder with matching PID/start ticks. It observes an existing
lock and never acquires or steals one. The existing release-policy fencing
check also runs immediately before invocation.

It may only append
`OC_SELFHOST_CC5_T1555U_ADMIN_CREATE_ENABLED=1` to the fixed 0600 root env file,
or retain an existing value of exactly `1`. An intentional `0`, empty value,
duplicate task key, model ON or any TEST_UID presence refuses the operation.
Unrelated env bytes are preserved. Ambiguous multiline/escaped env syntax
fails closed and requires review, without printing contents. File identity is
checked again before same-directory atomic rename and file/directory fsync.

This key does not activate `cc5-remote-t1555u`. Model entry remains OFF and
TEST_UID must be absent. Public registration, normal users, catalog/prices,
grants and existing containers are unchanged. The subsequent account creation
requires a normally authenticated administrator and a password supplied only
in request memory. The fixed endpoint returns an unverified UID without email,
session, prewarm or container creation. A 409 or unknown response is inspected
through the formal admin query/audit path before any further attempt.

Code/runtime rollback does **not** undo this key, an account or its audit data.
Do not claim a configuration rollback from a successful release rollback.
The helper returns 2 for uncertain IO after a replacement attempt; inspect
official state and task-key booleans only, and do not blindly retry. Closing the
endpoint after account creation needs a separately reviewed fixed disable
carrier or an otherwise authorized official configuration path; this helper
does not provide an arbitrary patch or automatic disabling operation.

The second activation batch remains separate: fresh UID, dedicated cc5
identity and its own native interactive login, fixed runtime artifacts,
catalog/price/grant and usage constraints, then normal personal publication.
The final acceptance must include the actual personal webpage and concurrent
cc5 tmux/TTY evidence plus a real command/file receipt from the fresh execution
container. Synthetic fixtures and CI success cannot replace that evidence.

Tests: `python3 scripts/__tests__/v5SelfhostCc5Bootstrap.test.py`.
They use only isolated synthetic files and locks; the two actual `/proc` lock
tests require Linux. The selfhost gates workflow runs all tests under root in
an isolated checkout, matching the publisher's ownership checks.
