import { test } from 'node:test'
import { NAMES } from './names.mjs'

for (const name of NAMES.slice(0, 11)) {
  test(name, () => {})
}
