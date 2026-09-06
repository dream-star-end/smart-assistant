import assert from 'node:assert/strict'
import test from 'node:test'

import {
  formatSmokeFailureReport,
  resolveSmokeReportMode,
  shouldWriteSmokeFailureReport,
} from '../src/smokeReport.mjs'

test('W-R2-3 local-host smoke failures write a report with mode smoke-local-host', () => {
  assert.equal(shouldWriteSmokeFailureReport({ smokeTest: false, smokeLocalHost: false }), false)
  assert.equal(shouldWriteSmokeFailureReport({ smokeTest: true, smokeLocalHost: false }), true)
  assert.equal(shouldWriteSmokeFailureReport({ smokeTest: false, smokeLocalHost: true }), true)
  assert.equal(resolveSmokeReportMode({ stage: 'local-host', smokeLocalHost: true }), 'smoke-local-host')
  const body = formatSmokeFailureReport({
    stage: 'local-host',
    error: new Error('host did not send ready'),
    mode: 'smoke-local-host',
  })
  assert.match(body, /^\[windows\] local-host failed:\nmode: smoke-local-host\n/)
  assert.equal(body.includes('host did not send ready'), true)
})
