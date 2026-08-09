import { url } from '@kit.ArkTS';

const PRIMARY_ORIGIN: string = 'https://claudeai.chat';
const SHELL_STYLE_ID: string = 'aurora-native-shell-v1-style';
const SHELL_MARKER: string = 'data-aurora-native-shell-v1';
const SHELL_UNSUPPORTED_RESULT: string = 'aurora-native-shell-unsupported-v1';
const ACTION_BLOCKED_RESULT: string = 'aurora-native-action-blocked-v1';
const ACTION_UNSUPPORTED_RESULT: string = 'aurora-native-action-unsupported-v1';
const ACTION_CLICKED_RESULT: string = 'aurora-native-action-clicked-v1';

export const SHELL_READY_RESULT: string = 'aurora-native-shell-ready-v1';
export const SHELL_LIFECYCLE_BRIDGE_NAME: string = 'auroraNativeShellLifecycleV1';
export const SHELL_LIFECYCLE_BRIDGE_METHOD: string = 'contractChanged';

export enum NativeWebAction {
  OPEN_SESSIONS = 'open-sessions',
  OPEN_MODEL = 'open-model',
  OPEN_MEDIA = 'open-media',
  OPEN_TUTORIAL = 'open-tutorial',
  OPEN_INBOX = 'open-inbox',
  OPEN_BILLING = 'open-billing'
}

function fixedSelectorFor(action: NativeWebAction): string {
  switch (action) {
    case NativeWebAction.OPEN_SESSIONS:
      return '[aria-label="打开菜单"]';
    case NativeWebAction.OPEN_MODEL:
      return '[aria-label="选择对话模型"]';
    case NativeWebAction.OPEN_MEDIA:
      return '[aria-label="视频任务"]';
    case NativeWebAction.OPEN_TUTORIAL:
      return '[aria-label="打开使用教程"]';
    case NativeWebAction.OPEN_INBOX:
      return '[aria-label="站内信"]';
    case NativeWebAction.OPEN_BILLING:
      return '[aria-label="账户与计费"]';
    default:
      return '';
  }
}

function buildUnsupportedActionScript(): string {
  return [
    '(() => {',
    `  if (location.origin !== '${PRIMARY_ORIGIN}') {`,
    `    return '${ACTION_BLOCKED_RESULT}';`,
    '  }',
    `  return '${ACTION_UNSUPPORTED_RESULT}';`,
    '})();'
  ].join('\n');
}

function hasExactPrimaryOrigin(currentUrl: string): boolean {
  try {
    const parsed: url.URL = url.URL.parseURL(currentUrl);
    return parsed.protocol === 'https:' &&
      parsed.hostname === 'claudeai.chat' &&
      parsed.port.length === 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0;
  } catch (_) {
    return false;
  }
}

