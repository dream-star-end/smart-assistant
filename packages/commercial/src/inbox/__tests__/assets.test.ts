import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import sharp from 'sharp'
import {
  InboxAssetValidationError,
  MAX_INBOX_ASSET_OUTPUT_SIDE,
  prepareInboxRichBody,
} from '../assets.js'

const CLIENT_ID = '550e8400-e29b-41d4-a716-446655440000'

async function png(width = 8, height = 6): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 35, g: 99, b: 220, alpha: 1 } },
  })
    .png()
    .toBuffer()
}

describe('inbox rich assets', () => {
  test('旧 payload 无图片时正文逐字保留', async () => {
    const body = '# 标题\n\n普通 **Markdown**'
    assert.deepEqual(await prepareInboxRichBody(body, undefined), { bodyMd: body, assets: [] })
  })

  test('PNG 占位符变成服务端 UUID URL，字节归一为静态 WebP', async () => {
    const source = await png()
    const result = await prepareInboxRichBody(`![示意图](inbox-asset://${CLIENT_ID})`, [
      {
        client_id: CLIENT_ID,
        filename: 'demo.png',
        mime_type: 'image/png',
        data_base64: source.toString('base64'),
      },
    ])
    assert.match(result.bodyMd, /^!\[示意图\]\(\/api\/inbox-assets\/[0-9a-f-]{36}\)$/)
    assert.ok(!result.bodyMd.includes(source.toString('base64')), '正文不得泄露 base64')
    assert.equal(result.assets.length, 1)
    assert.equal(result.assets[0]!.mimeType, 'image/webp')
    assert.equal(result.assets[0]!.filename, 'demo.webp')
    assert.equal(result.assets[0]!.sha256.length, 64)
    const metadata = await sharp(result.assets[0]!.data).metadata()
    assert.equal(metadata.format, 'webp')
    assert.equal(metadata.pages ?? 1, 1)
  })

  test('超长边会缩到 8,192 px 内', async () => {
    const source = await png(9_000, 1)
    const result = await prepareInboxRichBody(`![](inbox-asset://${CLIENT_ID})`, [
      {
        client_id: CLIENT_ID,
        filename: 'wide.png',
        mime_type: 'image/png',
        data_base64: source.toString('base64'),
      },
    ])
    const metadata = await sharp(result.assets[0]!.data).metadata()
    assert.ok((metadata.width ?? 0) <= MAX_INBOX_ASSET_OUTPUT_SIDE)
    assert.ok((metadata.height ?? 0) <= MAX_INBOX_ASSET_OUTPUT_SIDE)
  })

  test('拒绝 MIME 伪装、未知引用与未引用上传', async () => {
    const source = await png()
    const base = {
      client_id: CLIENT_ID,
      filename: 'demo.jpg',
      mime_type: 'image/jpeg' as const,
      data_base64: source.toString('base64'),
    }
    await assert.rejects(
      () => prepareInboxRichBody(`![](inbox-asset://${CLIENT_ID})`, [base]),
      (error: unknown) => error instanceof InboxAssetValidationError && /MIME/.test(error.message),
    )
    await assert.rejects(
      () => prepareInboxRichBody(`![](inbox-asset://${CLIENT_ID})`, []),
      (error: unknown) =>
        error instanceof InboxAssetValidationError && /未上传/.test(error.message),
    )
    await assert.rejects(
      () => prepareInboxRichBody('![](inbox-asset://not-a-uuid)', []),
      (error: unknown) =>
        error instanceof InboxAssetValidationError && /格式错误/.test(error.message),
    )
    await assert.rejects(
      () => prepareInboxRichBody('没有图片引用', [{ ...base, mime_type: 'image/png' }]),
      (error: unknown) =>
        error instanceof InboxAssetValidationError && /必须在正文中引用/.test(error.message),
    )
  })

  test('拒绝手写复用已存资产 URL', async () => {
    await assert.rejects(
      () => prepareInboxRichBody(`/api/inbox-assets/${CLIENT_ID}`, undefined),
      (error: unknown) =>
        error instanceof InboxAssetValidationError && /不能直接复用/.test(error.message),
    )
  })
})
