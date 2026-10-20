# OCV5-521: per-train release failure policy

The default release behavior is unchanged. A formal personal release ride may
explicitly bind `--release-policy user-impact-only` to its exact pushed SHA:

```sh
env -u OC_SESSION_KEY -u OPENCLAUDE_SESSION_KEY OC_USER_ID=3 \
  scripts/oc-lease.sh register --resource deploy:selfhost --mode ride \
  --sha "$SHA" --ticket OCV5-521 --owner codex-ux-p1-ocv5-521 \
  --callback auto --release-policy user-impact-only
```

This is not a gate waiver or global environment switch. Mixed, late, malformed
or mismatched policy requests fail before exposure. The real owner holds the
existing deployment lock and freezes request membership, operation, candidate,
original stack and nonce on the existing lease/train JSON fields. No migration
or second release queue is introduced.

All static, compatibility, canary, user-idle, user-contract and cache gates still
run. The source/tuple saga compensates only before possible candidate exposure
or after candidate-bound evidence of actual user impairment, and retains the
original lossless/model/storage guards on that compensation. Locally usable
candidates stay in service when a user gate, history write or state receipt
fails; uncertain identity/health/authority also stays unresolved. No financial
records or whole environment/credential files are restored.

Exit codes: `78` is a known held failure, `79` is unresolved observation or
receipt failure, and `86` is owner/fencing loss. None is a successful release.
These results propagate through the actual outer caller without a second
compensation. Backup rotation and release GC run only after verified acceptance.

The private durable intent defaults to
`/var/lib/openclaude-v5-selfhost/release-policy/unresolved.json`. Its presence,
corruption, links, unreadable paths or probe failures prevent automatic watch,
survivor, autorecovery, dispatch and ride settlement from clearing the hold or
rolling the candidate back. New mutation commands recheck this barrier after
acquiring the original lock. Read-only status/smoke and dry-run remain usable.
The old installed watch inode/readers and the captured old worker invocation/job
are naturally drained while a real rejected survivor phase protects the first
policy release; timers and other publishers are not stopped.

Recovery uses the original operation and original nonce, under the same official
train and deployment lock. It requires a dead original executor (PID plus start
identity), unchanged frozen requests/acceptance, no other open train and the
actual exact source, four-key tuple, raw current link and master/active-egress
process generations. Invoke through the canonical script, detached with normal
release evidence capture:

```sh
scripts/deploy-v5-selfhost.sh --deploy --resume-release-policy \
  --lease-train="$ORIGINAL_TRAIN" --target-sha="$ORIGINAL_SHA"
```

This recovery does not build, switch source/runtime pointers, restart services,
create another operation or adjust billing. It repairs one missing history
record only against the exact captured prefix. A visible write with lost ACK
remains nonzero; retry recognizes the verified record without a duplicate.
Unknown, old, mixed or advanced serving stacks refuse before taking over the
old train. New releases continue to use ordinary ride registration.

Real gates, coherent history, process identity, original finalization and the
owner terminal train write must pass while the intent still blocks readers.
A private verified forward archive bound to the pre-recorded exact operation,
nonce and target digest is the finite acceptance point. Active-intent removal
is cleanup. If its final directory ACK is lost, the command remains nonzero,
while readers revalidate/fsync the exact archive before settling. An exact
archive plus identical active intent is completed without repeated paid gates.
No same-SHA archive search or old-survivor green shortcut can prove acceptance.

Tests are registered in `test:v5:ops` through `v5ReleasePolicy.test.ts` and use
actual source functions, real temporary SQLite/Git/history and owned fixture
processes. Synthetic observation fixtures verify reader contracts; they do not
stand in for real multi-round release canaries or billing reconciliation. The
red drill keeps the real compatibility guards and disables only the policy
branch in a private copy. `--history <pinned-old-lib>` additionally captures the
original writer swallowing a real rename failure. No production fault injection
is required or authorized by these tests.
