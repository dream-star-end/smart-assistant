import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { TypeCompiler } from '@sinclair/typebox/compiler'

import {
  AnyFrame,
  InboundPromptQueueDelete,
  InboundPromptQueueEdit,
  InboundPromptQueueEnqueue,
  InboundPromptQueueInterject,
  InboundPromptQueueReorder,
  PROMPT_QUEUE_V1_CAPABILITY,
  PROMPT_QUEUE_V1_ENV,
  PROMPT_STEER_CCB_FORK_ENV,
  PROMPT_STEER_CODEX_NATIVE_ENV,
  PromptQueueMutationFrame,
  PromptQueueSnapshot,
  comparePromptQueueVersions,
  nextPromptQueueVersion,
  parsePromptQueueVersion,
  promptQueueItemIdFromClientMessageId,
} from '../frames.js'

const peer = { id: 'web-session-1', kind: 'dm' as const }
const itemId = 'queue_item-1'
const turnId = 'ab'.repeat(32)
const contentHash = 'cd'.repeat(32)
const mediaUrl = `/api/media/${'ef'.repeat(32)}.png`

const enqueue = {
  type: 'inbound.prompt_queue.enqueue' as const,
  peer,
  channel: 'webchat' as const,
  agentId: 'main',
  itemId,
  clientMessageId: itemId,
  observedVersion: '9007199254740993',
  idempotencyKey: 'enqueue-1',
  content: { text: '先排队', media: [{ kind: 'image', url: mediaUrl }] },
  requestedExecution: { model: 'gpt-5.6-sol', effortLevel: 'high', teamMode: false },
}

const edit = {
  type: 'inbound.prompt_queue.edit' as const,
  peer,
  agentId: 'main',
  itemId,
  expectedVersion: '2',
  idempotencyKey: 'edit-1',
  content: { text: '修改后的内容' },
}

const remove = {
  type: 'inbound.prompt_queue.delete' as const,
  peer,
  agentId: 'main',
  itemId,
  expectedVersion: '3',
  idempotencyKey: 'delete-1',
}

const reorder = {
  type: 'inbound.prompt_queue.reorder' as const,
  peer,
  agentId: 'main',
  orderedItemIds: [itemId, 'queue_item-2'],
  expectedVersion: '4',
  idempotencyKey: 'reorder-1',
}

const interject = {
  type: 'inbound.prompt_queue.interject' as const,
  peer,
  agentId: 'main',
  itemId,
  mode: 'insert_current' as const,
  expectedVersion: '5',
  expectedTurnId: turnId,
  idempotencyKey: 'interject-1',
}

const snapshot = {
  type: 'outbound.prompt_queue.snapshot' as const,
  owner: {
    userId: '42',
    sessionKey: 'agent:main:webchat:dm:web-session-1',
    clientSessionId: 'web-session-1',
    agentId: 'main',
  },
  version: '9007199254740994',
  activeTurn: {
    id: turnId,
    sourceItemId: itemId,
    traceId: '0123456789abcdef0123456789abcdef',
    startedAt: 1_721_111_111_111,
    steerDelivery: 'native' as const,
  },
  items: [
    {
      id: itemId,
      clientMessageId: itemId,
      position: 1,
      displayText: '先排队',
      contentHash,
      contentBytes: '12',
      attachmentRefs: [{ ordinal: 0, kind: 'image', url: mediaUrl, mimeType: 'image/png' }],
      state: 'queued' as const,
      requestedExecution: {
        agentId: 'main',
        model: 'gpt-5.6-sol',
        effortLevel: 'high',
        teamMode: false,
      },
      createdAt: 1_721_111_111_000,
      updatedAt: 1_721_111_111_100,
    },
  ],
  mutation: {
    idempotencyKey: 'enqueue-1',
    operation: 'enqueue' as const,
    outcome: 'applied' as const,
    appliedVersion: '9007199254740994',
  },
  serverTs: 1_721_111_111_200,
  frameSeq: 17,
}

