#!/bin/bash
# Test-private local TTL clock. Every unrelated sleep remains the real system sleep.
if [[ $# == 1 && "$1" == 1 && -n "${FAKE_MANUAL_CLOCK:-}" \
    && "${OC_V5_MANUAL_LEASE_INTERNAL:-}" == 1 \
    && "${OC_V5_MANUAL_LEASE_WATCHDOG:-}" != 1 && "${FAKE_MANUAL_REMOTE:-}" != 1 ]]; then
  read -r started < "$FAKE_MANUAL_CLOCK" || exit 2
  printf '%s %s %s\n' "$$" "$1" "$started" > "$FAKE_LOCAL_TIMER"
  while :; do
    read -r now < "$FAKE_MANUAL_CLOCK" || exit 2
    (( now >= started + 1 )) && exit 0
    /bin/sleep 0.01
  done
fi
exec /bin/sleep "$@"
