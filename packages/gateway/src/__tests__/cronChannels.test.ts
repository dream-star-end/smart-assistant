/**
 * Cron 送达通道注册表:合法值校验 + GET /api/cron/channels 载荷。
 *
 * Run: npx tsx --test packages/gateway/src/__tests__/cronChannels.test.ts
 */
import * as assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  isAllowedCronDeliverValue,
  listCronDeliverChannels,
} from '../cronChannels.js'

describe('isAllowedCronDeliverValue', () => {
  it('always accepts local and webchat', () => {
    assert.equal(isAllowedCronDeliverValue('local', []), true)
    assert.equal(isAllowedCronDeliverValue('webchat', ['telegram']), true)
  })

  it('accepts registered adapter names and rejects unknown', () => {
    assert.equal(isAllowedCronDeliverValue('telegram', ['telegram']), true)
    assert.equal(isAllowedCronDeliverValue('telegram', []), false)
    assert.equal(isAllowedCronDeliverValue('discord', ['telegram']), false)
  })
})

describe('listCronDeliverChannels', () => {
  it('webchat/local 恒 available,adapter 按注册表实况出现', () => {
    assert.deepEqual(listCronDeliverChannels([]), [
      { value: 'webchat', available: true },
      { value: 'local', available: true },
    ])
    assert.deepEqual(listCronDeliverChannels(['telegram']), [
      { value: 'webchat', available: true },
      { value: 'local', available: true },
      { value: 'telegram', available: true },
    ])
  })

  it('does not duplicate builtins or empty names; new adapters appear automatically', () => {
    const listed = listCronDeliverChannels(['webchat', '', 'discord', 'telegram', 'telegram'])
    assert.deepEqual(listed, [
      { value: 'webchat', available: true },
      { value: 'local', available: true },
      { value: 'discord', available: true },
      { value: 'telegram', available: true },
    ])
  })
})
