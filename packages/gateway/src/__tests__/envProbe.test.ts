/**
 * envProbe — 稳定环境事实注入。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/envProbe.test.ts
 */
import * as assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'

const TEST_HOME = mkdtempSync(join(tmpdir(), 'envprobe-home-'))
process.env.OPENCLAUDE_HOME = TEST_HOME
delete process.env.OPENCLAUDE_PLATFORM_PROMPTS_DIR

const {
  ENV_SLOT_MAX_BYTES,
  buildEnvSlot,
  computeEnvFacts,
  probeEnvFacts,
  resetEnvFactsCache,
} = await import('../envProbe.js')
const { buildPromptContext } = await import('../promptSlots.js')
type EnvProbeDeps = import('../envProbe.js').EnvProbeDeps

const HOST_BIN = '/home/agent/.local/bin/host'
const MANIFEST = '/opt/openclaude/MANIFEST.json'
const LEGACY_GIT = '/opt/openclaude/openclaude/.git'
const COMMIT = '70aa2637d1435aa711a42bfc3e6aee8a044d03ce'
const CLAUDE_MD = '/run/oc/claude-config/CLAUDE.md'

type FakeFile = { exec?: boolean; content?: string }

interface FakeDeps extends EnvProbeDeps {
  exists: (path: string) => boolean
  _existsPaths: string[]
  _readPaths: string[]
}

function fakeDeps(opts: {
  env?: NodeJS.ProcessEnv
  files?: Record<string, FakeFile>
  initEnvironPath?: string | null
}): FakeDeps {
  const files = opts.files ?? {}
  const existsPaths: string[] = []
  const readPaths: string[] = []
  return {
    env: opts.env ?? {},
    initEnvironPath: opts.initEnvironPath === undefined ? null : opts.initEnvironPath,
    exists: (p: string) => {
      existsPaths.push(p)
      return p in files
    },
    isExecutable: (p: string) => !!files[p]?.exec,
    readPrefix: (p: string, maxBytes: number) => {
      readPaths.push(p)
      const content = files[p]?.content
      return content == null ? null : content.slice(0, maxBytes)
    },
    _existsPaths: existsPaths,
    _readPaths: readPaths,
  }
}

const selfhostEnv: NodeJS.ProcessEnv = {
  OC_USER_ID: '3',
  OC_CONTAINER_ID: '20',
  CLAUDE_CONFIG_DIR: '/run/oc/claude-config',
  OC_SELFHOST_ENGINE_LOCAL_TURNS: '1',
  OPENCLAUDE_HOME: '/home/agent/.openclaude',
  HOME: '/tmp/openclaude-cursor.fake-home',
}

const selfhostFiles: Record<string, FakeFile> = {
  [HOST_BIN]: { exec: true },
  [MANIFEST]: { content: `{\n  "schemaVersion": 1,\n  "sourceCommit": "${COMMIT}"\n}` },
}

