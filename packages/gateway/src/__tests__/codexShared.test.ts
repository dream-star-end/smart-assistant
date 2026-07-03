import * as assert from 'node:assert/strict'
/**
 * Tests for engine/codexShared — codex spawn 路径共享 helper(M1a 从旧
 * codexRunner.ts 抽离的 6 符号)。effort 归一 / provider 路由覆盖用例移植自
 * P1f 删除的 codexRunnerArgs.test.ts(exec argv 主体不复活,只搬 helper 段);
 * buildCodexEnv scrub 是安全红线(codex 进程不得见 OpenClaude/Anthropic 凭证),
 * 补锁死用例。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/codexShared.test.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  _sanitizeThreadId,
  buildCodexEnv,
  buildCodexProviderConfigArgs,
  buildCodexTelemetryHardeningArgs,
  codexReasoningEffortConfig,
  copyImagePathsToPublicDir,
} from '../engine/codexShared.js'

/** 从 `-c a=b -c c=d` 的扁平数组里取出 key=value 对(过滤 '-c' 分隔符)。 */
function pairsOf(args: string[]): string[] {
  return args.filter((a) => a !== '-c')
}

describe('codexReasoningEffortConfig', () => {
  it('returns empty array for missing / empty / invalid input', () => {
    assert.deepEqual(codexReasoningEffortConfig(undefined), [])
    assert.deepEqual(codexReasoningEffortConfig(null), [])
    assert.deepEqual(codexReasoningEffortConfig(''), [])
    assert.deepEqual(codexReasoningEffortConfig('turbo'), [])
    assert.deepEqual(codexReasoningEffortConfig('minimal'), [])
  })

  it('returns -c slot for direct levels', () => {
    assert.deepEqual(codexReasoningEffortConfig('low'), ['-c', 'model_reasoning_effort="low"'])
    assert.deepEqual(codexReasoningEffortConfig('medium'), [
      '-c',
      'model_reasoning_effort="medium"',
    ])
    assert.deepEqual(codexReasoningEffortConfig('high'), ['-c', 'model_reasoning_effort="high"'])
    assert.deepEqual(codexReasoningEffortConfig('xhigh'), ['-c', 'model_reasoning_effort="xhigh"'])
  })

  it('max → xhigh explicit map', () => {
    assert.deepEqual(codexReasoningEffortConfig('max'), ['-c', 'model_reasoning_effort="xhigh"'])
  })
})

