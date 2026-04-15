import { describe, it } from 'node:test'
import * as assert from 'node:assert/strict'
import { parseVerificationVerdict } from '../sessionManager.js'

describe('parseVerificationVerdict', () => {
  it('returns null when no VERDICT line present', () => {
    assert.equal(parseVerificationVerdict('just some text'), null)
    assert.equal(parseVerificationVerdict('VERDICT looks like a verdict'), null)
  })

  it('parses PASS verdict with checks', () => {
    const text = `
### Check: Build succeeds
**Command run:**
  npm run build
**Output observed:**
  Build complete
**Result: PASS**

### Check: Tests pass
**Command run:**
  npm test
**Output observed:**
  42 passing
**Result: PASS**

VERDICT: PASS
`
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.equal(result.verdict, 'PASS')
    assert.equal(result.passed, true)
    assert.equal(result.evidence.length, 2)
    assert.equal(result.evidence[0].check, 'Build succeeds')
    assert.equal(result.evidence[0].passed, true)
    assert.equal(result.evidence[1].check, 'Tests pass')
    assert.equal(result.evidence[1].passed, true)
  })

  it('parses FAIL verdict with mixed check results', () => {
    const text = `
### Check: Build succeeds
**Command run:** npm run build
**Output observed:** Build complete
**Result: PASS**

### Check: API endpoint returns 200
**Command run:** curl -s localhost:3000/api/health
**Output observed:** Connection refused
**Expected vs Actual:** Expected 200, got connection refused
**Result: FAIL**

VERDICT: FAIL
`
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.equal(result.verdict, 'FAIL')
    assert.equal(result.passed, false)
    assert.equal(result.evidence.length, 2)
    assert.equal(result.evidence[0].passed, true)
    assert.equal(result.evidence[1].passed, false)
    assert.equal(result.evidence[1].check, 'API endpoint returns 200')
  })

  it('parses PARTIAL verdict', () => {
    const text = `
### Check: Build succeeds
**Result: PASS**

VERDICT: PARTIAL
`
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.equal(result.verdict, 'PARTIAL')
    assert.equal(result.passed, false)
    assert.equal(result.evidence.length, 1)
  })

  it('handles verdict with no check blocks', () => {
    const text = 'Could not run checks.\n\nVERDICT: PARTIAL\n'
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.equal(result.verdict, 'PARTIAL')
    assert.equal(result.evidence.length, 0)
  })

  it('truncates long detail to 500 chars', () => {
    const longOutput = 'x'.repeat(1000)
    const text = `
### Check: Long output test
**Command run:** echo long
**Output observed:** ${longOutput}
**Result: PASS**

VERDICT: PASS
`
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.ok((result.evidence[0].detail?.length ?? 0) <= 500)
  })

  it('ignores "### Check:" inside code fences', () => {
    const text = `
### Check: Real check
**Command run:** echo ok
**Output observed:** ok
**Result: PASS**

Here is an example of the format:
\`\`\`
### Check: Fake check in code fence
**Result: FAIL**
\`\`\`

VERDICT: PASS
`
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.equal(result.evidence.length, 1)
    assert.equal(result.evidence[0].check, 'Real check')
  })

  it('uses last Result line when multiple exist in a block', () => {
    const text = `
### Check: API returns correct shape
**Command run:** curl localhost:3000/api/data
**Output observed:**
  **Result: PASS** appeared in the JSON output
  then later:
**Result: FAIL**

VERDICT: FAIL
`
    const result = parseVerificationVerdict(text)
    assert.ok(result)
    assert.equal(result.evidence[0].passed, false)
  })
})
