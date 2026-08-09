import { webview } from '@kit.ArkWeb';
import {
  SHELL_LIFECYCLE_BRIDGE_METHOD,
  SHELL_LIFECYCLE_BRIDGE_NAME
} from '../common/NativeShellPolicy';
import { isPrimaryAppOrigin } from '../common/NavigationPolicy';

const MAX_NAVIGATION_GENERATION: number = 2147483647;

export const SHELL_LIFECYCLE_PERMISSION: string =
  '{"javascriptProxyPermission":{"urlPermissionList":[' +
  '{"scheme":"https","host":"claudeai.chat","port":"","path":""}],' +
  '"methodList":[{"methodName":"' + SHELL_LIFECYCLE_BRIDGE_METHOD +
  '","urlPermissionList":[' +
  '{"scheme":"https","host":"claudeai.chat","port":"","path":""}]}]}}';

export type ShellLifecycleListener = (generation: number) => void;

export function shouldDispatchShellLifecycleSignal(
  generation: number,
  callingFrameUrl: string
): boolean {
  return generation >= 0 &&
    generation <= MAX_NAVIGATION_GENERATION &&
    Math.floor(generation) === generation &&
    isPrimaryAppOrigin(callingFrameUrl);
}

/**
 * A one-method, no-return lifecycle signal. The permission JSON constrains
 * scheme/host at object and method level. Its empty port/path fields mean
 * "not checked", so the synchronous caller URL check remains mandatory.
 */
export class ShellLifecycleBridge {
  private readonly controller: webview.WebviewController;
  private listener: ShellLifecycleListener | undefined = undefined;

  constructor(controller: webview.WebviewController) {
    this.controller = controller;
  }

  attach(listener: ShellLifecycleListener): void {
    this.listener = listener;
  }

  detach(): void {
    this.listener = undefined;
  }

  contractChanged(generation: number): void {
    let callingFrameUrl: string = '';
    try {
      // This API is only authoritative during the synchronous proxy call.
      callingFrameUrl = this.controller.getLastJavascriptProxyCallingFrameUrl();
    } catch (_) {
      return;
    }
    if (!shouldDispatchShellLifecycleSignal(generation, callingFrameUrl)) {
      return;
    }

    const listener: ShellLifecycleListener | undefined = this.listener;
    if (listener !== undefined) {
      listener(generation);
    }
  }
}

// Keep the registration constants referenced here so permission, injected
// script, and ArkWeb method allowlist cannot silently drift apart.
export const SHELL_LIFECYCLE_REGISTRATION_NAME: string = SHELL_LIFECYCLE_BRIDGE_NAME;
export const SHELL_LIFECYCLE_REGISTRATION_METHOD: string = SHELL_LIFECYCLE_BRIDGE_METHOD;
