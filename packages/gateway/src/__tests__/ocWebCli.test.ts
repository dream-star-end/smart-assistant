import * as assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { runOcWebCli } from '../ocWebCli.js'

describe('runOcWebCli — dispatch & usage', () => {
  it('no command → usage error (exit 2)', async () => {
    const r = await runOcWebCli([])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /Usage: oc-web/)
  })

  it('help → exit 0 with usage on stdout', async () => {
    const r = await runOcWebCli(['help'])
    assert.equal(r.exitCode, 0)
    assert.match(r.stdout, /Usage: oc-web/)
  })

  it('unknown command → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['frobnicate'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /unknown command 'frobnicate'/)
  })

  it('extract without url → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['extract'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /requires a <url>/)
  })

  it('parse without file → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['parse'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /requires a <file>/)
  })
})

describe('runOcWebCli — parse safety boundary is preserved', () => {
  it('rejects a relative path (must be absolute)', async () => {
    const r = await runOcWebCli(['parse', 'relative/path.pdf'])
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /absolute path/)
  })

  it('rejects an absolute path outside the safe roots', async () => {
    // /etc/passwd exists (realpath resolves) but is outside the uploads/
    // generated/ScanSci allowlist, so resolveSafeParseFile must throw.
    const r = await runOcWebCli(['parse', '/etc/passwd'])
    assert.equal(r.exitCode, 1)
    assert.ok(r.stderr.startsWith('oc-web:'))
    assert.match(r.stderr, /under uploads|absolute path|regular file|extension/)
  })

  it('--json surfaces failures as valid JSON with ok:false', async () => {
    const r = await runOcWebCli(['parse', '/etc/passwd', '--json'])
    assert.equal(r.exitCode, 1)
    const parsed = JSON.parse(r.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(typeof parsed.error, 'string')
  })
})

describe('runOcWebCli — extract input validation', () => {
  it('extract with empty url string → core rejects (exit 1)', async () => {
    const r = await runOcWebCli(['extract', '   '])
    // a whitespace-only positional still counts as present at the CLI layer,
    // so it reaches extractUrl, which rejects with "url is required".
    assert.equal(r.exitCode, 1)
    assert.match(r.stderr, /url is required/)
  })

  it('extra positional → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['extract', 'https://a', 'https://b'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /single <url>/)
  })
})

describe('runOcWebCli — flag parsing robustness', () => {
  it('--flag=value form is accepted (reaches core, not a usage error)', async () => {
    // /etc/passwd is rejected by the parse safety gate (exit 1), which proves
    // the `--max-chars=100` flag parsed cleanly rather than tripping usage(2).
    const r = await runOcWebCli(['parse', '/etc/passwd', '--max-chars=100'])
    assert.equal(r.exitCode, 1)
  })

  it('unknown flag → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['parse', '/etc/passwd', '--bogus'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /unknown flag --bogus/)
  })

  it('value flag without a value → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['parse', '/etc/passwd', '--max-chars'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /requires a value/)
  })

  it('boolean flag given a value → usage error (exit 2)', async () => {
    const r = await runOcWebCli(['health', '--json=1'])
    assert.equal(r.exitCode, 2)
    assert.match(r.stderr, /takes no value/)
  })
})

describe('runOcWebCli — health integration', () => {
  it('executes the configured parser and formats a successful health result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'oc-web-health-'))
    const bin = join(dir, 'web-context-helper')
    await writeFile(
      bin,
      `#!/bin/sh
payload="$(cat)"
case "$payload" in
  *'"op":"health_check"'*) printf '%s\\n' '{"ok":true,"python":true,"browser":false}' ;;
  *) printf '%s\\n' 'unexpected payload' >&2; exit 9 ;;
esac
`,
    )
    await chmod(bin, 0o755)

    const previous = process.env.OPENCLAUDE_WEB_CONTEXT_BIN
    process.env.OPENCLAUDE_WEB_CONTEXT_BIN = bin
    try {
      const r = await runOcWebCli(['health', '--json'])
      assert.equal(r.exitCode, 0, r.stderr)
      assert.deepEqual(JSON.parse(r.stdout), {
        ok: true,
        python: true,
        browser: false,
      })
    } finally {
      if (previous === undefined) process.env.OPENCLAUDE_WEB_CONTEXT_BIN = undefined
      else process.env.OPENCLAUDE_WEB_CONTEXT_BIN = previous
      await rm(dir, { recursive: true, force: true })
    }
  })
})
