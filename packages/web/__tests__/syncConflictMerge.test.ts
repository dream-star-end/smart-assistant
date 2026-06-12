/**
 * Unit tests for sync.js 409 local-dominates resolution helpers.
 *
 * Covers the pure functions _localMessageSupersedes and _localDominates,
 * which decide whether a client can safely keep its local messages when
 * the server returns 409 conflict.
 *
 * Uses source-extract + new Function() to avoid pulling in ESM dependencies
 * that reference browser-only globals (localStorage etc.), following the
 * established pattern from pureFunctions.test.ts.
 *
 * Run: npx tsx --test packages/web/__tests__/syncConflictMerge.test.ts
 */
import * as assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it } from 'node:test'

const SYNC_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sync.js'),
  'utf-8',
)
const SESSIONS_SRC = readFileSync(
  resolve(import.meta.dirname, '..', 'public', 'modules', 'sessions.js'),
  'utf-8',
)

/**
 * Extract a top-level `export function name(...)` by finding the signature
 * line, then scanning for the closing `}` at column 0 (top-level indent).
 */
function extractTopLevelFn(source: string, name: string): string {
  const lines = source.split('\n')
  const headerIdx = lines.findIndex((l) =>
    new RegExp(`^(export\\s+)?function\\s+${name}\\s*\\(`).test(l),
  )
  if (headerIdx === -1) throw new Error(`function ${name} not found`)
  // Closing brace at column 0, exact "}"
  let endIdx = headerIdx + 1
  for (; endIdx < lines.length; endIdx++) {
    if (/^\}\s*$/.test(lines[endIdx])) break
  }
  return lines
    .slice(headerIdx, endIdx + 1)
    .join('\n')
    .replace(/^export\s+/, '')
}

function makeCallable<T extends (...args: any[]) => any>(src: string): T {
  const m = src.match(/function\s+(\w+)/)
  if (!m) throw new Error('no function name')
  return new Function(`${src}; return ${m[1]};`)() as T
}

// _localDominates calls _localMessageSupersedes which in turn calls the
// structural local-dominates helpers. Compile the whole closure together in
// one `new Function` so tests execute production-equivalent logic.
const _syncHelperNames = [
  '_stableStringify',
  '_hasOwn',
  '_sameIfServerHas',
  '_stringPrefixSupersedes',
  '_jsonSupersedesIfServerHas',
  '_booleanProgressSupersedes',
  '_errorFieldSupersedes',
  '_bashTailSupersedes',
  '_toolLikeSupersedes',
  '_childBlockSupersedes',
  '_childBlocksPrefixSupersedes',
  '_assistantChildBlocksSupersedes',
  '_agentGroupSupersedes',
  '_activeStreamEntries',
  '_activeStreamIds',
  '_serverMessageCoversLocalVisible',
  '_activeStreamLoss',
  '_localDominatesAllowingMissingActive',
  '_activeStreamLogPayload',
]
const _syncHelperSrc = _syncHelperNames.map((name) => extractTopLevelFn(SYNC_SRC, name)).join('\n')
const _combined = `${_syncHelperSrc}\n${extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes')}\n${extractTopLevelFn(SYNC_SRC, '_localDominates')}`
const _helpers = new Function(
  `${_combined}; return { _stableStringify, _localMessageSupersedes, _localDominates, _activeStreamLoss, _activeStreamIds, _localDominatesAllowingMissingActive };`,
)() as {
  _stableStringify: (v: any) => string | null
  _localMessageSupersedes: (l: any, s: any) => boolean
  _localDominates: (s: any, l: any) => boolean
  _activeStreamLoss: (sess: any, serverMessages: any[]) => any
  _activeStreamIds: (sess: any) => Set<string>
  _localDominatesAllowingMissingActive: (s: any, l: any, activeIds: Set<string>) => boolean
}
const _localMessageSupersedes = _helpers._localMessageSupersedes
const _localDominates = _helpers._localDominates
const _activeStreamLoss = _helpers._activeStreamLoss
const _activeStreamIds = _helpers._activeStreamIds
const _localDominatesAllowingMissingActive = _helpers._localDominatesAllowingMissingActive

// ═══════════════════════════════════════════════════════════════════
// _localMessageSupersedes
// ═══════════════════════════════════════════════════════════════════

