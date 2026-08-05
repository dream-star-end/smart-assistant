#!/bin/sh
set -eu
SELF_ROOT=$(dirname "$(dirname "$(readlink -f "$0")")")
cli="$SELF_ROOT/bin/oc-h3"
if [ ! -x "$cli" ]; then cli="$SELF_ROOT/bin/oc-h3.py"; fi
exec "$cli" project "$@"
