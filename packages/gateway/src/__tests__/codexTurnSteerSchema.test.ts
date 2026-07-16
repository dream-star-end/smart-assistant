/**
 * Codex app-server 0.144.0 turn/steer compatibility evidence.
 *
 * The JSON fixture payloads are direct outputs from:
 *   codex app-server generate-json-schema --experimental --out <dir>
 * The repository adds its conventional final LF; the manifest pins both the
 * generator bytes and repository bytes so any other drift fails loudly.
 * No runner code consumes these files; they freeze the P0 mapping assumptions
 * before native steering is implemented in RFC P5.
 */
import * as assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import {
  InboundPromptQueueInterject,
  PromptQueueAttachmentRef,
  PromptQueueItemId,
  promptQueueItemIdFromClientMessageId,
} from '@openclaude/protocol/frames'
import { Value } from '@sinclair/typebox/value'

type JsonObject = Record<string, unknown>

const fixtureRoot = new URL('./fixtures/codex-app-server-0.144.0/', import.meta.url)

function readFixture(name: string): { raw: Buffer; json: JsonObject } {
  const raw = readFileSync(new URL(name, fixtureRoot))
  return { raw, json: JSON.parse(raw.toString('utf8')) as JsonObject }
}

function object(value: unknown, label: string): JsonObject {
  assert.ok(
    value && typeof value === 'object' && !Array.isArray(value),
    `${label} must be an object`,
  )
  return value as JsonObject
}

function array(value: unknown, label: string): unknown[] {
  assert.ok(Array.isArray(value), `${label} must be an array`)
  return value
}

function sha256(raw: Buffer): string {
  return createHash('sha256').update(raw).digest('hex')
}

const manifestFixture = readFixture('manifest.json')
const paramsFixture = readFixture('TurnSteerParams.json')
const responseFixture = readFixture('TurnSteerResponse.json')

describe('Codex 0.144.0 turn/steer generated schema fixture', () => {
  it('pins the binary coordinate, generation command and byte snapshots', () => {
    const manifest = manifestFixture.json
    assert.equal(manifest.codexVersion, '0.144.0')
    assert.equal(
      manifest.binaryPath,
      '/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
    )
    assert.equal(
      manifest.binarySha256,
      '901923c1808a151f6926d41d703c17ad48815662cefb1c8d832a052c44271429',
    )
    assert.equal(manifest.method, 'turn/steer')
    assert.equal(
      manifest.command,
      '<binaryPath> app-server generate-json-schema --experimental --out <outputDir>',
    )

    const generatedFiles = object(manifest.generatedFiles, 'manifest.generatedFiles')
    const repositoryFiles = object(manifest.repositoryFiles, 'manifest.repositoryFiles')
    for (const [name, fixture] of [
      ['TurnSteerParams.json', paramsFixture],
      ['TurnSteerResponse.json', responseFixture],
    ] as const) {
      assert.equal(repositoryFiles[name], sha256(fixture.raw))
      assert.equal(fixture.raw.at(-1), 0x0a, `${name} repository fixture must end in LF`)
      assert.equal(generatedFiles[name], sha256(fixture.raw.subarray(0, -1)))
    }
  })

  it('requires thread/input/native expected turn and keeps client id optional nullable', () => {
    const schema = paramsFixture.json
    assert.equal(schema.title, 'TurnSteerParams')
    assert.equal(schema.type, 'object')
    assert.deepEqual(schema.required, ['expectedTurnId', 'input', 'threadId'])

    const properties = object(schema.properties, 'params.properties')
    assert.deepEqual(object(properties.threadId, 'threadId'), { type: 'string' })
    assert.equal(object(properties.expectedTurnId, 'expectedTurnId').type, 'string')
    assert.deepEqual(object(properties.clientUserMessageId, 'clientUserMessageId').type, [
      'string',
      'null',
    ])
    assert.equal(array(schema.required, 'params.required').includes('clientUserMessageId'), false)
    assert.deepEqual(object(properties.input, 'input'), {
      type: 'array',
      items: { $ref: '#/definitions/UserInput' },
    })
    assert.deepEqual(object(properties.additionalContext, 'additionalContext').type, [
      'object',
      'null',
    ])
    assert.deepEqual(
      object(properties.additionalContext, 'additionalContext').additionalProperties,
      { $ref: '#/definitions/AdditionalContextEntry' },
    )
    assert.deepEqual(
      object(properties.responsesapiClientMetadata, 'responsesapiClientMetadata').type,
      ['object', 'null'],
    )
    assert.deepEqual(
      object(properties.responsesapiClientMetadata, 'responsesapiClientMetadata')
        .additionalProperties,
      { type: 'string' },
    )
  })

  it('pins the statically mappable text/image/localImage input variants', () => {
    const definitions = object(paramsFixture.json.definitions, 'params.definitions')
    const userInput = object(definitions.UserInput, 'definitions.UserInput')
    const variants = array(userInput.oneOf, 'UserInput.oneOf').map((entry, index) =>
      object(entry, `UserInput.oneOf[${index}]`),
    )
    const byType = new Map(
      variants.map((variant) => {
        const properties = object(variant.properties, `${String(variant.title)}.properties`)
        const typeSchema = object(properties.type, `${String(variant.title)}.properties.type`)
        return [array(typeSchema.enum, `${String(variant.title)}.type.enum`)[0], variant]
      }),
    )

    assert.deepEqual([...byType.keys()], ['text', 'image', 'localImage', 'skill', 'mention'])
    assert.deepEqual(byType.get('text')?.required, ['text', 'type'])
    assert.deepEqual(byType.get('image')?.required, ['type', 'url'])
    assert.deepEqual(byType.get('localImage')?.required, ['path', 'type'])
  })

  it('returns the active native turn id as the only response field', () => {
    assert.deepEqual(responseFixture.json, {
      $schema: 'http://json-schema.org/draft-07/schema#',
      title: 'TurnSteerResponse',
      type: 'object',
      required: ['turnId'],
      properties: { turnId: { type: 'string' } },
    })
  })
})

