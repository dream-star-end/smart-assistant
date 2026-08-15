import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  WORKSPACE_INSPECT_EMPTY_REASONS,
  WORKSPACE_INSPECT_ERROR_CODES,
  WORKSPACE_INSPECT_MAX_GIT_ENTRIES,
  WORKSPACE_INSPECT_MAX_JSON_BYTES,
  WORKSPACE_INSPECT_MAX_LIST_ENTRIES,
  WORKSPACE_INSPECT_PROTOCOL_VERSION,
  WORKSPACE_INSPECT_SKIP_NAMES,
  type WorkspaceInspectEmptyBody,
} from '../workspaceInspect.js'

describe('workspace inspect protocol', () => {
  it('pins protocol version and resource caps', () => {
    assert.equal(WORKSPACE_INSPECT_PROTOCOL_VERSION, 1)
    assert.equal(WORKSPACE_INSPECT_MAX_LIST_ENTRIES, 200)
    assert.equal(WORKSPACE_INSPECT_MAX_GIT_ENTRIES, 500)
    assert.equal(WORKSPACE_INSPECT_MAX_JSON_BYTES, 256 * 1024)
  })

  it('includes required error codes and empty reasons', () => {
    for (const code of [
      'BAD_SESSION_ID',
      'BAD_PATH',
      'MISSING_SESSION_ID',
      'PATH_DENIED',
      'NOT_FOUND',
      'IN_FLIGHT',
      'HOST_FORBIDDEN',
      'GIT_TIMEOUT',
      'LIST_TIMEOUT',
      'WORKSPACE_CHANGED',
    ]) {
      assert.ok(WORKSPACE_INSPECT_ERROR_CODES.includes(code as (typeof WORKSPACE_INSPECT_ERROR_CODES)[number]))
    }
    assert.deepEqual([...WORKSPACE_INSPECT_EMPTY_REASONS], ['no_workspace', 'not_ready', 'not_a_repo'])
  })

  it('empty body has snapshot null and no added:0', () => {
    const body: WorkspaceInspectEmptyBody = {
      ok: true,
      empty: true,
      reason: 'no_workspace',
      snapshot: null,
    }
    const json = JSON.stringify(body)
    assert.equal(json.includes('"added"'), false)
    assert.equal(body.snapshot, null)
  })

  it('skip names include vendor and vcs dirs', () => {
    assert.ok(WORKSPACE_INSPECT_SKIP_NAMES.includes('node_modules'))
    assert.ok(WORKSPACE_INSPECT_SKIP_NAMES.includes('.git'))
  })
})