describe('prompt queue TypeBox frames', () => {
  const mutationCases = [
    [InboundPromptQueueEnqueue, enqueue],
    [InboundPromptQueueEdit, edit],
    [InboundPromptQueueDelete, remove],
    [InboundPromptQueueReorder, reorder],
    [InboundPromptQueueInterject, interject],
  ] as const

  it('compiles and accepts all five client mutation frames', () => {
    for (const [schema, frame] of mutationCases) {
      assert.equal(TypeCompiler.Compile(schema).Check(frame), true, frame.type)
    }
  })

  it('compiles and accepts the complete server snapshot', () => {
    assert.equal(TypeCompiler.Compile(PromptQueueSnapshot).Check(snapshot), true)
  })

  it('rejects non-canonical or negative queue versions', () => {
    const check = TypeCompiler.Compile(InboundPromptQueueEdit)
    for (const expectedVersion of ['-1', '01', '1.0', '', ' 1']) {
      assert.equal(check.Check({ ...edit, expectedVersion }), false, expectedVersion)
    }
  })

  it('rejects malformed snapshot owners and unstable item ids', () => {
    const snapshotCheck = TypeCompiler.Compile(PromptQueueSnapshot)
    assert.equal(
      snapshotCheck.Check({ ...snapshot, owner: { ...snapshot.owner, userId: 42 } }),
      false,
    )
    assert.equal(
      snapshotCheck.Check({ ...snapshot, owner: { ...snapshot.owner, sessionKey: '' } }),
      false,
    )

    const enqueueCheck = TypeCompiler.Compile(InboundPromptQueueEnqueue)
    for (const badItemId of ['bad item', '../item', 'x'.repeat(129)]) {
      assert.equal(
        enqueueCheck.Check({ ...enqueue, itemId: badItemId, clientMessageId: badItemId }),
        false,
        badItemId,
      )
    }
  })

  it('rejects non-durable attachment URLs, extra local fields and more than eight refs', () => {
    const check = TypeCompiler.Compile(PromptQueueSnapshot)
    const baseItem = snapshot.items[0]!
    const withRefs = (attachmentRefs: unknown[]) => ({
      ...snapshot,
      items: [{ ...baseItem, attachmentRefs }],
    })

    assert.equal(check.Check(withRefs([{ ordinal: 0, kind: 'image', url: 'blob:local' }])), false)
    assert.equal(
      check.Check(withRefs([{ ordinal: 0, kind: 'image', url: mediaUrl, localSrc: 'blob:local' }])),
      false,
    )
    assert.equal(
      check.Check(
        withRefs(
          Array.from({ length: 9 }, (_, ordinal) => ({ ordinal, kind: 'file', url: mediaUrl })),
        ),
      ),
      false,
    )
  })

  it('rejects more than eight inbound content attachments', () => {
    const check = TypeCompiler.Compile(InboundPromptQueueEnqueue)
    assert.equal(
      check.Check({
        ...enqueue,
        content: {
          text: 'too many',
          media: Array.from({ length: 9 }, () => ({ kind: 'image', url: mediaUrl })),
        },
      }),
      false,
    )
  })

  it('registers every queue frame in its aggregate unions', () => {
    const mutationCheck = TypeCompiler.Compile(PromptQueueMutationFrame)
    const anyCheck = TypeCompiler.Compile(AnyFrame)
    for (const [, frame] of mutationCases) {
      assert.equal(mutationCheck.Check(frame), true, frame.type)
      assert.equal(anyCheck.Check(frame), true, frame.type)
    }
    assert.equal(anyCheck.Check(snapshot), true, snapshot.type)
  })
})

describe('prompt queue pure identity/version helpers', () => {
  it('freezes the RFC §11.1 flag and capability names without reading them', () => {
    assert.equal(PROMPT_QUEUE_V1_ENV, 'OC_PROMPT_QUEUE_V1')
    assert.equal(PROMPT_STEER_CODEX_NATIVE_ENV, 'OC_PROMPT_STEER_CODEX_NATIVE')
    assert.equal(PROMPT_STEER_CCB_FORK_ENV, 'OC_PROMPT_STEER_CCB_FORK')
    assert.equal(PROMPT_QUEUE_V1_CAPABILITY, 'promptQueueV1')
  })

  it('keeps the browser message id byte-for-byte stable', () => {
    assert.equal(promptQueueItemIdFromClientMessageId(itemId), itemId)
    assert.throws(
      () => promptQueueItemIdFromClientMessageId('bad item'),
      /invalid prompt queue item id/,
    )
  })

  it('parses, compares and increments versions beyond Number.MAX_SAFE_INTEGER', () => {
    assert.equal(parsePromptQueueVersion('9007199254740993'), 9_007_199_254_740_993n)
    assert.equal(comparePromptQueueVersions('9007199254740993', '9007199254740994'), -1)
    assert.equal(comparePromptQueueVersions('7', '7'), 0)
    assert.equal(comparePromptQueueVersions('8', '7'), 1)
    assert.equal(nextPromptQueueVersion('9007199254740993'), '9007199254740994')
    assert.throws(() => parsePromptQueueVersion('01'), /invalid prompt queue version/)
  })
})
