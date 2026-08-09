import { describe, expect, it } from '@ohos/hypium';
import {
  AURORA_ABOUT_ROUTE,
  AURORA_PRIVACY_ROUTE,
  AURORA_SETTINGS_ROUTE,
  AURORA_WEB_ROUTE,
  decideWebBack,
  hasRoute,
  PendingWebAction,
  shouldCreateFreshWebController,
  shouldPushRoute,
  WebBackAction
} from '../main/ets/common/WorkspaceNavigationPolicy';

export default function workspaceNavigationPolicyTest(): void {
  describe('WorkspaceNavigationPolicy', () => {
    it('treats an empty path stack as the native home', 0, () => {
      const homePathNames: string[] = [];
      expect(hasRoute(homePathNames, AURORA_WEB_ROUTE)).assertFalse();
      expect(shouldPushRoute(homePathNames, AURORA_WEB_ROUTE)).assertTrue();
      expect(shouldCreateFreshWebController(hasRoute(homePathNames, AURORA_WEB_ROUTE))).assertTrue();
    });

    it('does not push the current destination twice', 0, () => {
      expect(shouldPushRoute([AURORA_WEB_ROUTE], AURORA_WEB_ROUTE)).assertFalse();
      expect(shouldPushRoute(
        [AURORA_WEB_ROUTE, AURORA_SETTINGS_ROUTE],
        AURORA_SETTINGS_ROUTE
      )).assertFalse();
      expect(shouldPushRoute(
        [AURORA_WEB_ROUTE, AURORA_SETTINGS_ROUTE],
        AURORA_WEB_ROUTE
      )).assertTrue();
      expect(shouldCreateFreshWebController(true)).assertFalse();
    });

    it('allows settings and information surfaces to stack above web', 0, () => {
      const webPathNames: string[] = [AURORA_WEB_ROUTE];
      expect(shouldPushRoute(webPathNames, AURORA_SETTINGS_ROUTE)).assertTrue();
      expect(shouldPushRoute(webPathNames, AURORA_PRIVACY_ROUTE)).assertTrue();
      expect(shouldPushRoute(webPathNames, AURORA_ABOUT_ROUTE)).assertTrue();
      expect(hasRoute(
        [AURORA_WEB_ROUTE, AURORA_SETTINGS_ROUTE],
        AURORA_WEB_ROUTE
      )).assertTrue();
    });

    it('dismisses a pending OAuth confirmation before every other back action', 0, () => {
      expect(decideWebBack(true, true, true))
        .assertEqual(WebBackAction.DISMISS_PENDING_OAUTH);
      expect(decideWebBack(true, false, false))
        .assertEqual(WebBackAction.DISMISS_PENDING_OAUTH);
    });

    it('uses web history while an active OAuth flow can go backward', 0, () => {
      expect(decideWebBack(false, true, true)).assertEqual(WebBackAction.WEB_BACKWARD);
    });

    it('cancels active OAuth when it has no history', 0, () => {
      expect(decideWebBack(false, true, false)).assertEqual(WebBackAction.CANCEL_ACTIVE_OAUTH);
    });

    it('uses ordinary web history before returning home', 0, () => {
      expect(decideWebBack(false, false, true)).assertEqual(WebBackAction.WEB_BACKWARD);
      expect(decideWebBack(false, false, false)).assertEqual(WebBackAction.POP_TO_HOME);
    });

    it('keeps pending web actions as a closed native enum', 0, () => {
      expect(PendingWebAction.NONE).assertEqual('none');
      expect(PendingWebAction.RELOAD).assertEqual('reload');
    });
  });
}
