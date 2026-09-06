/**
 * Cloud / local / kill-switch fallback (§6, E6).
 * Kill switch 503 and Host/tunnel loss fall back to the cloud shell once,
 * then refuse to re-enter local until the cooldown elapses (no tight-loop).
 */

export const LocalMode = Object.freeze({
  CLOUD: 'cloud',
  LOCAL: 'local',
  FALLBACK: 'fallback',
})

export const DEFAULT_KILL_SWITCH_COOLDOWN_MS = 30_000

export function localModeTrayLabel(mode, { desired } = {}) {
  if (mode === LocalMode.LOCAL) return '本地模式:开'
  if (mode === LocalMode.FALLBACK) return '本地模式:回落云端'
  if (desired === true) return '本地模式:连接中'
  return '本地模式:关'
}

export function createLocalModeController({
  now = () => Date.now(),
  cooldownMs = DEFAULT_KILL_SWITCH_COOLDOWN_MS,
  onChange = () => {},
  audit = () => {},
} = {}) {
  let desired = false
  let mode = LocalMode.CLOUD
  let lastBlockAt = 0
  let lastBlockReason = null
  let enableAttempts = 0

  function emit(reason) {
    try {
      audit({ event: 'local_mode', mode, desired, reason, lastBlockReason })
    } catch {
      /* */
    }
    onChange({ mode, desired, reason, lastBlockReason, lastBlockAt })
  }

  function inCooldown(at = now()) {
    return lastBlockAt > 0 && at - lastBlockAt < cooldownMs
  }

  function enterFallback(reason, at = now()) {
    lastBlockAt = at
    lastBlockReason = reason
    desired = false
    if (mode === LocalMode.FALLBACK) {
      emit(reason)
      return { ok: true, mode, blocked: true, reason }
    }
    mode = LocalMode.FALLBACK
    emit(reason)
    return { ok: true, mode, blocked: true, reason }
  }

  return {
    get mode() {
      return mode
    },
    get desired() {
      return desired
    },
    get lastBlockReason() {
      return lastBlockReason
    },
    get lastBlockAt() {
      return lastBlockAt
    },
    get enableAttempts() {
      return enableAttempts
    },
    inCooldown,
    status() {
      return {
        mode,
        desired,
        lastBlockReason,
        lastBlockAt,
        cooldownRemainingMs: inCooldown() ? Math.max(0, cooldownMs - (now() - lastBlockAt)) : 0,
        label: localModeTrayLabel(mode, { desired }),
      }
    },
    enableLocal({ force = false } = {}) {
      enableAttempts += 1
      if (!force && inCooldown()) {
        emit('cooldown')
        return { ok: false, mode, reason: 'cooldown', retryAfterMs: Math.max(0, cooldownMs - (now() - lastBlockAt)) }
      }
      desired = true
      mode = LocalMode.LOCAL
      emit('enable')
      return { ok: true, mode }
    },
    disableLocal(reason = 'user') {
      desired = false
      mode = LocalMode.CLOUD
      emit(reason)
      return { ok: true, mode }
    },
    fallbackCloud(reason = 'user') {
      desired = false
      mode = LocalMode.CLOUD
      emit(reason === 'user' ? 'fallback-cloud' : reason)
      return { ok: true, mode }
    },
    noteKillSwitch() {
      return enterFallback('killswitch')
    },
    noteHostUnavailable(reason = 'host_unavailable') {
      return enterFallback(reason)
    },
    noteTunnelOffline() {
      if (mode !== LocalMode.LOCAL && mode !== LocalMode.FALLBACK) return { ok: true, mode }
      return enterFallback('tunnel_offline')
    },
    noteFlagOff() {
      return enterFallback('flag_off')
    },
  }
}
