# Antigravity large-native-history resume observation failure

## Scope and evidence (2026-11-04, selfhost only)

Official CLI 1.4.0 can return only init, then fail after approximately 121–125s
with `timeout waiting for cascade to start running` when resuming a large native
conversation. **This is not evidence that execution never started.** Native SQLite
steps and egress records showed actual model/tool execution behind the missing
progress. Automatically retrying this error can duplicate side effects.

An offline loopback Gemini fixture seeds 280KB user text plus 800KB assistant text
(approximately 2.16MB native state), snapshots the state, and resumes the same
native ID from the identical snapshot with both binaries. The fixture issues one
real `run_command` that appends one byte to its isolated cwd:
- 1.4.0: 125.11s, exit 1, zero step_update, **one actual write**.
- 1.5.0: first step 2.00s, complete 2.93s, exit 0, six step_update, one actual write.
- Both retained the native ID. Small-history and slow-response controls did not
  reproduce the old failure. This identifies an upstream large-state observation
  defect, not a proved source-line cause inside the closed-source CLI.

Reproduce without real credentials, user history, platform tools, or paid calls:
```sh
python3 scripts/diagnostics/antigravity-large-history-resume.py   --old /path/to/1.4.0/antigravity --new /path/to/1.5.0/antigravity   --output /absolute/new-evidence-directory
```
The output directory must not exist. The script retains raw stdout/stderr, native
state snapshots, schemas and summary timings; exit 0 requires the red/green
observation difference, preserved native ID and exactly one write from each CLI.
The output contains only synthetic fixture data; do not commit large DB artifacts.
CLI tool schemas differ by version, so the fixture reads the actual declaration.
Measure wall time, not CLI cumulative result.duration_seconds or historical usage.

## Pinned upstream artifact

Manifest: https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/linux_amd64.json
- version: 1.5.0
- build: 1.5.0-5269980577660928
- URL: https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/linux-x64/cli_linux_x64.tar.gz
- SHA512: e6031f850929210705d8c2393a5665b82b8c3b19684a6d3c556cafa31f26f77acbf164dfee96ca84a5ae7670ac0cc238a974c981c517b269194bdccff271cbd5

## Containment contract

The adapter normalizes only the precise upstream observation error. Shared taxonomy
uses `antigravity_start_observation_failed`: non-retryable, no automatic recovery
and no one-click retry CTA. Wire, lossless tape and PG finalization use the same
code. Catch-path textual timeout fallback applies only to unknown errors and must
not override a recognized non-retryable policy. Generic network errors retain
their existing behavior. Native conversation ID/history and billing are unchanged.

UI warns that operations may already have completed and asks the user to inspect
results. It must not claim nothing ran, clear the native session, auto-replay the
original request, or bypass a model-switch cost confirmation.

## Validation and rollout

- Gateway adapter fake subprocess + classification/taxonomy + resolved/thrown
  terminal-error tests: 118 passed.
- Protocol suite: 464 passed.
- PG integration suite: 165 passed, including real admit → stage → finalize →
  reconcile and zero recovery jobs for the new code.
- Full typecheck/web suite and actual Chromium card tests are release gates.
- Build via official `packages/commercial/agent-sandbox/build-image.sh` with
  `OC_FLAVOR=selfhost`, correct `PERSONAL_SRC` and full source SHA.
- Deploy via official selfhost release workflow; verify actual runtime image ID,
  `antigravity --version`, runtime release, and isolated synthetic smoke.
- Existing paused recovery requiring model-switch confirmation stays paused.
  No real task is replayed for validation. This document records evidence and
  required gates, not a claim that deployment has already completed.
