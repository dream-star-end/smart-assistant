# OCV5-713: temporary personal Grok withdrawal

User authorization: CODEX-START.md steward 16:10, 2026-11-02. Personal only.

The only switch is `deploy/v5-selfhost/model-availability.json` → `grokEnabled`.
The initial value is false. No database row, quota threshold, account, credential,
registration setting or commercial deployment is changed.

A verified selfhost master and egress read this file from their own release at
startup. False removes grok-build and grok-build-fast from the effective active
catalog and legacy pricing availability. Anonymous, signed-in, admin and granted
users cannot see or authorize them; aliases cannot issue an execution descriptor.
Raw admin catalog records stay intact. Other products ignore this selfhost file.
The shared allocator rejects browser and container-local delegate minting before
any pool access. A valid old relay route is rejected before lease renewal, token
loading or upstream access. Release cleanup remains available. Existing user
containers cannot bypass these gates.

The release C3 reads the same candidate release file. While false, it runs
**gpt-6-luna (codex) + deepseek-v4-flash (ccb)**, each with the existing two-turn
continuation and live forwarding. Grok overrides and a leaked Grok catalog row
fail C3. Two different engines remain mandatory. C1/C2, prewarm, G1/S1, budgets,
inline-request checks and every other gate remain unchanged. True restores the
original Grok+DeepSeek C3 matrix. This is not a skipped or automatically passing C3.

## Restore on/after November 6

Restoration is not automatic and does not enable any account. First obtain the
steward's restoration/batch approval and verify usable Grok quota under the
unchanged 95% policy. Old disabled-account quota snapshots do not establish that.

In a fresh isolated task worktree based on current origin/feat/v5-selfhost, run:

```bash
node --input-type=module -e 'import {writeFileSync} from "node:fs"; writeFileSync("deploy/v5-selfhost/model-availability.json", JSON.stringify({grokEnabled:true},null,2)+"\n")'
```

That is the single configuration change: no model IDs or smoke test code need
editing. Commit/push it, obtain normal independent approval and green CI, then
obtain steward go and use the official personal ride/queue for that new SHA.
Both master and egress load the new release's value during normal activation;
C3 automatically returns to Grok+DeepSeek. Run real continuation and billing
reconciliation. Changing an active release file does not hot-reload a process.
Do not hand-edit the live file/env or restart units outside the official path.

To withdraw again, use the same command with `grokEnabled:false` and the same
reviewed official release workflow. The old false artifact remains a rollback
candidate. Never cut over the already-current release just to reload config:
that would overwrite the real `.prev-release` pointer.

## This batch and failure rollback

This batch is only #1344 + #1346 + #1348 + OCV5-713. It excludes #1345/#1343 and
all commercial changes. Before registering a ride, record exact merged SHA,
previous complete master/runtime/platform tuple, health and available disk.
Steward go is mandatory; this PR does not register or launch a train.

Current baseline is rel-9826fe951-20261101-172017, source
9826fe9512f6c2e2a9479d2db7faa55dd4515ac2. After a failed release, first let the
unique official executor finish. Confirm live and actual previous pointer, run
official `scripts/deploy-v5-selfhost.sh --rollback --dry-run`, assert its target
is the recorded previous complete baseline, then perform one official rollback
if required and authorized. Verify status/smoke/version/health and journal agree.
Do not repeat rollback if the baseline is already live: current pre-train .prev
points to the failed 77a7 release, so blindly repeating it would roll forward.
Old9826 predates this switch; rolling back code can re-expose Grok. Report that
explicitly and do not call old C3 green. Prefer a controlled false-policy release
for a later Grok-only withdrawal rather than editing production SQL or accounts.
