import { describe, expect, it } from '@ohos/hypium';
import { isCurrentDownloadCallback } from '../main/ets/common/DownloadLifecyclePolicy';

export default function downloadLifecyclePolicyTest(): void {
  describe('DownloadLifecyclePolicy', () => {
    it('accepts callbacks only for the current Web instance', 0, () => {
      expect(isCurrentDownloadCallback(4, 4, 4)).assertTrue();
    });

    it('rejects stale delegates and stale download targets', 0, () => {
      expect(isCurrentDownloadCallback(3, 4, 4)).assertFalse();
      expect(isCurrentDownloadCallback(4, 3, 4)).assertFalse();
      expect(isCurrentDownloadCallback(3, 3, 4)).assertFalse();
    });
  });
}