export function buildShellActivationScript(expectedGeneration: number): string {
  return [
    '(() => {',
    `  if (location.origin !== '${PRIMARY_ORIGIN}') {`,
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    `  const styleId = '${SHELL_STYLE_ID}';`,
    `  const marker = '${SHELL_MARKER}';`,
    `  const expectedGeneration = ${expectedGeneration};`,
    "  const expectedGenerationText = String(expectedGeneration);",
    "  const observerKey = '__auroraNativeShellObserverV1';",
    '  const existingGeneration = document.documentElement.getAttribute(marker);',
    '  if (existingGeneration !== null && Number(existingGeneration) > Number(expectedGeneration)) {',
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    '  const existingObserver = window[observerKey];',
    '  if (existingObserver !== undefined && existingObserver !== null &&',
    '    Number(existingObserver.generation) > expectedGeneration) {',
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    "  const rootNodes = document.querySelectorAll('#root');",
    '  const root = rootNodes.item(0);',
    '  const clearStaleShell = () => {',
    '    const markerGeneration = document.documentElement.getAttribute(marker);',
    '    if (markerGeneration !== null && Number(markerGeneration) > expectedGeneration) {',
    '      return;',
    '    }',
    '    const staleStyle = document.getElementById(styleId);',
    '    if (staleStyle !== null) {',
    '      staleStyle.remove();',
    '    }',
    '    document.documentElement.removeAttribute(marker);',
    '  };',
    '  const clearExactShell = () => {',
    '    if (document.documentElement.getAttribute(marker) !== expectedGenerationText) {',
    '      return;',
    '    }',
    '    const staleStyle = document.getElementById(styleId);',
    '    if (staleStyle !== null) {',
    '      staleStyle.remove();',
    '    }',
    '    document.documentElement.removeAttribute(marker);',
    '  };',
    '  if (rootNodes.length !== 1 || !(root instanceof HTMLElement) || document.head === null) {',
    '    clearStaleShell();',
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    '  const readContract = () => {',
    '    const headerNodes = root.querySelectorAll(\'[data-product-entry-scope="chat-header"]\');',
    '    const agentNodes = root.querySelectorAll(\'button[data-product-feature="agents"]\');',
    '    const modelNodes = root.querySelectorAll(\'button[aria-label="选择对话模型"]\');',
    '    const header = headerNodes.item(0);',
    '    const agent = agentNodes.item(0);',
    '    const model = modelNodes.item(0);',
    '    const contractSupported = headerNodes.length === 1 && agentNodes.length === 1 &&',
    '      modelNodes.length === 1 && header instanceof HTMLElement &&',
    '      agent instanceof HTMLElement && model instanceof HTMLElement &&',
    '      agent.parentElement === header && model.parentElement === header;',
    "    const fingerprint = String(headerNodes.length) + ':' + String(agentNodes.length) + ':' +",
    "      String(modelNodes.length) + ':' + (contractSupported ? '1' : '0');",
    '    return {',
    '      header: header,',
    '      agent: agent,',
    '      model: model,',
    '      contractSupported: contractSupported,',
    '      fingerprint: fingerprint',
    '    };',
    '  };',
    '  let contract = readContract();',
    '  const observerReusable = existingObserver !== undefined && existingObserver !== null &&',
    '    Number(existingObserver.generation) === expectedGeneration &&',
    "    typeof existingObserver.dispose === 'function';",
    '  if (!observerReusable) {',
    '    if (existingObserver !== undefined && existingObserver !== null &&',
    "      typeof existingObserver.dispose === 'function') {",
    '      try {',
    '        existingObserver.dispose();',
    '      } catch (_) {',
    '      }',
    '    }',
    '    let lastFingerprint = contract.fingerprint;',
    '    let lastSupported = contract.contractSupported;',
    '    let framePending = false;',
    '    let frameId = 0;',
    '    let disposed = false;',
    '    const notifyNative = () => {',
    `      const bridge = window['${SHELL_LIFECYCLE_BRIDGE_NAME}'];`,
    `      if (bridge === undefined || bridge === null || typeof bridge.${SHELL_LIFECYCLE_BRIDGE_METHOD} !== 'function') {`,
    '        return;',
    '      }',
    '      try {',
    `        bridge.${SHELL_LIFECYCLE_BRIDGE_METHOD}(expectedGeneration);`,
    '      } catch (_) {',
    '      }',
    '    };',
    '    const flushContractChange = () => {',
    '      framePending = false;',
    '      frameId = 0;',
    '      if (disposed) {',
    '        return;',
    '      }',
    '      const nextContract = readContract();',
    '      if (nextContract.fingerprint === lastFingerprint) {',
    '        return;',
    '      }',
    '      const wasSupported = lastSupported;',
    '      lastFingerprint = nextContract.fingerprint;',
    '      lastSupported = nextContract.contractSupported;',
    '      if (wasSupported && !nextContract.contractSupported) {',
    '        clearExactShell();',
    '      }',
    '      notifyNative();',
    '    };',
    '    const observer = new MutationObserver(() => {',
    '      if (!disposed && !framePending) {',
    '        framePending = true;',
    '        frameId = requestAnimationFrame(flushContractChange);',
    '      }',
    '    });',
    '    observer.observe(root, {',
    '      childList: true,',
    '      subtree: true,',
    '      attributes: true,',
    "      attributeFilter: ['data-product-entry-scope', 'data-product-feature', 'aria-label']",
    '    });',
    '    const observerRecord = {',
    '      generation: expectedGeneration,',
    '      dispose: () => {',
    '        disposed = true;',
    '        observer.disconnect();',
    '        if (framePending) {',
    '          cancelAnimationFrame(frameId);',
    '          framePending = false;',
    '          frameId = 0;',
    '        }',
    '      }',
    '    };',
    '    window[observerKey] = observerRecord;',
    "    window.addEventListener('pagehide', () => {",
    '      if (window[observerKey] === observerRecord) {',
    '        observerRecord.dispose();',
    '        delete window[observerKey];',
    '      }',
    '    }, { once: true });',
    '  }',
    '  if (!contract.contractSupported) {',
    '    clearStaleShell();',
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    '  let style = document.getElementById(styleId);',
    '  if (!(style instanceof HTMLStyleElement)) {',
    '    if (style !== null) {',
    '      style.remove();',
    '    }',
    "    style = document.createElement('style');",
    '    style.id = styleId;',
    '    document.head.appendChild(style);',
    '  }',
    '  document.documentElement.setAttribute(marker, expectedGenerationText);',
    '  style.textContent =',
    '    \'[data-product-entry-scope="chat-header"]{display:flex!important;height:44px!important;min-height:44px!important;padding:0 12px 4px!important;gap:6px!important;border-bottom:1px solid var(--border)!important;background:var(--surface)!important;}\' +',
    '    \'[data-product-entry-scope="chat-header"]>*{display:none!important;}\' +',
    '    \'[data-product-entry-scope="chat-header"]>button[data-product-feature="agents"],[data-product-entry-scope="chat-header"]>button[aria-label="选择对话模型"]{display:flex!important;}\' +',
    '    \'[data-product-entry-scope="chat-header"]>button[data-product-feature="agents"]{min-width:0!important;flex:1 1 auto!important;}\' +',
    '    \'[data-product-entry-scope="chat-header"]>button[aria-label="选择对话模型"]{flex:0 1 auto!important;max-width:48%!important;}\';',
    `  return '${SHELL_READY_RESULT}';`,
    '})();'
  ].join('\n');
}

