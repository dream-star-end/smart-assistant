import navigationPolicyTest from './NavigationPolicy.test';
import nativeShellPolicyTest from './NativeShellPolicy.test';
import networkStateClockTest from './NetworkStateClock.test';

export default function testsuite(): void {
  navigationPolicyTest();
  nativeShellPolicyTest();
  networkStateClockTest();
}
