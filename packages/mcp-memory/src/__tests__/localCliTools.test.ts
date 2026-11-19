/**
 * Run: npx tsx --test packages/mcp-memory/src/__tests__/localCliTools.test.ts
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  clampInt,
  handleOcBash,
  handleOcGlob,
  handleOcGrep,
  isLocalCliToolEnabled,
  isLocalCliToolName,
  LOCAL_CLI_TOOL_NAMES,
  OC_BASH_MAX_TIMEOUT_MS,
  OC_BASH_MIN_TIMEOUT_MS,
  OC_GREP_MAX_LINE_CHARS,
  OcBashJobManager,
  ocGlobArgv,
  ocGrepArgv,
  runCaptured,
} from '../localCliTools.js'
import { DeltaStreamBuffer } from '../ocBashJobManager.js'
import { TOOLS } from '../toolDefs.js'

describe('clampInt', () => {
  it('falls back, floors, and clamps up to the 600s Antigravity ceiling in lockstep with toolDefs', () => {
    assert.equal(clampInt(undefined, 60_000, OC_BASH_MIN_TIMEOUT_MS, OC_BASH_MAX_TIMEOUT_MS), 60_000)
    assert.equal(clampInt('nope', 60_000, 1_000, 600_000), 60_000)
    assert.equal(clampInt(500, 60_000, 1_000, 600_000), 1_000)
    assert.equal(clampInt(300_000, 60_000, OC_BASH_MIN_TIMEOUT_MS, OC_BASH_MAX_TIMEOUT_MS), 300_000)
    assert.equal(clampInt(999_999, 60_000, OC_BASH_MIN_TIMEOUT_MS, OC_BASH_MAX_TIMEOUT_MS), 600_000)
    assert.equal(OC_BASH_MAX_TIMEOUT_MS, 600_000)
    assert.equal(clampInt(1500.9, 60_000, 1_000, 600_000), 1500)
    const ocBashDef = TOOLS.find((t) => t.name === 'oc_bash')
    assert.ok(ocBashDef, 'oc_bash definition must exist in TOOLS')
    const timeoutProp = (ocBashDef.inputSchema.properties as Record<string, { maximum?: number }>).timeout_ms
    assert.equal(timeoutProp?.maximum, OC_BASH_MAX_TIMEOUT_MS)
    assert.match(ocBashDef.description, /600000/)
    assert.equal(ocBashDef.description.includes('170000'), false)
  })
})

describe('rg argv', () => {
  it('oc_grep puts the pattern after -- and never shells it', () => {
    assert.deepEqual(
      ocGrepArgv('/usr/bin/rg', { pattern: '-n', path: 'src', glob: '*.ts', maxMatches: 80 }),
      ['/usr/bin/rg', '--line-number', '--no-heading', '--color', 'never', '--max-count', '80', '--glob', '*.ts', '--', '-n', 'src'],
    )
  })

  it('oc_glob uses --files and skips .git', () => {
    assert.deepEqual(
      ocGlobArgv('/usr/bin/rg', { pattern: '*.ts', path: 'src' }),
      ['/usr/bin/rg', '--files', '--hidden', '--iglob', '*.ts', '--glob', '!.git/**', '--color', 'never', '--', 'src'],
    )
    const noPath = ocGlobArgv('/usr/bin/rg', { pattern: '*.ts' })
    assert.equal(noPath.includes('--'), false)
    assert.equal(noPath.includes('src'), false)
    assert.deepEqual(
      ocGlobArgv('/usr/bin/rg', { pattern: '*', path: '--glob=!*' }).slice(-2),
      ['--', '--glob=!*'],
    )
  })
})

describe('oc_bash', () => {
  it('rejects an empty command', async () => {
    const result = await handleOcBash({ command: '   ' })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /command/)
  })

  it('returns stdout and exit=0 for a short command', async () => {
    const result = await handleOcBash({ command: 'echo hello-oc-bash' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /exit=0/)
    assert.match(result.content[0]!.text, /hello-oc-bash/)
  })

  it('reports a non-zero exit in the text without a protocol error', async () => {
    const result = await handleOcBash({ command: 'exit 7' })
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /exit=7/)
  })

  it('caps timeout_ms 999999 at 600000 and still returns a short command', async () => {
    assert.equal(
      clampInt(999_999, 60_000, OC_BASH_MIN_TIMEOUT_MS, OC_BASH_MAX_TIMEOUT_MS),
      600_000,
    )
    const started = Date.now()
    const result = await handleOcBash({ command: 'echo capped', timeout_ms: 999_999 })
    assert.ok(Date.now() - started < 5_000, 'must not sleep the requested timeout')
    assert.equal(result.isError, undefined)
    assert.match(result.content[0]!.text, /exit=0/)
    assert.match(result.content[0]!.text, /capped/)
  })

  it('kills a detached descendant ignoring TERM when kill_on_timeout=true', { timeout: 8_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-timeout-'))
    const pidFile = join(dir, 'child.pid')
    let pid: number | undefined
    const running = (childPid: number): boolean => {
      try {
        const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8')
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    }
    try {
      const result = await handleOcBash({
        command: `bash -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 30' >/dev/null 2>&1 & wait`,
        timeout_ms: 1000,
        kill_on_timeout: true,
      })
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.ok(Number.isInteger(pid) && pid > 0)
      assert.equal(result.isError, true)
      assert.match(result.content[0]!.text, /timed out/)
      const deadline = Date.now() + 2_000
      while (running(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(running(pid), false, 'TERM-ignoring child must not survive the timed-out shell')
    } finally {
      if (pid && running(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('kills a sleep that outlives the timeout when kill_on_timeout=true', async () => {
    const started = Date.now()
    const result = await handleOcBash({ command: 'sleep 30', timeout_ms: 1000, kill_on_timeout: true })
    const elapsed = Date.now() - started
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /timed out/)
    assert.ok(elapsed < 8_000, `elapsed ${elapsed}ms`)
  })

  it('soft-yields by default at timeout_ms and completes cleanly on subsequent job_id wait', { timeout: 12_000 }, async () => {
    const mgr = new OcBashJobManager()
    try {
      const first = await handleOcBash(
        { command: 'printf "part-1\\n"; sleep 1.6; printf "part-2\\n"', timeout_ms: 1000 },
        { jobManager: mgr },
      )
      assert.equal(first.isError, undefined)
      const firstText = first.content[0]!.text
      assert.match(firstText, /status=running job_id=(ocb_\d+)/)
      assert.match(firstText, /part-1/)
      assert.doesNotMatch(firstText, /part-2/)
      const jobId = /job_id=(ocb_\d+)/.exec(firstText)![1]!

      const second = await handleOcBash({ job_id: jobId, timeout_ms: 5000 }, { jobManager: mgr })
      assert.equal(second.isError, undefined)
      const secondText = second.content[0]!.text
      assert.match(secondText, /^exit=0/m)
      assert.match(secondText, /part-2/)
      assert.doesNotMatch(secondText, /part-1/)

      const third = await handleOcBash({ job_id: jobId }, { jobManager: mgr })
      assert.equal(third.isError, undefined)
      assert.match(third.content[0]!.text, /status=already_collected/)
    } finally {
      mgr.shutdown()
    }
  })

  it('supports action=status and action=kill on TERM-ignoring descendants', { timeout: 12_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-kill-'))
    const pidFile = join(dir, 'child.pid')
    const mgr = new OcBashJobManager()
    let pid: number | undefined
    const running = (childPid: number): boolean => {
      try {
        const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8')
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    }
    try {
      const yielded = await handleOcBash(
        {
          command: `echo "booting"; bash -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 30' >/dev/null 2>&1 & wait`,
          timeout_ms: 1000,
        },
        { jobManager: mgr },
      )
      assert.equal(yielded.isError, undefined)
      const jobId = /job_id=(ocb_\d+)/.exec(yielded.content[0]!.text)![1]!
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.equal(running(pid), true)

      const polled = await handleOcBash({ job_id: jobId, action: 'status' }, { jobManager: mgr })
      assert.equal(polled.isError, undefined)
      assert.match(polled.content[0]!.text, new RegExp(`status=running job_id=${jobId}`))

      const killed = await handleOcBash({ job_id: jobId, action: 'kill' }, { jobManager: mgr })
      assert.equal(killed.isError, undefined)
      assert.match(killed.content[0]!.text, new RegExp(`status=killed job_id=${jobId}`))

      const deadline = Date.now() + 2_000
      while (running(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
      assert.equal(running(pid), false)

      const afterKill = await handleOcBash({ job_id: jobId }, { jobManager: mgr })
      assert.equal(afterKill.isError, undefined)
      assert.match(afterKill.content[0]!.text, /status=already_killed/)
    } finally {
      mgr.shutdown()
      if (pid && running(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps head + rolling tail and UTF-8 boundaries when >200KB output truncates', async () => {
    const script = [
      'process.stdout.write("HEAD_BANNER_MARKER\\n");',
      'const chunk = "🚀中文".repeat(2000);',
      'for (let i = 0; i < 20; i++) process.stdout.write(chunk);',
      'process.stdout.write("\\nFINAL_FAILURE_SUMMARY_MARKER\\n");',
      'process.exit(1);',
    ].join('')
    const result = await handleOcBash({
      command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
      timeout_ms: 10_000,
    })
    assert.equal(result.isError, undefined)
    const text = result.content[0]!.text
    assert.match(text, /^exit=1 truncated/m)
    assert.match(text, /HEAD_BANNER_MARKER/)
    assert.match(text, /FINAL_FAILURE_SUMMARY_MARKER/)
    assert.match(text, /\.\.\.\[truncated \d+ bytes\]\.\.\./)
    assert.equal(text.includes('\uFFFD'), false, 'must not contain UTF-8 replacement chars')
    assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false)
    assert.ok(Buffer.byteLength(text, 'utf8') <= 215 * 1024)
  })

  it('carries split UTF-8 multi-byte sequences cleanly across DeltaStreamBuffer drains', () => {
    const buf = new DeltaStreamBuffer(1024)
    const emoji = Buffer.from('🚀', 'utf8') // F0 9F 9A 80
    buf.push(Buffer.concat([Buffer.from('ok-'), emoji.subarray(0, 2)]))
    const seg1 = buf.drain(false)
    assert.equal(seg1.text, 'ok-')
    assert.equal(seg1.truncated, false)
    buf.push(Buffer.concat([emoji.subarray(2), Buffer.from('-done')]))
    const seg2 = buf.drain(true)
    assert.equal(seg2.text, '🚀-done')
    assert.equal(seg2.truncated, false)
  })

  it('reaps unpolled yielded jobs after idleJobTtlMs and reports tombstone error', { timeout: 10_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-idle-'))
    const pidFile = join(dir, 'idle.pid')
    const mgr = new OcBashJobManager({ idleJobTtlMs: 250 })
    let pid: number | undefined
    const running = (childPid: number): boolean => {
      try {
        const stat = readFileSync(`/proc/${childPid}/stat`, 'utf8')
        return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0] !== 'Z'
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw err
      }
    }
    try {
      const yielded = await handleOcBash(
        {
          command: `bash -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 30' >/dev/null 2>&1 & wait`,
          timeout_ms: 1000,
        },
        { jobManager: mgr },
      )
      assert.equal(yielded.isError, undefined)
      const jobId = /job_id=(ocb_\d+)/.exec(yielded.content[0]!.text)![1]!
      pid = Number(readFileSync(pidFile, 'utf8').trim())
      assert.equal(running(pid), true)

      const deadline = Date.now() + 3_000
      while (running(pid) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 30))
      assert.equal(running(pid), false, 'idle TTL must kill unpolled process group')

      // Wait briefly for close listener tombstone promotion if needed.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const after = await handleOcBash({ job_id: jobId }, { jobManager: mgr })
      assert.equal(after.isError, true)
      assert.match(after.content[0]!.text, /terminated_idle|idle timeout/)
    } finally {
      mgr.shutdown()
      if (pid && running(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('enforces maxActiveJobs concurrency cap and recovers after kill', { timeout: 10_000 }, async () => {
    const mgr = new OcBashJobManager({ maxActiveJobs: 2 })
    try {
      const j1 = await handleOcBash({ command: 'sleep 30', timeout_ms: 1000 }, { jobManager: mgr })
      const j2 = await handleOcBash({ command: 'sleep 30', timeout_ms: 1000 }, { jobManager: mgr })
      assert.equal(j1.isError, undefined)
      assert.equal(j2.isError, undefined)
      const id1 = /job_id=(ocb_\d+)/.exec(j1.content[0]!.text)![1]!
      const id2 = /job_id=(ocb_\d+)/.exec(j2.content[0]!.text)![1]!

      const blocked = await handleOcBash({ command: 'echo blocked', timeout_ms: 1000 }, { jobManager: mgr })
      assert.equal(blocked.isError, true)
      assert.match(blocked.content[0]!.text, /并发上限/)
      assert.match(blocked.content[0]!.text, new RegExp(id1))
      assert.match(blocked.content[0]!.text, new RegExp(id2))

      await handleOcBash({ job_id: id1, action: 'kill' }, { jobManager: mgr })
      const ok = await handleOcBash({ command: 'echo freed-slot', timeout_ms: 5000 }, { jobManager: mgr })
      assert.equal(ok.isError, undefined)
      assert.match(ok.content[0]!.text, /freed-slot/)
    } finally {
      mgr.shutdown()
    }
  })

  it('injects OC_BASH_TIMEOUT_MS and validates mutually exclusive / action inputs', async () => {
    const envRes = await handleOcBash({ command: 'echo "t=$OC_BASH_TIMEOUT_MS"', timeout_ms: 12345 })
    assert.equal(envRes.isError, undefined)
    assert.match(envRes.content[0]!.text, /t=12345/)

    const both = await handleOcBash({ command: 'echo 1', job_id: 'ocb_1' })
    assert.equal(both.isError, true)
    assert.match(both.content[0]!.text, /不能同时传入/)

    const badAction = await handleOcBash({ job_id: 'ocb_1', action: 'bogus' })
    assert.equal(badAction.isError, true)
    assert.match(badAction.content[0]!.text, /无效的 action/)

    const cmdWithKill = await handleOcBash({ command: 'echo 1', action: 'kill' })
    assert.equal(cmdWithKill.isError, true)

    const missing = await handleOcBash({ job_id: 'ocb_missing_999' })
    assert.equal(missing.isError, true)
    assert.match(missing.content[0]!.text, /未找到任务/)
  })
})

describe('runCaptured truncation', () => {
  it('caps output and still lets the writer exit', async () => {
    const outcome = await runCaptured({
      bin: '/bin/bash',
      args: ['-lc', "printf '%200000s' '' | tr ' ' x"],
      timeoutMs: 8_000,
      maxBytes: 1024,
    })
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.truncated, true)
    assert.equal(outcome.exitCode, 0)
    assert.ok(outcome.stdout.length <= 1024)
  })
})

describe('oc_grep / oc_glob', () => {
  it('returns rg hits and no-match text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-'))
    writeFileSync(join(dir, 'note.ts'), 'export const needle = 1\n')
    const hit = await handleOcGrep({ pattern: 'needle', path: dir })
    assert.equal(hit.isError, undefined)
    assert.match(hit.content[0]!.text, /needle/)
    const miss = await handleOcGrep({ pattern: 'not-in-file-xyz', path: dir })
    assert.equal(miss.isError, undefined)
    assert.equal(miss.content[0]!.text, 'no matches')
    const files = await handleOcGlob({ pattern: 'note.ts', path: dir })
    assert.equal(files.isError, undefined)
    assert.match(files.content[0]!.text, /note\.ts/)
  })

  it('does not treat a path that looks like an rg flag as an option', async () => {
    const result = await handleOcGlob({ pattern: '*', path: '--glob=!*' })
    assert.equal(result.isError, true)
    const text = result.content[0]!.text
    assert.match(text, /No such file|os error/)
    assert.doesNotMatch(text, /^package\.json$/m)
    assert.doesNotMatch(text, /^bun\.lock$/m)
  })

  it('errors when rg is missing', async () => {
    const result = await handleOcGrep({ pattern: 'x' }, { rgBin: null })
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /找不到 rg/)
    const globbed = await handleOcGlob({ pattern: '*.ts' }, { rgBin: null })
    assert.equal(globbed.isError, true)
    assert.match(globbed.content[0]!.text, /找不到 rg/)
  })

  it('bounds single-line minified oc_grep hits without splitting UTF-16 surrogate pairs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-cli-longline-'))
    try {
      // Place an emoji (surrogate pair) straddling the exact cut index so naive slice() would leave a lone high surrogate.
      const prefixLen = OC_GREP_MAX_LINE_CHARS - 20
      const linePrefix = 'a'.repeat(prefixLen)
      // Note: rg prepends `<file>:1:` to the output line; pad across a range of offsets with emojis to guarantee surrogate safety.
      const emojiRun = '🚀'.repeat(40)
      writeFileSync(join(dir, 'minified.js'), `const bundle = "${linePrefix}${emojiRun}${'z'.repeat(5000)}";\n`)

      const hit = await handleOcGrep({ pattern: 'bundle', path: dir })
      assert.equal(hit.isError, undefined)
      const text = hit.content[0]!.text
      assert.match(text, /\[truncated\]$/)
      const firstLine = text.split('\n')[0]!
      assert.ok(firstLine.length <= OC_GREP_MAX_LINE_CHARS + 1)
      assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false, 'must not emit lone UTF-16 surrogates')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('isLocalCliToolEnabled', () => {
  it('is true only for the antigravity engine id', () => {
    assert.equal(isLocalCliToolEnabled('antigravity'), true)
    for (const engine of ['', 'grok', 'cursor', 'ccb', 'codex', 'Antigravity']) {
      assert.equal(isLocalCliToolEnabled(engine), false, JSON.stringify(engine))
    }
    assert.deepEqual([...LOCAL_CLI_TOOL_NAMES], ['oc_bash', 'oc_grep', 'oc_glob'])
    assert.equal(isLocalCliToolName('oc_bash'), true)
    assert.equal(isLocalCliToolName('oc_grep'), true)
    assert.equal(isLocalCliToolName('oc_glob'), true)
    assert.equal(isLocalCliToolName('skill_list'), false)
  })
})
