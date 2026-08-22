/**
 * Runtime lock: PG sessions backend imports this symbol from the package
 * entry. Path-mapped tsc can hide a missing public export; this import
 * goes through the storage index barrel.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { planReplaceServerAuthoredKeepingOrderSlots } from '../index.js'

test('storage package entry re-exports planReplaceServerAuthoredKeepingOrderSlots', () => {
  assert.equal(typeof planReplaceServerAuthoredKeepingOrderSlots, 'function')
})
