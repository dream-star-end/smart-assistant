import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatMessage } from '../../lib/chat/model';
import { collectRecoveredTurnStatusRecordIds } from '../../lib/chat/manualTaskContinuation';
import { messageSignature } from '../../lib/chat/render';
import { TurnStatusCard } from './TurnErrorNotice';

afterEach(cleanup);

test('OCV5-682: the single gray delivery line keeps its final resend across recovery lineage', () => {
  const root = { id: 'root-682', role: 'user', text: 'original', status: 'error', ts: 1 } as ChatMessage;
  const child = { ...root, id: 'child-682', _automaticRecovery: true, _recoveryOfClientMessageId: root.id };
  const notice = { id: 'turn-status:682', role: 'system', text: '', ts: 2, _source: 'server',
    _turnStatusRecord: true, _dispatchTerminal: true, _errorCode: 'DISPATCH_AUTHORITY_EXPIRED',
    _clientMessageId: root.id, _dispatchDeliveryRecovery: 'resent', _dispatchRetryClientMessageId: child.id } as ChatMessage;
  expect(collectRecoveredTurnStatusRecordIds([root, notice, child]).has(notice.id)).toBe(false);
  const resend = vi.fn();
  const view = render(<TurnStatusCard msg={notice} cb={{ resolveRetryTarget: () => child, onRetrySend: resend }} currentTurn />);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status')).toHaveTextContent('这一轮没发出去，已自动重发');
  const failed = { ...notice, _dispatchDeliveryRecovery: 'failed' as const };
  expect(messageSignature(notice, { isLast: true, sending: false })).not.toBe(messageSignature(failed, { isLast: true, sending: false }));
  view.rerender(<><TurnStatusCard msg={failed} cb={{ resolveRetryTarget: () => child, onRetrySend: resend }} currentTurn />
    <TurnStatusCard msg={{ ...failed, id: 'hidden-682', _dispatchDeliveryRecovery: 'hidden' }} cb={{}} currentTurn /></>);
  expect(screen.getAllByRole('status')).toHaveLength(1);
  expect(screen.getByRole('status').className).toContain('text-faint');
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '重新发送' }));
  expect(resend).toHaveBeenCalledExactlyOnceWith(child);
});
