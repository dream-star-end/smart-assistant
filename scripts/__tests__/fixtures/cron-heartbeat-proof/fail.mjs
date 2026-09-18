import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NAMES } from './names.mjs'

for (const [i, name] of NAMES.entries()) {
  test(name, () => {
    if (i === 0) assert.equal(0, 1, 'fixture controlled fail')
  })
}
