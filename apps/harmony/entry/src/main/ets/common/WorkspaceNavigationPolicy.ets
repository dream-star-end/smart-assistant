export const AURORA_WEB_ROUTE: string = 'aurora-web';
export const AURORA_SETTINGS_ROUTE: string = 'aurora-settings';
export const AURORA_PRIVACY_ROUTE: string = 'aurora-privacy';
export const AURORA_ABOUT_ROUTE: string = 'aurora-about';

export enum PendingWebAction {
  NONE = 'none',
  RELOAD = 'reload'
}

export enum WebBackAction {
  DISMISS_PENDING_OAUTH = 'dismiss-pending-oauth',
  WEB_BACKWARD = 'web-backward',
  CANCEL_ACTIVE_OAUTH = 'cancel-active-oauth',
  POP_TO_HOME = 'pop-to-home'
}

export function shouldPushRoute(pathNames: string[], target: string): boolean {
  if (pathNames.length === 0) {
    return true;
  }
  return pathNames[pathNames.length - 1] !== target;
}

export function hasRoute(pathNames: string[], target: string): boolean {
  for (let index: number = 0; index < pathNames.length; index++) {
    if (pathNames[index] === target) {
      return true;
    }
  }
  return false;
}

export function decideWebBack(
  hasPendingOauth: boolean,
  activeOauth: boolean,
  canGoBackward: boolean
): WebBackAction {
  if (hasPendingOauth) {
    return WebBackAction.DISMISS_PENDING_OAUTH;
  }
  if (activeOauth) {
    return canGoBackward ? WebBackAction.WEB_BACKWARD : WebBackAction.CANCEL_ACTIVE_OAUTH;
  }
  return canGoBackward ? WebBackAction.WEB_BACKWARD : WebBackAction.POP_TO_HOME;
}

export function shouldCreateFreshWebController(hasWebRoute: boolean): boolean {
  return !hasWebRoute;
}
