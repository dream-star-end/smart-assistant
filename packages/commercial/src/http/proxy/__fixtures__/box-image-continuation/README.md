# Sanitized synthetic Box image continuation capture

These are synthetic loopback captures from the official CLI, **not production
incident wire**. The original tasks read two local synthetic files in temporary
ocv5-img-* directories. No production account UUID, user Core memory, credentials,
or private image is included.

Only metadata.user_id.device_id and metadata.user_id.session_id are replaced
with deterministic test identities. All other body fields, tool calls/results,
images, captions, system bytes, and their order are preserved. The tested context
hash deliberately excludes metadata; the original SMALL_PRIOR/SMALL_NEXT and
image-byte SHA oracles remain unchanged.

Each capture records its original file SHA and source-round SHA/length under
provenance; these are historical provenance, not hashes of the sanitized body.
Each current round sha256/bytes is recomputed from UTF-8 JSON.stringify(body).
The tests check both current round identities and fixed full-file SHA values.

The canonical fixture is this repository directory. No user-generated directory
fallback and no skip is allowed. Missing, truncated, or changed fixtures must
fail the test. Do not update the fixed oracles merely to make a red test green.
