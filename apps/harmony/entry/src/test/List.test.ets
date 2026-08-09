import navigationPolicyTest from './NavigationPolicy.test';
import nativeShellPolicyTest from './NativeShellPolicy.test';
import networkStateClockTest from './NetworkStateClock.test';
import shellEvaluationClockTest from './ShellEvaluationClock.test';
import shellLifecycleBridgeTest from './ShellLifecycleBridge.test';

export default function testsuite(): void {
  navigationPolicyTest();
  nativeShellPolicyTest();
  networkStateClockTest();
  shellEvaluationClockTest();
  shellLifecycleBridgeTest();
}