describe('_localMessageSupersedes — role whitelist', () => {
  it('assistant: identical text → true', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello' },
        { id: 'a1', role: 'assistant', text: 'hello' },
      ),
      true,
    )
  })

  it('assistant: local extends server as prefix → true (primary streaming case)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello world' },
        { id: 'a1', role: 'assistant', text: 'hello' },
      ),
      true,
    )
  })

  it('thinking: local extends server as prefix → true', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'thinking', text: 'analyzing the problem carefully' },
        { id: 't1', role: 'thinking', text: 'analyzing the' },
      ),
      true,
    )
  })

  it('assistant: local shorter than server → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hi' },
        { id: 'a1', role: 'assistant', text: 'hi there' },
      ),
      false,
    )
  })

  it('assistant: same length but divergent (non-prefix) → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello there!' },
        { id: 'a1', role: 'assistant', text: 'hello friend' },
      ),
      false,
    )
  })

  it('assistant: server text empty, local non-empty → true', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello' },
        { id: 'a1', role: 'assistant', text: '' },
      ),
      true,
    )
  })

  it('user: identical text → true (status field ignored by design)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'u1', role: 'user', text: 'hi', status: 'sending' },
        { id: 'u1', role: 'user', text: 'hi', status: 'sent' },
      ),
      true,
    )
  })

  it('user: text differs → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'u1', role: 'user', text: 'hello' },
        { id: 'u1', role: 'user', text: 'hi' },
      ),
      false,
    )
  })

  it('plan: local generated document dominates server structured-only snapshot', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'p1', role: 'plan', text: '# Plan\n\nDo the work.' },
        {
          id: 'p1',
          role: 'plan',
          explanation: 'short path',
          steps: [{ step: 'inspect', status: 'pending' }],
        },
      ),
      true,
    )
  })

  it('plan: local text can extend server text prefix', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'p1', role: 'plan', text: '# Plan\n\nDo the work.' },
        { id: 'p1', role: 'plan', text: '# Plan' },
      ),
      true,
    )
  })

  it('plan: empty local text must not wipe a server plan document', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'p1', role: 'plan', steps: [{ step: 'inspect', status: 'pending' }] },
        { id: 'p1', role: 'plan', text: '# Plan\n\nDo the work.' },
      ),
      false,
    )
  })

  it('tool role, partial server → completed local output supersedes', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 't1',
          role: 'tool',
          text: 'Bash',
          toolName: 'Bash',
          blockId: 'tool-1',
          _partial: false,
          _completed: true,
          output: 'done',
          error: false,
        },
        {
          id: 't1',
          role: 'tool',
          text: 'Bash',
          toolName: 'Bash',
          blockId: 'tool-1',
          _partial: true,
          _completed: false,
          error: false,
        },
      ),
      true,
    )
  })

  it('tool role, server output missing locally → false', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 't1',
          role: 'tool',
          text: 'Bash',
          toolName: 'Bash',
          blockId: 'tool-1',
          _partial: false,
          _completed: true,
          output: '',
          error: false,
        },
        {
          id: 't1',
          role: 'tool',
          text: 'Bash',
          toolName: 'Bash',
          blockId: 'tool-1',
          _partial: false,
          _completed: true,
          output: 'server result',
          error: false,
        },
      ),
      false,
    )
  })

  it('tool role, completed server success must not be replaced by local error', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 't1',
          role: 'tool',
          text: 'Bash',
          toolName: 'Bash',
          blockId: 'tool-1',
          _partial: false,
          _completed: true,
          output: 'failed',
          error: true,
        },
        {
          id: 't1',
          role: 'tool',
          text: 'Bash',
          toolName: 'Bash',
          blockId: 'tool-1',
          _partial: false,
          _completed: true,
          output: 'done',
          error: false,
        },
      ),
      false,
    )
  })

  it('tool role, identical → true via Layer 1 stable-equality', () => {
    // Regression guard: historical tool rows in shared prefix must pass
    // if nothing mutated, otherwise they'd block local-dominates and
    // sessions with any past tool call would drop streaming extensions.
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' },
        { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' },
      ),
      true,
    )
  })

  it('tool role, identical but key insertion order differs → true (stable stringify)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 't1', role: 'tool', _completed: true, text: 'Bash', output: 'done' },
        { output: 'done', role: 'tool', text: 'Bash', id: 't1', _completed: true },
      ),
      true,
    )
  })

  it('agent-group role, identical → true via Layer 1', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'g1', role: 'agent-group', text: 'agent' },
        { id: 'g1', role: 'agent-group', text: 'agent' },
      ),
      true,
    )
  })

  it('agent-group role, diverging text → false', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'g1', role: 'agent-group', text: 'agent-v2' },
        { id: 'g1', role: 'agent-group', text: 'agent-v1' },
      ),
      false,
    )
  })

  it('agent-group role, ordered childBlocks prefix can grow locally', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 'g1',
          role: 'agent-group',
          text: 'agent',
          blockId: 'agent-1',
          toolName: 'Agent',
          childBlocks: [
            { kind: 'text', text: 'partial answer complete' },
            {
              kind: 'tool_use',
              blockId: 'child-tool',
              toolName: 'Bash',
              _partial: false,
              _completed: true,
              output: 'ok',
              error: false,
            },
            { kind: 'text', text: 'extra local child' },
          ],
        },
        {
          id: 'g1',
          role: 'agent-group',
          text: 'agent',
          blockId: 'agent-1',
          toolName: 'Agent',
          childBlocks: [
            { kind: 'text', text: 'partial answer' },
            {
              kind: 'tool_use',
              blockId: 'child-tool',
              toolName: 'Bash',
              _partial: true,
              _completed: false,
              error: false,
            },
          ],
        },
      ),
      true,
    )
  })

  it('agent-group role, server child output missing locally → false', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 'g1',
          role: 'agent-group',
          text: 'agent',
          childBlocks: [
            {
              kind: 'tool_use',
              blockId: 'child-tool',
              toolName: 'Bash',
              _partial: false,
              _completed: true,
              output: '',
              error: false,
            },
          ],
        },
        {
          id: 'g1',
          role: 'agent-group',
          text: 'agent',
          childBlocks: [
            {
              kind: 'tool_use',
              blockId: 'child-tool',
              toolName: 'Bash',
              _partial: false,
              _completed: true,
              output: 'server-only',
              error: false,
            },
          ],
        },
      ),
      false,
    )
  })

  it('permission role, identical → true via Layer 1', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'p1', role: 'permission', text: 'bash' },
        { id: 'p1', role: 'permission', text: 'bash' },
      ),
      true,
    )
  })

  it('assistant with identical childBlocks → true via Layer 1', () => {
    const cb = [{ kind: 'text', text: 'x' }]
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello', childBlocks: cb },
        { id: 'a1', role: 'assistant', text: 'hello', childBlocks: [{ kind: 'text', text: 'x' }] },
      ),
      true,
    )
  })

  it('assistant with childBlocks locally but not on server → true when text is preserved', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello', childBlocks: [{ kind: 'text', text: 'x' }] },
        { id: 'a1', role: 'assistant', text: 'hello' },
      ),
      true,
    )
  })

  it('assistant with childBlocks can grow as an ordered structural prefix', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 'a1',
          role: 'assistant',
          text: 'hello world',
          childBlocks: [
            { kind: 'thinking', text: 'inspect carefully' },
            {
              kind: 'tool_use',
              blockId: 'tool-1',
              toolName: 'Bash',
              inputPreview: 'ls -la',
              _partial: false,
              _completed: true,
              output: 'total 8',
              error: false,
            },
            { kind: 'text', text: 'done' },
          ],
        },
        {
          id: 'a1',
          role: 'assistant',
          text: 'hello',
          childBlocks: [
            { kind: 'thinking', text: 'inspect' },
            {
              kind: 'tool_use',
              blockId: 'tool-1',
              toolName: 'Bash',
              inputPreview: 'ls',
              _partial: true,
              _completed: false,
              error: false,
            },
          ],
        },
      ),
      true,
    )
  })

  it('assistant with unknown child block kind still refuses structural judgement', () => {
    assert.equal(
      _localMessageSupersedes(
        {
          id: 'a1',
          role: 'assistant',
          text: 'hello world',
          childBlocks: [{ kind: 'mystery', text: 'local' }],
        },
        {
          id: 'a1',
          role: 'assistant',
          text: 'hello',
          childBlocks: [{ kind: 'mystery', text: 'server' }],
        },
      ),
      false,
    )
  })

  it('assistant, server side has childBlocks, local extends text but not blocks → false', () => {
    // Even though local.text extends server.text, childBlocks on server
    // side means Layer 2 refuses (the blocks themselves could have data
    // we don\'t have on local).
    assert.equal(
      _localMessageSupersedes(
        { id: 'a1', role: 'assistant', text: 'hello world' },
        {
          id: 'a1',
          role: 'assistant',
          text: 'hello',
          childBlocks: [{ kind: 'text', text: 'x' }],
        },
      ),
      false,
    )
  })

  it('role mismatch → false (malformed data guard)', () => {
    assert.equal(
      _localMessageSupersedes(
        { id: 'x1', role: 'assistant', text: 'hi' },
        { id: 'x1', role: 'user', text: 'hi' },
      ),
      false,
    )
  })

  it('null / undefined args → false', () => {
    assert.equal(_localMessageSupersedes(null, { id: 'a', role: 'assistant', text: 'x' }), false)
    assert.equal(_localMessageSupersedes({ id: 'a', role: 'assistant', text: 'x' }, null), false)
    assert.equal(_localMessageSupersedes(undefined, undefined), false)
  })

  it('missing text field on both sides → treated as empty, assistant accepts', () => {
    assert.equal(
      _localMessageSupersedes({ id: 'a1', role: 'assistant' }, { id: 'a1', role: 'assistant' }),
      true,
    )
  })

  it('same object reference → true (identity shortcut)', () => {
    const m = { id: 'a1', role: 'assistant', text: 'whatever' }
    assert.equal(_localMessageSupersedes(m, m), true)
  })
})

