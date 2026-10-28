import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { WebSocket } from 'ws';
import { sendError } from '../http/util.js';
import { sendErrorFrame } from '../ws/userErrorFrames.js';
import { recoveryJobStatus, recoveryRunningFrame } from '../ws/recoveryPresentation.js';
import type { ClaimedRecoveryJob } from '../dispatch/turnRecoveryStore.js';

describe('server error presentation contract', () => {
test('real HTTP error emitter adds public copy without changing guidance or internal identifiers', () => {
  let encoded = '';
  const response = { setHeader() {}, end(body: string) { encoded = body; } } as unknown as ServerResponse;
  sendError(response, 503, 'MODEL_CATALOG_UNAVAILABLE', 'oceng-secret cost=8', 'trace-test', undefined,
    undefined, { retrySafe: 'never', sideEffect: 'unknown' });
  const wire = JSON.parse(encoded);
  assert.equal(response.statusCode, 503);
  assert.deepEqual(wire.error, { code: 'MODEL_CATALOG_UNAVAILABLE', message: 'oceng-secret cost=8',
    request_id: 'trace-test', retrySafe: 'never', sideEffect: 'unknown' });
  assert.equal(wire.userError.code, 'model_catalog_unavailable');
  assert.doesNotMatch(wire.userError.message, /oceng-|cost=/);
});

test('bridge rejection keeps routing and retry denial while adding safe catalog metadata', () => {
  let encoded = '';
  const ws = { readyState: WebSocket.OPEN, send(body: string) { encoded = body; } } as unknown as WebSocket;
  sendErrorFrame(ws, 'SESSION_DELETED', 'legacy', { peerId: 'peer', clientMessageId: 'm-1', retryable: false, action: 'new_session' });
  const frame = JSON.parse(encoded);
  assert.equal(frame.message, 'legacy');
  assert.equal(frame.retryable, false);
  assert.equal(frame.clientMessageId, 'm-1');
  assert.equal(frame.userError.code, 'session_deleted');
});

test('accepted recovery status uses persisted actual limit and has no prompt or internal request id', () => {
  const job = { sessionId: 's', sourceClientMessageId: 'm-source', rootClientMessageId: 'm-root',
    semanticRecoveryAttempt: 2, request: { clientMessageId: 'm-recover-opaque',
      content: { text: 'PRIVATE PROMPT', recovery: { max: 10, retryLimit: 3 } } },
  } as unknown as ClaimedRecoveryJob;
  assert.equal(recoveryJobStatus(job, 'scheduled').state, 'scheduled');
  const frame = recoveryRunningFrame(job);
  assert.equal(frame.retryStatus.message, '正在自动重试（2/3）。');
  assert.equal(frame.peer.id, 's');
  assert.doesNotMatch(JSON.stringify(frame), /PRIVATE PROMPT/);
  job.request.content = { recovery: { max: 10 } };
  assert.equal(recoveryRunningFrame(job).retryStatus.maxAttempts, undefined);
});

})
