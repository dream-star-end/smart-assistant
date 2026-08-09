import { describe, expect, it } from '@ohos/hypium';
import {
  SHELL_LIFECYCLE_PERMISSION,
  SHELL_LIFECYCLE_REGISTRATION_METHOD,
  SHELL_LIFECYCLE_REGISTRATION_NAME,
  shouldDispatchShellLifecycleSignal
} from '../main/ets/services/ShellLifecycleBridge';

function occurrenceCount(value: string, token: string): number {
  let count: number = 0;
  let offset: number = 0;
  while (offset < value.length) {
    const found: number = value.indexOf(token, offset);
    if (found < 0) {
      return count;
    }
    count += 1;
    offset = found + token.length;
  }
  return count;
}

export default function shellLifecycleBridgeTest(): void {
  describe('ShellLifecycleBridge', () => {
    it('keeps object and method permission on one exact HTTPS hostname', 0, () => {
      expect(SHELL_LIFECYCLE_REGISTRATION_NAME).assertEqual('auroraNativeShellLifecycleV1');
      expect(SHELL_LIFECYCLE_REGISTRATION_METHOD).assertEqual('contractChanged');
      expect(occurrenceCount(
        SHELL_LIFECYCLE_PERMISSION,
        '"scheme":"https","host":"claudeai.chat","port":"","path":""'
      )).assertEqual(2);
      expect(occurrenceCount(
        SHELL_LIFECYCLE_PERMISSION,
        '"methodName":"contractChanged"'
      )).assertEqual(1);
      expect(SHELL_LIFECYCLE_PERMISSION.indexOf('*') < 0).assertTrue();
      expect(SHELL_LIFECYCLE_PERMISSION.indexOf('http"') < 0).assertTrue();
    });

    it('accepts only integer generations from the exact primary caller URL', 0, () => {
      expect(shouldDispatchShellLifecycleSignal(
        21,
        'https://claudeai.chat/chat/session-1?source=harmony#latest'
      )).assertTrue();
      expect(shouldDispatchShellLifecycleSignal(
        21.5,
        'https://claudeai.chat/chat/session-1'
      )).assertFalse();
      expect(shouldDispatchShellLifecycleSignal(
        -1,
        'https://claudeai.chat/chat/session-1'
      )).assertFalse();
    });

    it('rejects lookalike, credentialed, non-default-port, and OAuth callers', 0, () => {
      expect(shouldDispatchShellLifecycleSignal(
        21,
        'https://evil.claudeai.chat/chat/session-1'
      )).assertFalse();
      expect(shouldDispatchShellLifecycleSignal(
        21,
        'https://user:secret@claudeai.chat/chat/session-1'
      )).assertFalse();
      expect(shouldDispatchShellLifecycleSignal(
        21,
        'https://claudeai.chat:8443/chat/session-1'
      )).assertFalse();
      expect(shouldDispatchShellLifecycleSignal(
        21,
        'https://connect.linux.do/oauth2/authorize'
      )).assertFalse();
    });
  });
}
