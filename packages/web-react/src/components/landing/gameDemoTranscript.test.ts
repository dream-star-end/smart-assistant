import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { DEMO_SCENARIOS } from './demoScripts'
import { GAME_DEMO_TURNS } from './gameDemoTranscript'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

describe('game demo transcript fixture', () => {
  test('两轮助手正文与生产核验基准逐字一致', () => {
    expect(GAME_DEMO_TURNS).toHaveLength(2)
    expect(sha256(GAME_DEMO_TURNS[0].assistantText)).toBe(
      'cd78e49a6b47b0f55c7a1beeb0962d5fb939bcf08cbe6d775e358feb20abbdd9',
    )
    expect(sha256(GAME_DEMO_TURNS[1].assistantText)).toBe(
      'ee7b5d160d74e8afbf0028f85f3dc3fce6cd805d7d35493953b998ddc0187f57',
    )
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
