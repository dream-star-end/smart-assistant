import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachWcoGeometryListeners,
  isPositiveTitlebarGeometry,
} from '../src/shell/wco-geometry.mjs'

test('isPositiveTitlebarGeometry accepts only finite positive width and height', () => {
  assert.equal(isPositiveTitlebarGeometry(120, 44), true)
  assert.equal(isPositiveTitlebarGeometry(0, 44), false)
  assert.equal(isPositiveTitlebarGeometry(120, 0), false)
  assert.equal(isPositiveTitlebarGeometry(-1, 44), false)
  assert.equal(isPositiveTitlebarGeometry(Number.NaN, 44), false)
  assert.equal(isPositiveTitlebarGeometry(120, Number.POSITIVE_INFINITY), false)
})

test('attachWcoGeometryListeners remeasures on resize and geometrychange', () => {
  const calls = []
  const targetWindow = new EventTarget()
  const overlay = new EventTarget()
  assert.equal(
    attachWcoGeometryListeners({
      window: targetWindow,
      overlay,
      onChange: () => calls.push(calls.length + 1),
    }),
    true,
  )
  targetWindow.dispatchEvent(new Event('resize'))
  overlay.dispatchEvent(new Event('geometrychange'))
  assert.deepEqual(calls, [1, 2])
})

test('attachWcoGeometryListeners still binds resize when overlay is missing', () => {
  const calls = []
  const targetWindow = new EventTarget()
  attachWcoGeometryListeners({
    window: targetWindow,
    overlay: null,
    onChange: () => calls.push('resize'),
  })
  targetWindow.dispatchEvent(new Event('resize'))
  assert.deepEqual(calls, ['resize'])
})