describe('envProbe', () => {
  beforeEach(() => {
    resetEnvFactsCache()
  })
  afterEach(() => {
    resetEnvFactsCache()
  })

  it('renders selfhost facts from measured env/files and stays under budget', () => {
    const deps = fakeDeps({ env: selfhostEnv, files: selfhostFiles })
    const slot = buildEnvSlot({ agentId: 'main' }, deps)
    assert.ok(slot)
    assert.equal(slot.name, 'ENV')
    assert.match(slot.content, /^# Env · 勿重探$/m)
    assert.match(slot.content, /^uid=3 agent=main$/m)
    assert.match(slot.content, /^inst=新个人版V5自用$/m)
    assert.match(slot.content, /^host=yes HOME=\/home\/agent host 'cmd'$/m)
    assert.match(
      slot.content,
      new RegExp(`^snap=${COMMIT} -> /opt/openclaude/openclaude-v5-selfhost$`, 'm'),
    )
    assert.match(
      slot.content,
      /^rt=\/home\/agent\/\.openclaude gen=\/home\/agent\/\.openclaude\/generated up=\/home\/agent\/\.openclaude\/uploads$/m,
    )
    assert.doesNotMatch(slot.content, /openclaude-cursor/)
    assert.doesNotMatch(slot.content, /商业版容器/)
    const bytes = Buffer.byteLength(slot.content, 'utf8')
    assert.ok(bytes <= ENV_SLOT_MAX_BYTES, `env slot ${bytes} bytes exceeds ${ENV_SLOT_MAX_BYTES}`)
    const traced = deps
    assert.equal(traced._existsPaths.includes(CLAUDE_MD), false)
    assert.equal(traced._readPaths.includes(CLAUDE_MD), false)
    assert.equal(
      traced._existsPaths.some((p) => p.startsWith('/tmp/openclaude-cursor')),
      false,
    )
  })

  it('does not treat Cursor HOME as agent home or host path', () => {
    const deps = fakeDeps({
      env: { ...selfhostEnv, HOME: '/tmp/openclaude-cursor.fyym9OSC' },
      files: selfhostFiles,
    })
    const facts = computeEnvFacts(deps)
    assert.equal(facts.hostHome, '/home/agent')
    assert.equal(facts.runtimeDir, '/home/agent/.openclaude')
    assert.equal(facts.hostBin, HOST_BIN)
    const traced = deps
    assert.equal(
      traced._existsPaths.some((p) => p.includes('openclaude-cursor')),
      false,
    )
  })

  it('classifies commercial production without host channel and omits the git tree', () => {
    const slot = buildEnvSlot(
      { agentId: 'main' },
      fakeDeps({
        env: {
          OC_USER_ID: '1',
          OC_CONTAINER_ID: '9',
          CLAUDE_CONFIG_DIR: '/run/oc/claude-config',
          OPENCLAUDE_HOME: '/home/agent/.openclaude',
        },
        files: {
          [MANIFEST]: { content: `{"sourceCommit":"${COMMIT}"}` },
        },
      }),
    )
    assert.ok(slot)
    assert.match(slot.content, /uid=1/)
    assert.match(slot.content, /inst=V5商业版生产/)
    assert.match(slot.content, /^host=no$/m)
    assert.match(slot.content, new RegExp(`^snap=${COMMIT}$`, 'm'))
    assert.doesNotMatch(slot.content, /openclaude-v5-selfhost/)
    assert.doesNotMatch(slot.content, /openclaude-v5-aurora/)
  })

  it('classifies legacy personal only when the host git tree exists', () => {
    const slot = buildEnvSlot(
      { agentId: 'main' },
      fakeDeps({
        env: { OPENCLAUDE_HOME: '/root/.openclaude' },
        files: { [LEGACY_GIT]: {} },
      }),
    )
    assert.ok(slot)
    assert.match(slot.content, /inst=老个人版/)
    assert.match(slot.content, /^tree=\/opt\/openclaude\/openclaude$/m)
    assert.doesNotMatch(slot.content, /^uid=/)
  })

  it('omits instance when signals are ambiguous and omits the whole slot when nothing is known', () => {
    const ambiguous = buildEnvSlot(
      { agentId: 'main' },
      fakeDeps({
        env: { OPENCLAUDE_HOME: '/home/agent/.openclaude' },
        files: {},
      }),
    )
    assert.ok(ambiguous)
    assert.doesNotMatch(ambiguous.content, /^inst=/)
    assert.doesNotMatch(ambiguous.content, /^uid=/)

    const empty = buildEnvSlot(
      { agentId: 'main' },
      fakeDeps({ env: {}, files: {} }),
    )
    assert.equal(empty, null)
  })

  it('omits uid/snap lines when values are missing or malformed', () => {
    const slot = buildEnvSlot(
      { agentId: 'main' },
      fakeDeps({
        env: {
          OC_USER_ID: 'not-a-uid',
          OC_CONTAINER_ID: '20',
          CLAUDE_CONFIG_DIR: '/run/oc/claude-config',
          OC_SELFHOST_ENGINE_LOCAL_TURNS: '1',
          OPENCLAUDE_HOME: '/home/agent/.openclaude',
        },
        files: {
          [HOST_BIN]: { exec: true },
          [MANIFEST]: { content: '{"digest":"abc"}' },
        },
      }),
    )
    assert.ok(slot)
    assert.doesNotMatch(slot.content, /^uid=/)
    assert.doesNotMatch(slot.content, /^snap=/)
    assert.match(slot.content, /inst=新个人版V5自用/)
  })

  it('does not read /proc/1/environ when env is passed explicitly', () => {
    const facts = computeEnvFacts(
      fakeDeps({
        env: { OPENCLAUDE_HOME: '/home/agent/.openclaude' },
        files: {},
      }),
    )
    assert.equal(facts.uid, null)
    assert.equal(facts.instance, null)
  })

  it('fills allowlisted keys from init environ when process env was scrubbed', () => {
    const initPath = join(TEST_HOME, 'init-environ')
    writeFileSync(
      initPath,
      Buffer.from(
        [
          'OC_USER_ID=3',
          'OC_CONTAINER_ID=20',
          'CLAUDE_CONFIG_DIR=/run/oc/claude-config',
          'OC_SELFHOST_ENGINE_LOCAL_TURNS=1',
          'OPENCLAUDE_HOME=/home/agent/.openclaude',
          'HOME=/should-not-copy',
          'OPENCLAUDE_V3_CONTAINER_TOKEN=secret-must-not-copy',
        ].join('\0') + '\0',
      ),
    )
    const facts = computeEnvFacts(
      fakeDeps({
        env: { HOME: '/tmp/openclaude-cursor.x' },
        files: selfhostFiles,
        initEnvironPath: initPath,
      }),
    )
    assert.equal(facts.uid, '3')
    assert.equal(facts.instance, 'v5-selfhost')
    assert.equal(facts.runtimeDir, '/home/agent/.openclaude')
    assert.equal(facts.hostHome, '/home/agent')
  })

  it('caches the first probe so the second call does not re-read disk', () => {
    let existsCalls = 0
    const deps = fakeDeps({ env: selfhostEnv, files: selfhostFiles })
    const counting = {
      ...deps,
      exists: (p: string) => {
        existsCalls++
        return deps.exists(p)
      },
    }
    const first = probeEnvFacts(counting)
    assert.ok(existsCalls > 0)
    const afterFirst = existsCalls
    const second = probeEnvFacts({
      ...counting,
      exists: () => {
        throw new Error('cache miss re-read disk')
      },
      readPrefix: () => {
        throw new Error('cache miss re-read manifest')
      },
    })
    assert.equal(existsCalls, afterFirst)
    assert.equal(second, first)
    assert.equal(second.uid, '3')
  })

  it('injects ENV as the first prompt slot from the process cache', async () => {
    probeEnvFacts(fakeDeps({ env: selfhostEnv, files: selfhostFiles }))
    const result = await buildPromptContext({ agentId: 'wired-agent' })
    assert.equal(result.applied[0]?.name, 'ENV')
    assert.match(result.content, /uid=3 agent=wired-agent/)
    assert.match(result.content, /inst=新个人版V5自用/)
  })
})
