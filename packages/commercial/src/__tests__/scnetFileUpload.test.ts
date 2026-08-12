import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { describe, test } from 'node:test'

import {
  type ScnetUploadCredential,
  ScnetUploadHttpError,
  uploadScnetFile,
  validateScnetUploadCredential,
} from '../ocr/scnetFileUpload.js'

const credential: ScnetUploadCredential = {
  uploadUrl: 'https://uploads.example:58003/llm',
  fileUrl: 'https://uploads.example:58003/llm/uploads/job.pdf?signature=x',
  policy: 'policy-value',
  algorithm: 'AWS4-HMAC-SHA256',
  credential: 'credential-value',
  date: '20260811T000000Z',
  signature: 'signature-value',
  key: '/uploads/job.pdf',
}

describe('SCNet pinned file upload', () => {
  test('streams an exact-length signed multipart body and closes after the response body', async () => {
    let closed = false
    let uploaded = Buffer.alloc(0)
    await uploadScnetFile(
      {
        credential,
        source: Readable.from([Buffer.from('stream-'), Buffer.from('me')]),
        filename: 'table.pdf',
        contentType: 'application/pdf',
        contentLength: 9n,
      },
      {
        resolver: {
          resolve4: async () => ['203.0.114.10'],
          resolve6: async () => [],
        },
        makeDispatcher: (() => ({
          close: async () => {
            closed = true
          },
        })) as any,
        fetchImpl: async (url, init) => {
          assert.equal(url, credential.uploadUrl)
          assert.equal(init.redirect, 'error')
          assert.equal('signal' in init, false)
          const chunks: Buffer[] = []
          for await (const chunk of init.body as AsyncIterable<Buffer>) {
            assert.equal(closed, false)
            chunks.push(Buffer.from(chunk))
          }
          uploaded = Buffer.concat(chunks)
          assert.equal(
            (init.headers as Record<string, string>)['content-length'],
            `${uploaded.length}`,
          )
          return new Response(
            new ReadableStream({
              async start(controller) {
                await new Promise((done) => setTimeout(done, 30))
                assert.equal(closed, false)
                controller.enqueue(new TextEncoder().encode('ok'))
                controller.close()
              },
            }),
          )
        },
      },
    )
    assert.equal(closed, true)
    const body = uploaded.toString('utf8')
    assert.match(body, /name="policy"\r\n\r\npolicy-value/)
    assert.match(body, /name="x-amz-signature"\r\n\r\nsignature-value/)
    assert.match(body, /name="key"\r\n\r\n\/uploads\/job\.pdf/)
    assert.match(body, /name="file"; filename="table\.pdf"/)
    assert.match(body, /stream-me/)
  })

  test('rejects private DNS answers before upload', async () => {
    let fetched = false
    await assert.rejects(
      uploadScnetFile(
        {
          credential,
          source: Readable.from('x'),
          filename: 'x.pdf',
          contentType: 'application/pdf',
          contentLength: 1n,
        },
        {
          resolver: {
            resolve4: async () => ['127.0.0.1'],
            resolve6: async () => [],
          },
          fetchImpl: async () => {
            fetched = true
            return new Response()
          },
        },
      ),
      /global unicast/,
    )
    assert.equal(fetched, false)
  })

  test('rejects redirects and closes the dispatcher', async () => {
    let closed = false
    await assert.rejects(
      uploadScnetFile(
        {
          credential,
          source: Readable.from('x'),
          filename: 'x.pdf',
          contentType: 'application/pdf',
          contentLength: 1n,
        },
        {
          resolver: {
            resolve4: async () => ['203.0.114.10'],
            resolve6: async () => [],
          },
          makeDispatcher: (() => ({
            close: async () => {
              closed = true
            },
          })) as any,
          fetchImpl: async () => new Response(null, { status: 302 }),
        },
      ),
      (error: unknown) => error instanceof ScnetUploadHttpError && error.status === 302,
    )
    assert.equal(closed, true)
  })

  test('validates both provider URLs as HTTPS before use', () => {
    assert.throws(
      () =>
        validateScnetUploadCredential({
          upload_url: credential.uploadUrl,
          file_url: 'http://127.0.0.1/file',
          policy: credential.policy,
          x_amz_algorithm: credential.algorithm,
          x_amz_credential: credential.credential,
          x_amz_date: credential.date,
          x_amz_signature: credential.signature,
          key: credential.key,
        }),
      /HTTPS-only/,
    )
  })
})
