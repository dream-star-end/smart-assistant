import navigationPolicyTest from '../../../test/NavigationPolicy.test';
import nativeShellPolicyTest from '../../../test/NativeShellPolicy.test';
import networkStateClockTest from '../../../test/NetworkStateClock.test';
import shellEvaluationClockTest from '../../../test/ShellEvaluationClock.test';
import shellLifecycleBridgeTest from '../../../test/ShellLifecycleBridge.test';

export default function testsuite(): void {
  navigationPolicyTest();
  nativeShellPolicyTest();
  networkStateClockTest();
  shellEvaluationClockTest();
  shellLifecycleBridgeTest();
}
