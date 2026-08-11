import { url } from '@kit.ArkTS';

export const APP_HOME_URL: string = 'https://claudeai.chat/';
export const APP_CLIENT_URL: string = 'https://claudeai.chat/?client=harmony';

const PRIMARY_HOST: string = 'claudeai.chat';
const OAUTH_CALLBACK_PATHS: Array<string> = [
  '/api/auth/linuxdo/callback',
  '/api/auth/github/callback',
  '/api/connectors/oauth/callback'
];

export enum NavigationDecision {
  IN_APP = 'in-app',
  EXTERNAL = 'external',
  BLOCKED = 'blocked'
}

function isDefaultHttpsUrl(parsed: url.URL): boolean {
  return parsed.protocol === 'https:' &&
    parsed.hostname.length > 0 &&
    parsed.port.length === 0 &&
    parsed.username.length === 0 &&
    parsed.password.length === 0;
}

function isOauthCallbackPath(pathname: string): boolean {
  for (let index: number = 0; index < OAUTH_CALLBACK_PATHS.length; index++) {
    if (pathname === OAUTH_CALLBACK_PATHS[index]) {
      return true;
    }
  }
  return false;
}

export function classifyNavigationUrl(targetUrl: string): NavigationDecision {
  try {
    const parsed: url.URL = url.URL.parseURL(targetUrl);
    if (!isDefaultHttpsUrl(parsed)) {
      return NavigationDecision.BLOCKED;
    }
    if (parsed.hostname === PRIMARY_HOST) {
      return NavigationDecision.IN_APP;
    }
    return NavigationDecision.EXTERNAL;
  } catch (_) {
    return NavigationDecision.BLOCKED;
  }
}

// This only recognizes the shape of an OAuth candidate. It is not proof that
// the external origin is trusted; the native shell must still ask the user to
// verify the displayed hostname before loading it in ArkWeb.
export function isOauthCandidateUrl(targetUrl: string): boolean {
  try {
    const parsed: url.URL = url.URL.parseURL(targetUrl);
    if (!isDefaultHttpsUrl(parsed) || parsed.hostname === PRIMARY_HOST) {
      return false;
    }

    const state: string | null = parsed.params.get('state');
    const redirectValue: string | null = parsed.params.get('redirect_uri');
    if (state === null || state.length === 0 || redirectValue === null) {
      return false;
    }

    const redirect: url.URL = url.URL.parseURL(redirectValue);
    return isDefaultHttpsUrl(redirect) &&
      redirect.hostname === PRIMARY_HOST &&
      isOauthCallbackPath(redirect.pathname);
  } catch (_) {
    return false;
  }
}

export function safeHttpsHostname(targetUrl: string): string {
  try {
    const parsed: url.URL = url.URL.parseURL(targetUrl);
    return isDefaultHttpsUrl(parsed) ? parsed.hostname : '';
  } catch (_) {
    return '';
  }
}

export function isPrimaryAppOrigin(origin: string): boolean {
  try {
    const parsed: url.URL = url.URL.parseURL(origin);
    return isDefaultHttpsUrl(parsed) && parsed.hostname === PRIMARY_HOST;
  } catch (_) {
    return false;
  }
}

export function isSafeExternalUrl(targetUrl: string): boolean {
  try {
    return isDefaultHttpsUrl(url.URL.parseURL(targetUrl));
  } catch (_) {
    return false;
  }
}

export function isSafeDownloadUrl(targetUrl: string): boolean {
  return isSafeExternalUrl(targetUrl) || targetUrl.startsWith('blob:https://claudeai.chat/');
}
