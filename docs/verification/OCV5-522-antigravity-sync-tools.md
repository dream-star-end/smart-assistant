# Antigravity synchronous tools (OCV5-522)

Antigravity CLI 1.4.0 does not declare its native grep/glob tools for the tested
Gemini models. Its native `run_command` waits at most 10 seconds before returning
an asynchronous command. OCV5-522 adds synchronous `oc_bash`, `oc_grep`, and
`oc_glob` to the platform MCP server and documents their arguments in the
Antigravity preamble.

The original implementation was pushed directly to the selfhost branch in
`4437ceb73`, `33f1baaf3`, `cc21927e9`, and `db7115fbc`. This PR adds the timeout
cleanup correction and its regression test; those earlier changes are already
in its base. The complete implementation must also be reviewed as the range
`c1fdde26a..db7115fbc`.

## Verified CLI constraints

The isolated control, camel-case `forceAllToolsEager`, and snake-case
`force_all_tools_eager` configurations all produced the same lazy tool listing.
Neither option promoted the probe tool into an eager declaration. Production
configuration therefore does not contain these ineffective settings.

An isolated MCP call sleeping 179 seconds returned successfully after 179028 ms.
A call sleeping 185 seconds received protocol cancellation after 180059 ms, with
`timed out after 3m0s: context deadline exceeded`. `oc_bash` defaults to 60000 ms
and caps the requested timeout at 170000 ms so that its own timeout can return
before the CLI deadline. These measurements describe CLI 1.4.0.

The three tools are both advertised and dispatched only when
`OPENCLAUDE_ENGINE=antigravity`. Other engines keep their existing tool path.
MCP process exit and termination signals reap tracked process groups. Timeout
cleanup must also kill a descendant that ignores TERM and redirects its output:
otherwise its parent shell can close before the delayed KILL fires. The added
regression test starts exactly this process shape and checks that it stops;
Linux zombies are treated as terminated rather than running work.

## Release acceptance

Use the normal selfhost lease and deployment gates. This change affects runtime
source and frontend tool labels. Master health alone does not establish that an
existing user container has the new runtime. A normal connection can prepare the
canary container through the existing idle/drain checks; do not force recycling
an active user container.

For ordinary canary UID765, compare fresh Flash sessions before and after the
release using the same effort, six-turn memory/tool protocol, and a final gap of
at least 300 seconds. Run post-release Flash and Argon sessions concurrently.
Separately verify actual `mcp__openclaude-memory__oc_bash`, `oc_glob`, and
`oc_grep` calls, matching each call to its successful tool result. A command that
waits 12 seconds and returns in the same MCP call exercises the native 10-second
limitation. Use only generated canary fixtures.

Record every planned message, including failures, before sending it. Preserve
all relay calls, including checkpoint, monitoring, and retries, when reconciling
billing. Native Antigravity settlement uses `antigravity_turns`, relay usage,
`usage_records`, and every ledger bucket; proxy journal checks do not apply to
this native path. Recompute each frozen-price charge and reconcile the complete
new fee window and wallet snapshots. Report cache observations with their actual
account identities and cold/warm boundaries; a small sample is not a long-term
cache guarantee.

Administrator-only Claude models are outside this canary scope. User UID3's
existing runtime and any untested model must be reported separately. A release
receipt must include the exact source SHA, live release, actual master/egress
process locations, frontend/runtime evidence, functional results, and billing
results before claiming acceptance.
