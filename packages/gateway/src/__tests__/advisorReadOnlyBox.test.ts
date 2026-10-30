import assert from 'node:assert/strict'
import { test } from 'node:test'
import { remoteClaudeArgs } from '../engine/cursorBoxCcExec.js'
import { remoteInteractiveClaudeArgs, boxCcInteractiveLaunchExec } from '../engine/cursorBoxCcInteractive.js'
import { buildOfficialClaudeCliArgs } from '../subprocessSpawnConfig.js'

for (const convert of [remoteClaudeArgs, remoteInteractiveClaudeArgs]) {
  test(`${convert.name} preserves no-write tools and closes remote MCP discovery`, () => {
    const original = buildOfficialClaudeCliArgs({
      model: 'box-claude-sonnet-5', permissionMode: 'bypassPermissions', readOnly: true,
      mcpConfigFile: '/container/restricted-mcp.json', resumeSessionId: 'original-session',
    })
    const remote = convert(original)
    assert.equal(remote[remote.indexOf('--tools') + 1], 'Read,Glob,Grep')
    assert.ok(remote.includes('--strict-mcp-config'))
    assert.deepEqual(JSON.parse(remote[remote.indexOf('--mcp-config') + 1]!), { mcpServers: {} })
    assert.equal(remote.includes('/container/restricted-mcp.json'), false)
    assert.equal(remote[remote.indexOf('--resume') + 1], 'original-session')
    const ordinary = convert(buildOfficialClaudeCliArgs({ permissionMode: 'bypassPermissions' }))
    assert.equal(ordinary.includes('--tools'), false)
    assert.equal(ordinary.includes('--strict-mcp-config'), false)
    const launch = boxCcInteractiveLaunchExec({
      fifo: '/tmp/oc-box-cc-test.aaaaaaaa.fifo', cwd: '/workspace', remoteClaude: '/home/box/.local/bin/claude',
    } as never, remote, { files: {}, sha256: 'test', hostPy: '' })
    assert.equal(launch.args[launch.args.indexOf('--tools') + 1], 'Read,Glob,Grep')
    assert.throws(() => convert(['--tools', 'Bash', '--strict-mcp-config']), /BOX_ADVISOR_READ_ONLY_POLICY_INVALID/)
    assert.throws(() => convert(['--tools', 'Read,Glob,Grep']), /BOX_ADVISOR_READ_ONLY_POLICY_INVALID/)
  })
}
