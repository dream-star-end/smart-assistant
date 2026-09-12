import { afterEach, beforeEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId, switchSession } from '../../bootstrap/state.js'
import { createUserMessage } from '../messages.js'
import {
  clearSessionMessagesCache,
  flushSessionStorage,
  getProjectDir,
  getTranscriptPath,
  getSessionMessages,
  prepareStrictReceiptInput,
  recordTranscript,
  resetProjectForTesting,
} from '../sessionStorage.js'
import {
  admitReceiptInput,
  bindReceiptInput,
} from '../receiptInputAdmission.js'
import type { Message } from '../../types/message.js'

let dir: string
const originalConfig = process.env.CLAUDE_CONFIG_DIR
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'receipt-input-'))
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  getProjectDir.cache.clear?.()
  resetProjectForTesting()
  clearSessionMessagesCache()
  switchSession(randomUUID() as any)
})
afterEach(async () => {
  await flushSessionStorage()
  resetProjectForTesting()
  await rm(dir, { recursive: true, force: true })
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
})
function fixture() {
  const parent = createUserMessage({ content: 'do the task' })
  const assistant = {
    type: 'assistant',
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: {
      id: 'assistant-api-id',
      type: 'message',
      role: 'assistant',
      model: 'synthetic',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'Bash',
          input: { command: 'true' },
        },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  } as any
  const result = createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'tool-1',
        content: 'EXACT_CHILD_FAILURE',
      },
    ],
    sourceToolAssistantUUID: assistant.uuid,
  })
  const marker = {
    jobId: 'job-strict',
    generation: 1,
    resultDigest: 'a'.repeat(64),
  }
  return { result, marker, history: [parent, assistant] as Message[] }
}

test('ordinary tool results remain the exact object; fake stdout cannot enroll', async () => {
  const { result, history } = fixture()
  ;(result as any).receipt = { jobId: 'job-strict' }
  expect(await admitReceiptInput(result, history)).toBe(result)
})

test('input admission awaits native commit and new-process native resume sees it once', async () => {
  const { result, history, marker } = fixture()
  let release!: () => void
  const gate = new Promise<void>(r => {
    release = r
  })
  let entered!: () => void
  const ready = new Promise<void>(r => {
    entered = r
  })
  bindReceiptInput(result, {
    marker,
    ingest: async (proof, commit, oracle) => {
      expect(proof.nativeSessionId).toBe(getSessionId())
      entered()
      await gate
      await commit()
      expect((await oracle()).kind).toBe('present')
      return 'ingested'
    },
  })
  let returned = false
  const work = admitReceiptInput(result, history).then(r => {
    returned = true
    return r
  })
  await ready
  expect(returned).toBe(false)
  expect(
    (await getSessionMessages(getSessionId() as any)).has(result.uuid),
  ).toBe(false)
  release()
  const admitted = await work
  expect(admitted.uuid).toBe(result.uuid)
  await recordTranscript([...history, admitted])
  await flushSessionStorage()
  const file = getTranscriptPath()
  const lines = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map(l => JSON.parse(l))
  const matches = lines.filter(l => l.uuid === result.uuid)
  expect(matches).toHaveLength(1)
  expect(matches[0].parentUuid).toBe(history[1]!.uuid)
  expect(matches[0].sessionId).toBe(getSessionId())
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import {loadFullLog} from ${JSON.stringify(new URL('../sessionStorage.ts', import.meta.url).pathname)};
    const log=await loadFullLog({isLite:true,sessionId:process.env.SESSION_ID,fullPath:process.env.FILE,messages:[],date:'',value:0,created:new Date(),modified:new Date(),firstPrompt:'',messageCount:3,isSidechain:false});
    const matches=log.messages.filter(m=>m.uuid===process.env.RESULT_UUID);
    console.log(JSON.stringify({count:matches.length,content:matches[0]?.message?.content,ids:log.messages.map(m=>m.uuid)}));
  `,
    ],
    {
      env: {
        PATH: process.env.PATH!,
        HOME: dir,
        CLAUDE_CONFIG_DIR: dir,
        NODE_ENV: 'test',
        FILE: file,
        RESULT_UUID: result.uuid,
        SESSION_ID: getSessionId(),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: '' })
  const restored = JSON.parse(stdout.trim())
  expect({ count: restored.count, ids: restored.ids }).toEqual({
    count: 1,
    ids: [...history.map(m => m.uuid), result.uuid],
  })
  expect(JSON.stringify(restored.content)).toContain('EXACT_CHILD_FAILURE')
  expect(restored.ids).toEqual([...history.map(m => m.uuid), result.uuid])
}, 60000)

test('losing input owner yields no original result or result side channel', async () => {
  const { result, history, marker } = fixture()
  result.toolUseResult = 'SECRET_SIDE_CHANNEL'
  bindReceiptInput(result, { marker, ingest: async () => 'notify_owned' })
  const admitted = await admitReceiptInput(result, history)
  expect(admitted.uuid).not.toBe(result.uuid)
  expect(JSON.stringify(admitted)).not.toContain('EXACT_CHILD_FAILURE')
  expect(JSON.stringify(admitted)).not.toContain('SECRET_SIDE_CHANNEL')
  expect(
    (await getSessionMessages(getSessionId() as any)).has(result.uuid),
  ).toBe(false)
})

test('skipped persistence and changed parent session fail closed', async () => {
  const { result, history, marker } = fixture()
  process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = '1'
  try {
    await expect(
      prepareStrictReceiptInput(result, history, marker),
    ).rejects.toThrow('unavailable')
  } finally {
    delete process.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY
  }
  const prepared = await prepareStrictReceiptInput(result, history, marker)
  switchSession(randomUUID() as any)
  await expect(prepared.commit()).rejects.toThrow('changed')
})
