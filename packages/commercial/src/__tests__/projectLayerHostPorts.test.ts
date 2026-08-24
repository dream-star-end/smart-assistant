import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'node:test'
import {
  CANONICAL_HOST_LIVE_READ_SCRIPT,
  applyArmed,
  containerToHostPath,
  makeApplyPorts,
  openLiveReadHandle,
  parseUsageRowId,
  portsFromSnapshot,
  resolveLiveReadScript,
  type LiveSnapshot,
} from '../projectLayerHostPorts.js'

const OCV5 = '852859fa-cf1d-481c-96fd-23f2966b8b5f'
const here = dirname(fileURLToPath(import.meta.url))
const pySrc = readFileSync(
  join(here, '../../scripts/ocv5-project-layer-live-read.py'),
  'utf8',
)

function snap(over: Partial<LiveSnapshot> = {}): LiveSnapshot {
  return {
    generatedAt: '2026-08-24T00:00:00Z',
    readonly: true,
    usageBoardColumn: false,
    sessions: [
      { id: 'web-a', projectId: null, updatedAt: 10, deletedAt: null, archivedAt: null },
    ],
    chatProjects: [{ id: 'chat-1', name: 'x', boardProjectId: null }],
    usage: [
      { id: '3830', sessionId: 'web-a', parentSessionId: null, boardProjectId: null, source: null },
    ],
    assets: [],
    cron: [{ id: 'remind-1', projectMode: 'follow_session', sourceSessionKey: 'agent:main:webchat:dm:web-a' }],
    board: { id: OCV5, key: 'OCV5', archivedAt: null, contextVersion: 0 },
    projectContext: {
      path: '/x',
      exists: false,
      contextVersion: 0,
      skillNames: [],
      uid: null,
      gid: null,
      mode: null,
      candidateFiles: [],
    },
    ...over,
  }
}

describe('parseUsageRowId', () => {
  test('accepts short bigint ids and rejects session keys', () => {
    assert.equal(parseUsageRowId('100'), '100')
    assert.equal(parseUsageRowId('1000'), '1000')
    assert.equal(parseUsageRowId(1000), '1000')
    assert.equal(parseUsageRowId('webmt6uqcvnj6p069'), null)
    assert.equal(parseUsageRowId(''), null)
    assert.equal(parseUsageRowId('12ab'), null)
  })
})

describe('resolveLiveReadScript', () => {
  test('official default is the deployed canonical host path', () => {
    assert.equal(
      CANONICAL_HOST_LIVE_READ_SCRIPT,
      '/opt/openclaude/openclaude-v5-selfhost/packages/commercial/scripts/ocv5-project-layer-live-read.py',
    )
    const prev = process.env.OC_OCV5_LIVE_READ_SCRIPT
    delete process.env.OC_OCV5_LIVE_READ_SCRIPT
    try {
      const p = resolveLiveReadScript()
      assert.equal(p, CANONICAL_HOST_LIVE_READ_SCRIPT)
    } catch (err) {
      assert.match(String(err), /live_read_script_missing/)
      assert.equal(
        String(err).includes(CANONICAL_HOST_LIVE_READ_SCRIPT),
        true,
      )
    } finally {
      if (prev === undefined) delete process.env.OC_OCV5_LIVE_READ_SCRIPT
      else process.env.OC_OCV5_LIVE_READ_SCRIPT = prev
    }
  })

  test('worktree/test must pass explicit override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocv5-script-'))
    const override = join(dir, 'ocv5-project-layer-live-read.py')
    writeFileSync(override, 'print(1)\n')
    const handle = openLiveReadHandle({ explicit: override, kind: 'host' })
    assert.equal(handle.path, override)
    assert.notEqual(handle.path, CANONICAL_HOST_LIVE_READ_SCRIPT)
    assert.equal(handle.sha256.length, 64)
  })

  test('does not silently pick cwd or feature worktree', () => {
    const src = readFileSync(join(here, '../projectLayerHostPorts.ts'), 'utf8')
    assert.equal(src.includes('process.cwd()'), false)
    assert.equal(src.includes('/opt/openclaude/wt-ocv5-project-layer'), false)
    assert.match(src, /hostApply\(\s*script,/)
    assert.equal(/python3', resolveLiveReadScript\(\)/.test(src), false)
    assert.equal(src.includes('writeCandidate'), false)
    assert.equal(src.includes("'test', '-r'"), false)
    assert.match(src, /'oc-memory',\s*'project-search'/)
    assert.match(src, /\/api\/project-assets/)
    assert.match(src, /existing && existing.boardProjectId === boardProjectId/)
    assert.match(src, /ProjectMemoryLedger/)
    assert.match(src, /memory-candidates/)
    assert.match(src, /bind_chat_id_is_board/)
    assert.match(src, /EPIPE/)
  })
})