describe('buildCodexProviderConfigArgs', () => {
  it('maps OC_CODEX_* env to TOML -c overrides', () => {
    const args = buildCodexProviderConfigArgs({
      OC_CODEX_MODEL_PROVIDER: 'api111',
      OC_CODEX_BASE_URL: 'https://yunwu.ai/v1',
      OC_CODEX_WIRE_API: 'responses',
      OC_CODEX_PREFERRED_AUTH_METHOD: 'apikey',
      OC_CODEX_DISABLE_RESPONSE_STORAGE: '1',
    })
    assert.deepEqual(args, [
      '-c',
      'model_provider="api111"',
      '-c',
      'model_providers.api111.name="api111"',
      '-c',
      'model_providers.api111.base_url="https://yunwu.ai/v1"',
      '-c',
      'model_providers.api111.wire_api="responses"',
      '-c',
      'preferred_auth_method="apikey"',
      '-c',
      'disable_response_storage=true',
    ])
  })

  it('per-turn route override wins over env defaults, without inheriting env-only fields', () => {
    const args = buildCodexProviderConfigArgs(
      {
        OC_CODEX_MODEL_PROVIDER: 'env_provider',
        OC_CODEX_BASE_URL: 'https://env.example/v1',
        OC_CODEX_PROVIDER_NAME: 'env_name',
        OC_CODEX_WIRE_API: 'chat_completions',
        OC_CODEX_PREFERRED_AUTH_METHOD: 'envauth',
        OC_CODEX_DISABLE_RESPONSE_STORAGE: '0',
      },
      {
        modelProvider: 'route_provider',
        baseUrl: 'http://127.0.0.1:18789/internal/v3/codex-relay/route/abcdef',
        providerName: null,
        wireApi: null,
        preferredAuthMethod: null,
        disableResponseStorage: null,
      },
    )
    assert.deepEqual(args, [
      '-c',
      'model_provider="route_provider"',
      '-c',
      'model_providers.route_provider.name="route_provider"',
      '-c',
      'model_providers.route_provider.base_url="http://127.0.0.1:18789/internal/v3/codex-relay/route/abcdef"',
      '-c',
      'model_providers.route_provider.wire_api="responses"',
      '-c',
      'preferred_auth_method="apikey"',
      '-c',
      'disable_response_storage=true',
    ])
  })

  it('empty override = official OAuth marker → ignores env relay defaults entirely', () => {
    const args = buildCodexProviderConfigArgs(
      {
        OC_CODEX_MODEL_PROVIDER: 'api111',
        OC_CODEX_BASE_URL: 'https://yunwu.ai/v1',
      },
      {},
    )
    assert.deepEqual(args, [])
  })

  it('rejects malformed provider ids and honors false storage flag', () => {
    assert.deepEqual(
      buildCodexProviderConfigArgs({
        OC_CODEX_MODEL_PROVIDER: 'bad.provider',
        OC_CODEX_BASE_URL: 'https://yunwu.ai/v1',
      }),
      [],
    )
    const args = buildCodexProviderConfigArgs({
      OC_CODEX_MODEL_PROVIDER: 'api111',
      OC_CODEX_BASE_URL: 'https://yunwu.ai/v1',
      OC_CODEX_DISABLE_RESPONSE_STORAGE: 'false',
    })
    assert.ok(args.includes('disable_response_storage=false'), args.join(' '))
  })
})

describe('buildCodexTelemetryHardeningArgs — 遥测/自更新封堵(C1 双保险)', () => {
  it('总是关 analytics / otel(trace+metrics)/ 启动更新检查', () => {
    const pairs = pairsOf(buildCodexTelemetryHardeningArgs())
    assert.ok(pairs.includes('analytics.enabled=false'), pairs.join(' '))
    assert.ok(pairs.includes('otel.trace_exporter="none"'), pairs.join(' '))
    assert.ok(pairs.includes('otel.metrics_exporter="none"'), pairs.join(' '))
    assert.ok(pairs.includes('check_for_update_on_startup=false'), pairs.join(' '))
    // 每个键前都有 '-c'
    assert.equal(buildCodexTelemetryHardeningArgs().filter((a) => a === '-c').length, pairs.length)
  })

  it('探针实测偏离锁定:不使用 log_exporter(0.137 非有效键)', () => {
    const flat = buildCodexTelemetryHardeningArgs('http://127.0.0.1:18789/x').join(' ')
    assert.ok(!flat.includes('log_exporter'), flat)
  })

  it('给了 loopback relay base → 追加 chatgpt_base_url 顶层键(引号包裹)', () => {
    const base = 'http://127.0.0.1:18789/internal/v3/codex-relay/backend-api/codex'
    const pairs = pairsOf(buildCodexTelemetryHardeningArgs(base))
    assert.ok(pairs.includes(`chatgpt_base_url="${base}"`), pairs.join(' '))
  })

  it('缺 base(legacy naked 路径)→ 省略 chatgpt_base_url,其余照常', () => {
    for (const empty of [undefined, null, '', '   ']) {
      const pairs = pairsOf(buildCodexTelemetryHardeningArgs(empty))
      assert.ok(!pairs.some((p) => p.startsWith('chatgpt_base_url=')), `empty=${JSON.stringify(empty)}`)
      assert.ok(pairs.includes('analytics.enabled=false'))
    }
  })
})

