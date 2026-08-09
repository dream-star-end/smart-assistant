import auroraSharePolicyTest from '../../../test/AuroraSharePolicy.test';
import downloadLifecyclePolicyTest from '../../../test/DownloadLifecyclePolicy.test';
import navigationPolicyTest from '../../../test/NavigationPolicy.test';
import nativeShellPolicyTest from '../../../test/NativeShellPolicy.test';
import networkStateClockTest from '../../../test/NetworkStateClock.test';
import shellEvaluationClockTest from '../../../test/ShellEvaluationClock.test';
import shellLifecycleBridgeTest from '../../../test/ShellLifecycleBridge.test';
import workspaceNavigationPolicyTest from '../../../test/WorkspaceNavigationPolicy.test';
import workspaceUiTest from './WorkspaceUi.test';

export default function testsuite(): void {
  auroraSharePolicyTest();
  downloadLifecyclePolicyTest();
  navigationPolicyTest();
  nativeShellPolicyTest();
  networkStateClockTest();
  shellEvaluationClockTest();
  shellLifecycleBridgeTest();
  workspaceNavigationPolicyTest();
  workspaceUiTest();
}
