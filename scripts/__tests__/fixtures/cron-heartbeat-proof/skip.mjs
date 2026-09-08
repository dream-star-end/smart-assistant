import { test } from 'node:test'
import { NAMES } from './names.mjs'

for (const [i, name] of NAMES.entries()) {
  test(name, { skip: i === 0 }, () => {})
}