describe('path kinds', () => {
  test('maps container home to uid3 volume', () => {
    assert.equal(
      containerToHostPath('/home/agent/.openclaude/generated/shot.png'),
      '/var/lib/docker/volumes/oc-v5-data-u3/_data/generated/shot.png',
    )
  })
})

describe('python apply SQL', () => {
  test('session CAS RAISES in the same TX before COMMIT', () => {
    const move = pySrc.slice(pySrc.indexOf('def apply_move_sessions_sql'), pySrc.indexOf('def apply_move_sessions('))
    assert.match(move, /RAISE EXCEPTION 'stale_session/)
    assert.match(move, /WITH u AS/)
    assert.match(move, /INSERT INTO _ocv5_post SELECT \* FROM u/)
    assert.ok(move.lastIndexOf('RAISE EXCEPTION') < move.lastIndexOf('COMMIT;'))
    assert.ok(move.lastIndexOf('RAISE EXCEPTION') > 0)
    assert.equal(move.includes('if not got.get("ok")'), false)
  })

  test('bind is idempotent when already bound and reports chatId on empty RETURNING', () => {
    const bind = pySrc.slice(pySrc.indexOf('def apply_bind_facade'), pySrc.indexOf('def _sql_text_or_null'))
    assert.match(bind, /bind_failed:no_row/)
    assert.match(bind, /idempotent/)
    assert.match(bind, /empty_returning/)
    assert.match(pySrc, /UUID_RE/)
    assert.match(pySrc, /create_facade_bad_id/)
  })

  test('usage planned=updated=recorded RAISE before COMMIT; missing-row self-test exists', () => {
    const usage = pySrc.slice(pySrc.indexOf('def apply_usage_backfill_sql'), pySrc.indexOf('def apply_usage_backfill('))
    assert.match(usage, /RAISE EXCEPTION 'usage_count_mismatch/)
    assert.ok(usage.lastIndexOf('RAISE EXCEPTION') < usage.lastIndexOf('COMMIT;'))
    assert.ok(usage.lastIndexOf('RAISE EXCEPTION') > 0)
    assert.match(pySrc, /def self_test_usage_missing_row/)
    assert.equal(pySrc.includes('INSERT INTO project_assets'), false)
  })

  test('missing-1-row negative liveness: 0 rows committed', () => {
    const py = join(here, '../../scripts/ocv5-project-layer-live-read.py')
    const ran = spawnSync('python3', [py, '--mode', 'self-test-usage-missing-row'], {
      encoding: 'utf8',
    })
    assert.equal(ran.status, 0, ran.stderr || ran.stdout)
    const body = JSON.parse(ran.stdout) as {
      ok: boolean
      updated: number
      committed: boolean
      sqlHasRaise: boolean
    }
    assert.equal(body.ok, true)
    assert.equal(body.updated, 0)
    assert.equal(body.committed, false)
    assert.equal(body.sqlHasRaise, true)
  })
})

describe('portsFromSnapshot', () => {
  test('exposes live session CAS tuple and usage row ids', async () => {
    const ports = portsFromSnapshot(snap())
    const s = await ports.getSession('web-a')
    assert.equal(s?.updatedAt, 10)
    const usage = await ports.listNullUsage?.(['web-a'])
    assert.equal(usage?.[0]?.id, '3830')
    const cron = await ports.listCronJobs?.()
    assert.equal(cron?.[0]?.id, 'remind-1')
  })
})

describe('makeApplyPorts', () => {
  test('refuses writes when apply is not armed', async () => {
    assert.equal(applyArmed(), false)
    const dir = mkdtempSync(join(tmpdir(), 'ocv5-script-'))
    const override = join(dir, 'ocv5-project-layer-live-read.py')
    writeFileSync(override, 'print(1)\n')
    const ports = makeApplyPorts({
      boardProjectId: OCV5,
      snapshot: snap(),
      script: openLiveReadHandle({ explicit: override }),
    })
    await assert.rejects(() => ports.createChatProject('OCV5'), /apply_disabled/)
    await assert.rejects(() => ports.ensureProjectContext(OCV5), /apply_disabled/)
  })
})