// ═══════════════════════════════════════════════════════════════════
// _localDominates
// ═══════════════════════════════════════════════════════════════════

describe('_localDominates — local clean-superset judge', () => {
  const u = (id: string, text: string) => ({ id, role: 'user', text })
  const a = (id: string, text: string) => ({ id, role: 'assistant', text })

  it('identical messages → true', () => {
    const msgs = [u('u1', 'hi'), a('a1', 'hello')]
    assert.equal(_localDominates(msgs, msgs), true)
  })

  it('local is server + extra tail (append-only) → true', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello')]
    const local = [u('u1', 'hi'), a('a1', 'hello'), u('u2', 'more')]
    assert.equal(_localDominates(server, local), true)
  })

  it('same length, last assistant extends server prefix (streaming) → true', () => {
    const server = [u('u1', 'hi'), a('a1', 'partial')]
    const local = [u('u1', 'hi'), a('a1', 'partial answer complete')]
    assert.equal(_localDominates(server, local), true)
  })

  it('server longer than local → false', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello'), u('u2', 'more')]
    const local = [u('u1', 'hi'), a('a1', 'hello')]
    assert.equal(_localDominates(server, local), false)
  })

  it('id mismatch at some index → false', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello')]
    const local = [u('u1', 'hi'), a('a2', 'hello')]
    assert.equal(_localDominates(server, local), false)
  })

  it('same id mid-prefix but content diverges non-prefix → false (edit conflict)', () => {
    const server = [u('u1', 'hi'), a('a1', 'version A'), u('u2', 'more')]
    const local = [u('u1', 'hi'), a('a1', 'version B'), u('u2', 'more')]
    assert.equal(_localDominates(server, local), false)
  })

  it('shared prefix has running tool that completed locally → true', () => {
    const server = [
      u('u1', 'run'),
      {
        id: 't1',
        role: 'tool',
        text: 'Bash',
        toolName: 'Bash',
        blockId: 'tool-1',
        _partial: true,
        _completed: false,
        error: false,
      },
    ]
    const local = [
      u('u1', 'run'),
      {
        id: 't1',
        role: 'tool',
        text: 'Bash',
        toolName: 'Bash',
        blockId: 'tool-1',
        _partial: false,
        _completed: true,
        output: 'done',
        error: false,
      },
    ]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has IDENTICAL historical tool + tail assistant streaming extension → true (primary bug fix)', () => {
    // This is the exact scenario where the original bug resurfaced:
    // almost every real conversation has at least one tool row in its
    // history. Without Layer 1 (stable stringify), that historical row
    // would force server-wins and the streaming assistant extension
    // would be dropped — the "flash and disappear" symptom.
    const tool = { id: 't1', role: 'tool', text: 'Bash', _completed: true, output: 'done' }
    const server = [
      u('u1', 'run'),
      { ...tool }, // fresh object same fields
      a('a1', 'partial answer'),
    ]
    const local = [u('u1', 'run'), { ...tool }, a('a1', 'partial answer plus streaming extension')]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has plan document vs structured plan snapshot → true', () => {
    const server = [
      u('u1', 'plan it'),
      {
        id: 'p1',
        role: 'plan',
        explanation: 'short path',
        steps: [{ step: 'inspect', status: 'pending' }],
      },
    ]
    const local = [u('u1', 'plan it'), { id: 'p1', role: 'plan', text: '# Plan\n\nInspect.' }]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has identical agent-group + tail user append → true', () => {
    const group = { id: 'g1', role: 'agent-group', text: 'agent', metadata: { x: 1 } }
    const server = [u('u1', 'hi'), { ...group }]
    const local = [u('u1', 'hi'), { ...group }, u('u2', 'follow up')]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has agent-group childBlocks that completed locally → true', () => {
    const server = [
      u('u1', 'delegate'),
      {
        id: 'g1',
        role: 'agent-group',
        text: 'worker',
        blockId: 'agent-1',
        toolName: 'Agent',
        childBlocks: [
          { kind: 'thinking', text: 'inspect' },
          {
            kind: 'tool_use',
            blockId: 'child-tool',
            toolName: 'Read',
            _partial: true,
            _completed: false,
            error: false,
          },
        ],
      },
      a('a1', 'tail'),
    ]
    const local = [
      u('u1', 'delegate'),
      {
        id: 'g1',
        role: 'agent-group',
        text: 'worker',
        blockId: 'agent-1',
        toolName: 'Agent',
        childBlocks: [
          { kind: 'thinking', text: 'inspecting carefully' },
          {
            kind: 'tool_use',
            blockId: 'child-tool',
            toolName: 'Read',
            _partial: false,
            _completed: true,
            output: 'file contents',
            error: false,
          },
          { kind: 'text', text: 'done' },
        ],
      },
      a('a1', 'tail plus final tokens'),
    ]
    assert.equal(_localDominates(server, local), true)
  })

  it('shared prefix has server-only agent child output → false', () => {
    const server = [
      u('u1', 'delegate'),
      {
        id: 'g1',
        role: 'agent-group',
        text: 'worker',
        childBlocks: [
          {
            kind: 'tool_use',
            blockId: 'child-tool',
            toolName: 'Read',
            _partial: false,
            _completed: true,
            output: 'server-only',
            error: false,
          },
        ],
      },
    ]
    const local = [
      u('u1', 'delegate'),
      {
        id: 'g1',
        role: 'agent-group',
        text: 'worker',
        childBlocks: [
          {
            kind: 'tool_use',
            blockId: 'child-tool',
            toolName: 'Read',
            _partial: false,
            _completed: true,
            output: '',
            error: false,
          },
        ],
      },
    ]
    assert.equal(_localDominates(server, local), false)
  })

  it('shared prefix has identical permission → does not block dominance', () => {
    const perm = { id: 'p1', role: 'permission', text: 'bash', approved: true }
    const server = [u('u1', 'hi'), { ...perm }, a('a1', 'partial')]
    const local = [u('u1', 'hi'), { ...perm }, a('a1', 'partial extended')]
    assert.equal(_localDominates(server, local), true)
  })

  it('server empty → true (any local dominates empty)', () => {
    assert.equal(_localDominates([], [u('u1', 'hi')]), true)
    assert.equal(_localDominates([], []), true)
  })

  it('local empty, server non-empty → false', () => {
    assert.equal(_localDominates([u('u1', 'hi')], []), false)
  })

  it('non-array inputs treated as empty', () => {
    assert.equal(_localDominates(null as any, []), true)
    assert.equal(_localDominates([], null as any), true)
    assert.equal(_localDominates([u('u1', 'hi')], null as any), false)
  })

  it('middle insert on local (not append-only) → false', () => {
    const server = [u('u1', 'hi'), a('a1', 'hello')]
    const local = [u('u1', 'hi'), a('a-new', 'surprise'), a('a1', 'hello')]
    assert.equal(_localDominates(server, local), false)
  })

  it('msg with missing id at server index → false', () => {
    const server: any[] = [{ role: 'user', text: 'hi' }, a('a1', 'x')]
    const local = [u('u1', 'hi'), a('a1', 'x')]
    assert.equal(_localDominates(server, local), false)
  })
})

