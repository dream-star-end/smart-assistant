import { writeFileSync } from 'node:fs'
import { test } from 'node:test'

test('hold grandchild until supervisor stops the group', { timeout: 60_000 }, async () => {
  const marker = process.env.OC_PROOF_HOLD_MARKER
  if (!marker) throw new Error('OC_PROOF_HOLD_MARKER required')
  writeFileSync(
    marker,
    JSON.stringify({
      pid: process.pid,
      ppid: process.ppid,
      home: process.env.HOME,
      tmp: process.env.TMPDIR,
    }),
  )
  await new Promise(() => {
    setInterval(() => {}, 1000).unref()
    setInterval(() => {}, 60_000)
  })
})
