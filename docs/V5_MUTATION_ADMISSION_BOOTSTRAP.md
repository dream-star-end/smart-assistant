# V5 production mutation admission and first-install prerequisite

All official mutation lanes retain the remote OS flock. A successor rotates the
common root-only admission nonce, then drains the same PostgreSQL advisory lock
before advertising LEASED or touching a physical deployment surface. The three
explicit role URIs must address the same single TCP endpoint and actual primary
postmaster/database (system identifier, database OID, actual server address/port,
postmaster epoch and recovery=false). No v3, local-default or multi-host fallback
is supported. A model activation operator must acquire that advisory lock in its
writing transaction, then verify the live invocation's common nonce/holder proof
after taking all required state/model locks, and retain the PG lock until COMMIT.
An old manual-holder file is not an admission proof.

## First installation / bootstrap

Before invoking the official bootstrap lane, an authorized operator must privately
pre-provision /etc/openclaude/commercial-v5.env as a regular, non-symlink, root-owned
0600 file. Provision the **complete runtime environment**, not a three-URL stub:

- complete current runtime config accepted by commercial loadConfig;
- explicit DATABASE_URL, MODEL_AUTHORITY_DEPLOY_DATABASE_URL and
  MODEL_CATALOG_ADMIN_DATABASE_URL for the one approved production primary;
- REDIS_URL, COMMERCIAL_ENABLED=1 and COMMERCIAL_JWT_SECRET or JWT_SECRET using
  the runtime's existing length/selection contract;
- OC_RUNTIME_CHANNEL=v5 and the approved OC_RUNTIME_IMAGE;
- the official first-install split template: OC_EGRESS_SPLIT=1, loopback
  INTERNAL_CONTROL_BIND, valid INTERNAL_CONTROL_PORT and OC_EGRESS_SECRET;
- other configured features obey their **existing conditional** runtime groups.
  Do not make optional OAuth/payment providers mandatory just for admission.

Required host tools (node, PostgreSQL client, jq, python3, coreutils/flock,
base64/gzip and timeout) must already be available. Missing prerequisites fail
closed. Secrets remain operator-provisioned root-only data, never committed or
printed. Do not derive a partial environment from the retired v3 installation.

After the actual common admission lease is acquired, bootstrap validates the
candidate runtime schema in production mode **before** its first unit install,
rsync or live-tree write. It transports a locally bundled, gzip-compressed pure
validator, verifies the decoded SHA-256, executes it only in a private temporary
file, and deletes that file on exit. No candidate dependencies or source are
installed in a live/public tree merely to run validation.

This complete candidate-schema gate is **bootstrap-only**. It must not be applied
to ordinary deploy, rollback/recover/abort or a manual repair lease: a future
candidate schema cannot lock an operator out of repairing an old runtime.
The first-install split=1 requirement is this entry's template constraint, not a
claim of general non-split/legacy compatibility.

## Verification

Pure config and byte-boundary regression is part of test:v5:ops:
scripts/__tests__/v5BootstrapEnv.test.ts. The actual local root/PG/bootstrap entry
proof is separately run under the official commercial test mutex:

    bash scripts/test-mutex.sh commercial 'node --test ops/ocv5-308/bootstrap-runtime-env.node-test.mjs'

That release proof uses only the dedicated local openclaude_test endpoint and a
private flock/env tree. SSH transport is local, but actual holder shell, PG probe,
nonce/proof, candidate bundle validation and first effect boundary are consumed.
It is not a fake-root or mocked PG test. Its config/entry success does not by
itself prove the separate old-transaction/SIGKILL successor race or unknown-COMMIT
reconciliation; those require their own transaction/process evidence.
