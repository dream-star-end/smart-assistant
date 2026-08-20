import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  sanitizeTutorialSnapshot,
  scanArtifactBytes,
  scanJsonValue,
  scanMarkdownBody,
  scanText,
} from '../tutorials/snapshotSanitizer.js'

test('scanner catches secrets, identity, paths, signed media and schemes without echoing values', () => {
  const leaks = [
    ...scanText('token sk-abcdefghijklmnopqrstuvwxyz123456', 'text'),
    ...scanText('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', 'key'),
    ...scanText('mail me at owner@example.com please', 'text'),
    ...scanText('call +1 415-555-0100 now', 'text'),
    ...scanText('see /home/agent/.openclaude/generated/a.txt', 'text'),
    ...scanText('session_id=abc', 'text'),
    ...scanText('trace_id=deadbeef', 'text'),
    ...scanText('https://x.test/api/media-signed?t=abc', 'text'),
    ...scanText('javascript:alert(1)', 'html'),
    ...scanText('<img src="https://tracker.test/x.gif">', 'html'),
    ...scanText('fetch("https://exfil.test")', 'js'),
    ...scanText('Authorization: Bearer supersecretvalue1234567890', 'auth'),
    ...scanText('OPENAI_API_KEY=AbCdEfGhIjKlMnOpQrStUvWx12345678', 'env'),
    ...scanText('password=correct-horse-battery-staple', 'env'),
  ]
  assert.ok(leaks.length >= 8)
  assert.ok(leaks.every((row) => row.field && row.rule && !JSON.stringify(row).includes('sk-abc')))
  assert.ok(scanJsonValue({ apiKey: 'AbCdEfGhIjKlMnOpQrStUvWx12345678' }, 'json').length > 0)
})

