import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

import { runOcConnectCli, runOcPluginCli } from '../../../gateway/src/ocConnectCli.js'
import { planSkillCommand } from '../../../gateway/src/ocSkillCli.js'
import { runOcWebCli } from '../../../gateway/src/ocWebCli.js'

type RunResult = { code: number | null; stdout: string; stderr: string }
type Probe = () => void | Promise<void>

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const BIN_DIR = join(REPO_ROOT, 'packages/commercial/agent-sandbox/platform-runtime/bin')
const TSX = join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const BROWSER_SKILL_ALLOWED_COMMANDS = new Set([
  'check',
  'click',
  'close',
  'dblclick',
  'eval',
  'fill',
  'go-back',
  'goto',
  'hover',
  'open',
  'press',
  'reload',
  'screenshot',
  'select',
  'snapshot',
  'state-save',
  'tab-list',
  'tab-new',
  'tab-select',
])

function childEnv(patch: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...patch }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete env[key]
  }
  return env
}

function run(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string } = {},
): Promise<RunResult> {
  return new Promise((done, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env: childEnv(options.env),
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

function runTs(entry: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<RunResult> {
  return run(process.execPath, [TSX, join(REPO_ROOT, entry), ...args], { env })
}

function isolatedEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const home = mkdtempSync(join(tmpdir(), 'oc-cli-surface-'))
  return {
    env: {
      HOME: home,
      OPENCLAUDE_HOME: home,
      OPENCLAUDE_V3_MASTER_BASE_URL: undefined,
      OPENCLAUDE_V3_CONTAINER_TOKEN: undefined,
      OPENCLAUDE_V3_CONTAINER_TOKEN_FILE: undefined,
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

function tsFailureProbe(entry: string, args: string[], expected: RegExp): Probe {
  return async () => {
    const iso = isolatedEnv()
    try {
      const result = await runTs(entry, args, iso.env)
      assert.notEqual(result.code, 0, `${entry} ${args.join(' ')} unexpectedly succeeded`)
      assert.match(result.stderr, expected)
    } finally {
      iso.cleanup()
    }
  }
}

function scriptProbe(
  script: string,
  args: string[],
  expected: { code: number; stdout?: RegExp; stderr?: RegExp },
): Probe {
  return async () => {
    const result = await run(script.endsWith('.py') ? 'python3' : 'bash', [
      join(BIN_DIR, script),
      ...args,
    ])
    assert.equal(result.code, expected.code, result.stderr)
    if (expected.stdout) assert.match(result.stdout, expected.stdout)
    if (expected.stderr) assert.match(result.stderr, expected.stderr)
  }
}

function browserLauncherProbe(): void {
  const value = readFileSync(join(BIN_DIR, 'oc-browser.sh'), 'utf8')
  assert.match(value, /cli_bin=\/usr\/local\/bin\/playwright-cli/)
  assert.match(value, /XDG_CACHE_HOME="\$cache_home" PLAYWRIGHT_CLI_SESSION="\$session_name"/)
  assert.match(value, /PWTEST_SOCKETS_DIR="\$state_dir\/sockets"/)
  assert.match(value, /sha256sum/)
  assert.match(value, /flock -x 9/)
  assert.match(value, /__openclaude_reap/)
  assert.match(value, /"\$cli_bin" "\$@" 9>&-/)
}

function skillProbe(argv: string[], expectedKind: string): Probe {
  return () => assert.equal(planSkillCommand(argv).kind, expectedKind)
}

const connectDeps = {
  readStdin: async () => '{}',
  transport: async (op: string) => {
    if (op === 'list') return { connections: [{ id: 'c1', provider: 'demo' }] }
    if (op === 'catalog') return { connectors: [] }
    return { kind: 'result', result: { ok: true } }
  },
}

const pluginDeps = {
  readStdin: async () => '{}',
  transport: async (op: string) => {
    if (op === 'list') return { plugins: [{ id: 'p1', provider: 'demo' }] }
    if (op === 'catalog') return { plugins: [] }
    return { kind: 'result', result: { ok: true } }
  },
}

function connectProbe(argv: string[], plugin = false): Probe {
  return async () => {
    const result = plugin
      ? await runOcPluginCli(argv, pluginDeps)
      : await runOcConnectCli(argv, connectDeps)
    assert.equal(result.exitCode, 0, result.stderr)
  }
}

function marketNoContainerProbe(args: string[], expected: RegExp): Probe {
  return tsFailureProbe('packages/gateway/src/ocMarketCli.ts', args, expected)
}

function memoryProbe(args: string[], expected: RegExp): Probe {
  return tsFailureProbe('packages/mcp-memory/src/ocMemoryCli.ts', args, expected)
}

function webContextProbe(payload: Record<string, unknown>, expected: (value: any) => void): Probe {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'oc-web-context-surface-'))
    try {
      const result = await run('python3', [join(BIN_DIR, 'oc-web-context.py')], {
        env: { OPENCLAUDE_WEB_CONTEXT_ROOT: root },
        input: JSON.stringify(payload),
      })
      assert.equal(result.code, 0, result.stderr)
      expected(JSON.parse(result.stdout))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
}

function xlsxCommandProbe(command: string): Probe {
  return async () => {
    const fakeSite = mkdtempSync(join(tmpdir(), 'oc-xlsx-imports-'))
    const packageDir = join(fakeSite, 'openpyxl')
    mkdirSync(packageDir)
    writeFileSync(join(packageDir, '__init__.py'), 'class Workbook:\n    pass\n')
    writeFileSync(
      join(packageDir, 'styles.py'),
      'class _Style:\n    def __init__(self, *args, **kwargs): pass\nAlignment=Border=Font=PatternFill=Side=_Style\n',
    )
    writeFileSync(
      join(packageDir, 'utils.py'),
      'def get_column_letter(value):\n    return str(value)\n',
    )
    try {
      const result = await run('python3', [join(BIN_DIR, 'oc-xlsx.py'), command], {
        env: { PYTHONPATH: fakeSite },
      })
      assert.equal(result.code, 1)
      assert.match(result.stderr, new RegExp(`${command}: 缺少输入文件`))
    } finally {
      rmSync(fakeSite, { recursive: true, force: true })
    }
  }
}

/**
 * Executable public-surface contract. Every value is a real dispatch probe;
 * adding a bin/oc-* file or a public operation without a probe makes this suite red.
 */
const OC_SURFACES: Record<string, Record<string, Probe>> = {
  'oc-browser': {
    forward: browserLauncherProbe,
  },
  'oc-cite': {
    verify: tsFailureProbe('packages/gateway/src/ocCiteCli.ts', ['verify'], /verify <id/),
    format: tsFailureProbe('packages/gateway/src/ocCiteCli.ts', ['format'], /format <id/),
    check: tsFailureProbe('packages/gateway/src/ocCiteCli.ts', ['check'], /check --manifest/),
    fix: tsFailureProbe('packages/gateway/src/ocCiteCli.ts', ['fix'], /fix --manifest/),
  },
  'oc-connect': {
    list: connectProbe(['list']),
    catalog: connectProbe(['catalog']),
    call: connectProbe(['call', 'demo', 'read', '--account', 'c1']),
  },
  'oc-diagram': {
    render: scriptProbe('oc-diagram.sh', ['--help'], { code: 0, stdout: /oc-diagram/ }),
  },
  'oc-docx': {
    render: scriptProbe('oc-docx.sh', ['--help'], { code: 0, stdout: /oc-docx/ }),
  },
  'oc-figcheck': {
    check: tsFailureProbe('packages/gateway/src/ocFigCheckCli.ts', [], /usage: oc-figcheck/),
  },
  'oc-ingest': {
    parse: tsFailureProbe('packages/gateway/src/ocIngestCli.ts', ['parse'], /parse <file>/),
  },
  'oc-ocr': {
    run: tsFailureProbe('packages/gateway/src/ocOcrCli.ts', ['run'], /run <file>/),
    submit: tsFailureProbe('packages/gateway/src/ocOcrCli.ts', ['submit'], /submit <file>/),
    status: tsFailureProbe('packages/gateway/src/ocOcrCli.ts', ['status'], /status <ticket>/),
    cancel: tsFailureProbe('packages/gateway/src/ocOcrCli.ts', ['cancel'], /cancel <ticket>/),
    download: tsFailureProbe('packages/gateway/src/ocOcrCli.ts', ['download'], /download <ticket>/),
  },
  'oc-h3': {
    generate: scriptProbe('oc-h3.py', ['generate', '--help'], {
      code: 0,
      stdout: /--duration \{5,10,15\}/,
    }),
    status: scriptProbe('oc-h3.py', ['status', '--help'], { code: 0, stdout: /job_id/ }),
    cancel: scriptProbe('oc-h3.py', ['cancel', '--help'], { code: 0, stdout: /job_id/ }),
    download: scriptProbe('oc-h3.py', ['download', '--help'], { code: 0, stdout: /--out/ }),
    project: scriptProbe('oc-h3.py', ['project', '--help'], {
      code: 0,
      stdout: /regenerate-shot,accept-shot/,
    }),
    'project.create': scriptProbe('oc-h3.py', ['project', 'create', '--help'], {
      code: 0,
      stdout: /--last-frame/,
    }),
    'project.status': scriptProbe('oc-h3.py', ['project', 'status', '--help'], {
      code: 0,
      stdout: /project_id/,
    }),
    'project.edit': scriptProbe('oc-h3.py', ['project', 'edit', '--help'], {
      code: 0,
      stdout: /--storyboard/,
    }),
    'project.start': scriptProbe('oc-h3.py', ['project', 'start', '--help'], {
      code: 0,
      stdout: /--expected-rev/,
    }),
    'project.render': scriptProbe('oc-h3.py', ['project', 'render', '--help'], {
      code: 0,
      stdout: /--expected-rev/,
    }),
    'project.regenerate-shot': scriptProbe('oc-h3.py', ['project', 'regenerate-shot', '--help'], {
      code: 0,
      stdout: /shot_id/,
    }),
    'project.accept-shot': scriptProbe('oc-h3.py', ['project', 'accept-shot', '--help'], {
      code: 0,
      stdout: /shot_id/,
    }),
  },
  'oc-lit': {
    search: tsFailureProbe('packages/gateway/src/ocLitCli.ts', ['search'], /search <query>/),
    snowball: tsFailureProbe('packages/gateway/src/ocLitCli.ts', ['snowball'], /snowball <DOI/),
  },
  'oc-litrag': {
    query: tsFailureProbe('packages/gateway/src/ocLitragCli.ts', ['query'], /query .*--docs/),
  },
  'oc-market': {
    search: marketNoContainerProbe(['search', 'query'], /not in a commercial container/),
    detail: marketNoContainerProbe(['detail'], /detail <slug>/),
    installed: marketNoContainerProbe(['installed'], /not in a commercial container/),
    install: marketNoContainerProbe(['install'], /install <slug>/),
    uninstall: marketNoContainerProbe(['uninstall'], /uninstall <slug>/),
    'publish-skill': marketNoContainerProbe(['publish-skill'], /needs --body-file/),
    'publish-agent': marketNoContainerProbe(['publish-agent'], /needs --persona-file/),
    'plugin.examples': scriptProbe('oc-market.sh', ['plugin', 'examples'], {
      code: 0,
      stdout: /recommendedBlueprint/,
    }),
    'plugin.prepare': scriptProbe('oc-market.sh', ['plugin', 'prepare'], {
      code: 2,
      stderr: /required: --file/,
    }),
    'plugin.validate': scriptProbe('oc-market.sh', ['plugin', 'validate'], {
      code: 2,
      stderr: /required: --file/,
    }),
    'plugin.publish': scriptProbe('oc-market.sh', ['plugin', 'publish'], {
      code: 2,
      stderr: /required: --file/,
    }),
    'publish-connector.help': scriptProbe('oc-market.sh', ['publish-connector', '--help'], {
      code: 0,
      stdout: /--spec-file/,
    }),
    'publish-connector.examples': scriptProbe('oc-market.sh', ['publish-connector', '--examples'], {
      code: 0,
      stdout: /static-token/,
    }),
    'publish-connector.disabled': scriptProbe(
      'oc-market.sh',
      [
        'publish-connector',
        '--spec-file',
        '/missing/spec.json',
        '--security-decision-file',
        '/missing/decision.json',
        '--version',
        '1.0.0',
        '--category',
        'daily-tools',
        '--use-cases',
        'demo',
      ],
      { code: 1, stderr: /legacy publish-connector is disabled/ },
    ),
  },
  'oc-memory': {
    'core-search': memoryProbe(['core-search'], /core-search requires/),
    'session-search': memoryProbe(['session-search'], /session-search requires/),
    'archival-add': memoryProbe(['archival-add'], /archival-add requires/),
    'archival-search': memoryProbe(['archival-search'], /archival-search requires/),
    'archival-delete': memoryProbe(['archival-delete'], /archival-delete requires/),
    'memory.retired': memoryProbe(['memory'], /子命令已退役/),
  },
  'oc-minimax': {
    image: scriptProbe('oc-minimax.py', ['image', '--help'], { code: 0, stdout: /image generate/ }),
    'image.generate': scriptProbe('oc-minimax.py', ['image', 'generate', '--help'], {
      code: 0,
      stdout: /image generate/,
    }),
    speech: scriptProbe('oc-minimax.py', ['speech', '--help'], {
      code: 0,
      stdout: /speech synthesize/,
    }),
    'speech.synthesize': scriptProbe('oc-minimax.py', ['speech', 'synthesize', '--help'], {
      code: 0,
      stdout: /speech synthesize/,
    }),
    music: scriptProbe('oc-minimax.py', ['music', '--help'], { code: 0, stdout: /music generate/ }),
    'music.generate': scriptProbe('oc-minimax.py', ['music', 'generate', '--help'], {
      code: 0,
      stdout: /music generate/,
    }),
    'music.lyrics': scriptProbe('oc-minimax.py', ['music', 'lyrics', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    'music.lyrics.generate': scriptProbe(
      'oc-minimax.py',
      ['music', 'lyrics', 'generate', '--help'],
      { code: 0, stdout: /lyrics generate/ },
    ),
    'music.lyric': scriptProbe('oc-minimax.py', ['music', 'lyric', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    'music.lyric.generate': scriptProbe('oc-minimax.py', ['music', 'lyric', 'generate', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    lyrics: scriptProbe('oc-minimax.py', ['lyrics', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    'lyrics.generate': scriptProbe('oc-minimax.py', ['lyrics', 'generate', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    lyric: scriptProbe('oc-minimax.py', ['lyric', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    'lyric.generate': scriptProbe('oc-minimax.py', ['lyric', 'generate', '--help'], {
      code: 0,
      stdout: /lyrics generate/,
    }),
    video: scriptProbe('oc-minimax.py', ['video', '--help'], {
      code: 0,
      stdout: /video generate/,
    }),
    'video.generate': scriptProbe('oc-minimax.py', ['video', 'generate', '--help'], {
      code: 0,
      stdout: /video generate/,
    }),
    'video.query': scriptProbe('oc-minimax.py', ['video', 'query', '--help'], {
      code: 0,
      stdout: /video query/,
    }),
    'video.download': scriptProbe('oc-minimax.py', ['video', 'download', '--help'], {
      code: 0,
      stdout: /video download/,
    }),
    'auth.denied': scriptProbe('oc-minimax.py', ['auth'], { code: 1, stderr: /does not expose/ }),
    'quota.denied': scriptProbe('oc-minimax.py', ['quota'], { code: 1, stderr: /does not expose/ }),
    'config.denied': scriptProbe('oc-minimax.py', ['config'], {
      code: 1,
      stderr: /does not expose/,
    }),
    'update.denied': scriptProbe('oc-minimax.py', ['update'], {
      code: 1,
      stderr: /does not expose/,
    }),
  },
  'oc-pdf': {
    render: scriptProbe('oc-pdf.sh', ['--help'], { code: 0, stdout: /oc-pdf/ }),
  },
  'oc-plugin': {
    list: connectProbe(['list'], true),
    catalog: connectProbe(['catalog'], true),
    call: connectProbe(['call', 'demo', 'read', '--account', 'p1'], true),
  },
  'oc-poster': {
    render: tsFailureProbe('packages/gateway/src/ocPosterCli.ts', [], /usage: oc-poster/),
  },
  'oc-rank': {
    elo: tsFailureProbe('packages/gateway/src/ocRankCli.ts', ['elo'], /elo --matches/),
  },
  'oc-report': {
    render: tsFailureProbe('packages/gateway/src/ocReportCli.ts', [], /usage: oc-report/),
  },
  'oc-skill': {
    train: skillProbe(['train', 'demo', '--confirm'], 'request'),
    'train-status': skillProbe(['train-status', 'run-1'], 'request'),
    'evals-generate': skillProbe(['evals-generate', 'demo', '--confirm'], 'request'),
    'evals-gen-status': skillProbe(['evals-gen-status', 'run-1'], 'request'),
  },
  'oc-slides': {
    render: tsFailureProbe('packages/gateway/src/ocSlidesCli.ts', [], /usage: oc-slides/),
  },
  'oc-vision': {
    understand: tsFailureProbe(
      'packages/gateway/src/ocVisionCli.ts',
      ['understand'],
      /understand <image_file>/,
    ),
  },
  'oc-video': {
    create: scriptProbe('oc-video.sh', ['create', '--help'], { code: 0, stdout: /--storyboard/ }),
    status: scriptProbe('oc-video.sh', ['status', '--help'], { code: 0, stdout: /project_id/ }),
    edit: scriptProbe('oc-video.sh', ['edit', '--help'], { code: 0, stdout: /--storyboard/ }),
    start: scriptProbe('oc-video.sh', ['start', '--help'], { code: 0, stdout: /--expected-rev/ }),
    render: scriptProbe('oc-video.sh', ['render', '--help'], { code: 0, stdout: /--expected-rev/ }),
    'regenerate-shot': scriptProbe('oc-video.sh', ['regenerate-shot', '--help'], {
      code: 0,
      stdout: /shot_id/,
    }),
    'accept-shot': scriptProbe('oc-video.sh', ['accept-shot', '--help'], {
      code: 0,
      stdout: /shot_id/,
    }),
  },
  'oc-web-context': {
    health_check: webContextProbe({ op: 'health_check' }, (value) => {
      assert.equal(value.ok, false)
      assert.deepEqual(Object.keys(value.checks).sort(), ['crawl4ai', 'markitdown', 'trafilatura'])
    }),
    extract_file: webContextProbe(
      { op: 'extract_file', file_path: '/tmp/missing.txt', kind: 'text' },
      (value) => assert.match(value.error, /python env missing/),
    ),
    parse_document_file: webContextProbe(
      { op: 'parse_document_file', file_path: '/tmp/missing.pdf', kind: 'pdf' },
      (value) => assert.match(value.error, /python env missing/),
    ),
    browser_extract_url: webContextProbe(
      { op: 'browser_extract_url', url: 'https://example.com' },
      (value) => assert.match(value.error, /python env missing/),
    ),
    unknown: webContextProbe({ op: 'unknown-op' }, (value) =>
      assert.match(value.error, /unknown op/),
    ),
  },
  'oc-web': {
    extract: async () => {
      const result = await runOcWebCli(['extract'])
      assert.equal(result.exitCode, 2)
      assert.match(result.stderr, /extract requires/)
    },
    parse: async () => {
      const result = await runOcWebCli(['parse'])
      assert.equal(result.exitCode, 2)
      assert.match(result.stderr, /parse requires/)
    },
    health: async () => {
      const result = await runOcWebCli(['health', 'unexpected'])
      assert.equal(result.exitCode, 2)
      assert.match(result.stderr, /health takes no arguments/)
    },
  },
  'oc-xlsx': {
    'from-csv': xlsxCommandProbe('from-csv'),
    'from-json': xlsxCommandProbe('from-json'),
    'from-md': xlsxCommandProbe('from-md'),
  },
}

const THIN_WRAPPERS: Record<string, string> = {
  'oc-cite': 'packages/gateway/src/ocCiteCli.ts',
  'oc-connect': 'packages/gateway/src/ocConnectCli.ts',
  'oc-figcheck': 'packages/gateway/src/ocFigCheckCli.ts',
  'oc-ingest': 'packages/gateway/src/ocIngestCli.ts',
  'oc-ocr': 'packages/gateway/src/ocOcrCli.ts',
  'oc-lit': 'packages/gateway/src/ocLitCli.ts',
  'oc-litrag': 'packages/gateway/src/ocLitragCli.ts',
  'oc-market': 'packages/gateway/src/ocMarketCli.ts',
  'oc-memory': 'packages/mcp-memory/src/ocMemoryCli.ts',
  'oc-plugin': 'packages/gateway/src/ocPluginCli.ts',
  'oc-poster': 'packages/gateway/src/ocPosterCli.ts',
  'oc-rank': 'packages/gateway/src/ocRankCli.ts',
  'oc-report': 'packages/gateway/src/ocReportCli.ts',
  'oc-skill': 'packages/gateway/src/ocSkillCli.ts',
  'oc-slides': 'packages/gateway/src/ocSlidesCli.ts',
  'oc-vision': 'packages/gateway/src/ocVisionCli.ts',
  'oc-web': 'packages/gateway/src/ocWebCli.ts',
}

function toolName(file: string): string {
  return basename(file).replace(/\.(?:sh|py)$/, '')
}

const HELP_COMMANDS = new Set(['help', '--help', '-h'])

function source(relativePath: string): string {
  const path = join(REPO_ROOT, relativePath)
  const value = readFileSync(path, 'utf8')
  assert.ok(value.length > 0, `${relativePath}: production source is empty`)
  return value
}

function tsAst(relativePath: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
}

function stringValue(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ? node.text : undefined
}

/** Discover actual command branches from a production TS dispatcher. */
function tsDispatchCommands(relativePath: string, variable: 'cmd' | 'command'): Set<string> {
  const commands = new Set<string>()
  let foundDispatcher = false
  const visit = (node: ts.Node): void => {
    if (
      ts.isSwitchStatement(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === variable
    ) {
      foundDispatcher = true
      for (const clause of node.caseBlock.clauses) {
        if (!ts.isCaseClause(clause)) continue
        const value = stringValue(clause.expression)
        if (value) commands.add(value)
      }
    }
    if (ts.isBinaryExpression(node)) {
      const leftMatches = ts.isIdentifier(node.left) && node.left.text === variable
      const rightMatches = ts.isIdentifier(node.right) && node.right.text === variable
      const value = leftMatches
        ? stringValue(node.right)
        : rightMatches
          ? stringValue(node.left)
          : undefined
      if (value !== undefined) {
        foundDispatcher = true
        commands.add(value)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(tsAst(relativePath))
  assert.equal(foundDispatcher, true, `${relativePath}: ${variable} dispatcher not found`)
  for (const help of HELP_COMMANDS) commands.delete(help)
  assert.ok(commands.size > 0, `${relativePath}: no production commands discovered`)
  return commands
}

function quotedValues(fragment: string): string[] {
  return [...fragment.matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1])
}

function pythonComparedValues(body: string, variable: string): Set<string> {
  const values = new Set<string>()
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const match of body.matchAll(new RegExp(`${escaped}\\s*==\\s*['"]([^'"]+)['"]`, 'g'))) {
    values.add(match[1])
  }
  for (const match of body.matchAll(new RegExp(`${escaped}\\s+in\\s+\\{([^}]+)\\}`, 'g'))) {
    for (const value of quotedValues(match[1])) values.add(value)
  }
  return values
}

function pythonFunctionBody(value: string, name: string): string {
  const start = value.indexOf(`def ${name}(`)
  assert.notEqual(start, -1, `oc-minimax.py: ${name} not found`)
  const tail = value.slice(start)
  const next = tail.slice(1).search(/\ndef\s+[A-Za-z_][A-Za-z0-9_]*\(/)
  return next < 0 ? tail : tail.slice(0, next + 1)
}

function minimaxCommands(): Set<string> {
  const value = source('packages/commercial/agent-sandbox/platform-runtime/bin/oc-minimax.py')
  const main = pythonFunctionBody(value, 'main')
  const roots = pythonComparedValues(main, 'cmd')
  assert.deepEqual(
    [...roots].sort(),
    ['auth', 'config', 'image', 'lyric', 'lyrics', 'music', 'quota', 'speech', 'update', 'video'],
    'oc-minimax.py: unrecognized top-level dispatcher shape',
  )
  const denied = new Set(['auth', 'quota', 'config', 'update'])
  const commands = new Set<string>()
  for (const root of roots) {
    if (denied.has(root)) {
      commands.add(`${root}.denied`)
      continue
    }
    commands.add(root)
    const functionName = root === 'lyric' ? 'cmd_lyrics' : `cmd_${root}`
    const body = pythonFunctionBody(value, functionName)
    const subs = new Set([
      ...pythonComparedValues(body, 'sub'),
      ...pythonComparedValues(body, 'argv[0]'),
    ])
    for (const sub of subs) commands.add(`${root}.${sub}`)
    if (root === 'music') {
      const lyricsSubs = pythonComparedValues(pythonFunctionBody(value, 'cmd_lyrics'), 'argv[0]')
      for (const alias of [...subs].filter((sub) => sub === 'lyrics' || sub === 'lyric')) {
        for (const nested of lyricsSubs) commands.add(`${root}.${alias}.${nested}`)
      }
    }
  }
  return commands
}

function webContextCommands(): Set<string> {
  const value = source('packages/commercial/agent-sandbox/platform-runtime/bin/oc-web-context.py')
  const commands = pythonComparedValues(value, 'op')
  assert.ok(commands.size > 0, 'oc-web-context.py: op dispatcher not found')
  return commands
}

function xlsxCommands(): Set<string> {
  const value = source('packages/commercial/agent-sandbox/platform-runtime/bin/oc-xlsx.py')
  const match = /handlers\s*=\s*\{([^}]+)\}/s.exec(value)
  assert.ok(match, 'oc-xlsx.py: handlers registry not found')
  const commands = new Set(quotedValues(match[1]))
  assert.ok(commands.size > 0, 'oc-xlsx.py: handlers registry is empty')
  return commands
}

function h3Commands(projectOnly = false): Set<string> {
  const value = source('packages/commercial/agent-sandbox/platform-runtime/bin/oc-h3.py')
  const required = [
    'generate',
    'status',
    'cancel',
    'download',
    'project',
    'create',
    'edit',
    'start',
    'render',
    'regenerate-shot',
    'accept-shot',
  ]
  for (const command of required) {
    assert.match(
      value,
      new RegExp(`add_parser\\(["']${command}["']`),
      `oc-h3.py: ${command} missing`,
    )
  }
  if (projectOnly)
    return new Set([
      'create',
      'status',
      'edit',
      'start',
      'render',
      'regenerate-shot',
      'accept-shot',
    ])
  return new Set([
    'generate',
    'status',
    'cancel',
    'download',
    'project',
    'project.create',
    'project.status',
    'project.edit',
    'project.start',
    'project.render',
    'project.regenerate-shot',
    'project.accept-shot',
  ])
}

function marketCommands(): Set<string> {
  const commands = tsDispatchCommands('packages/gateway/src/ocMarketCli.ts', 'cmd')
  const value = source('packages/commercial/agent-sandbox/platform-runtime/bin/oc-market.sh')
  assert.match(value, /"\$\{1:-\}" = "plugin".*"\$\{1:-\}" = "publish-connector"/s)
  const pluginOps = new Set(
    [...value.matchAll(/sub\.add_parser\("([^"]+)"/g)].map((match) => match[1]),
  )
  assert.ok(pluginOps.size > 0, 'oc-market.sh: Plugin argparse operations not found')
  for (const operation of pluginOps) commands.add(`plugin.${operation}`)
  assert.match(value, /prog="oc-market publish-connector"/)
  assert.match(value, /if argv == \["--examples"\]/)
  assert.match(value, /legacy publish-connector is disabled/)
  commands.add('publish-connector.help')
  commands.add('publish-connector.examples')
  commands.add('publish-connector.disabled')
  return commands
}

function singlePurpose(relativePath: string, operation: string, usage: RegExp): Set<string> {
  const value = source(relativePath)
  assert.match(value, usage, `${relativePath}: single-purpose usage marker missing`)
  if (relativePath.endsWith('.ts')) {
    const ast = tsAst(relativePath)
    let hasDispatcher = false
    const visit = (node: ts.Node): void => {
      if (
        ts.isSwitchStatement(node) &&
        ts.isIdentifier(node.expression) &&
        (node.expression.text === 'cmd' || node.expression.text === 'command')
      ) {
        hasDispatcher = true
      }
      if (
        ts.isBinaryExpression(node) &&
        ((ts.isIdentifier(node.left) &&
          (node.left.text === 'cmd' || node.left.text === 'command')) ||
          (ts.isIdentifier(node.right) &&
            (node.right.text === 'cmd' || node.right.text === 'command')))
      ) {
        hasDispatcher = true
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
    assert.equal(hasDispatcher, false, `${relativePath}: became multi-command; add exact probes`)
  }
  return new Set([operation])
}

function productionSurfaces(): Record<string, Set<string>> {
  const connect = tsDispatchCommands('packages/gateway/src/ocConnectCli.ts', 'command')
  const memory = tsDispatchCommands('packages/mcp-memory/src/ocMemoryCli.ts', 'cmd')
  assert.equal(memory.delete('memory'), true, 'oc-memory: retired memory branch not discovered')
  memory.add('memory.retired')
  return {
    'oc-browser': singlePurpose(
      'packages/commercial/agent-sandbox/platform-runtime/bin/oc-browser.sh',
      'forward',
      /\/usr\/local\/bin\/playwright-cli/,
    ),
    'oc-cite': tsDispatchCommands('packages/gateway/src/ocCiteCli.ts', 'cmd'),
    'oc-connect': new Set(connect),
    'oc-diagram': singlePurpose(
      'packages/commercial/agent-sandbox/platform-runtime/bin/oc-diagram.sh',
      'render',
      /用法: \$TOOL/,
    ),
    'oc-docx': singlePurpose(
      'packages/commercial/agent-sandbox/platform-runtime/bin/oc-docx.sh',
      'render',
      /Usage:\s+oc-docx/,
    ),
    'oc-figcheck': singlePurpose(
      'packages/gateway/src/ocFigCheckCli.ts',
      'check',
      /usage: oc-figcheck/,
    ),
    'oc-ingest': tsDispatchCommands('packages/gateway/src/ocIngestCli.ts', 'cmd'),
    'oc-ocr': tsDispatchCommands('packages/gateway/src/ocOcrCli.ts', 'cmd'),
    'oc-h3': h3Commands(),
    'oc-lit': tsDispatchCommands('packages/gateway/src/ocLitCli.ts', 'cmd'),
    'oc-litrag': tsDispatchCommands('packages/gateway/src/ocLitragCli.ts', 'cmd'),
    'oc-market': marketCommands(),
    'oc-memory': memory,
    'oc-minimax': minimaxCommands(),
    'oc-pdf': singlePurpose(
      'packages/commercial/agent-sandbox/platform-runtime/bin/oc-pdf.sh',
      'render',
      /用法:\s+oc-pdf/,
    ),
    'oc-plugin': new Set(connect),
    'oc-poster': singlePurpose('packages/gateway/src/ocPosterCli.ts', 'render', /usage: oc-poster/),
    'oc-rank': tsDispatchCommands('packages/gateway/src/ocRankCli.ts', 'cmd'),
    'oc-report': singlePurpose('packages/gateway/src/ocReportCli.ts', 'render', /usage: oc-report/),
    'oc-skill': tsDispatchCommands('packages/gateway/src/ocSkillCli.ts', 'cmd'),
    'oc-slides': singlePurpose('packages/gateway/src/ocSlidesCli.ts', 'render', /usage: oc-slides/),
    'oc-vision': tsDispatchCommands('packages/gateway/src/ocVisionCli.ts', 'cmd'),
    'oc-video': h3Commands(true),
    'oc-web-context': webContextCommands(),
    'oc-web': tsDispatchCommands('packages/gateway/src/ocWebCli.ts', 'command'),
    'oc-xlsx': xlsxCommands(),
  }
}

describe('V5 oc-* public surface coverage contract', () => {
  test('browser Skill only documents reviewed commands from the pinned Playwright CLI', () => {
    const skill = source('packages/commercial/agent-sandbox/ccb-baseline/skills/browser/SKILL.md')
    const commands = [...skill.matchAll(/^oc-browser\s+([a-z-]+)/gm)].map((match) => match[1]!)
    const unsupported = [...new Set(commands)].filter(
      (command) => !BROWSER_SKILL_ALLOWED_COMMANDS.has(command),
    )
    assert.deepEqual(unsupported, [])

    for (const example of skill.match(/^oc-browser eval .*$/gm) ?? []) {
      assert.match(example, /^oc-browser eval "\(\) => /)
    }
  })

  test('oc-browser pins the official CLI to the same Playwright build as internal MCP consumers', () => {
    const dockerfile = source('packages/commercial/agent-sandbox/Dockerfile.openclaude-runtime')
    const buildImage = source('packages/commercial/agent-sandbox/build-image.sh')
    const cliConfig = JSON.parse(
      source('packages/commercial/agent-sandbox/playwright-cli.config.json'),
    )
    assert.match(dockerfile, /ARG OC_PLAYWRIGHT_MCP_VERSION=0\.0\.76/)
    assert.match(dockerfile, /ARG OC_PLAYWRIGHT_CLI_VERSION=0\.1\.14/)
    assert.match(dockerfile, /test "\$MCP_PW_VERSION" = "\$CLI_PW_VERSION"/)
    assert.match(dockerfile, /playwright-cli --version/)
    assert.deepEqual(cliConfig, {
      browser: {
        browserName: 'chromium',
        launchOptions: { chromiumSandbox: false },
      },
    })
    assert.match(dockerfile, /oc-browser open about:blank/)
    assert.match(dockerfile, /oc-browser snapshot/)
    assert.match(dockerfile, /oc-browser close/)
    assert.match(
      dockerfile,
      /COPY --chown=root:root \.\/playwright-cli\.config\.json \/etc\/openclaude\/playwright-cli\.config\.json/,
    )
    assert.match(
      buildImage,
      /cp "\$SANDBOX_DIR\/playwright-cli\.config\.json" "\$BUILD_CTX\/playwright-cli\.config\.json"/,
    )
  })

  test('every bundled oc-* tool has an executable operation matrix (and no stale row)', () => {
    const actual = readdirSync(BIN_DIR)
      .filter((file) => /^oc-.*\.(?:sh|py)$/.test(file))
      .map(toolName)
      .sort()
    assert.deepEqual(actual, Object.keys(OC_SURFACES).sort())
    for (const [tool, operations] of Object.entries(OC_SURFACES)) {
      assert.ok(Object.keys(operations).length > 0, `${tool} has no operation probes`)
    }
  })

  test('production dispatchers and executable operation probes match exactly', () => {
    const discovered = productionSurfaces()
    assert.deepEqual(Object.keys(discovered).sort(), Object.keys(OC_SURFACES).sort())
    for (const [tool, commands] of Object.entries(discovered)) {
      const probes = new Set(Object.keys(OC_SURFACES[tool]))
      // Unknown-op is an intentional negative probe, not a public web-context operation.
      if (tool === 'oc-web-context') probes.delete('unknown')
      assert.deepEqual(
        [...probes].sort(),
        [...commands].sort(),
        `${tool}: production commands and executable probes drifted`,
      )
    }
  })

  test('thin wrappers pin the bundle revision and forward argv to the exact TS entry', () => {
    for (const [tool, entry] of Object.entries(THIN_WRAPPERS)) {
      const candidates = [`${tool}.sh`, `${tool}.py`]
      const file = candidates.find((name) => {
        try {
          readFileSync(join(BIN_DIR, name))
          return true
        } catch {
          return false
        }
      })
      assert.ok(file, `${tool} wrapper missing`)
      const source = readFileSync(join(BIN_DIR, file), 'utf8')
      assert.match(source, /^#!\//, `${tool}: shebang`)
      assert.match(source, /readlink -f/, `${tool}: revision pin`)
      assert.match(source, /cd \/opt\/openclaude/, `${tool}: runtime cwd`)
      assert.ok(
        source.includes(`exec npx --no-install tsx ${entry} \"$@\"`),
        `${tool}: expected exact argv-forwarding entry ${entry}`,
      )
    }
  })

  test('self-contained tools pin SELF_ROOT and bundle finalization strips .sh/.py names', () => {
    for (const tool of Object.keys(OC_SURFACES).filter((name) => !(name in THIN_WRAPPERS))) {
      const file = readdirSync(BIN_DIR).find((name) => toolName(name) === tool)
      assert.ok(file, `${tool} source missing`)
      const source = readFileSync(join(BIN_DIR, file), 'utf8')
      assert.match(source, /^#!\//, `${tool}: shebang`)
      assert.match(source, /SELF_ROOT/, `${tool}: revision pin root`)
    }
    const finalize = readFileSync(join(REPO_ROOT, 'scripts/v5-runtime-release-lib.sh'), 'utf8')
    assert.match(finalize, /for f in \"\$staging\"\/bin\/\*\.sh \"\$staging\"\/bin\/\*\.py/)
    assert.match(finalize, /bare=\"\$\{f%\.\*\}\"/)
    assert.match(finalize, /mv \"\$f\" \"\$bare\"/)
  })
})

describe('all oc-* public operations dispatch', { concurrency: 4 }, () => {
  for (const [tool, operations] of Object.entries(OC_SURFACES)) {
    for (const [operation, probe] of Object.entries(operations)) {
      test(`${tool} ${operation}`, probe)
    }
  }
})
