import assert from 'node:assert/strict'
import test from 'node:test'

import { TOOLBAR_HEIGHT, calculateViewBounds } from '../src/window-layout.mjs'

test('toolbar mode reserves a fixed product offset without overlap', () => {
  assert.equal(TOOLBAR_HEIGHT, 52)
  assert.deepEqual(calculateViewBounds({ width: 1280, height: 800 }), {
    shell: { x: 0, y: 0, width: 1280, height: 52 },
    product: { x: 0, y: 52, width: 1280, height: 748 },
  })
})

test('downloads mode covers the full product surface while product bounds stay stable', () => {
  const toolbar = calculateViewBounds({ width: 900, height: 700 })
  const downloads = calculateViewBounds({ width: 900, height: 700 }, { shellMode: 'downloads' })

  assert.deepEqual(downloads.shell, { x: 0, y: 0, width: 900, height: 700 })
  assert.deepEqual(downloads.product, toolbar.product)
})

test('shell modes clamp to small content areas', () => {
  assert.deepEqual(
    calculateViewBounds({ width: 500.9, height: 40.7 }, { shellMode: 'downloads' }),
    {
      shell: { x: 0, y: 0, width: 500, height: 40 },
      product: { x: 0, y: 40, width: 500, height: 0 },
    },
  )
  assert.equal(
    calculateViewBounds({ width: 500, height: 400 }, { shellMode: 'offline' }).shell.height,
    400,
  )
})

test('invalid dimensions fail closed to non-negative empty bounds', () => {
  assert.deepEqual(calculateViewBounds({ width: -1, height: Number.NaN }), {
    shell: { x: 0, y: 0, width: 0, height: 0 },
    product: { x: 0, y: 0, width: 0, height: 0 },
  })
})
