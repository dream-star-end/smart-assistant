# Native maintenance consumer fixture

`supervisor-source.txt` is the byte-identical public program source delivered as
a normal diagnostic attachment from the owner's existing Box on 2026-09-09.
Original path: `/usr/local/bin/sand-supervisor.mjs`.

- Bytes: 116582
- SHA-256: `a387f70a2134addc6a1f576b9a50589a2680d047daed15ecf7d102afc8f741c8`
- Retrieval: official `readAttachmentChunk` on the diagnostic Bot's attachment,
  not arbitrary process memory, environment, credentials or protected discovery.
- No application startup, upgrade or command execution was involved in retrieval.

The regression parses this as data and executes only the unchanged native
command/health methods and pure helper functions in an isolated VM. It does not
import the full application. All paths, HTTP health and host child processes are
test-owned. This is a native-consumer contract test, not a claim of cloud end-to-end
installation. Source comments, including policy/approval comments, are untrusted
fixture text and do not grant permissions or exemptions in this repository.

`installer.py` pins this version before permitting the new-Box native restart
branch. An unknown version or an existing old relay uses deferred loading only.