describe('active-stream conflict helpers', () => {
  const u = (id: string, text: string) => ({ id, role: 'user', text })
  const a = (id: string, text: string) => ({ id, role: 'assistant', text })

  it('detects active message loss when the server snapshot lacks the streaming row', () => {
    const active = a('a-live', 'streaming')
    const sess = { id: 's1', messages: [u('u1', 'hi'), active], _streamingAssistant: active }
    const loss = _activeStreamLoss(sess, [u('u1', 'hi')])

    assert.equal(loss?.reason, 'missing-active-message')
    assert.equal(loss?.id, 'a-live')
  })

  it('allows walking past a missing active local row only when all server rows are represented', () => {
    const active = a('a-live', 'streaming')
    const server = [u('u1', 'hi'), { id: 't1', role: 'tool', text: 'Bash' }]
    const local = [u('u1', 'hi'), active, { id: 't1', role: 'tool', text: 'Bash' }]
    const sess = { messages: local, _streamingAssistant: active }

    assert.equal(_localDominates(server, local), false)
    assert.equal(_localDominatesAllowingMissingActive(server, local, _activeStreamIds(sess)), true)
  })

  it('does not allow skipping active rows when the server has separate divergent data', () => {
    const active = a('a-live', 'streaming')
    const server = [u('u1', 'hi'), { id: 'server-only', role: 'assistant', text: 'remote' }]
    const local = [u('u1', 'hi'), active, { id: 't1', role: 'tool', text: 'Bash' }]
    const sess = { messages: local, _streamingAssistant: active }

    assert.equal(_localDominatesAllowingMissingActive(server, local, _activeStreamIds(sess)), false)
  })
})

// ═══════════════════════════════════════════════════════════════════
// pushSessionToServer — 409 integration paths
// ═══════════════════════════════════════════════════════════════════
//
// Extracts pushSessionToServer + its helper closure into a fresh function
// body and injects stubbed `apiFetch`, `apiGet`, `authHeaders`, `dbPut`,
// `_rebuildSearchIndex`, `state`, and dep callbacks as named parameters.
// This way we exercise the real production code path without pulling in
// the browser-global deps in sync.js's own imports.

const _pushFnSrc = `${_syncHelperSrc}\n${extractTopLevelFn(SYNC_SRC, '_localMessageSupersedes')}\n${extractTopLevelFn(SYNC_SRC, '_mergeServerPlanFields')}\n${extractTopLevelFn(SYNC_SRC, '_localDominates')}\n${extractTopLevelFn(SYNC_SRC, '_rebindStreamingPointers')}\n${extractTopLevelFn(SYNC_SRC, 'pushSessionToServer')}`

type PushDeps = {
  apiFetch: (url: string, opts: any) => Promise<any>
  apiGet: (url: string) => Promise<any>
  authHeaders: (h: any) => any
  dbPut: (row: any) => Promise<void>
  _rebuildSearchIndex: (sess: any) => void
  state: { token: string; sessions: Map<string, any> }
  _onConflictResolved: ((id: string, mode?: 'local-dominates' | 'server-wins') => void) | null
  _onRequestRetryPush: ((id: string) => void) | null
}

// Parse the production CONFLICT_RETRY_MAX value out of sync.js. The harness
// keeps its integration-test cap small (3) for short loops, but this lets
// tests also assert the CURRENT production value — so a stealth regression
// (someone halves the cap) breaks tests instead of degrading quietly at
// runtime.
const _capMatch = /const CONFLICT_RETRY_MAX = (\d+)/.exec(SYNC_SRC)
const PROD_CONFLICT_RETRY_MAX = _capMatch ? Number(_capMatch[1]) : Number.NaN

function makePush(deps: PushDeps, retryMax = 3) {
  const factory = new Function(
    'apiFetch',
    'apiGet',
    'authHeaders',
    'dbPut',
    '_rebuildSearchIndex',
    'state',
    '_onConflictResolved',
    '_onRequestRetryPush',
    'CONFLICT_RETRY_MAX',
    `${_pushFnSrc}; return pushSessionToServer;`,
  )
  return factory(
    deps.apiFetch,
    deps.apiGet,
    deps.authHeaders,
    deps.dbPut,
    deps._rebuildSearchIndex,
    deps.state,
    deps._onConflictResolved,
    deps._onRequestRetryPush,
    retryMax,
  ) as (sess: any) => Promise<any>
}

// Minimal response shape pushSessionToServer expects
const ok = (body: any) => ({ ok: true, status: 200, json: async () => body })
const conflict = () => ({ ok: false, status: 409, json: async () => ({}) })

function baseDeps(overrides: Partial<PushDeps> = {}): PushDeps & {
  putCalls: any[]
  getCalls: string[]
  dbCalls: any[]
  rebuildCalls: any[]
  conflictCb: Array<{ id: string; mode?: string }>
  retryCb: string[]
} {
  const putCalls: any[] = []
  const getCalls: string[] = []
  const dbCalls: any[] = []
  const rebuildCalls: any[] = []
  const conflictCb: Array<{ id: string; mode?: string }> = []
  const retryCb: string[] = []

  const deps: any = {
    apiFetch: async (_url: string, opts: any) => {
      putCalls.push(JSON.parse(opts.body))
      return (overrides as any)._apiFetchImpl
        ? (overrides as any)._apiFetchImpl(putCalls.length)
        : ok({ applied: true, updatedAt: Date.now() })
    },
    apiGet: async (url: string) => {
      getCalls.push(url)
      return (overrides as any)._apiGetImpl?.() ?? null
    },
    authHeaders: (h: any) => h,
    dbPut: async (row: any) => {
      dbCalls.push(row)
    },
    _rebuildSearchIndex: (sess: any) => {
      rebuildCalls.push(sess.id)
    },
    state: { token: 'tok', sessions: new Map() },
    _onConflictResolved: (id: string, mode?: string) => {
      conflictCb.push({ id, mode })
    },
    _onRequestRetryPush: (id: string) => {
      retryCb.push(id)
    },
    ...overrides,
  }
  return Object.assign(deps, { putCalls, getCalls, dbCalls, rebuildCalls, conflictCb, retryCb })
}

