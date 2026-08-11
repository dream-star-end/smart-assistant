import { describe, expect, it } from '@ohos/hypium';
import {
  APP_CLIENT_URL,
  APP_HOME_URL,
  classifyNavigationUrl,
  isOauthCandidateUrl,
  isPrimaryAppOrigin,
  isSafeDownloadUrl,
  isSafeExternalUrl,
  NavigationDecision
} from '../main/ets/common/NavigationPolicy';

export default function navigationPolicyTest(): void {
  describe('NavigationPolicy', () => {
    it('separates the app entry from the public share URL', 0, () => {
      expect(APP_HOME_URL).assertEqual('https://claudeai.chat/');
      expect(APP_CLIENT_URL).assertEqual('https://claudeai.chat/?client=harmony');
      expect(classifyNavigationUrl(APP_CLIENT_URL)).assertEqual(NavigationDecision.IN_APP);
    });

    it('keeps only the primary app in ArkWeb by default', 0, () => {
      expect(classifyNavigationUrl('https://claudeai.chat/chat/123?source=app#latest'))
        .assertEqual(NavigationDecision.IN_APP);
      expect(classifyNavigationUrl('https://connect.linux.do/oauth2/authorize?client_id=aurora'))
        .assertEqual(NavigationDecision.EXTERNAL);
      expect(classifyNavigationUrl('https://github.com/login/oauth/authorize'))
        .assertEqual(NavigationDecision.EXTERNAL);
    });

    it('recognizes OAuth candidates that still require native confirmation', 0, () => {
      expect(isOauthCandidateUrl(
        'https://accounts.feishu.cn/open-apis/authen/v1/authorize?state=s1&redirect_uri=' +
        'https%3A%2F%2Fclaudeai.chat%2Fapi%2Fconnectors%2Foauth%2Fcallback'
      )).assertTrue();
      expect(isOauthCandidateUrl(
        'https://github.com/login/oauth/authorize?state=s2&redirect_uri=' +
        'https%3A%2F%2Fclaudeai.chat%2Fapi%2Fauth%2Fgithub%2Fcallback'
      )).assertTrue();
      expect(isOauthCandidateUrl(
        'https://connect.linux.do/oauth2/authorize?state=s3&redirect_uri=' +
        'https%3A%2F%2Fclaudeai.chat%2Fapi%2Fauth%2Flinuxdo%2Fcallback'
      )).assertTrue();
      expect(isOauthCandidateUrl(
        'https://linear.app/oauth/authorize?state=s4&redirect_uri=' +
        'https%3A%2F%2Fevil.example%2Fapi%2Fconnectors%2Foauth%2Fcallback'
      )).assertFalse();
      expect(isOauthCandidateUrl(
        'https://linear.app/oauth/authorize?redirect_uri=' +
        'https%3A%2F%2Fclaudeai.chat%2Fapi%2Fconnectors%2Foauth%2Fcallback'
      )).assertFalse();
      expect(isOauthCandidateUrl(
        'https://evil.example/oauth?state=forged&redirect_uri=' +
        'https%3A%2F%2Fclaudeai.chat%2Fapi%2Fconnectors%2Foauth%2Fcallback'
      )).assertTrue();
    });

    it('does not trust lookalike or subdomain hosts', 0, () => {
      expect(classifyNavigationUrl('https://claudeai.chat.example.com/login'))
        .assertEqual(NavigationDecision.EXTERNAL);
      expect(classifyNavigationUrl('https://evil.claudeai.chat/login'))
        .assertEqual(NavigationDecision.EXTERNAL);
    });

    it('opens ordinary secure links with the system handler', 0, () => {
      expect(classifyNavigationUrl('https://example.com/docs'))
        .assertEqual(NavigationDecision.EXTERNAL);
      expect(isSafeExternalUrl('https://example.com/file.pdf')).assertTrue();
    });

    it('accepts only HTTPS and primary-origin Blob downloads', 0, () => {
      expect(isSafeDownloadUrl('https://downloads.example.com/report.pdf')).assertTrue();
      expect(isSafeDownloadUrl('blob:https://claudeai.chat/4f85c0')).assertTrue();
      expect(isSafeDownloadUrl('blob:https://evil.example/4f85c0')).assertFalse();
      expect(isSafeDownloadUrl('data:text/plain,secret')).assertFalse();
      expect(isSafeDownloadUrl('http://downloads.example.com/report.pdf')).assertFalse();
    });

    it('blocks unsafe schemes, credentials, and non-default ports', 0, () => {
      expect(classifyNavigationUrl('http://claudeai.chat/'))
        .assertEqual(NavigationDecision.BLOCKED);
      expect(classifyNavigationUrl('javascript:alert(1)'))
        .assertEqual(NavigationDecision.BLOCKED);
      expect(classifyNavigationUrl('data:text/html,unsafe'))
        .assertEqual(NavigationDecision.BLOCKED);
      expect(classifyNavigationUrl('https://user:pass@claudeai.chat/'))
        .assertEqual(NavigationDecision.BLOCKED);
      expect(classifyNavigationUrl('https://claudeai.chat:8443/'))
        .assertEqual(NavigationDecision.BLOCKED);
      expect(classifyNavigationUrl('not a URL'))
        .assertEqual(NavigationDecision.BLOCKED);
    });

    it('grants web permissions only to the exact primary origin', 0, () => {
      expect(isPrimaryAppOrigin('https://claudeai.chat')).assertTrue();
      expect(isPrimaryAppOrigin('https://connect.linux.do')).assertFalse();
      expect(isPrimaryAppOrigin('https://evil.claudeai.chat')).assertFalse();
      expect(isPrimaryAppOrigin('http://claudeai.chat')).assertFalse();
    });
  });
}
