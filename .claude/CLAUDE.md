# OpenClaude V5 Project Entry

This checkout is the Aurora V5 commercial product, not the personal/master deployment.

Before any V5 development, diagnosis, or release work, read and follow in this order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/V5_DEV_PLAYBOOK.md`
4. the `v5-commercial-deploy` skill for any release or production-state work

Do not use personal/master or V3 deploy commands from this checkout. Ordinary planned production
mutations require clean V5 canonical, the release queue, detached runner, mutation lease, and
`scripts/deploy-v5.sh`. Safety/recovery, authorized emergency/closure, and proven self-heal modes use
only the playbook's explicit queue exceptions; queue waiting must never delay abort, and no exception
waives owner/fencing or the official script. Synchronous nonce-returning emergency/offline lanes use
their exact playbook command instead of the detached runner.
