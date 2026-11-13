import { signAccess } from '../auth/jwt.js'
import assert from 'node:assert/strict'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { dispatchSessionMetadataRead } from '../http/sessionMetadata.js'
import type { CommercialHttpDeps, RequestContext } from '../http/handlers.js'
const deps = { jwtSecret: 'synthetic-ephemeral-test-key-with-no-product-access' } as CommercialHttpDeps
const context = {} as RequestContext
const response = {} as ServerResponse
test('the new read dispatcher preserves the existing session GitHub route and unknown suffixes', async () => {
  for (const url of ['/api/me/sessions/target/github-selection','/api/me/sessions/target/other']) {
    const request = { url, headers: {} } as IncomingMessage
    let calls = 0
    await dispatchSessionMetadataRead(request, response, context, deps, async (req,res,ctx,used) => { calls++; assert.equal(req, request); assert.equal(res, response); assert.equal(ctx, context); assert.equal(used, deps) })
    assert.equal(calls, 1)
  }
})
test('the exact metadata path rejects missing browser authentication before any PG lookup', async () => {
  const request = { url: '/api/me/sessions/target/metadata', headers: {} } as IncomingMessage
  await assert.rejects(dispatchSessionMetadataRead(request, response, context, deps, async () => { throw new Error('must not delegate metadata') }), error => (error as { status: number }).status === 401)
})

test('an authenticated read without an explicitly registered PG session authority is unavailable before PG access', async () => {
  const { token } = await signAccess({ sub: '765', role: 'user' }, deps.jwtSecret)
  const request = { url: '/api/me/sessions/target/metadata', headers: { authorization: `Bearer ${token}` } } as IncomingMessage
  await assert.rejects(dispatchSessionMetadataRead(request,response,context,deps,async () => {}), error => (error as { status: number }).status === 503)
})
