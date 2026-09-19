import { test } from 'node:test'
import { NAMES } from './names.mjs'

test(NAMES[0], async () => {
  await new Promise(() => {})
})
