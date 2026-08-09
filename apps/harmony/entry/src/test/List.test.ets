import auroraSharePolicyTest from './AuroraSharePolicy.test';
import downloadLifecyclePolicyTest from './DownloadLifecyclePolicy.test';
import navigationPolicyTest from './NavigationPolicy.test';
import nativeShellPolicyTest from './NativeShellPolicy.test';
import networkStateClockTest from './NetworkStateClock.test';
import shellEvaluationClockTest from './ShellEvaluationClock.test';
import shellLifecycleBridgeTest from './ShellLifecycleBridge.test';
import workspaceNavigationPolicyTest from './WorkspaceNavigationPolicy.test';

export default function testsuite(): void {
  auroraSharePolicyTest();
  downloadLifecyclePolicyTest();
  navigationPolicyTest();
  nativeShellPolicyTest();
  networkStateClockTest();
  shellEvaluationClockTest();
  shellLifecycleBridgeTest();
  workspaceNavigationPolicyTest();
}
