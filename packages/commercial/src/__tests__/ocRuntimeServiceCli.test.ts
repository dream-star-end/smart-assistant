import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'

type RunResult = { code: number | null; stdout: string; stderr: string }
type MiniMaxRequest = {
  authorization?: string
  requestId?: string
  kind: string
  payload: Record<string, unknown>
}

const REPO_ROOT = resolve('.')
const BIN_DIR = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin')
const FILE_B64 = Buffer.from('generated-file').toString('base64')

function childEnv(patch: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...patch }
  for (const key of [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ]) {
    delete env[key]
  }
  return env
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: childEnv(options.env ?? {}),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += String(chunk)))
    child.stderr.on('data', (chunk) => (stderr += String(chunk)))
    child.once('error', reject)
    child.once('close', (code) => done({ code, stdout, stderr }))
    child.stdin.end(options.input ?? '')
  })
}

function executable(path: string, body: string): void {
  writeFileSync(path, body)
  chmodSync(path, 0o755)
}

describe('oc-minimax complete media command surface', () => {
  let baseUrl = ''
  let requests: MiniMaxRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        kind: string
        payload: Record<string, unknown>
      }
      requests.push({
        authorization: req.headers.authorization,
        requestId: req.headers['x-request-id'] as string | undefined,
        ...body,
      })
      const file = { filename: `${body.kind}.bin`, base64: FILE_B64 }
      const response: Record<string, unknown> =
        body.kind === 'lyrics'
          ? { text: 'generated lyrics', billing: { debited_credits: 3 } }
          : body.kind === 'video_generate'
            ? { task_id: 'task-1', billing: { debited_credits: 5 } }
            : body.kind === 'video_query'
              ? { raw: { status: 'Success', file_id: 'file-1' } }
              : { files: [file], billing: { debited_credits: 2 } }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response))
    })
  })

  before(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    baseUrl = `http://127.0.0.1:${address.port}`
  })

  after(async () => {
    await new Promise<void>((done) => server.close(() => done()))
  })

  beforeEach(() => {
    requests = []
  })

  test('image/speech/music/lyrics/video generate-query-download and wait all work', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-minimax-cli-'))
    const site = join(work, 'python-site')
    mkdirSync(site)
    writeFileSync(
      join(site, 'sitecustomize.py'),
      "import os, time\nif os.environ.get('OC_TEST_NO_SLEEP') == '1': time.sleep=lambda _seconds: None\n",
    )
    const env = {
      OPENCLAUDE_V3_MASTER_BASE_URL: baseUrl,
      OPENCLAUDE_V3_CONTAINER_TOKEN: 'container-secret',
      NO_PROXY: '127.0.0.1,localhost',
      no_proxy: '127.0.0.1,localhost',
      PYTHONPATH: site,
      OC_TEST_NO_SLEEP: '1',
    }
    const cli = join(BIN_DIR, 'oc-minimax.py')
    const invoke = async (args: string[]): Promise<RunResult> => {
      const result = await run('python3', [cli, ...args], { cwd: work, env })
      assert.equal(result.code, 0, result.stderr)
      return result
    }
    try {
      const image = join(work, 'image.png')
      const speech = join(work, 'speech.mp3')
      const music = join(work, 'music.mp3')
      const video = join(work, 'video.mp4')
      const waited = join(work, 'waited.mp4')

      await invoke(['image', 'generate', '--prompt', 'sunrise', '--n', '1', '--out', image])
      await invoke(['speech', 'synthesize', '--text', 'hello', '--out', speech])
      await invoke(['music', 'generate', '--prompt', 'calm', '--instrumental', '--out', music])
      let result = await invoke(['music', 'lyrics', '--prompt', 'a chorus'])
      assert.match(result.stdout, /generated lyrics/)
      result = await invoke(['lyric', 'generate', '--prompt', 'another chorus'])
      assert.match(result.stdout, /generated lyrics/)
      result = await invoke(['video', 'generate', '--prompt', 'waves'])
      assert.match(result.stdout, /task_id: task-1/)
      result = await invoke(['video', 'query', '--task-id', 'task-1'])
      assert.match(result.stdout, /"status": "Success"/)
      await invoke(['video', 'download', '--file-id', 'file-1', '--out', video])
      await invoke(['video', 'generate', '--prompt', 'forest', '--wait', '--out', waited])

      for (const path of [image, speech, music, video, waited]) {
        assert.equal(readFileSync(path, 'utf8'), 'generated-file')
      }
      assert.deepEqual(
        requests.map((request) => request.kind),
        [
          'image',
          'speech',
          'music',
          'lyrics',
          'lyrics',
          'video_generate',
          'video_query',
          'video_download',
          'video_generate',
          'video_query',
          'video_download',
        ],
      )
      assert.equal(requests[0].payload.prompt, 'sunrise')
      assert.equal(requests[2].payload.is_instrumental, true)
      assert.equal(requests[8].payload.prompt, 'forest')
      for (const request of requests) {
        assert.equal(request.authorization, 'Bearer container-secret')
        assert.match(request.requestId ?? '', /^[a-f0-9]{32}$/)
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

const FAKE_HELPER = `#!/usr/bin/python3
import json, pathlib, sys
code = sys.argv[2] if len(sys.argv) > 2 else ''
payload = json.loads(sys.stdin.read() or '{}')
name = pathlib.Path(sys.argv[0]).parts[-3]
if 'importlib.metadata' in code:
    print(json.dumps({'version': 'test-1.0'}))
elif name == 'trafenv':
    path = payload.get('file_path', '')
    if payload.get('kind') == 'text':
        text = pathlib.Path(path).read_text(encoding='utf-8')
    else:
        text = 'tiny'
    maximum = int(payload.get('max_chars') or 80000)
    print(json.dumps({'ok': bool(text), 'markdown': text[:maximum], 'chars': len(text), 'truncated': len(text) > maximum}))
elif name == 'markenv':
    print(json.dumps({'ok': True, 'markdown': 'document via markitdown', 'chars': 24, 'truncated': False}))
elif 'browser extraction unavailable' in code:
    print(json.dumps({'ok': False, 'extractor': 'crawl4ai', 'error': 'browser extraction unavailable'}))
else:
    text = 'crawl markdown with substantially more useful content'
    print(json.dumps({'ok': True, 'markdown': text, 'chars': len(text), 'truncated': False}))
`

describe('oc-web-context JSON-stdin operation surface', () => {
  test('health, text/html/document parse, browser refusal and unknown op are deterministic', async () => {
    const work = mkdtempSync(join(tmpdir(), 'oc-web-context-cli-'))
    const root = join(work, 'webctx')
    for (const envName of ['trafenv', 'markenv', 'crawlenv']) {
      const bin = join(root, envName, 'bin')
      mkdirSync(bin, { recursive: true })
      executable(join(bin, 'python'), FAKE_HELPER)
    }
    const cli = join(BIN_DIR, 'oc-web-context.py')
    const call = async (payload: Record<string, unknown>): Promise<any> => {
      const result = await run('python3', [cli], {
        env: { OPENCLAUDE_WEB_CONTEXT_ROOT: root },
        input: JSON.stringify(payload),
      })
      assert.equal(result.code, 0, result.stderr)
      return JSON.parse(result.stdout)
    }
    try {
      const textFile = join(work, 'long.txt')
      const htmlFile = join(work, 'page.html')
      const docFile = join(work, 'paper.docx')
      writeFileSync(textFile, 'x'.repeat(1_200))
      writeFileSync(htmlFile, '<html>tiny</html>')
      writeFileSync(docFile, 'fake-docx')

      const health = await call({ op: 'health_check' })
      assert.equal(health.ok, true)
      assert.deepEqual(Object.keys(health.checks).sort(), ['crawl4ai', 'markitdown', 'trafilatura'])

      const text = await call({
        op: 'extract_file',
        file_path: textFile,
        kind: 'text',
        max_chars: 1_000,
      })
      assert.equal(text.markdown.length, 1_000)
      assert.equal(text.truncated, true)

      const html = await call({ op: 'extract_file', file_path: htmlFile, kind: 'html' })
      assert.equal(html.extractor, 'hybrid_trafilatura_crawl4ai')
      assert.equal(html.primary_extractor, 'crawl4ai')
      assert.match(html.markdown, /crawl markdown/)

      const document = await call({
        op: 'parse_document_file',
        file_path: docFile,
        kind: 'docx',
      })
      assert.equal(document.markdown, 'document via markitdown')

      const browser = await call({ op: 'browser_extract_url', url: 'https://example.com' })
      assert.equal(browser.ok, false)
      assert.match(browser.error, /browser extraction unavailable/)

      const unknown = await call({ op: 'not-a-real-op' })
      assert.equal(unknown.ok, false)
      assert.match(unknown.error, /unknown op/)
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})
