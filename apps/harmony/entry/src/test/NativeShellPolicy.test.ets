import { describe, expect, it } from '@ohos/hypium';
import {
  buildShellActivationScript,
  buildShellRollbackScript,
  buildWebActionScript,
  isShellUnsupportedResult,
  NativeWebAction,
  SHELL_LIFECYCLE_BRIDGE_METHOD,
  SHELL_LIFECYCLE_BRIDGE_NAME,
  SHELL_READY_RESULT,
  shouldAcceptShellActivation,
  shouldAcceptWebAction
} from '../main/ets/common/NativeShellPolicy';

const ORIGIN_GUARD: string = "if (location.origin !== 'https://claudeai.chat')";
const STYLE_ID: string = 'aurora-native-shell-v1-style';
const HEADER_SELECTOR: string = '[data-product-entry-scope="chat-header"]';
const AGENT_SELECTOR: string = 'button[data-product-feature="agents"]';
const MODEL_SELECTOR: string = 'button[aria-label="选择对话模型"]';

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

function assertFixedAction(action: NativeWebAction, ariaLabel: string): void {
  const script: string = buildWebActionScript(action, 21);
  const selector: string = `[aria-label="${ariaLabel}"]`;
  expect(script.indexOf(ORIGIN_GUARD) >= 0).assertTrue();
  expect(script.indexOf(ORIGIN_GUARD) < script.indexOf('document.querySelectorAll')).assertTrue();
  expect(script.indexOf(selector) >= 0).assertTrue();
  expect(script.indexOf('target.click();') >= 0).assertTrue();
  expect(script.indexOf('targets.length !== 1') >= 0).assertTrue();
  expect(occurrenceCount(script, 'document.querySelectorAll')).assertEqual(1);
  expect(script.indexOf('const contractSupported = headerNodes.length === 1') >= 0).assertTrue();
  expect(script.indexOf('agent.parentElement === header && model.parentElement === header') >= 0)
    .assertTrue();
  expect(script.indexOf('eval(') < 0).assertTrue();
  expect(script.indexOf('new Function') < 0).assertTrue();
}

