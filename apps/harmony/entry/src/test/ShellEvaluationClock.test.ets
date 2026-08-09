import { describe, expect, it } from '@ohos/hypium';
import {
  ShellEvaluationClock,
  ShellEvaluationDecision,
  ShellEvaluationRequest,
  ShellRollbackDecision
} from '../main/ets/common/ShellEvaluationClock';

export default function shellEvaluationClockTest(): void {
  describe('ShellEvaluationClock', () => {
    it('coalesces a busy generation into one evaluation retry', 0, () => {
      const clock: ShellEvaluationClock = new ShellEvaluationClock();
      clock.beginGeneration(7);

      expect(clock.request(7)).assertEqual(ShellEvaluationRequest.STARTED);
      expect(clock.request(7)).assertEqual(ShellEvaluationRequest.QUEUED);
      expect(clock.request(7)).assertEqual(ShellEvaluationRequest.QUEUED);
      expect(clock.completeEvaluation(7, false)).assertEqual(ShellEvaluationDecision.RETRY);
      expect(clock.completeEvaluation(7, false)).assertEqual(ShellEvaluationDecision.COMMIT);
      expect(clock.request(7)).assertEqual(ShellEvaluationRequest.STARTED);
    });

    it('serializes rollback before consuming a pending retry', 0, () => {
      const clock: ShellEvaluationClock = new ShellEvaluationClock();
      clock.beginGeneration(12);

      expect(clock.request(12)).assertEqual(ShellEvaluationRequest.STARTED);
      expect(clock.completeEvaluation(12, true)).assertEqual(ShellEvaluationDecision.ROLLBACK);
      expect(clock.request(12)).assertEqual(ShellEvaluationRequest.QUEUED);
      expect(clock.completeRollback(12)).assertEqual(ShellRollbackDecision.RETRY);
      expect(clock.completeEvaluation(12, false)).assertEqual(ShellEvaluationDecision.COMMIT);
    });

    it('does not let an old generation clear or complete the current one', 0, () => {
      const clock: ShellEvaluationClock = new ShellEvaluationClock();
      clock.beginGeneration(20);
      expect(clock.request(20)).assertEqual(ShellEvaluationRequest.STARTED);

      clock.beginGeneration(21);
      expect(clock.request(21)).assertEqual(ShellEvaluationRequest.STARTED);
      expect(clock.completeEvaluation(20, false)).assertEqual(ShellEvaluationDecision.STALE);
      expect(clock.completeRollback(20)).assertEqual(ShellRollbackDecision.STALE);
      clock.cancel(20);
      expect(clock.request(21)).assertEqual(ShellEvaluationRequest.QUEUED);
      expect(clock.completeEvaluation(21, false)).assertEqual(ShellEvaluationDecision.RETRY);
      expect(clock.completeEvaluation(21, false)).assertEqual(ShellEvaluationDecision.COMMIT);
    });

    it('rejects requests while inactive and after lifecycle invalidation', 0, () => {
      const clock: ShellEvaluationClock = new ShellEvaluationClock();
      expect(clock.request(0)).assertEqual(ShellEvaluationRequest.REJECTED);

      clock.beginGeneration(0);
      expect(clock.request(0)).assertEqual(ShellEvaluationRequest.STARTED);
      clock.invalidate();
      expect(clock.request(0)).assertEqual(ShellEvaluationRequest.REJECTED);
      expect(clock.completeEvaluation(0, false)).assertEqual(ShellEvaluationDecision.STALE);
    });
  });
}