export function buildShellRollbackScript(expectedGeneration: number): string {
  return [
    '(() => {',
    `  if (location.origin !== '${PRIMARY_ORIGIN}') {`,
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    `  if (document.documentElement.getAttribute('${SHELL_MARKER}') !== '${expectedGeneration}') {`,
    `    return '${SHELL_UNSUPPORTED_RESULT}';`,
    '  }',
    `  const style = document.getElementById('${SHELL_STYLE_ID}');`,
    '  if (style !== null) {',
    '    style.remove();',
    '  }',
    `  document.documentElement.removeAttribute('${SHELL_MARKER}');`,
    `  return '${SHELL_UNSUPPORTED_RESULT}';`,
    '})();'
  ].join('\n');
}

export function buildWebActionScript(action: NativeWebAction, expectedGeneration: number): string {
  const selector: string = fixedSelectorFor(action);
  if (selector.length === 0) {
    return buildUnsupportedActionScript();
  }

  return [
    '(() => {',
    `  if (location.origin !== '${PRIMARY_ORIGIN}') {`,
    `    return '${ACTION_BLOCKED_RESULT}';`,
    '  }',
    `  if (document.documentElement.getAttribute('${SHELL_MARKER}') !== '${expectedGeneration}') {`,
    `    return '${ACTION_BLOCKED_RESULT}';`,
    '  }',
    "  const rootNodes = document.querySelectorAll('#root');",
    '  const root = rootNodes.item(0);',
    '  if (rootNodes.length !== 1 || !(root instanceof HTMLElement)) {',
    `    return '${ACTION_BLOCKED_RESULT}';`,
    '  }',
    '  const headerNodes = root.querySelectorAll(\'[data-product-entry-scope="chat-header"]\');',
    '  const agentNodes = root.querySelectorAll(\'button[data-product-feature="agents"]\');',
    '  const modelNodes = root.querySelectorAll(\'button[aria-label="选择对话模型"]\');',
    '  const header = headerNodes.item(0);',
    '  const agent = agentNodes.item(0);',
    '  const model = modelNodes.item(0);',
    '  const contractSupported = headerNodes.length === 1 && agentNodes.length === 1 &&',
    '    modelNodes.length === 1 && header instanceof HTMLElement &&',
    '    agent instanceof HTMLElement && model instanceof HTMLElement &&',
    '    agent.parentElement === header && model.parentElement === header;',
    '  if (!contractSupported) {',
    `    return '${ACTION_BLOCKED_RESULT}';`,
    '  }',
    `  const targets = root.querySelectorAll('${selector}');`,
    '  const target = targets.item(0);',
    '  if (targets.length !== 1 || !(target instanceof HTMLElement)) {',
    `    return '${ACTION_UNSUPPORTED_RESULT}';`,
    '  }',
    '  target.click();',
    `  return '${ACTION_CLICKED_RESULT}';`,
    '})();'
  ].join('\n');
}

export function shouldAcceptWebAction(
  startedGeneration: number,
  currentGeneration: number,
  currentUrl: string,
  scriptResult: string
): boolean {
  const clickedResult: boolean = scriptResult === ACTION_CLICKED_RESULT ||
    scriptResult === `"${ACTION_CLICKED_RESULT}"`;
  return startedGeneration === currentGeneration &&
    hasExactPrimaryOrigin(currentUrl) &&
    clickedResult;
}

export function shouldAcceptShellActivation(
  startedGeneration: number,
  currentGeneration: number,
  currentUrl: string,
  scriptResult: string
): boolean {
  const readyResult: boolean = scriptResult === SHELL_READY_RESULT ||
    scriptResult === `"${SHELL_READY_RESULT}"`;
  return startedGeneration === currentGeneration &&
    hasExactPrimaryOrigin(currentUrl) &&
    readyResult;
}

export function isShellUnsupportedResult(scriptResult: string): boolean {
  return scriptResult === SHELL_UNSUPPORTED_RESULT ||
    scriptResult === `"${SHELL_UNSUPPORTED_RESULT}"`;
}