export default function nativeShellPolicyTest(): void {
  describe('NativeShellPolicy', () => {
    it('guards shell activation with the exact primary origin before DOM access', 0, () => {
      const script: string = buildShellActivationScript(21);
      expect(script.indexOf(ORIGIN_GUARD) >= 0).assertTrue();
      expect(script.indexOf(ORIGIN_GUARD) < script.indexOf('document.querySelector')).assertTrue();
      expect(script.indexOf(ORIGIN_GUARD) < script.indexOf('new MutationObserver')).assertTrue();
      expect(script.indexOf('location.hostname') < 0).assertTrue();
    });

    it('removes only its own shell state when the versioned DOM contract is unavailable', 0, () => {
      const script: string = buildShellActivationScript(21);
      expect(script.indexOf(`root.querySelectorAll('${HEADER_SELECTOR}')`) >= 0).assertTrue();
      expect(script.indexOf('staleStyle.remove();') >= 0).assertTrue();
      expect(script.indexOf('document.documentElement.removeAttribute(marker);') >= 0).assertTrue();
      expect(script.indexOf('aurora-native-shell-unsupported-v1') >= 0).assertTrue();
      expect(script.indexOf(`${HEADER_SELECTOR}>*{display:none!important;}`) >= 0).assertTrue();
      expect(script.indexOf(`${HEADER_SELECTOR}>${AGENT_SELECTOR}`) >= 0).assertTrue();
      expect(script.indexOf(`${HEADER_SELECTOR}>${MODEL_SELECTOR}`) >= 0).assertTrue();
    });

    it('falls back when either retained control is missing or duplicated', 0, () => {
      const script: string = buildShellActivationScript(21);
      const headerLookup: number = script.indexOf(`root.querySelectorAll('${HEADER_SELECTOR}')`);
      const agentLookup: number = script.indexOf(`root.querySelectorAll('${AGENT_SELECTOR}')`);
      const modelLookup: number = script.indexOf(`root.querySelectorAll('${MODEL_SELECTOR}')`);
      const exactCountGuard: number = script.indexOf(
        'contractSupported = headerNodes.length === 1 && agentNodes.length === 1 &&\n' +
        '      modelNodes.length === 1'
      );
      const styleCreation: number = script.indexOf("document.createElement('style')");
      expect(headerLookup >= 0).assertTrue();
      expect(agentLookup >= 0).assertTrue();
      expect(modelLookup >= 0).assertTrue();
      expect(exactCountGuard >= 0).assertTrue();
      expect(exactCountGuard < styleCreation).assertTrue();
    });

    it('falls back when retained controls are no longer direct header children', 0, () => {
      const script: string = buildShellActivationScript(21);
      const directChildGuard: number = script.indexOf(
        'agent.parentElement === header && model.parentElement === header'
      );
      const fallback: number = script.indexOf('if (!contract.contractSupported)');
      const styleCreation: number = script.indexOf("document.createElement('style')");
      expect(directChildGuard >= 0).assertTrue();
      expect(fallback > directChildGuard).assertTrue();
      expect(fallback < styleCreation).assertTrue();
    });

    it('uses one versioned idempotent style identity on repeated activation', 0, () => {
      const first: string = buildShellActivationScript(21);
      const second: string = buildShellActivationScript(21);
      expect(first).assertEqual(second);
      expect(first.indexOf(`document.getElementById(styleId)`) >= 0).assertTrue();
      expect(first.indexOf('style.id = styleId;') >= 0).assertTrue();
      expect(occurrenceCount(first, STYLE_ID)).assertEqual(1);
      expect(occurrenceCount(first, "document.createElement('style')")).assertEqual(1);
    });

    it('installs one generation-bound observer and coalesces contract checks by frame', 0, () => {
      const script: string = buildShellActivationScript(21);
      expect(occurrenceCount(script, 'new MutationObserver')).assertEqual(1);
      expect(script.indexOf("const observerKey = '__auroraNativeShellObserverV1';") >= 0)
        .assertTrue();
      expect(script.indexOf('Number(existingObserver.generation) > expectedGeneration') >= 0)
        .assertTrue();
      expect(script.indexOf('requestAnimationFrame(flushContractChange)') >= 0).assertTrue();
      expect(script.indexOf('characterData') < 0).assertTrue();
      expect(script.indexOf("attributeFilter: ['data-product-entry-scope', 'data-product-feature', 'aria-label']") >= 0)
        .assertTrue();
    });

    it('notifies only a fingerprint transition and clears an exact ready generation first', 0, () => {
      const script: string = buildShellActivationScript(21);
      const changedGuard: number = script.indexOf(
        'if (nextContract.fingerprint === lastFingerprint)'
      );
      const exactCleanup: number = script.indexOf(
        'if (wasSupported && !nextContract.contractSupported)'
      );
      const notification: number = script.indexOf('notifyNative();', exactCleanup);
      expect(script.indexOf(`window['${SHELL_LIFECYCLE_BRIDGE_NAME}']`) >= 0).assertTrue();
      expect(script.indexOf(
        `bridge.${SHELL_LIFECYCLE_BRIDGE_METHOD}(expectedGeneration);`
      ) >= 0).assertTrue();
      expect(changedGuard >= 0).assertTrue();
      expect(exactCleanup > changedGuard).assertTrue();
      expect(notification > exactCleanup).assertTrue();
      expect(script.indexOf('document.cookie') < 0).assertTrue();
      expect(script.indexOf('localStorage') < 0).assertTrue();
      expect(script.indexOf('innerText') < 0).assertTrue();
    });

    it('rolls back only the versioned native shell state on activation failure', 0, () => {
      const script: string = buildShellRollbackScript(21);
      expect(script.indexOf(ORIGIN_GUARD) >= 0).assertTrue();
      expect(script.indexOf(`document.getElementById('${STYLE_ID}')`) >= 0).assertTrue();
      expect(script.indexOf("removeAttribute('data-aurora-native-shell-v1')") >= 0).assertTrue();
    });

    it('binds activation, rollback, and actions to one navigation generation', 0, () => {
      const activation: string = buildShellActivationScript(21);
      const rollback: string = buildShellRollbackScript(21);
      const action: string = buildWebActionScript(NativeWebAction.OPEN_SESSIONS, 21);
      const actionMarkerCheck: number = action.indexOf(
        "getAttribute('data-aurora-native-shell-v1') !== '21'"
      );
      expect(activation.indexOf('const expectedGeneration = 21;') >= 0).assertTrue();
      expect(activation.indexOf('setAttribute(marker, expectedGenerationText)') >= 0).assertTrue();
      expect(rollback.indexOf("getAttribute('data-aurora-native-shell-v1') !== '21'") >= 0)
        .assertTrue();
      expect(actionMarkerCheck >= 0).assertTrue();
      expect(actionMarkerCheck < action.indexOf('document.querySelectorAll')).assertTrue();
      expect(actionMarkerCheck < action.indexOf('target.click();')).assertTrue();
    });

    it('keeps a newer generation intact when an old rollback arrives late', 0, () => {
      const oldRollback: string = buildShellRollbackScript(20);
      expect(oldRollback.indexOf("getAttribute('data-aurora-native-shell-v1') !== '20'") >= 0)
        .assertTrue();
      expect(oldRollback.indexOf("return 'aurora-native-shell-unsupported-v1';") <
        oldRollback.indexOf(`document.getElementById('${STYLE_ID}')`)).assertTrue();
    });

    it('rejects stale generations and non-ready script results', 0, () => {
      expect(shouldAcceptShellActivation(
        4,
        5,
        'https://claudeai.chat/chat/session-1',
        SHELL_READY_RESULT
      )).assertFalse();
      expect(shouldAcceptShellActivation(
        5,
        5,
        'https://claudeai.chat/chat/session-1',
        'aurora-native-shell-unsupported-v1'
      )).assertFalse();
      expect(shouldAcceptShellActivation(
        5,
        5,
        'https://claudeai.chat/chat/session-1',
        `"${SHELL_READY_RESULT}"`
      )).assertTrue();
      expect(isShellUnsupportedResult('aurora-native-shell-unsupported-v1')).assertTrue();
      expect(isShellUnsupportedResult('"aurora-native-shell-unsupported-v1"')).assertTrue();
      expect(isShellUnsupportedResult('unexpected')).assertFalse();
    });

    it('accepts primary app routes but rejects OAuth and lookalike origins', 0, () => {
      expect(shouldAcceptShellActivation(
        8,
        8,
        'https://claudeai.chat/chat/session-2?source=harmony#latest',
        SHELL_READY_RESULT
      )).assertTrue();
      expect(shouldAcceptShellActivation(
        8,
        8,
        'https://connect.linux.do/oauth2/authorize?client_id=aurora',
        SHELL_READY_RESULT
      )).assertFalse();
      expect(shouldAcceptShellActivation(
        8,
        8,
        'https://evil.claudeai.chat/chat/session-2',
        SHELL_READY_RESULT
      )).assertFalse();
      expect(shouldAcceptShellActivation(
        8,
        8,
        'http://claudeai.chat/chat/session-2',
        SHELL_READY_RESULT
      )).assertFalse();
    });

    it('maps every native action to one fixed selector without executable input', 0, () => {
      assertFixedAction(NativeWebAction.OPEN_SESSIONS, '打开菜单');
      assertFixedAction(NativeWebAction.OPEN_MODEL, '选择对话模型');
      assertFixedAction(NativeWebAction.OPEN_MEDIA, '视频任务');
      assertFixedAction(NativeWebAction.OPEN_TUTORIAL, '打开使用教程');
      assertFixedAction(NativeWebAction.OPEN_INBOX, '站内信');
      assertFixedAction(NativeWebAction.OPEN_BILLING, '账户与计费');
    });

    it('accepts only current-generation action results on the exact primary origin', 0, () => {
      expect(shouldAcceptWebAction(
        12,
        12,
        'https://claudeai.chat/chat/session-3',
        'aurora-native-action-clicked-v1'
      )).assertTrue();
      expect(shouldAcceptWebAction(
        12,
        12,
        'https://claudeai.chat/chat/session-3',
        '"aurora-native-action-clicked-v1"'
      )).assertTrue();
      expect(shouldAcceptWebAction(
        11,
        12,
        'https://claudeai.chat/chat/session-3',
        'aurora-native-action-clicked-v1'
      )).assertFalse();
      expect(shouldAcceptWebAction(
        12,
        12,
        'https://evil.claudeai.chat/chat/session-3',
        'aurora-native-action-clicked-v1'
      )).assertFalse();
      expect(shouldAcceptWebAction(
        12,
        12,
        'https://claudeai.chat/chat/session-3',
        'aurora-native-action-unsupported-v1'
      )).assertFalse();
    });
  });
}
