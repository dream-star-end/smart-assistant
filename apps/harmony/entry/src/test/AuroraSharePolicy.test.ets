import { url } from '@kit.ArkTS';
import { describe, expect, it } from '@ohos/hypium';
import {
  AURORA_SHARE_URL,
  AuroraShareRecord,
  createAuroraShareRecord
} from '../main/ets/common/AuroraSharePolicy';

export default function auroraSharePolicyTest(): void {
  describe('AuroraSharePolicy', () => {
    it('creates only one fixed Aurora hyperlink record', 0, () => {
      const record: AuroraShareRecord = createAuroraShareRecord();
      expect(record.utd).assertEqual('general.hyperlink');
      expect(record.content).assertEqual(AURORA_SHARE_URL);
      expect(record.title).assertEqual('Aurora');
      expect(record.description).assertEqual('在 Aurora 中继续你的 AI 工作');
      expect(JSON.stringify(record)).assertEqual(
        '{"utd":"general.hyperlink","content":"https://claudeai.chat/",' +
        '"title":"Aurora","description":"在 Aurora 中继续你的 AI 工作"}'
      );
    });

    it('pins the shared URL to the secure default-port primary origin', 0, () => {
      const parsed: url.URL = url.URL.parseURL(AURORA_SHARE_URL);
      expect(AURORA_SHARE_URL).assertEqual('https://claudeai.chat/');
      expect(parsed.protocol).assertEqual('https:');
      expect(parsed.hostname).assertEqual('claudeai.chat');
      expect(parsed.port).assertEqual('');
      expect(parsed.username).assertEqual('');
      expect(parsed.password).assertEqual('');
      expect(AURORA_SHARE_URL.indexOf('?')).assertEqual(-1);
      expect(AURORA_SHARE_URL.indexOf('#')).assertEqual(-1);
    });

    it('has no input channel for current session data', 0, () => {
      const shareFactory: () => AuroraShareRecord = createAuroraShareRecord;
      const serialized: string = JSON.stringify(shareFactory());
      expect(serialized.indexOf('session')).assertEqual(-1);
      expect(serialized.indexOf('token')).assertEqual(-1);
      expect(serialized.indexOf('query')).assertEqual(-1);
      expect(serialized.indexOf('credential')).assertEqual(-1);
    });
  });
}
