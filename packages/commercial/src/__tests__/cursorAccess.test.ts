import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { isCursorCredentialMember, parseCursorCredentialUids } from '../cursor/access.js'

describe('Cursor credential membership', () => {
  test('accepts the explicit shared members only', () => {
    assert.deepEqual([...parseCursorCredentialUids('1,4')], [1, 4])
    assert.equal(isCursorCredentialMember(1, '1,4'), true)
    assert.equal(isCursorCredentialMember(4, '1,4'), true)
    assert.equal(isCursorCredentialMember('4', '1,4'), true)
    assert.equal(isCursorCredentialMember(4n, '1,4'), true)
    assert.equal(isCursorCredentialMember(2, '1,4'), false)
    assert.equal(isCursorCredentialMember('04', '1,4'), false)
  })

  test('star/all opens every syntactically valid uid', () => {
    assert.equal(parseCursorCredentialUids('*'), 'all')
    assert.equal(parseCursorCredentialUids('all'), 'all')
    assert.equal(isCursorCredentialMember(2, '*'), true)
    assert.equal(isCursorCredentialMember(7, 'all'), true)
    assert.equal(isCursorCredentialMember('04', '*'), false)
    assert.equal(isCursorCredentialMember(0, '*'), false)
  })

  test('malformed configuration fails closed as a whole', () => {
    for (const raw of ['', '1,04', '1, 4', '1,evil', '0,1', '9007199254740992', '*,1', 'all,4']) {
      const parsed = parseCursorCredentialUids(raw)
      assert.equal(parsed === 'all' ? 'all' : parsed.size, 0, raw)
    }
  })
})
