import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  BOX_GPT_WEB_BUSY_CODE,
  BOX_GPT_WEB_BUSY_MESSAGE,
  BOX_GPT_WEB_CATALOG_SQL_PLAN,
  BOX_GPT_WEB_CDP_PORT_DEFAULT,
  BOX_GPT_WEB_DISPLAY_DEFAULT,
  BOX_GPT_WEB_FORBIDDEN_PROXY_PORTS,
  BOX_GPT_WEB_LOCAL_PROXY_DEFAULT,
  BOX_GPT_WEB_MAX_CONCURRENCY,
  BOX_GPT_WEB_MODELS,
  BOX_GPT_WEB_MODEL_IDS,
  BOX_GPT_WEB_OWNER_UID,
  BOX_GPT_WEB_OWNER_UID_STR,
  boxClaudeRunner,
  boxGptWebModelById,
  cursorFamilyDefaultEffort,
  cursorFamilyHasEffortAxis,
  cursorModelById,
  cursorModelIdFromPublic,
  findCursorEngineModel,
  isBoxGptWebModel,
  isBoxGptWebOwnerUid,
  isCursorEngineModel,
  publicCursorModelId,
} from '../index.js'

describe('BOX_GPT_WEB_MODELS (OCV5-551 L0 protocol)', () => {
  it('registers box-gpt-6-astra-pro as a ChatGPT Web Pro Box model', () => {
    assert.deepEqual(BOX_GPT_WEB_MODEL_IDS, ['box-gpt-6-astra-pro'])
    assert.equal(isBoxGptWebModel('box-gpt-6-astra-pro'), true)
    assert.equal(isBoxGptWebModel('box-claude-opus-5-5'), false)
    assert.equal(isBoxGptWebModel('gpt-6-astra'), false)
    assert.equal(isBoxGptWebModel(null), false)

    const model = boxGptWebModelById('box-gpt-6-astra-pro')
    assert.ok(model)
    assert.equal(model.upstreamModel, 'gpt-6-astra-pro')
    assert.equal(model.thinkingMode, 'pro')
    assert.equal(model.contextWindow, 400_000)
    assert.equal(model.maxOutputTokens, 128_000)
    assert.equal(model.supportsVision, true)
    assert.equal(model.runner, 'chatgpt-web-pro')
  })

  it('enforces exclusive owner user_id=3 and global concurrency=1 constants', () => {
    assert.equal(BOX_GPT_WEB_OWNER_UID, 3)
    assert.equal(BOX_GPT_WEB_OWNER_UID_STR, '3')
    assert.equal(BOX_GPT_WEB_MAX_CONCURRENCY, 1)
    assert.equal(BOX_GPT_WEB_BUSY_CODE, 'BOX_GPT_WEB_BUSY')
    assert.match(BOX_GPT_WEB_BUSY_MESSAGE, /Pro 通道忙/)
    assert.equal(isBoxGptWebOwnerUid(3), true)
    assert.equal(isBoxGptWebOwnerUid('3'), true)
    assert.equal(isBoxGptWebOwnerUid(' 3 '), true)
    assert.equal(isBoxGptWebOwnerUid(3n), true)
    assert.equal(isBoxGptWebOwnerUid(2), false)
    assert.equal(isBoxGptWebOwnerUid(765), false)
    assert.equal(isBoxGptWebOwnerUid('765'), false)
    assert.equal(isBoxGptWebOwnerUid(0), false)
    assert.equal(isBoxGptWebOwnerUid(null), false)
    assert.equal(isBoxGptWebOwnerUid(undefined), false)
  })

  it('integrates with CURSOR_ENGINE_MODELS for interactive Box routing without polluting effort families', () => {
    assert.equal(isCursorEngineModel('box-gpt-6-astra-pro'), true)
    assert.equal(cursorModelById('box-gpt-6-astra-pro')?.upstreamModel, 'gpt-6-astra-pro')
    assert.equal(boxClaudeRunner('box-gpt-6-astra-pro'), 'interactive')
    assert.equal(publicCursorModelId('box-gpt-6-astra-pro'), 'box-gpt-6-astra-pro')
    assert.equal(cursorModelIdFromPublic('box-gpt-6-astra-pro'), 'box-gpt-6-astra-pro')
    assert.equal(cursorFamilyHasEffortAxis('box-gpt-6-astra-pro'), false)
    assert.equal(cursorFamilyDefaultEffort('box-gpt-6-astra-pro'), null)
    assert.equal(
      findCursorEngineModel('box-gpt-6-astra-pro', null, false)?.id,
      'box-gpt-6-astra-pro',
    )
  })

  it('pins safe defaults for Box display, CDP port, loopback proxy, and catalog SQL plan', () => {
    assert.equal(BOX_GPT_WEB_DISPLAY_DEFAULT, ':1')
    assert.equal(BOX_GPT_WEB_CDP_PORT_DEFAULT, 9229)
    assert.equal(BOX_GPT_WEB_LOCAL_PROXY_DEFAULT, 'socks5://127.0.0.1:18992')
    assert.deepEqual(BOX_GPT_WEB_FORBIDDEN_PROXY_PORTS, [18991, 19095])
    assert.equal(BOX_GPT_WEB_MODELS.length, 1)
    assert.match(BOX_GPT_WEB_CATALOG_SQL_PLAN, /INSERT INTO model_catalog/)
    assert.match(BOX_GPT_WEB_CATALOG_SQL_PLAN, /'box-gpt-6-astra-pro'/)
    assert.match(BOX_GPT_WEB_CATALOG_SQL_PLAN, /'staged'/)
  })
})
