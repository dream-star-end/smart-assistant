import navigationPolicyTest from '../../../test/NavigationPolicy.test';
import nativeShellPolicyTest from '../../../test/NativeShellPolicy.test';
import networkStateClockTest from '../../../test/NetworkStateClock.test';

export default function testsuite(): void {
  navigationPolicyTest();
  nativeShellPolicyTest();
  networkStateClockTest();
}
