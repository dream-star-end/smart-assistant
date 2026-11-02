# Model policy versions and recovery

New selfhost artifacts declare `modelAvailabilityPolicyGeneration:1` in `.complete`.
The seal and static gate require the complete policy bundle and a valid boolean
`grokEnabled`, using the same JSON reader as the existing contract runner. An
unknown generation, partial bundle, malformed JSON, or missing new file fails.
Ordinary forward cutover requires generation1 before changing the running stack.

A historical artifact is recognized only when the generation and the entire new
policy bundle are absent. That classification alone never permits publication or
chooses historical code. A legacy runner is allowed only for an internally
validated rollback target or the owner-bound predecessor of policy compensation.
The selector checks the exact target source identity, running predecessor tuple
where applicable, full artifact digest and ordinary child paths again.

Only the verified predecessor's prewarm and C1–C3 child scripts are selected.
The canonical deploy controller, Python process supervisor, G1/S1, lease fencing,
state transitions and failure handling remain in charge. An old deploy script is
never executed, and no JSON is written into an immutable predecessor.

Historical C3 receives the existing explicit matrix
`gpt-6-luna,deepseek-v4-flash`: two different engines, two turns in each session,
random purchase-code recall and live forwarding. It does not depend on exhausted
Grok quota. The restored historical application may expose Grok again; neither
the matrix nor health restoration proves Grok is usable. Current generation1
artifacts keep the policy-specific matrix and reject leaked Grok catalog entries
when `grokEnabled` is false.

The new recovery regression runs in the official train and required selfhost CI.
Its fixtures reject forged context, wrong owner/target/tuple, corrupt digest,
missing/invalid policy and symlink children. Frozen9826 entry scripts also run
against a localhost browser backend to prove actual two-engine continuation.

Before any ride, recheck the approved scope, old complete tuple, current live and
previous pointer. A dry-run does not execute live probes. After failure, let the
unique executor finish, verify the exact previous target, and use the official
rollback only once if needed. Preserve separate deployment and restoration
outcomes: successful restoration never turns the failed original release green.
