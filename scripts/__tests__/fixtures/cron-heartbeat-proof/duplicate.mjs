import { test } from 'node:test'
import { NAMES } from './names.mjs'

const names = [NAMES[0], NAMES[0], ...NAMES.slice(1, 11)]
for (const name of names) {
  test(name, () => {})
}
