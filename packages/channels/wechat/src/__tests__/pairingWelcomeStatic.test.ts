import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const source = readFileSync(resolve(__dirname, '../pairing.ts'), 'utf8')
const resumeStart = source.indexOf('export async function resumePairing')
const resumeEnd = source.indexOf('\nexport function cancelPairing')
const resumeBody = source.slice(resumeStart, resumeEnd)

describe('pairing welcome send is best-effort after confirmed binding', () => {
  it('persists binding, releases pending QR, then fires welcome without delaying poll response', () => {
    assert.ok(source.includes('async function sendBindingWelcome'), 'welcome helper should exist')
    assert.ok(resumeStart >= 0 && resumeEnd > resumeStart, 'resumePairing body should be readable')

    const upsertIdx = resumeBody.indexOf('await upsertWechatBinding({')
    const deleteIdx = resumeBody.indexOf('PENDING.delete(qrcode)', upsertIdx)
    const welcomeIdx = resumeBody.indexOf('void sendBindingWelcome(confirmed, qrcode)', deleteIdx)

    assert.ok(upsertIdx >= 0, 'binding must be persisted before confirmed response')
    assert.ok(deleteIdx > upsertIdx, 'pending QR must be released after persistence')
    assert.ok(welcomeIdx > deleteIdx, 'welcome must be fire-and-forget after pending QR release')
    assert.doesNotMatch(resumeBody, /await\s+sendBindingWelcome/)
    assert.doesNotMatch(resumeBody, /await\s+sendIlinkText/)
  })

  it('stores QR context token when upstream provides one', () => {
    assert.match(resumeBody, /contextTokens:\s*\{\s*\[confirmed\.login_user_id\]:\s*confirmed\.context_token\s*\}/)
  })
})