describe('queue protocol → Codex turn/steer mapping assumptions', () => {
  it('uses one stable queue item id as clientUserMessageId', () => {
    const stableId = promptQueueItemIdFromClientMessageId('queue_item-0144')
    assert.equal(Value.Check(PromptQueueItemId, stableId), true)

    const properties = object(paramsFixture.json.properties, 'params.properties')
    const clientIdTypes = array(
      object(properties.clientUserMessageId, 'clientUserMessageId').type,
      'clientUserMessageId.type',
    )
    assert.equal(clientIdTypes.includes(typeof stableId), true)
  })

  it('keeps the browser platform turn id separate from Codex expectedTurnId', () => {
    const platformTurnId = 'ab'.repeat(32)
    assert.equal(
      Value.Check(InboundPromptQueueInterject, {
        type: 'inbound.prompt_queue.interject',
        peer: { id: 'web-session-1', kind: 'dm' },
        agentId: 'main',
        itemId: 'queue_item-0144',
        mode: 'insert_current',
        expectedVersion: '7',
        expectedTurnId: platformTurnId,
        idempotencyKey: 'interject-0144',
      }),
      true,
    )

    const properties = object(paramsFixture.json.properties, 'params.properties')
    const nativeExpectedTurn = object(properties.expectedTurnId, 'expectedTurnId')
    assert.equal(nativeExpectedTurn.type, 'string')
    assert.equal(
      'pattern' in nativeExpectedTurn,
      false,
      'native UUID shape stays private to the runner',
    )
  })

  it('maps durable media refs only to generated image/localImage input variants', () => {
    const mediaUrl = `/api/media/${'cd'.repeat(32)}.png`
    assert.equal(
      Value.Check(PromptQueueAttachmentRef, { ordinal: 0, kind: 'image', url: mediaUrl }),
      true,
    )

    const definitions = object(paramsFixture.json.definitions, 'params.definitions')
    const variants = array(object(definitions.UserInput, 'UserInput').oneOf, 'UserInput.oneOf')
    const inputTypes = variants.map((variant, index) => {
      const properties = object(
        object(variant, `variant[${index}]`).properties,
        'variant.properties',
      )
      return array(object(properties.type, 'variant.type').enum, 'variant.type.enum')[0]
    })
    assert.equal(inputTypes.includes('image'), true)
    assert.equal(inputTypes.includes('localImage'), true)
  })
})