test('unknown and svg artifacts cannot be published', () => {
  const svg = scanArtifactBytes('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'file')
  assert.equal(svg[0]?.rule, 'svg_embed_forbidden')
  const bin = scanArtifactBytes('application/octet-stream', Buffer.from('xxxx'), 'file')
  assert.equal(bin[0]?.rule, 'metadata_unsupported')
  const fakePdf = scanArtifactBytes('application/pdf', Buffer.from('%PDF-1.7 secret'), 'file')
  assert.equal(fakePdf[0]?.rule, 'metadata_unsupported')
})

test('snapshot sanitizer rewrites ids, strips internal roles, and requires explicit artifacts', () => {
  const stripped = sanitizeTutorialSnapshot({
    messages: [
      { id: 'msg-1', role: 'system', text: 'internal', ts: 1 },
      { id: 'msg-2', role: 'user', text: '请分析这份公开数据', ts: 2 },
      { id: 'msg-3', role: 'assistant', text: '结论如下', ts: 3 },
    ],
  })
  assert.equal(stripped.ok, true)
  if (stripped.ok) {
    assert.deepEqual(
      stripped.messages.map((row) => row.id),
      ['tutorial-1', 'tutorial-2'],
    )
    assert.deepEqual(
      stripped.messages.map((row) => row.role),
      ['user', 'assistant'],
    )
  }

  const leaked = sanitizeTutorialSnapshot({
    messages: [{ id: 'x', role: 'user', text: 'send to admin@example.com', ts: 1 }],
  })
  assert.equal(leaked.ok, false)
  if (!leaked.ok) {
    assert.equal(leaked.leakReport.leaks[0]?.rule, 'email')
    assert.equal(JSON.stringify(leaked.leakReport).includes('admin@example.com'), false)
  }

  const unselected = sanitizeTutorialSnapshot({
    messages: [
      {
        id: 'x',
        role: 'assistant',
        text: '交付 /home/agent/.openclaude/generated/report.md',
        ts: 1,
      },
    ],
  })
  assert.equal(unselected.ok, false)
  if (!unselected.ok) {
    assert.ok(unselected.leakReport.leaks.some((row) => row.rule === 'unselected_artifact' || row.rule === 'absolute_path'))
  }
})

test('thinking with secrets is stripped rather than published', () => {
  const result = sanitizeTutorialSnapshot({
    messages: [
      { id: 'u', role: 'user', text: '请写报告', ts: 1 },
      { id: 't', role: 'thinking', text: 'token sk-abcdefghijklmnopqrstuvwxyz123456', ts: 2 },
      { id: 'a', role: 'assistant', text: '已完成', ts: 3 },
    ],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.messages.some((row) => row.role === 'thinking'), false)
    assert.equal(result.messages.length, 2)
  }
})

test('markdown body scanner is used for community posts', () => {
  const leaks = scanMarkdownBody('![x](https://tracker.test/p.png)\n\n```htmlpreview\n<script src="https://x"></script>\n```')
  assert.ok(leaks.some((row) => row.rule === 'html_external' || row.rule === 'network_api'))
})

test('explicit html artifact is classified as htmlpreview when clean', () => {
  const html = Buffer.from('<div>hello</div>').toString('base64')
  const result = sanitizeTutorialSnapshot({
    messages: [
      { id: 'u', role: 'user', text: '做个页面', ts: 1 },
      { id: 'a', role: 'assistant', text: '已生成预览', ts: 2 },
    ],
    selectedArtifacts: [{
      name: 'demo.html',
      mimeType: 'text/html',
      contentBase64: html,
      sourcePath: '/home/agent/.openclaude/generated/demo.html',
    }],
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.blobs.some((blob) => blob.kind === 'htmlpreview'), true)
    assert.ok(result.manifest.artifacts.some((row) => row.mimeType === 'text/html'))
  }
})

test('html navigation primitives are rejected; html stays in manifest with other artifacts', () => {
  const nav = Buffer.from('<meta http-equiv="refresh" content="0;url=https://evil.test">').toString('base64')
  const leaked = sanitizeTutorialSnapshot({
    messages: [{ id: 'u', role: 'user', text: '做个页面', ts: 1 }],
    selectedArtifacts: [{
      name: 'nav.html',
      mimeType: 'text/html',
      contentBase64: nav,
      sourcePath: '/home/agent/.openclaude/generated/nav.html',
    }],
  })
  assert.equal(leaked.ok, false)
  if (!leaked.ok) {
    assert.ok(leaked.leakReport.leaks.some((row) => row.rule === 'html_navigation'))
  }

  const loc = Buffer.from('<script>window.location.assign("https://evil.test")</script>').toString('base64')
  const locResult = sanitizeTutorialSnapshot({
    messages: [{ id: 'u', role: 'user', text: '做个页面', ts: 1 }],
    selectedArtifacts: [{
      name: 'loc.html',
      mimeType: 'text/html',
      contentBase64: loc,
      sourcePath: '/home/agent/.openclaude/generated/loc.html',
    }],
  })
  assert.equal(locResult.ok, false)

  const html = Buffer.from('<div>hello</div>').toString('base64')
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  const both = sanitizeTutorialSnapshot({
    messages: [
      { id: 'u', role: 'user', text: '做个页面', ts: 1 },
      { id: 'a', role: 'assistant', text: '已生成预览', ts: 2 },
    ],
    selectedArtifacts: [
      {
        name: 'demo.html',
        mimeType: 'text/html',
        contentBase64: html,
        sourcePath: '/home/agent/.openclaude/generated/demo.html',
      },
      {
        name: 'shot.png',
        mimeType: 'image/png',
        contentBase64: png,
        sourcePath: '/home/agent/.openclaude/generated/shot.png',
      },
    ],
  })
  assert.equal(both.ok, true)
  if (both.ok) {
    assert.ok(both.manifest.artifacts.some((row) => row.mimeType === 'text/html'))
    assert.ok(both.manifest.artifacts.some((row) => row.mimeType === 'image/png'))
  }
})

test('strict canonical base64, 48MiB body constant and 32MiB decoded cap', async () => {
  const { TUTORIAL_SNAPSHOT_MAX_BODY_BYTES, SNAPSHOT_MAX_TOTAL_ARTIFACT_BYTES, decodeCanonicalBase64 } =
    await import('../tutorials/snapshotSanitizer.js')
  assert.equal(TUTORIAL_SNAPSHOT_MAX_BODY_BYTES, 48 * 1024 * 1024)
  assert.equal(SNAPSHOT_MAX_TOTAL_ARTIFACT_BYTES, 32 * 1024 * 1024)
  assert.equal(decodeCanonicalBase64('abc'), null)
  assert.equal(decodeCanonicalBase64('ab cd'), null)
  assert.equal(decodeCanonicalBase64('YQ==\n'), null)
  const ok = decodeCanonicalBase64(Buffer.from('hi').toString('base64'))
  assert.ok(ok && ok.equals(Buffer.from('hi')))

  const chunk = Buffer.alloc(7 * 1024 * 1024, 1)
  const encoded = chunk.toString('base64')
  const oversized = sanitizeTutorialSnapshot({
    messages: [{ id: 'u', role: 'user', text: '打包成果', ts: 1 }],
    selectedArtifacts: [1, 2, 3, 4, 5].map((n) => ({
      name: `part${n}.bin`,
      mimeType: 'application/pdf',
      contentBase64: encoded,
      sourcePath: `/home/agent/.openclaude/generated/part${n}.pdf`,
    })),
  })
  assert.equal(oversized.ok, false)
})

test('complete sanitized timeline is split into ordered 50-message pages without truncation', () => {
  const input = Array.from({ length: 51 }, (_, index) => ({
    id: `m-${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `公开消息 ${index}`,
    ts: index + 1,
  }))
  const result = sanitizeTutorialSnapshot({ messages: input })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.messages.length, 51)
  assert.deepEqual(
    result.manifest.pages.map((page) => ({
      role: page.role,
      count: page.messageCount,
      start: page.startOrdinal,
    })),
    [
      { role: 'messages:0001', count: 50, start: 0 },
      { role: 'messages:0002', count: 1, start: 50 },
    ],
  )
  const messageBlobs = result.blobs.filter((blob) => blob.kind === 'messages')
  assert.equal(messageBlobs.length, 2)
  assert.equal(JSON.parse(messageBlobs[1]!.body.toString('utf8')).pageIndex, 1)
})

test('selected generated path is rewritten and rich tool/plan/goal/agent fields survive safely', () => {
  const sourcePath = '/home/agent/.openclaude/generated/report.md'
  const result = sanitizeTutorialSnapshot({
    messages: [
      { id: 'u', role: 'user', text: '生成报告', ts: 1 },
      {
        id: 't',
        role: 'tool',
        text: 'Write',
        ts: 2,
        toolName: 'Write',
        inputJson: { file: sourcePath, purpose: '公开报告' },
        output: `saved ${sourcePath}`,
        _completed: true,
      },
      {
        id: 'p',
        role: 'plan',
        text: '执行计划',
        ts: 3,
        steps: [{ step: '生成报告', status: 'completed' }],
      },
      {
        id: 'g',
        role: 'goal',
        text: '交付报告',
        ts: 4,
        goalStatus: 'complete',
        tokenBudget: 1000,
      },
      {
        id: 'a',
        role: 'agent-group',
        text: '子任务完成',
        ts: 5,
        childBlocks: [
          { kind: 'text', text: '已核对' },
          { kind: 'tool_use', toolName: 'Read', inputJson: { file: sourcePath } },
        ],
        _delegateStatus: 'ok',
      },
      { id: 'final', role: 'assistant', text: `交付：${sourcePath}`, ts: 6 },
    ],
    selectedArtifacts: [{
      name: 'report.md',
      mimeType: 'text/markdown',
      contentBase64: Buffer.from('# 公开报告').toString('base64'),
      sourcePath,
    }],
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  const tool = result.messages.find((message) => message.role === 'tool')
  assert.equal(tool?.toolName, 'Write')
  assert.match(String(tool?.output), /成果「report.md」/)
  assert.deepEqual(result.messages.find((message) => message.role === 'plan')?.steps, [
    { step: '生成报告', status: 'completed' },
  ])
  assert.equal(result.messages.find((message) => message.role === 'goal')?.goalStatus, 'complete')
  assert.equal(result.messages.find((message) => message.role === 'agent-group')?.childBlocks?.length, 2)
  assert.match(result.messages.at(-1)?.text ?? '', /成果「report.md」/)
  assert.equal(JSON.stringify(result.messages).includes(sourcePath), false)
})
