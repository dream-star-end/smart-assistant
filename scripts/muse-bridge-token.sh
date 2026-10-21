#!/usr/bin/env bash
# muse-bridge-token.sh — Muse bridge credentials for the selfhost master (OCV5-561).
#
#   muse-bridge-token.sh issue --label <name>   # new token; prints only id + file path
#   muse-bridge-token.sh list
#   muse-bridge-token.sh revoke <id>
#
# Only sha256(token) goes into muse_bridge_credentials. The plaintext token is written once to
# a root-only 0600 file under $MUSE_TOKEN_DIR (default /root/ocv5-muse) and never echoed, so it
# does not end up in terminals, logs or transcripts. The user copies it into the Muse VM with
# `python3 muse_bridge.py set-token` (no echo) and the file can then be deleted.
#
# DB access: DATABASE_URL from $MUSE_ENV_FILE (default /etc/openclaude/commercial-v5-selfhost.env);
# never printed.
set -euo pipefail
set +x

ENV_FILE=${MUSE_ENV_FILE:-/etc/openclaude/commercial-v5-selfhost.env}
TOKEN_DIR=${MUSE_TOKEN_DIR:-/root/ocv5-muse}

die() { echo "muse-bridge-token: $*" >&2; exit 1; }

db_url() {
  [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE"
  local url
  url=$(grep -E '^DATABASE_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)
  url=${url%\"}; url=${url#\"}; url=${url%\'}; url=${url#\'}
  [[ -n "$url" ]] || die "DATABASE_URL missing in $ENV_FILE"
  printf '%s' "$url"
}

psql_q() { psql "$(db_url)" -X -q -v ON_ERROR_STOP=1 -tA "$@"; }

cmd=${1:-}
shift || true
case "$cmd" in
  issue)
    label=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --label) label=${2:-}; shift 2 ;;
        *) die "unknown option: $1" ;;
      esac
    done
    [[ "$label" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "--label must be 1-64 chars of [A-Za-z0-9._-]"
    umask 077
    mkdir -p "$TOKEN_DIR"
    chmod 700 "$TOKEN_DIR"
    tmp=$(mktemp "$TOKEN_DIR/.issue.XXXXXX")
    trap 'rm -f "$tmp"' EXIT
    printf 'mbr_%s' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')" > "$tmp"
    hex=$(sha256sum < "$tmp" | cut -d' ' -f1)
    id=$(psql_q -c "INSERT INTO muse_bridge_credentials (label, token_sha256)
                    VALUES ('$label', decode('$hex', 'hex')) RETURNING id")
    [[ "$id" =~ ^[0-9]+$ ]] || die "insert failed"
    out="$TOKEN_DIR/bridge-token-$id"
    mv "$tmp" "$out"
    trap - EXIT
    chmod 600 "$out"
    echo "issued credential id=$id label=$label"
    echo "token file (root-only, 0600): $out"
    ;;
  list)
    psql_q -F ' | ' -c "SELECT id, label, created_at, COALESCE(revoked_at::text, '-'),
                               COALESCE(last_seen_at::text, '-'), COALESCE(last_bridge_version, '-')
                          FROM muse_bridge_credentials ORDER BY id"
    ;;
  revoke)
    id=${1:-}
    [[ "$id" =~ ^[0-9]+$ ]] || die "usage: revoke <id>"
    n=$(psql_q -c "WITH r AS (UPDATE muse_bridge_credentials SET revoked_at = NOW()
                              WHERE id = $id AND revoked_at IS NULL RETURNING 1)
                   SELECT COUNT(*) FROM r")
    echo "revoked $n credential(s) (the master's 30 s cache expires shortly)"
    ;;
  *)
    sed -n '2,7p' "$0"
    exit 2
    ;;
esac
