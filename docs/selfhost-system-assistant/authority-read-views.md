# Explicit authority read views

`createAuthorityPaths(root)` supplies one explicit formal-data root. `UserProfileView`, `CoreMemoryView` and `SkillReadView` read that root; they do not select a root from request arguments, HOME or environment fallback. The skill facade exposes list/view only; history is not part of this slice.

Pure profile reads preserve disk bytes, including old section markers. Snapshot normalization happens once, so a legacy read version remains valid for the real writer even with CRCRLF. Pure memory reads retain existing TTL, scanning and injection caps without acquiring the old repair/migration barriers.

These APIs are currently inert: no actual user migration, OS mount, write-route closure or authority activation is performed by this PR. Existing legacy readers remain in use until their composition is explicitly switched. A read facade is not an OS permission boundary, and it does not promise an atomic snapshot across independent files. Trusted migration must reject aliases and copy new inodes; future activation must close all old writers and readers together.

The inherited PG migration is `0327_system_action_receipts.sql`, an additive receipt table and index. It must be applied and registered under the formal personal deployment mutation lane before feature activation. This view API performs no production DDL and does not change taskboard schema or running task data.
