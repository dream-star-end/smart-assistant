// Electron supports system background materials on Windows 11 22H2 (build 22621) and newer.
const WINDOWS_11_MICA_MIN_BUILD = 22_621

export function parseLaunchIntent(argv) {
  if (!Array.isArray(argv)) return null
  return argv.some((argument) => argument === '--home') ? { type: 'home' } : null
}

export function buildJumpList({ executablePath, iconPath = executablePath } = {}) {
  if (typeof executablePath !== 'string' || executablePath.length === 0) {
    throw new TypeError('buildJumpList requires executablePath')
  }
  const safeIconPath =
    typeof iconPath === 'string' && iconPath.length > 0 ? iconPath : executablePath
  return [
    {
      type: 'tasks',
      items: [
        {
          type: 'task',
          program: executablePath,
          args: '--home',
          iconPath: safeIconPath,
          iconIndex: 0,
          title: '打开主页',
          description: '打开 OpenClaude Aurora 主页',
        },
      ],
    },
  ]
}

export function installJumpList({ app, executablePath, iconPath } = {}) {
  if (!app || typeof app.setJumpList !== 'function') return false
  try {
    const resolvedExecutable =
      executablePath ||
      app.getPath?.('exe') ||
      (typeof process !== 'undefined' ? process.execPath : '')
    const result = app.setJumpList(
      buildJumpList({
        executablePath: resolvedExecutable,
        iconPath: iconPath || resolvedExecutable,
      }),
    )
    return result === 'ok'
  } catch {
    return false
  }
}

function windowsBuildNumber(systemVersion) {
  if (typeof systemVersion !== 'string') return 0
  const components = systemVersion.match(/\d+/g)?.map(Number) ?? []
  if (components.length >= 3) return components[2]
  if (components.length === 1) return components[0]
  return 0
}

export function shouldUseMica({
  platform = typeof process !== 'undefined' ? process.platform : '',
  systemVersion = '',
  forcedColors = false,
  transparencyEnabled = true,
  reduceTransparency = false,
  micaSupported = true,
} = {}) {
  return (
    platform === 'win32' &&
    windowsBuildNumber(systemVersion) >= WINDOWS_11_MICA_MIN_BUILD &&
    forcedColors !== true &&
    transparencyEnabled !== false &&
    reduceTransparency !== true &&
    micaSupported === true
  )
}

export function applyWindowsAppearance({
  window,
  nativeTheme,
  platform = typeof process !== 'undefined' ? process.platform : '',
  systemVersion = '',
  transparencyEnabled = true,
  reduceTransparency = false,
} = {}) {
  const dark = nativeTheme?.shouldUseDarkColors === true
  const forcedColors =
    nativeTheme?.inForcedColorsMode === true || nativeTheme?.shouldUseHighContrastColors === true
  const opaqueColor = forcedColors ? (dark ? '#000000' : '#ffffff') : dark ? '#202020' : '#f7f7f7'
  const micaSupported = typeof window?.setBackgroundMaterial === 'function'
  const wantsMica = shouldUseMica({
    platform,
    systemVersion,
    forcedColors,
    transparencyEnabled,
    reduceTransparency,
    micaSupported,
  })

  if (wantsMica) {
    try {
      window.setBackgroundMaterial('mica')
      window.setBackgroundColor?.('#00000000')
      return { usedMica: true, material: 'mica', backgroundColor: '#00000000' }
    } catch {
      // Fall through to the opaque Windows 10/high-contrast-safe surface.
    }
  }

  try {
    window?.setBackgroundMaterial?.('none')
  } catch {
    // An unavailable material API must not prevent the opaque fallback.
  }
  try {
    window?.setBackgroundColor?.(opaqueColor)
  } catch {
    // Appearance is best effort; callers can still create and show the window.
  }
  return { usedMica: false, material: 'none', backgroundColor: opaqueColor }
}

function run(actions, name) {
  const action = actions?.[name]
  if (typeof action !== 'function') return false
  action()
  return true
}

export function handleDesktopShortcut(input, actions = {}) {
  if (!input || input.type !== 'keyDown') return false
  const key = typeof input.key === 'string' ? input.key : ''
  const lowerKey = key.toLowerCase()
  const lowerKeyCode = String(input.keyCode ?? '').toLowerCase()
  if (
    input.isComposing === true ||
    ['229', 'process', 'processkey', 'dead', 'unidentified'].includes(lowerKey) ||
    ['229', 'process', 'processkey', 'dead', 'unidentified'].includes(lowerKeyCode)
  ) {
    return false
  }

  const control = input.control === true
  const alt = input.alt === true
  const shift = input.shift === true
  const meta = input.meta === true

  if (alt && !control && !shift && !meta) {
    if (lowerKey === 'arrowleft') return run(actions, 'back')
    if (lowerKey === 'arrowright') return run(actions, 'forward')
    return false
  }
  if (!control || alt || meta) return false
  if (lowerKey === 'r' && !shift) return run(actions, 'reload')
  if (key === '+' || key === '=' || lowerKey === 'add') return run(actions, 'zoomIn')
  if (key === '-' || lowerKey === 'subtract') return run(actions, 'zoomOut')
  if (key === '0' || lowerKey === 'numpad0') return run(actions, 'zoomReset')
  return false
}
