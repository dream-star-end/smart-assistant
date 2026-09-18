import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { AdvisorConsultStore, hashEvidence, mintConsultId } from '../advisorConsultStore.js'
import {
  CONSULT_INVOCATION_HEADER,
  DELEGATE_CONTEXT_HEADER,
  inspectConsultTurnToken,
  issueConsultTurnToken,
} from '../delegateContext.js'
import { Gateway } from '../server.js'

const dir = process.env.OC_ADVISOR_RESTART_HOME
if (!dir) throw new Error('OC_ADVISOR_RESTART_HOME')
process.env.OC_SELFHOST_ENGINE_LOCAL_TURNS = '1'
const SESSION = 'agent:main:webchat:dm:restart-probe'
const TURN = 'a'.repeat(64)
const INVOCATION = 'cinv-restart-m4e'
const mode = process.argv[2]

if (mode === 'mint') {
  const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
  store.insertNew({
    consultId: mintConsultId(),
    invocationId: INVOCATION,
    userId: '3',
    sessionKey: SESSION,
    clientSessionId: 'restart-probe',
    originTurnKey: TURN,
    originTurnIndex: 1,
    configVersion: 'v1:advisor:gpt-6-astra',
    evidenceVersion: hashEvidence('{}'),
    advisorModel: 'gpt-6-astra',
    question: 'why red?',
    concern: '',
    snapshotJson: '{}',
    jobId: null,
    billingRequestId: 'ab'.repeat(16),
    advice: process.env.OC_ADVISOR_CRASH_WINDOW === '1' ? null : 'ORIGINAL_ADVICE',
    state: process.env.OC_ADVISOR_CRASH_WINDOW === '1' ? 'spawned' : 'settled',
  })
  store.close()
  const token = issueConsultTurnToken({
    agentId: 'main',
    sessionKey: SESSION,
    depth: 0,
    turnKey: TURN,
    turnIndex: 1,
    collabMode: 'advisor',
    configVersion: 'v1:advisor:gpt-6-astra',
  })
  writeFileSync(join(dir, 'token.json'), JSON.stringify({ token }))
  process.stdout.write(`${JSON.stringify({ minted: true })}\n`)
} else if (mode === 'replay') {
  const token = JSON.parse(readFileSync(join(dir, 'token.json'), 'utf8')).token as string
  const inspected = inspectConsultTurnToken(token)
  const store = new AdvisorConsultStore(join(dir, 'advisor.db'))
  const gw = Object.create(Gateway.prototype) as any
  gw._advisorConsults = store
  gw.getUserId = () => '3'
  gw.readBody = async () => JSON.stringify({ question: 'why red?' })
  gw.log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
  gw.sessions = { getByKey: () => undefined }
  let status = 0
  let raw = ''
  await gw.handleConsultAdvisor(
    {
      method: 'POST',
      headers: {
        [DELEGATE_CONTEXT_HEADER]: token,
        [CONSULT_INVOCATION_HEADER]: INVOCATION,
      },
    },
    {
      writeHead: (c: number) => {
        status = c
      },
      end: (b?: unknown) => {
        raw = String(b ?? '')
      },
    },
  )
  process.stdout.write(
    `${JSON.stringify({
      status,
      body: raw ? JSON.parse(raw) : {},
      hmacOk: inspected?.hmacOk === true,
      parentPresent: false,
    })}\n`,
  )
  store.close()
} else {
  throw new Error(`unknown mode ${mode}`)
}