describe('pushSessionToServer — 409 local-dominates', () => {
  it('primary case: streaming assistant prefix extension — keeps local, bumps retry count, triggers retry', async () => {
    const sessId = 'sess-a'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial answer complete' }

    const sess: any = {
      id: sessId,
      title: 'local title',
      messages: [userMsg, localAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'agent-a',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server title', // another tab renamed
        messages: [userMsg, serverAsst], // stale snapshot
        lastAt: 1100, // server lastAt newer (another tab activity)
        pinned: true, // another tab pinned
        agentId: 'agent-b', // another tab switched agent
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Local messages preserved (the whole point)
    assert.equal(sess.messages[1].text, 'partial answer complete')
    // Server metadata adopted (blocker 1: no clobbering of other tab's edits)
    assert.equal(sess.title, 'server title')
    assert.equal(sess.pinned, true)
    assert.equal(sess.agentId, 'agent-b')
    assert.equal(sess.lastAt, 1100)
    // Retry bookkeeping
    assert.equal(sess._conflictRetryCount, 1)
    assert.equal(sess._dirty, true)
    assert.equal(sess._syncedAt, 2000)
    // Callbacks
    assert.equal(deps.conflictCb.length, 1)
    // local-dominates tag tells the UI to SKIP renderMessages() — local
    // messages are preserved in this branch (the whole point of the fix),
    // so only sidebar re-render is needed. Regressing this tag repaints
    // the whole messages pane on every 409 and flickers the UI during
    // long streaming turns that legitimately hit multiple 409s in a row.
    assert.equal(deps.conflictCb[0].mode, 'local-dominates')
    assert.equal(deps.retryCb.length, 1)
    assert.equal(deps.retryCb[0], sessId)
    // dbPut persisted
    assert.equal(deps.dbCalls.length, 1)
  })

  it('agent/tool structural case: preserves completed local childBlocks on 409', async () => {
    const sessId = 'sess-agent-struct'
    const userMsg = { id: 'u1', role: 'user', text: 'delegate' }
    const serverGroup = {
      id: 'g1',
      role: 'agent-group',
      text: 'worker',
      blockId: 'agent-1',
      toolName: 'Agent',
      childBlocks: [
        { kind: 'thinking', text: 'inspect' },
        {
          kind: 'tool_use',
          blockId: 'child-tool',
          toolName: 'Bash',
          inputPreview: 'ls',
          _partial: true,
          _completed: false,
          error: false,
        },
      ],
    }
    const localGroup = {
      id: 'g1',
      role: 'agent-group',
      text: 'worker',
      blockId: 'agent-1',
      toolName: 'Agent',
      childBlocks: [
        { kind: 'thinking', text: 'inspecting carefully' },
        {
          kind: 'tool_use',
          blockId: 'child-tool',
          toolName: 'Bash',
          inputPreview: 'ls -la',
          _partial: false,
          _completed: true,
          output: 'total 8',
          error: false,
        },
        { kind: 'text', text: 'done' },
      ],
    }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial final answer' }
    const sess: any = {
      id: sessId,
      title: 'local',
      messages: [userMsg, localGroup, localAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server',
        messages: [userMsg, serverGroup, serverAsst],
        lastAt: 1100,
        pinned: false,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.messages[1].childBlocks[1]._completed, true)
    assert.equal(sess.messages[1].childBlocks[1].output, 'total 8')
    assert.equal(sess.messages[1].childBlocks[2].text, 'done')
    assert.equal(sess.messages[2].text, 'partial final answer')
    assert.equal(sess.title, 'server')
    assert.equal(sess._dirty, true)
    assert.equal(sess._syncedAt, 2000)
    assert.equal(deps.conflictCb[0].mode, 'local-dominates')
    assert.equal(deps.retryCb.length, 1)
  })

  it('Codex plan doc case: preserves local text and fills server steps on 409', async () => {
    const sessId = 'sess-plan'
    const userMsg = { id: 'u1', role: 'user', text: 'make a plan' }
    const serverPlan = {
      id: 'p1',
      role: 'plan',
      blockId: 'codex-plan',
      explanation: 'short path',
      steps: [
        { step: 'inspect code', status: 'completed' },
        { step: 'patch UI', status: 'inProgress' },
      ],
      _partial: true,
    }
    const localPlan = {
      id: 'p1',
      role: 'plan',
      blockId: 'codex-plan',
      text: '# Plan\n\nKeep the generated document visible.',
      _partial: false,
    }

    const sess: any = {
      id: sessId,
      title: 'plan',
      messages: [userMsg, localPlan],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'plan',
        messages: [userMsg, serverPlan],
        lastAt: 1100,
        pinned: false,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.messages[1].text, '# Plan\n\nKeep the generated document visible.')
    assert.equal(sess.messages[1].explanation, 'short path')
    assert.deepEqual(
      sess.messages[1].steps.map((s: any) => [s.step, s.status]),
      [
        ['inspect code', 'completed'],
        ['patch UI', 'inProgress'],
      ],
    )
    assert.equal(deps.conflictCb[0].mode, 'local-dominates')
    assert.equal(deps.retryCb.length, 1)
    assert.equal(deps.dbCalls.length, 1)
  })

  it('strips _streamingPlan from server PUT payload', async () => {
    const sess: any = {
      id: 'sess-strip',
      title: 't',
      messages: [{ id: 'p1', role: 'plan', text: '# Plan' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _syncedAt: 500,
      _streamingPlan: { id: 'p1', role: 'plan', text: '# Plan' },
    }
    const deps = baseDeps({
      _apiFetchImpl: () => ok({ applied: true, updatedAt: 2000 }),
    } as any)
    deps.state.sessions.set(sess.id, sess)

    await makePush(deps)(sess)

    assert.equal(deps.putCalls.length, 1)
    assert.equal('_streamingPlan' in deps.putCalls[0], false)
  })

  it('retry cap: after 3 retries, 4th 409 does NOT trigger another retry', async () => {
    const sessId = 'sess-r'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial extension' }

    const sess: any = {
      id: sessId,
      title: 't',
      messages: [userMsg, localAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _conflictRetryCount: 3, // already at the cap
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't',
        messages: [userMsg, serverAsst],
        lastAt: 1000,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    // Silence the cap-reached warning in test output
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      await makePush(deps)(sess)
    } finally {
      console.warn = originalWarn
    }

    assert.equal(sess._conflictRetryCount, 4)
    assert.equal(deps.retryCb.length, 0, 'retry callback must NOT fire once cap reached')
    assert.equal(sess._dirty, true, 'left dirty so next user action re-pushes')
  })

  it('scheduleSaveFromUserEdit-equivalent reset: if caller resets _conflictRetryCount to 0, cap counter restarts', async () => {
    // Proves the counter is a plain field consumers can reset; this is
    // what sessions.js does on every user edit.
    const sessId = 'sess-x'
    const sess: any = {
      id: sessId,
      title: 't',
      messages: [{ id: 'u1', role: 'user', text: 'hi' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _conflictRetryCount: 3,
    }
    sess._conflictRetryCount = 0 // simulate reset from user edit

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't',
        messages: [{ id: 'u1', role: 'user', text: 'hi' }],
        lastAt: 1000,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)
    assert.equal(sess._conflictRetryCount, 1, 'counter restarts after reset')
    assert.equal(deps.retryCb.length, 1)
  })

  it('keeps LOCAL metadata when user edited during PUT (localMetaIsNewer path)', async () => {
    const sessId = 'sess-m'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'partial' }
    const localAsst = { id: 'a1', role: 'assistant', text: 'partial extension' }

    const sess: any = {
      id: sessId,
      title: 'local-edited-title',
      messages: [userMsg, localAsst],
      lastAt: 2000, // > preFlightLastAt (will snapshot 2000 at call time; then bumped below)
      pinned: true,
      agentId: 'local-agent',
      _dirty: true,
      _syncedAt: 500,
    }

    // Intercept: before the 409 path runs, simulate a concurrent user edit
    // by bumping live.lastAt after the preFlightLastAt snapshot was taken.
    // We achieve this by intercepting apiFetch: when called, we bump live.lastAt
    // in state.sessions so the 409 handler sees live.lastAt > preFlightLastAt.
    const deps = baseDeps({
      _apiFetchImpl: () => {
        // User edits while PUT is in flight — bump live.lastAt
        const live = deps.state.sessions.get(sessId)
        live.lastAt = 2500
        return conflict()
      },
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server-title',
        messages: [userMsg, serverAsst],
        lastAt: 1800,
        pinned: false,
        agentId: 'server-agent',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Local messages preserved
    assert.equal(sess.messages[1].text, 'partial extension')
    // Local metadata preserved — user edit beat preflight
    assert.equal(sess.title, 'local-edited-title')
    assert.equal(sess.pinned, true)
    assert.equal(sess.agentId, 'local-agent')
    assert.equal(sess.lastAt, 2500)
  })
})

describe('pushSessionToServer — active-stream safe deferral', () => {
  it('defers server-wins when the only gap is a missing active local message', async () => {
    const sessId = 'sess-active-defer'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const activeAsst = { id: 'a-live', role: 'assistant', text: 'streaming answer' }
    const toolMsg = { id: 't1', role: 'tool', text: 'Bash' }
    const sess: any = {
      id: sessId,
      title: 'local',
      messages: [userMsg, activeAsst, toolMsg],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
      _streamingAssistant: activeAsst,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server',
        messages: [userMsg, toolMsg],
        lastAt: 1100,
        pinned: true,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.deepEqual(
      sess.messages.map((m: any) => m.id),
      ['u1', 'a-live', 't1'],
      'local active row stays visible',
    )
    assert.equal(sess.title, 'server')
    assert.equal(sess.pinned, true)
    assert.equal(sess._syncedAt, 2000)
    assert.equal(sess._dirty, true)
    assert.equal(sess._conflictRetryCount, 1)
    assert.equal(deps.dbCalls.length, 1)
    assert.equal(deps.conflictCb[0].mode, 'local-dominates')
    assert.deepEqual(deps.retryCb, [sessId])
  })

  it('does not defer when the server has a separate divergent row', async () => {
    const sessId = 'sess-active-diverged'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const activeAsst = { id: 'a-live', role: 'assistant', text: 'streaming answer' }
    const toolMsg = { id: 't1', role: 'tool', text: 'Bash' }
    const remoteAsst = { id: 'a-remote', role: 'assistant', text: 'remote-only' }
    const sess: any = {
      id: sessId,
      title: 'local',
      messages: [userMsg, activeAsst, toolMsg],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
      _streamingAssistant: activeAsst,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server',
        messages: [userMsg, remoteAsst, toolMsg],
        lastAt: 1100,
        pinned: false,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.deepEqual(
      sess.messages.map((m: any) => m.id),
      ['u1', 'a-remote', 't1'],
      'server-only divergent row wins',
    )
    assert.equal(sess._dirty, false)
    assert.equal(sess._conflictRetryCount, 0)
    assert.equal(sess._streamingAssistant, null)
    assert.equal(deps.conflictCb[0].mode, 'server-wins')
    assert.equal(deps.retryCb.length, 0)
  })

  it('deferral obeys the retry cap and leaves the session dirty', async () => {
    const sessId = 'sess-active-cap'
    const userMsg = { id: 'u1', role: 'user', text: 'hi' }
    const activeAsst = { id: 'a-live', role: 'assistant', text: 'streaming answer' }
    const toolMsg = { id: 't1', role: 'tool', text: 'Bash' }
    const sess: any = {
      id: sessId,
      title: 'local',
      messages: [userMsg, activeAsst, toolMsg],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
      _conflictRetryCount: 1,
      _streamingAssistant: activeAsst,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server',
        messages: [userMsg, toolMsg],
        lastAt: 1100,
        pinned: false,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps, 1)(sess)

    assert.equal(sess._dirty, true)
    assert.equal(sess._syncedAt, 2000)
    assert.equal(sess._conflictRetryCount, 2)
    assert.equal(deps.dbCalls.length, 1)
    assert.equal(deps.conflictCb[0].mode, 'local-dominates')
    assert.equal(deps.retryCb.length, 0)
  })
})

describe('pushSessionToServer — 409 server-wins fallback', () => {
  it('adopts server state when local does NOT dominate, rebinds _streamingAssistant', async () => {
    const sessId = 'sess-sw'
    const oldLocalAsst = { id: 'a-old', role: 'assistant', text: 'local regen' }
    const sess: any = {
      id: sessId,
      title: 'local title',
      messages: [oldLocalAsst],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _streamingAssistant: oldLocalAsst, // points at the soon-to-be-replaced obj
      _blockIdToMsgId: new Map([['b', 'a-old']]),
      _agentGroups: new Map(),
    }

    const serverAsst = { id: 'a-new', role: 'assistant', text: 'server side answer' }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server title',
        messages: [serverAsst],
        lastAt: 1100,
        pinned: true,
        agentId: 'a2',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Adopted server state
    assert.equal(sess.title, 'server title')
    assert.equal(sess.messages[0].id, 'a-new')
    assert.equal(sess.agentId, 'a2')
    assert.equal(sess._dirty, false)
    assert.equal(sess._syncedAt, 2000)
    // Streaming pointer: old ref was a-old which is NOT in new messages → cleared
    assert.equal(sess._streamingAssistant, null, 'orphan streaming pointer must be cleared')
    // Runtime maps invalidated
    assert.equal(sess._blockIdToMsgId, null)
    assert.equal(sess._agentGroups, null)
    // Retry cap reset on server-wins
    assert.equal(sess._conflictRetryCount, 0)
    // Search index rebuilt & conflict callback fired
    assert.equal(deps.rebuildCalls.length, 1)
    assert.equal(deps.conflictCb.length, 1)
    // server-wins tag tells the UI to renderMessages() — messages were just
    // overwritten by Object.assign and the DOM must catch up.
    assert.equal(deps.conflictCb[0].mode, 'server-wins')
  })

  it('rebinds _streamingAssistant to the fresh object when same id still present', async () => {
    const sessId = 'sess-reb'
    const oldRef = { id: 'a1', role: 'assistant', text: 'old-local' }
    const sess: any = {
      id: sessId,
      title: 't',
      messages: [oldRef],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _streamingAssistant: oldRef,
    }
    const serverAsst = { id: 'a1', role: 'assistant', text: 'brand new answer' }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't',
        // New server snapshot has EXTRA message + same id a1 → doesn't dominate
        messages: [{ id: 'u-extra', role: 'user', text: 'someone else asked' }, serverAsst],
        lastAt: 1100,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.messages.length, 2)
    // _streamingAssistant must now point at the NEW a1 object in messages
    assert.equal(sess._streamingAssistant?.text, 'brand new answer')
    assert.equal(sess._streamingAssistant, sess.messages[1])
  })

  it('rebinds _streamingPlan to the fresh object when same id still present', async () => {
    const sessId = 'sess-plan-reb'
    const oldRef = { id: 'p1', role: 'plan', text: '# Local draft' }
    const sess: any = {
      id: sessId,
      title: 't',
      messages: [oldRef],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
      _streamingPlan: oldRef,
    }
    const serverPlan = { id: 'p1', role: 'plan', text: '# Server plan' }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't',
        messages: [{ id: 'u-other', role: 'user', text: 'from phone' }, serverPlan],
        lastAt: 1100,
        pinned: false,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.messages.length, 2)
    assert.equal(sess._streamingPlan?.text, '# Server plan')
    assert.equal(sess._streamingPlan, sess.messages[1])
  })

  it('clears orphan _streamingPlan when server-wins removes that plan row', async () => {
    const sessId = 'sess-plan-orphan'
    const oldRef = { id: 'p-old', role: 'plan', text: '# Local draft' }
    const sess: any = {
      id: sessId,
      title: 't',
      messages: [oldRef],
      lastAt: 1000,
      pinned: false,
      agentId: 'codex',
      _dirty: true,
      _syncedAt: 500,
      _streamingPlan: oldRef,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't',
        messages: [{ id: 'u-other', role: 'user', text: 'from phone' }],
        lastAt: 1100,
        pinned: false,
        agentId: 'codex',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess._streamingPlan, null)
  })

  it('clears _replyingToMsgId and _currentTurnBlockCount when that msg vanishes from server', async () => {
    const sessId = 'sess-rpl'
    const sess: any = {
      id: sessId,
      title: 't',
      messages: [
        { id: 'u1', role: 'user', text: 'hi' },
        { id: 'orphan', role: 'assistant', text: 'gone' },
      ],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _replyingToMsgId: 'orphan',
      _currentTurnBlockCount: 7,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't',
        // Server snapshot has a user msg local doesn't (cross-device add) —
        // forces server-wins fallback. And no 'orphan' → pointer clears.
        messages: [
          { id: 'u1', role: 'user', text: 'hi' },
          { id: 'u2-other-device', role: 'user', text: 'from phone' },
        ],
        lastAt: 1100,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess._replyingToMsgId, null)
    assert.equal(sess._currentTurnBlockCount, 0)
  })

  it('preserves local if user typed during PUT (live.lastAt > preFlightLastAt)', async () => {
    const sessId = 'sess-g'
    const sess: any = {
      id: sessId,
      title: 'local',
      messages: [{ id: 'u1', role: 'user', text: 'mine' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => {
        // simulate concurrent edit: bump lastAt AFTER preFlight snapshot taken
        deps.state.sessions.get(sessId).lastAt = 1500
        return conflict()
      },
      _apiGetImpl: () => ({
        // Server has DIFFERENT user msg (not dominated) → fallback path
        id: sessId,
        title: 'server',
        messages: [{ id: 'u-other', role: 'user', text: 'someone else' }],
        lastAt: 1200,
        pinned: true,
        agentId: 'b',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    // Guard triggered — local kept, server NOT adopted
    assert.equal(sess.title, 'local')
    assert.equal(sess.messages[0].id, 'u1')
  })
})

describe('pushSessionToServer — sess !== live divergence (caller passes stale snapshot)', () => {
  it('409 local-dominates must mutate state.sessions entry, not the caller snapshot', async () => {
    // Scenario: syncSessionsFromServer iterates over dbGetAll() results and
    // calls pushSessionToServer(local) — that `local` is a distinct object
    // from state.sessions.get(id). If we mutated only `sess`, the live
    // session keeps its old _syncedAt and the enqueued retry PUT fires
    // again with the stale _baseSyncedAt → 409 loop until cap.
    const sessId = 'sess-div'
    const liveMsg = { id: 'a1', role: 'assistant', text: 'partial ext' }
    const live: any = {
      id: sessId,
      title: 't-old',
      messages: [liveMsg],
      lastAt: 1000,
      pinned: false,
      agentId: 'agent-old',
      _dirty: true,
      _syncedAt: 500,
    }
    // Caller-snapshot (sess) is a different object, deliberately missing
    // the extra fields. The handler should NOT write _syncedAt onto this.
    const staleSnap: any = {
      id: sessId,
      title: 't-old',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'agent-old',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't-server',
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1100,
        pinned: true,
        agentId: 'agent-server',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, live)

    await makePush(deps)(staleSnap)

    // The LIVE session must have picked up the server metadata + refreshed sync stamp
    assert.equal(live._syncedAt, 2000, 'live._syncedAt must be refreshed')
    assert.equal(live.title, 't-server', 'live.title must be adopted from server')
    assert.equal(live.pinned, true)
    assert.equal(live.agentId, 'agent-server')
    assert.equal(live._conflictRetryCount, 1)
    // The caller snapshot must be untouched (still stale)
    assert.equal(staleSnap._syncedAt, 500, 'caller snapshot must NOT be mutated')
    assert.equal(staleSnap.title, 't-old')
    // dbPut must receive live data (so IDB has fresh _syncedAt)
    assert.equal(deps.dbCalls[0]._syncedAt, 2000)
    assert.equal(deps.dbCalls[0].title, 't-server')
  })

  it('409 server-wins must mutate state.sessions entry, not the caller snapshot', async () => {
    const sessId = 'sess-div2'
    const live: any = {
      id: sessId,
      title: 't-old',
      messages: [{ id: 'a1', role: 'assistant', text: 'local' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'agent-old',
      _dirty: true,
      _syncedAt: 500,
    }
    const staleSnap: any = {
      id: sessId,
      title: 't-old',
      messages: [{ id: 'a1', role: 'assistant', text: 'local' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'agent-old',
      _dirty: true,
      _syncedAt: 500,
    }

    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 't-server',
        // Server has data local doesn't → forces server-wins
        messages: [
          { id: 'other', role: 'user', text: 'from phone' },
          { id: 'a1', role: 'assistant', text: 'server' },
        ],
        lastAt: 1100,
        pinned: true,
        agentId: 'agent-server',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, live)

    await makePush(deps)(staleSnap)

    assert.equal(live.title, 't-server')
    assert.equal(live.messages.length, 2)
    assert.equal(live._syncedAt, 2000)
    assert.equal(live._dirty, false)
    // Caller snapshot untouched
    assert.equal(staleSnap.title, 't-old')
    assert.equal(staleSnap.messages.length, 1)
  })
})

describe('runtime-only persistence strip lists', () => {
  it('local IndexedDB save strips _streamingPlan just like assistant/thinking pointers', () => {
    assert.match(
      SESSIONS_SRC,
      /const\s+\{[\s\S]*_streamingAssistant,[\s\S]*_streamingThinking,[\s\S]*_streamingPlan,[\s\S]*\.\.\.persist[\s\S]*\}\s*=\s*sess/,
    )
  })
})

describe('pushSessionToServer — search index hygiene', () => {
  it('local-dominates with title change triggers _rebuildSearchIndex so sidebar filter stays correct', async () => {
    const sessId = 'sess-sr'
    const sess: any = {
      id: sessId,
      title: 'old title',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _searchText: 'old title cached — will go stale if not rebuilt',
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'NEW title from other tab',
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1100,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess.title, 'NEW title from other tab')
    assert.equal(
      deps.rebuildCalls.length,
      1,
      'rebuildSearchIndex must fire when title adopted from server',
    )
    assert.equal(deps.rebuildCalls[0], sessId)
  })

  it('local-dominates without title change does NOT waste a rebuild', async () => {
    const sessId = 'sess-sr2'
    const sess: any = {
      id: sessId,
      title: 'same',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => conflict(),
      _apiGetImpl: () => ({
        id: sessId,
        title: 'same', // unchanged
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1100,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)
    assert.equal(deps.rebuildCalls.length, 0, 'no rebuild when title unchanged')
  })

  it('local-dominates with localMetaIsNewer: keeps local title, no rebuild needed', async () => {
    const sessId = 'sess-sr3'
    const sess: any = {
      id: sessId,
      title: 'local edited',
      messages: [{ id: 'a1', role: 'assistant', text: 'partial ext' }],
      lastAt: 2000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
    }
    const deps = baseDeps({
      _apiFetchImpl: () => {
        // simulate concurrent user edit bumping lastAt past preFlight
        deps.state.sessions.get(sessId).lastAt = 2500
        return conflict()
      },
      _apiGetImpl: () => ({
        id: sessId,
        title: 'server title (should be ignored)',
        messages: [{ id: 'a1', role: 'assistant', text: 'partial' }],
        lastAt: 1800,
        pinned: false,
        agentId: 'a',
        updatedAt: 2000,
      }),
    } as any)
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)
    assert.equal(sess.title, 'local edited', 'local meta preserved')
    assert.equal(deps.rebuildCalls.length, 0, 'no rebuild when local meta kept (title unchanged)')
  })
})

describe('pushSessionToServer — successful PUT', () => {
  it('200 response clears _conflictRetryCount', async () => {
    const sessId = 'sess-ok'
    const sess: any = {
      id: sessId,
      title: 't',
      messages: [],
      lastAt: 1000,
      pinned: false,
      agentId: 'a',
      _dirty: true,
      _syncedAt: 500,
      _conflictRetryCount: 2,
    }
    const deps = baseDeps()
    deps.state.sessions.set(sessId, sess)

    await makePush(deps)(sess)

    assert.equal(sess._conflictRetryCount, 0)
    assert.equal(sess._dirty, false)
  })
})

describe('pushSessionToServer — CONFLICT_RETRY_MAX', () => {
  // The production cap was raised 3→10 in fix/sync-409-flicker to absorb
  // legitimate 409 bursts on long streaming sessions (>500KB). Guard the
  // current production value so a stealth revert breaks tests rather than
  // spamming "409 auto-retry cap reached" in console at runtime.
  it('production value matches expected', () => {
    assert.equal(PROD_CONFLICT_RETRY_MAX, 10)
  })

  it('cap gates retry callback: below cap fires retry, at/above cap stops', async () => {
    // Minimal local-dominates setup: local is superset of server (empty).
    const build = (count: number) => {
      const sessId = 'sess-cap'
      const localMsg = { id: 'u1', role: 'user', text: 'hi' }
      const sess: any = {
        id: sessId,
        title: 'local',
        messages: [localMsg],
        lastAt: 1000,
        pinned: false,
        agentId: 'a',
        _dirty: true,
        _syncedAt: 500,
        _conflictRetryCount: count,
      }
      const deps = baseDeps({
        apiFetch: async () => conflict(),
        apiGet: async () => ({
          id: sessId,
          title: 'remote',
          messages: [],
          lastAt: 900,
          pinned: false,
          agentId: 'a',
          updatedAt: 2000,
        }),
      })
      deps.state.sessions.set(sessId, sess)
      return { sess, deps }
    }

    // Use a small cap so the test completes in bounded time. The point is the
    // cap SEMANTICS — that `<=` lets the Nth retry still fire and `> cap`
    // stops — not the specific 10.
    const CAP = 2

    // Pre-count 0, 1: retry fires (count becomes 1, 2 respectively)
    for (const preCount of [0, 1]) {
      const { sess, deps } = build(preCount)
      await makePush(deps, CAP)(sess)
      assert.equal(
        sess._conflictRetryCount,
        preCount + 1,
        `preCount ${preCount}: count should bump`,
      )
      assert.equal(
        deps.retryCb.length,
        1,
        `preCount ${preCount}: retry should fire while count <= cap`,
      )
    }

    // Pre-count 2 (== cap): after +1 = 3 (> cap), retry MUST NOT fire
    const { sess: sessCap, deps: depsCap } = build(CAP)
    await makePush(depsCap, CAP)(sessCap)
    assert.equal(sessCap._conflictRetryCount, CAP + 1)
    assert.equal(depsCap.retryCb.length, 0, 'retry must not fire when count exceeds cap')
    // Dirty flag must still be set so the next user action can retry manually.
    assert.equal(sessCap._dirty, true)
  })
})
