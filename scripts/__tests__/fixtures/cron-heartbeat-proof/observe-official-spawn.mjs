import cp from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const spawn = cp.spawn
let hooked = false
cp.spawn = function (...args) {
  const child = Reflect.apply(spawn, this, args)
  const argv = args[1]
  const tmp = process.env.TMPDIR
  if (!hooked && tmp && Array.isArray(argv) && argv.includes('--test')) {
    hooked = true
    writeFileSync(
      join(tmp, 'observer-child.json'),
      `${JSON.stringify({ pid: child.pid, args: argv })}\n`,
    )
    child.stdout?.on('data', (buf) => {
      try {
        appendFileSync(join(tmp, 'observer-child.stdout'), buf)
      } catch {
        // isolation dir may already be gone during bounded cleanup
      }
    })
    child.stderr?.on('data', (buf) => {
      try {
        appendFileSync(join(tmp, 'observer-child.stderr'), buf)
      } catch {
        // isolation dir may already be gone during bounded cleanup
      }
    })
  }
  return child
}
syncBuiltinESMExports()
