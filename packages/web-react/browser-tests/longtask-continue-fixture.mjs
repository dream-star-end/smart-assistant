/** Network/data only. The App, continuation hook and ChatSocket are real. */
import { BOARD_SESSION } from './process-disclosure-story.mjs';

export const LONGTASK_CONTEXT = 'LONGTASK_CONTEXT_ALREADY_SAVED';
export const LONGTASK_PARTIAL = 'LONGTASK_PARTIAL_ANSWER_ALREADY_SAVED';
export const LONGTASK_TOOL_FILE = 'longtask-ledger.md';
export const LONGTASK_FINISHED = 'LONGTASK_CONTINUED_IN_SAME_SESSION';

export function createLongtaskScenario(kind) {
  const source = `m-longtask-${kind}-source`;
  const goal = `LONGTASK_ORIGINAL_GOAL_${kind}: 完成报告，保留已执行步骤。`;
  const at = Date.now() - 10_000;
  const rows = [
    { id: 'm-longtask-prior', role: 'user', text: '请保留这个上下文', status: 'replied' },
    { id: 'longtask-prior-answer', role: 'assistant', text: LONGTASK_CONTEXT, _clientMessageId: 'm-longtask-prior' },
    { id: source, role: 'user', text: goal, status: 'error',
      _routing: { model: 'glm-5.2', teamMode: false, effortLevel: 'high' } },
    ...(kind === 'paid' ? [
      { id: 'longtask-completed-read', role: 'tool', text: '', toolName: 'Read',
        blockId: 'longtask-read', inputJson: { file_path: LONGTASK_TOOL_FILE },
        output: 'LONGTASK_TOOL_RESULT_ALREADY_SAVED', _completed: true,
        _clientMessageId: source, _turnTapeId: 'tape-longtask-paid',
        _toolEffect: { authority: 'gateway-v1', safety: 'read_only', outcome: 'completed',
          registryEntrySha256: 'a'.repeat(64) } },
    ] : []),
    { id: `longtask-error-${kind}`, role: 'assistant', text: kind === 'paid' ? LONGTASK_PARTIAL : '',
      _clientMessageId: source, _turnTapeId: `tape-longtask-${kind}`, _turnTapeComplete: true,
      _dispatchOutcome: 'crashed', _errorCode: 'MODEL_AUTHORITY_EXPIRED',
      _errorDetail: '任务暂时中断',
      // Prevent automatic attempts from hiding the explicit human action.
      _automaticRetryRootClientMessageId: source, _automaticRetryAttempt: 10, _automaticRetryMax: 10,
      usage: { costCredits: kind === 'paid' ? '71' : '0', waived: false,
        inputTokens: kind === 'paid' ? 50 : 0, outputTokens: kind === 'paid' ? 100 : 0 } },
  ].map((row, index) => ({ ...row, ts: at + index, _source: 'server',
    _seq: index + 1, _orderSeq: index + 1, _timelineRecord: true,
    _timelineUnitKey: `longtask-unit:${kind}:${row.id}` }));
  return { kind, source, goal, rows, frames: [], seq: 0 };
}

export function attachLongtaskWebSocket(preview, current) {
  preview.wss.removeAllListeners('connection');
  preview.wss.on('connection', (ws) => {
    const send = (frame) => ws.readyState === 1 && ws.send(JSON.stringify(frame));
    const ready = () => send({ type: 'sys.relay_ready', automaticRecoveryOwner: 'master-v1' });
    ready();
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === 'ping') return send({ type: 'pong', id: frame.id });
      if (frame.type === 'inbound.hello') return ready();
      if (frame.type !== 'inbound.message') return;
      const scenario = current();
      scenario.frames.push(structuredClone(frame));
      const id = frame.clientMessageId;
      const peer = { id: BOARD_SESSION, kind: 'dm' };
      send({ type: 'outbound.ack', admitted: true, peer, clientMessageId: id });
      const seq = preview.store.board.length + 1;
      const now = Date.now();
      preview.store.board.push(
        { id, role: 'user', text: frame.content?.displayText ?? frame.content?.text,
          _modelText: frame.content?.text, status: 'replied', ts: now, _source: 'server',
          _seq: seq, _orderSeq: seq, _timelineRecord: true,
          _routing: { model: frame.model || 'glm-5.2', teamMode: false, effortLevel: frame.effortLevel ?? null },
          ...(frame.content?.recovery ? { _recoveryOfClientMessageId: frame.content.recovery.sourceClientMessageId,
            _recoveryMode: frame.content.recovery.mode, _automaticRecovery: false, _isAutoRetry: true } : {}) },
        { id: `longtask-finished-${id}`, role: 'assistant', text: LONGTASK_FINISHED,
          _clientMessageId: id, ts: now + 1, _source: 'server', _seq: seq + 1, _orderSeq: seq + 1,
          _timelineRecord: true },
      );
      preview.store.revision += 1;
      send({ type: 'outbound.message', peer, sessionKey: `agent:main:webchat:dm:${BOARD_SESSION}`,
        clientMessageId: id, frameSeq: ++scenario.seq,
        blocks: [{ kind: 'text', text: LONGTASK_FINISHED, messageId: `longtask-finished-${id}` }], isFinal: true });
    });
  });
}
