import { describe, expect, it } from '@ohos/hypium';
import { NetworkStateClock } from '../main/ets/common/NetworkStateClock';

export default function networkStateClockTest(): void {
  describe('NetworkStateClock', () => {
    it('rejects an initial probe after a newer availability event', 0, () => {
      const clock: NetworkStateClock = new NetworkStateClock();
      clock.advance();
      const initialProbe: number = clock.capture();
      const availabilityEvent: number = clock.advance();

      expect(clock.accepts(initialProbe)).assertFalse();
      expect(clock.accepts(availabilityEvent)).assertTrue();
    });

    it('rejects a net-lost refresh after a newer available event', 0, () => {
      const clock: NetworkStateClock = new NetworkStateClock();
      const lostRefresh: number = clock.advance();
      const availableEvent: number = clock.advance();

      expect(clock.accepts(lostRefresh)).assertFalse();
      expect(clock.accepts(availableEvent)).assertTrue();
    });
  });
}
