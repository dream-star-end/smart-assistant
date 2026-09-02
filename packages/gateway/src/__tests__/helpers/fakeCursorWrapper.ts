import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 单测里构造 CursorRoutingAdapter 会在构造函数里同步执行 oc-cursor 凭据选择
 * (`OPENCLAUDE_CURSOR_SELECT_ONLY=1`)。CI / 开发机没有 /run/oc/platform 与
 * /usr/local/bin/oc-cursor,只能用 OC_CURSOR_WRAPPER_BIN 指向一个确定性的假 wrapper。
 * 只覆盖 select-only 与 record-result 两条本地协议;真实 turn 明确失败(exit 97),
 * 保证任何误触真 spawn 的测试红得可见,而不是静默假绿。
 */
export function installFakeCursorWrapper(opts: { variant?: 'native' | 'sand' } = {}): string {
  const existing = process.env.OC_CURSOR_WRAPPER_BIN?.trim()
  if (existing) return existing
  const dir = mkdtempSync(join(tmpdir(), 'oc-fake-cursor-wrapper-'))
  const wrapper = join(dir, 'oc-cursor')
  const variant = opts.variant ?? 'native'
  writeFileSync(wrapper, `#!/bin/sh
set -eu
if [ "\${OPENCLAUDE_CURSOR_SELECT_ONLY:-}" = 1 ]; then
  echo 'oc-cursor: selected_slot 1 api-key ${variant} legacy 0 0123456789abcdef'
  exit 0
fi
if [ -n "\${OPENCLAUDE_CURSOR_RECORD_RESULT:-}" ]; then
  exit 0
fi
echo 'fake oc-cursor: real turns are not supported in unit tests' >&2
exit 97
`, { mode: 0o755 })
  chmodSync(wrapper, 0o755)
  process.env.OC_CURSOR_WRAPPER_BIN = wrapper
  process.on('exit', () => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  })
  return wrapper
}
