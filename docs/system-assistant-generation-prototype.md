# Formal profile generation prototype (OCV5-610)

This library is inert. It registers no operation, enables no runtime capability,
imports no legacy authority and changes no user container mount.

The host supplies a private per-user root. Stable kernel flock serializes CAS
writers. A generation contains profile data, exact action-binding receipts and
an archived manifest; published generations are never updated. Candidate
validation uses the same complete tree rules as the pure reader.

The publisher fsyncs the tree and its parent, atomically selects a manifest and
fsyncs its parent before writing an independent exact commit seal. Historical
seals are complete temporary files followed by atomic rename under the same
stable lock. Incomplete temporary files are never commit evidence.

Recovery verifies only the selected current generation and a sealed archived
parent, preserves all prior receipts and completes durability without applying
business changes again. Initial baseline recovery requires its own exact host
permit and accepts no business receipts. Absence never authorizes retries.

Before production activation, implement the restricted data worker, trusted
actor-to-root mapping and private-ledger approval lineage, migrate all formal
readers/writers, validate actual read-only mounts and perform uid765 acceptance.

Inherited migration: 0327_system_action_receipts. Its separate reviewed personal
migration must be applied and ledgered before the required-migration release.
