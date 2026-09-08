#!/bin/bash
if [[ $# == 1 && "$1" == +%s && "${FAKE_MANUAL_REMOTE:-}" == 1 && -n "${FAKE_MANUAL_CLOCK:-}" ]]; then
  read -r now < "$FAKE_MANUAL_CLOCK" || exit 2
  printf '%s\n' "$now"
  exit 0
fi
exec /bin/date "$@"