describe('buildCodexEnv — 凭证 scrub(安全红线)', () => {
  const patched: string[] = []
  const setEnv = (k: string, v: string) => {
    patched.push(k)
    process.env[k] = v
  }
  afterEach(() => {
    for (const k of patched.splice(0)) Reflect.deleteProperty(process.env, k)
  })

  it('scrubs exact keys and OPENCLAUDE_/ANTHROPIC_/CLAUDE_CODE_ prefixes, keeps the rest', () => {
    setEnv('ANTHROPIC_API_KEY', 'sk-secret')
    setEnv('ANTHROPIC_BASE_URL', 'http://172.31.0.1:18892')
    setEnv('CLAUDE_CODE_OAUTH_TOKEN', 'oauth-secret')
    setEnv('OPENCLAUDE_GATEWAY_TOKEN', 'gw-secret')
    setEnv('OPENCLAUDE_V3_CONTAINER_TOKEN', 'container-secret')
    setEnv('MINIMAX_API_KEY', 'mm-secret')
    setEnv('DEEPSEEK_API_KEY', 'ds-secret')
    setEnv('OC_TEST_HARMLESS_VAR', 'keep-me')
    const env = buildCodexEnv()
    assert.equal(env.ANTHROPIC_API_KEY, undefined)
    assert.equal(env.ANTHROPIC_BASE_URL, undefined)
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined)
    assert.equal(env.OPENCLAUDE_GATEWAY_TOKEN, undefined)
    assert.equal(env.OPENCLAUDE_V3_CONTAINER_TOKEN, undefined, 'prefix scrub must cover container token')
    assert.equal(env.MINIMAX_API_KEY, undefined)
    assert.equal(env.DEEPSEEK_API_KEY, undefined)
    assert.equal(env.OC_TEST_HARMLESS_VAR, 'keep-me')
  })

  it('nit1:剥除全大小写 proxy 变体 + 强制 NO_PROXY loopback/网关', () => {
    setEnv('HTTP_PROXY', 'http://172.31.0.1:18892')
    setEnv('http_proxy', 'http://172.31.0.1:18892')
    setEnv('HTTPS_PROXY', 'http://172.31.0.1:18892')
    setEnv('https_proxy', 'http://172.31.0.1:18892')
    setEnv('ALL_PROXY', 'socks5://172.31.0.1:1080')
    setEnv('all_proxy', 'socks5://172.31.0.1:1080')
    const env = buildCodexEnv()
    for (const k of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
      assert.equal(env[k], undefined, `proxy var ${k} must be scrubbed (A 网络面 fail-closed 前提)`)
    }
    // 正向声明:NO_PROXY 两变体都被设成 loopback/网关直连
    assert.equal(env.NO_PROXY, '127.0.0.1,localhost,172.31.0.1')
    assert.equal(env.no_proxy, '127.0.0.1,localhost,172.31.0.1')
  })
})

describe('_sanitizeThreadId / copyImagePathsToPublicDir', () => {
  it('sanitize strips path separators and shell metacharacters', () => {
    assert.equal(_sanitizeThreadId('thr_abc-123.X'), 'thr_abc-123.X')
    assert.equal(_sanitizeThreadId('../evil/$(rm)'), '..evilrm')
  })

  it('copies images with codex-<thread>-<basename> naming and reports failures', async () => {
    const src = await mkdtemp(join(tmpdir(), 'codex-shared-src-'))
    const dst = await mkdtemp(join(tmpdir(), 'codex-shared-dst-'))
    try {
      const img = join(src, 'ig_cafe.png')
      await writeFile(img, Buffer.from('89504e47', 'hex'))
      const missing = join(src, 'nope.png')
      const { copied, failedNames } = await copyImagePathsToPublicDir('thr/1', [img, missing], dst)
      assert.equal(copied.length, 1)
      assert.equal(copied[0].publicPath, join(dst, 'codex-thr1-ig_cafe.png'))
      assert.ok(existsSync(copied[0].publicPath))
      assert.deepEqual(failedNames, ['nope.png'])
    } finally {
      await rm(src, { recursive: true, force: true })
      await rm(dst, { recursive: true, force: true })
    }
  })
})
