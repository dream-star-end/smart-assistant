import assert from 'node:assert/strict'
import test from 'node:test'

import { refreshProductAccessToken } from '../src/productAccessToken.mjs'

test('refreshProductAccessToken reads access_token from POST /api/auth/refresh', async () => {
  const calls = []
  const result = await refreshProductAccessToken({
    publicOrigin: 'https://claudeai.chat',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return {
        ok: true,
        status: 200,
        async json() {
          return { access_token: 'jwt-abc', access_exp: 123 }
        },
      }
    },
  })
  assert.equal(calls[0].url, 'https://claudeai.chat/api/auth/refresh')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(result.ok, true)
  assert.equal(result.accessToken, 'jwt-abc')
})
