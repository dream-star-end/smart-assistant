# Project formal read source

`loadProjectContextReadonly(id, locations)` reads metadata and verifies PROJECT.md without creating a directory, lock, migration or conflict copy. `loadFrozenProjectContext` can take a `formal` source containing explicit project paths and a readonly ledger facade. When supplied, ledger, instructions, skill carriers and official memory all use that source. It never falls back to the legacy database or root. Without the new option, existing behavior is retained.

The independent `formal-project.sqlite` format has application_id `0x4f435046` and user_version `1`; it contains only the four existing formal project memory/skill tables. Taskboard schema10, tickets, runs, leases and output remain in their original writable runtime database. The opener requires an existing regular independent inode, validates the schema and refuses symlink ancestors, hardlink aliases and WAL format before SQLite open. The host initializer uses a pre-created private root and creates a new inode exclusively; it is not registered as an agent operation.

The readonly object exposes `snapshot`, `listCandidates` and `close`. The caller owns and closes it. No SQL handle or writer escapes through that facade. Hash drift is excluded without repairing files. I/O errors are not converted to a legacy read. The related tests use explicit synthetic roots and compare file/database bytes before and after reading.

This PR does not activate the source for real users. Per-process path checks supplement the future OS read-only mount; they do not replace it or provide atomicity across files and DB. Before activation, the trusted per-user writer and a quiescent migration boundary must be implemented. Existing ProjectMemoryLedger writers still update runtime context_version and legacy metadata; they must not simply receive the new DB handle.

Inherited migration: `0327_system_action_receipts.sql`, additive only, applied/registered through the formal personal mutation lane before activation. No production migration or user copy is executed here.
