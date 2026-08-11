import { describe, expect, it } from '@ohos/hypium';
import {
  isWorkspaceUiFixtureBuildMode,
  isWorkspaceUiFixtureBootstrapUrl,
  shouldAllowWorkspaceUiFixtureLoadUrl,
  WORKSPACE_INITIAL_URL,
  WORKSPACE_UI_FIXTURE_BOOTSTRAP_URL,
  WORKSPACE_UI_FIXTURE_URL,
  workspaceUiControllerDescription
} from '../main/ets/common/WorkspaceUiFixture';

export default function workspaceUiFixtureTest(): void {
  describe('WorkspaceUiFixture', () => {
    it('enables the offline same-origin fixture only for the explicit test build mode', 0, () => {
      expect(isWorkspaceUiFixtureBuildMode('test')).assertTrue();
      expect(isWorkspaceUiFixtureBuildMode('debug')).assertFalse();
      expect(isWorkspaceUiFixtureBuildMode('release')).assertFalse();
      expect(isWorkspaceUiFixtureBuildMode('')).assertFalse();
    });

    it('uses the offline same-origin fixture in the test build', 0, () => {
      expect(WORKSPACE_INITIAL_URL).assertEqual(WORKSPACE_UI_FIXTURE_BOOTSTRAP_URL);
      expect(WORKSPACE_UI_FIXTURE_URL)
        .assertEqual('https://claudeai.chat/__harmony_ui_test_v1__');
      expect(workspaceUiControllerDescription(7))
        .assertEqual('aurora-ui-test-web-controller:7');
    });

    it('allows only the internal fixture bootstrap and generated data document', 0, () => {
      expect(isWorkspaceUiFixtureBootstrapUrl('about:blank')).assertTrue();
      expect(shouldAllowWorkspaceUiFixtureLoadUrl(
        'data:text/html;charset=UTF-8;base64,fixture'
      )).assertTrue();
      expect(shouldAllowWorkspaceUiFixtureLoadUrl('data:text/html,fixture')).assertFalse();
      expect(shouldAllowWorkspaceUiFixtureLoadUrl('https://claudeai.chat/')).assertFalse();
    });
  });
}
