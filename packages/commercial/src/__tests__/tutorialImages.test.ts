import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import sharp from 'sharp'

import {
  TUTORIAL_IMAGE_MAX_PER_POST,
  TutorialImageError,
  communityBlogEnabled,
  detectTutorialImageMime,
  firstTutorialImageSha,
  maskTutorialImageRefs,
  parseTutorialImageRefs,
  prepareTutorialImage,
  tutorialImageRole,
  tutorialReadMinutes,
} from '../tutorials/tutorialImages.js'
import { scanMarkdownBody } from '../tutorials/snapshotSanitizer.js'

const SHA_A = 'a'.repeat(64)
const SHA_B = `${'b'.repeat(63)}c`

function solid(format: 'png' | 'jpeg' | 'webp', width = 32, height = 24) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
  })
    [format]()
    .toBuffer()
}

async function expectImageError(fn: () => unknown, code: TutorialImageError['code']) {
  await assert.rejects(
    async () => fn(),
    (error: unknown) => error instanceof TutorialImageError && error.code === code,
  )
}

describe('tutorialImages · 正文图片引用', () => {
  test('按首次出现去重；代码块里的示例不算图片', () => {
    const body = [
      `![一](tutorial-blob:${SHA_A})`,
      '```md',
      '![外链示例](https://example.com/x.png)',
      '```',
      'inline `![x](http://evil/x.png)` code',
      `![二](tutorial-blob:${SHA_B} "标题")`,
      `![重复](tutorial-blob:${SHA_A})`,
    ].join('\n')
    assert.deepEqual(parseTutorialImageRefs(body), [SHA_A, SHA_B])
    assert.equal(firstTutorialImageSha(body), SHA_A)
  })

  test('外链、data URL、短 sha、引用式图片一律拒绝', async () => {
    for (const body of [
      '![x](https://example.com/a.png)',
      '![x](//cdn.example.com/a.png)',
      '![x](data:image/png;base64,AAAA)',
      `![x](tutorial-blob:${SHA_A.slice(0, 12)})`,
      '![x][ref]\n\n[ref]: https://example.com/a.png',
      '![x]\n\n[x]: https://example.com/a.png',
    ]) {
      await expectImageError(() => parseTutorialImageRefs(body), 'EXTERNAL_IMAGE')
    }
  })

  test('病态输入线性解析：大量反引号、空格、未闭合图片不会卡住事件循环', async () => {
    const started = Date.now()
    parseTutorialImageRefs('`'.repeat(50_000))
    parseTutorialImageRefs('`a``b'.repeat(10_000))
    await expectImageError(() => parseTutorialImageRefs(`![a](${' '.repeat(50_000)}`), 'EXTERNAL_IMAGE')
    await expectImageError(() => parseTutorialImageRefs('![['.repeat(16_000)), 'EXTERNAL_IMAGE')
    assert.equal(firstTutorialImageSha('![x'.repeat(16_000)), null)
    // 长度 1..314 的反引号串各出现一次、互不配对（Codex R2 的构造）。
    parseTutorialImageRefs(`x${Array.from({ length: 314 }, (_, n) => '`'.repeat(n + 1)).join('x')}`)
    assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started}ms`)
  })

  test('围栏没闭合时其后都算代码；行内代码按同长度反引号配对', () => {
    assert.deepEqual(parseTutorialImageRefs('```\n![x](https://a/b.png)\n'), [])
    assert.deepEqual(parseTutorialImageRefs('`` a ` ![x](https://a/b.png) ``'), [])
    assert.deepEqual(parseTutorialImageRefs(`\`x\` ![](tutorial-blob:${SHA_A})`), [SHA_A])
  })

  test(`每篇最多 ${TUTORIAL_IMAGE_MAX_PER_POST} 张`, async () => {
    const shas = Array.from({ length: TUTORIAL_IMAGE_MAX_PER_POST + 1 }, (_, i) =>
      i.toString(16).padStart(64, '0'),
    )
    const body = shas.map((sha) => `![](tutorial-blob:${sha})`).join('\n')
    await expectImageError(() => parseTutorialImageRefs(body), 'TOO_MANY_IMAGES')
    assert.equal(parseTutorialImageRefs(body.split('\n').slice(1).join('\n')).length, 20)
  })

  test('图片地址遮罩后不再被泄密扫描当成 container/trace id', () => {
    // 64 位十六进制只在正文同时提到 container/peer 时才算泄密；Docker 教程很常见。
    const body = `在 container 里跑一遍\n\n![图](tutorial-blob:${SHA_A})`
    assert.notDeepEqual(scanMarkdownBody(body), [])
    assert.deepEqual(scanMarkdownBody(maskTutorialImageRefs(body)), [])
  })

  test('role 取 sha 前 12 位，撞了用全长', () => {
    const taken = new Set([`image:${SHA_A.slice(0, 12)}`])
    assert.equal(tutorialImageRole(SHA_B, new Set()), `image:${SHA_B.slice(0, 12)}`)
    assert.equal(tutorialImageRole(SHA_A, taken), `image:${SHA_A}`)
  })

  test('阅读时长按 400 字/分钟，至少 1 分钟', () => {
    assert.equal(tutorialReadMinutes(0), 1)
    assert.equal(tutorialReadMinutes(400), 1)
    assert.equal(tutorialReadMinutes(401), 2)
    assert.equal(tutorialReadMinutes(50_000), 125)
  })

  test('开关只认 1/true', () => {
    assert.equal(communityBlogEnabled({ OC_COMMUNITY_BLOG_ENABLED: '1' }), true)
    assert.equal(communityBlogEnabled({ OC_COMMUNITY_BLOG_ENABLED: 'TRUE' }), true)
    assert.equal(communityBlogEnabled({ OC_COMMUNITY_BLOG_ENABLED: '0' }), false)
    assert.equal(communityBlogEnabled({}), false)
  })
})

describe('tutorialImages · 上传字节校验', () => {
  test('魔数判定 png/jpeg/webp；SVG、GIF 不认', async () => {
    assert.equal(detectTutorialImageMime(await solid('png')), 'image/png')
    assert.equal(detectTutorialImageMime(await solid('jpeg')), 'image/jpeg')
    assert.equal(detectTutorialImageMime(await solid('webp')), 'image/webp')
    assert.equal(detectTutorialImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
    assert.equal(detectTutorialImageMime(Buffer.from('GIF89a\x01\x00\x01\x00')), null)
  })

  test('png/webp 原样保留像素，去掉文本与 EXIF 块；sha 对应输出字节', async () => {
    const png = await sharp(await solid('png'))
      .withMetadata({ exif: { IFD0: { Copyright: 'secret-owner' } } })
      .png()
      .toBuffer()
    assert.ok(png.includes(Buffer.from('secret-owner')))
    const prepared = await prepareTutorialImage(png, 'image/png')
    assert.equal(prepared.mime, 'image/png')
    assert.equal(prepared.width, 32)
    assert.equal(prepared.height, 24)
    assert.ok(!prepared.body.includes(Buffer.from('secret-owner')))
    const webp = await prepareTutorialImage(await solid('webp'), 'image/webp')
    assert.equal(webp.mime, 'image/webp')
  })

  test('jpeg 转 webp，EXIF/GPS 不保留', async () => {
    const jpeg = await sharp(await solid('jpeg'))
      .withMetadata({ exif: { IFD0: { Copyright: 'gps-owner' } } })
      .jpeg()
      .toBuffer()
    assert.ok(jpeg.includes(Buffer.from('gps-owner')))
    const prepared = await prepareTutorialImage(jpeg, 'image/jpg')
    assert.equal(prepared.mime, 'image/webp')
    assert.ok(!prepared.body.includes(Buffer.from('gps-owner')))
    const meta = await sharp(prepared.body).metadata()
    assert.equal(meta.exif, undefined)
  })

  test('Content-Type 与真实格式不符、伪装格式、动图、空文件一律拒绝', async () => {
    await expectImageError(async () => prepareTutorialImage(await solid('png'), 'image/webp'), 'BAD_IMAGE')
    await expectImageError(
      () => prepareTutorialImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/png'),
      'BAD_IMAGE',
    )
    await expectImageError(() => prepareTutorialImage(Buffer.alloc(0), 'image/png'), 'BAD_IMAGE')
    // 头部完好、像素流损坏：metadata() 能读，完整解码失败。
    const broken = Buffer.from(await solid('png', 64, 64))
    const idat = broken.indexOf(Buffer.from('IDAT'))
    broken.fill(0, idat + 4, idat + 24)
    await expectImageError(() => prepareTutorialImage(broken, 'image/png'), 'BAD_IMAGE')
    // 两帧必须不同，否则 libwebp 会把重复帧合并成静态图。
    const frame = (background: string) =>
      sharp({ create: { width: 8, height: 8, channels: 3, background } }).webp().toBuffer()
    const animated = await sharp([await frame('#123456'), await frame('#654321')], {
      join: { animated: true },
    })
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer()
    assert.equal((await sharp(animated, { animated: true }).metadata()).pages, 2)
    await expectImageError(() => prepareTutorialImage(animated, 'image/webp'), 'BAD_IMAGE')
  })

  test('超过 10MB 直接拒绝', async () => {
    const big = Buffer.concat([await solid('png'), Buffer.alloc(10 * 1024 * 1024)])
    await expectImageError(() => prepareTutorialImage(big, 'image/png'), 'TOO_LARGE')
  })
})
