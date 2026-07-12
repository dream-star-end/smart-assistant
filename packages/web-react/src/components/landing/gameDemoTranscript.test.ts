import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { DEMO_SCENARIOS } from './demoScripts'
import { GAME_DEMO_TURNS } from './gameDemoTranscript'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe('game demo transcript fixture', () => {
  test('第一轮正文与生产基准一致，第二轮仅移除公网地址', () => {
    expect(GAME_DEMO_TURNS).toHaveLength(2)
    expect(sha256(GAME_DEMO_TURNS[0].assistantText)).toBe(
      'cd78e49a6b47b0f55c7a1beeb0962d5fb939bcf08cbe6d775e358feb20abbdd9',
    )
    expect(sha256(GAME_DEMO_TURNS[1].assistantText)).toBe(
      '3ac92e1204b79853fc62ae090d0429348e9c0a251d51f5ec97b6df6c891050b1',
    )
    expect(JSON.stringify(GAME_DEMO_TURNS)).not.toContain('dream-star-end.github.io')
  })

  test('场景只引用 fixture 构造六块有序 transcript，不保留摘要字段副本', () => {
    const game = DEMO_SCENARIOS.find((scenario) => scenario.id === 'game')
    expect(game?.presentation).toBe('transcript')
    if (!game || game.presentation !== 'transcript')
      throw new Error('missing transcript game scenario')

    expect('prompt' in game).toBe(false)
    expect('steps' in game).toBe(false)
    expect('answer' in game).toBe(false)
    expect(game.transcript.map((block) => block.kind)).toEqual([
      'user',
      'work',
      'assistant',
      'user',
      'work',
      'assistant',
    ])

    const workBlocks = game.transcript.filter((block) => block.kind === 'work')
    expect(workBlocks.map((block) => block.toolCallCount)).toEqual([61, 20])
    const userBlocks = game.transcript.filter((block) => block.kind === 'user')
    expect(userBlocks.map((block) => block.text)).toEqual(
      GAME_DEMO_TURNS.map((turn) => turn.userText),
    )
    const assistantBlocks = game.transcript.filter((block) => block.kind === 'assistant')
    expect(assistantBlocks.map((block) => block.text)).toEqual(
      GAME_DEMO_TURNS.map((turn) => turn.assistantText),
    )
  })
})
