import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isCursorEngineModel } from '../engineModels.js'
import { canUseCc5TestModel, isCc5ConfiguredTestUid, isCc5TestModel } from '../cc5TestModel.js'

const enabled = { OC_SELFHOST_CC5_T1555U_ENABLED: '1', OC_SELFHOST_CC5_T1555U_TEST_UID: '314159' }

test('cc5 has exact model identity and default-off execution', () => {
  assert.equal(isCc5TestModel('cc5-remote-t1555u'), true)
  // The old task policy remains a compatibility leaf, but is no longer a catalog/engine model.
  assert.equal(isCursorEngineModel('cc5-remote-t1555u'), false)
  for (const value of [null, '', 'CC5-remote-t1555u', 'cc5-remote-t1555u ', 'cursor-auto']) {
    assert.equal(isCc5TestModel(value), false)
  }
  for (const flag of [undefined, '', '0', 'true', 'all', ' 1']) {
    assert.equal(canUseCc5TestModel(314159, { ...enabled, OC_SELFHOST_CC5_T1555U_ENABLED: flag }), false)
  }
})

test('only the single configured positive test UID is admitted', () => {
  for (const uid of [314159, '314159', 314159n]) assert.equal(canUseCc5TestModel(uid, enabled), true)
  for (const uid of [undefined, null, 0, 3, 765, -1, 1.5, 'all', '314159,3', '0314159', ' 314159', 2 ** 54]) {
    assert.equal(canUseCc5TestModel(uid, enabled), false)
  }
  for (const configured of [undefined, '', 'all', '0', '-1', '3,314159', '0314159', '9223372036854775808']) {
    assert.equal(canUseCc5TestModel(314159, { ...enabled, OC_SELFHOST_CC5_T1555U_TEST_UID: configured }), false)
  }
  assert.equal(isCc5ConfiguredTestUid(314159, { OC_SELFHOST_CC5_T1555U_TEST_UID: '314159' }), true)
  assert.equal(canUseCc5TestModel(314159, { OC_SELFHOST_CC5_T1555U_TEST_UID: '314159' }), false)
})
